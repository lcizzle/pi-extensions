#!/usr/bin/env node
/**
 * Standalone stdio MCP Server for Laya Obsidian Triage
 */
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as readline from "node:readline";

const DAEMON_URL = process.env.LAYA_TRIAGE_URL ?? "http://127.0.0.1:8765";

async function api(path, init, signal) {
  const response = await fetch(`${DAEMON_URL}${path}`, { ...init, signal });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return await response.json();
}

async function ensureReady(signal) {
  const health = await api("/health", { method: "GET" }, signal);
  if (!health.ready) throw new Error(`daemon status is ${health.status}; wait for model warmup`);
}

function resolveVault(cwd, requested) {
  if (requested) return resolve(cwd, requested);
  let cur = cwd;
  for (let i = 0; i < 6; i++) {
    const directVault = resolve(cur, "Vaults", "AI");
    if (existsSync(directVault)) return directVault;
    const subVault = resolve(cur, "Obsidian-AI", "Vaults", "AI");
    if (existsSync(subVault)) return subVault;
    const parent = resolve(cur, "..");
    if (parent === cur) break;
    cur = parent;
  }
  return resolve(cwd, "Vaults", "AI");
}

function unqualifiedLinks(markdown) {
  const links = [...markdown.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((m) => m[1].trim());
  return [...new Set(links.filter((target) => target && !target.includes("/") && !target.startsWith("#")))];
}

function protocolProblems(markdown) {
  const problems = [];
  if (!/^---\s*\r?\n[\s\S]*?\r?\n---/m.test(markdown)) problems.push("missing YAML frontmatter");
  if (!/#+\s+(?:1[.: ]+)?Context\s*(?:&|and)\s*Objective/i.test(markdown)) problems.push("missing Context & Objective section");
  if (!/#+\s+(?:3[.: ]+)?Discovered Knowledge/i.test(markdown)) problems.push("missing Discovered Knowledge section");
  if (!/(?:state_mutations|state mutations)/i.test(markdown)) problems.push("missing state_mutations telemetry");
  return problems;
}

function formatRow(file, triage) {
  const action = triage.flag_adr ? "[TRIGGER ADR]" : triage.compliance_score >= 1 ? "[PASS]" : "[REVIEW]";
  return `| ${file} | ${triage.p_needs_adr.toFixed(2)} | ${triage.p_has_gotcha.toFixed(2)} | ${triage.root_cause} | ${triage.compliance_score >= 1 ? "PASS" : "FAIL"} | ${action} |`;
}

async function triageMarkdown(markdown, signal) {
  return api("/triage-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markdown }),
  }, signal);
}

const TOOLS = [
  {
    name: "obsidian_laya_triage",
    description: "Triage every pending active session for one project through the local Laya daemon without adding session Markdown to LLM context.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          description: "Project identifier, e.g. lch_Obsidian-AI, lch_Multigravity-Win-CLI, or _Template",
        },
        vaultRoot: {
          type: "string",
          description: "Vault root; defaults to Obsidian-AI/Vaults/AI or Vaults/AI",
        },
        autoWriteSidecar: {
          type: "boolean",
          description: "Write <session>.triage.json beside each session (default true)",
        },
      },
      required: ["projectId"],
    },
  },
  {
    name: "obsidian_precommit_check",
    description: "Audit a drafted active-session Markdown note for Laya protocol compliance and path-qualified wikilinks before saving it.",
    inputSchema: {
      type: "object",
      properties: {
        markdown: {
          type: "string",
          description: "The drafted session Markdown",
        },
      },
      required: ["markdown"],
    },
  },
];

async function handleToolCall(name, args) {
  const cwd = process.cwd();
  if (name === "obsidian_laya_triage") {
    const { projectId, vaultRoot, autoWriteSidecar = true } = args;
    try {
      await ensureReady();
      const vault = resolveVault(cwd, vaultRoot);
      const active = join(vault, "Projects", projectId, "Sessions", "Active");
      
      let files = [];
      try {
        const entries = await readdir(active, { withFileTypes: true });
        files = entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name).sort();
      } catch (err) {
        // Active directory may not exist or be empty
      }

      const rows = [
        "| Session File | P(ADR) | P(Gotcha) | Root Cause | Compliant | Action |",
        "|---|---:|---:|---|---|---|",
      ];

      for (const file of files) {
        const sessionPath = join(active, file);
        const content = await readFile(sessionPath, "utf8");
        const result = await triageMarkdown(content);
        if (autoWriteSidecar !== false) {
          await writeFile(`${sessionPath}.triage.json`, `${JSON.stringify(result, null, 2)}\n`, "utf8");
        }
        rows.push(formatRow(file, result));
      }

      if (files.length === 0) {
        rows.push("| *(none)* | - | - | - | - | - |");
      }

      return {
        content: [{ type: "text", text: rows.join("\n") }],
        isError: false,
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Laya triage unavailable: ${error instanceof Error ? error.message : String(error)}. Start the daemon on 127.0.0.1:8765.` }],
        isError: true,
      };
    }
  }

  if (name === "obsidian_precommit_check") {
    const { markdown } = args;
    try {
      await ensureReady();
      const result = await triageMarkdown(markdown);
      const links = unqualifiedLinks(markdown);
      const problems = protocolProblems(markdown);
      const pass = result.compliance_score >= 1 && links.length === 0 && problems.length === 0;
      const feedback = [
        `Pre-commit ${pass ? "PASS" : "REVIEW"}: compliance ${result.compliance_score.toFixed(2)}; root cause ${result.root_cause}.`,
        links.length ? `Unqualified wikilinks: ${links.map((link) => `[[${link}]]`).join(", ")}.` : "All wikilinks are path-qualified.",
        problems.length ? `Protocol issues: ${problems.join("; ")}.` : "Frontmatter and telemetry structure present.",
      ];
      return {
        content: [{ type: "text", text: feedback.join(" ") }],
        isError: false,
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Laya pre-commit check unavailable: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }

  throw new Error(`Unknown tool: ${name}`);
}

function sendResponse(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", async (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    const { id, method, params } = msg;

    if (method === "initialize") {
      sendResponse(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "laya-obsidian", version: "1.0.0" },
      });
      return;
    }

    if (method === "notifications/initialized") {
      return;
    }

    if (method === "tools/list") {
      sendResponse(id, { tools: TOOLS });
      return;
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const toolArgs = params?.arguments ?? {};
      const res = await handleToolCall(toolName, toolArgs);
      sendResponse(id, res);
      return;
    }

    if (id !== undefined) {
      sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    if (line) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.id) sendError(parsed.id, -32603, err.message);
      } catch {}
    }
  }
});
