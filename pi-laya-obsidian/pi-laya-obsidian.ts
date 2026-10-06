import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

const STATE_LINE_LIMIT = 150;
const DAEMON_URL = process.env.LAYA_TRIAGE_URL ?? "http://127.0.0.1:8765";

// Regex matching state note filenames: State_<Project_ID>.md
const STATE_NOTE_REGEX = /State_[^\/\\]+\.md$/i;

// Regex matching active session notes: Sessions/Active/<Session_ID>.md
const ACTIVE_SESSION_REGEX = /[\\/]Sessions[\\/]Active[\\/][^\\/\\]+\.md$/i;

export interface TriageResult {
  p_needs_adr: number;
  p_has_gotcha: number;
  root_cause: string;
  compliance_score: number;
  flag_adr: boolean;
  flag_gotcha: boolean;
  latency_ms?: number;
  input_tokens_approx?: number;
  error?: string;
}

/**
 * Resolve target file path from various tool input formats
 */
export function extractTargetPath(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  const raw =
    input.path ??
    input.TargetFile ??
    input.targetFile ??
    input.file ??
    input.filePath ??
    input.filepath ??
    "";
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * Calculate proposed line count for a tool call on a file
 */
export function calculateProposedLines(
  targetPath: string,
  cwd: string,
  _toolName: string,
  input: Record<string, unknown>
): number | null {
  const fullPath = path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath);

  // Case 1: Full content provided directly (write, write_to_file)
  const fullContent = input.content ?? input.CodeContent ?? input.replacement ?? null;
  if (typeof fullContent === "string") {
    return fullContent.split(/\r?\n/).length;
  }

  // Case 2: Edits / replacements (edit, replace_file_content)
  if (!fs.existsSync(fullPath)) {
    if (typeof input.ReplacementContent === "string") {
      return input.ReplacementContent.split(/\r?\n/).length;
    }
    return null;
  }

  try {
    let currentContent = fs.readFileSync(fullPath, "utf8");

    // Pi 'edit' tool: input.edits = [{ oldText: string, newText: string }]
    if (Array.isArray(input.edits)) {
      for (const edit of input.edits) {
        if (edit && typeof edit.oldText === "string" && typeof edit.newText === "string") {
          currentContent = currentContent.replace(edit.oldText, edit.newText);
        }
      }
      return currentContent.split(/\r?\n/).length;
    }

    // Antigravity 'replace_file_content': input.TargetContent, input.ReplacementContent
    if (typeof input.TargetContent === "string" && typeof input.ReplacementContent === "string") {
      currentContent = currentContent.replace(input.TargetContent, input.ReplacementContent);
      return currentContent.split(/\r?\n/).length;
    }

    return currentContent.split(/\r?\n/).length;
  } catch {
    return null;
  }
}

/**
 * Call Laya Daemon to triage session markdown
 */
export async function triageMarkdown(markdown: string, signal?: AbortSignal): Promise<TriageResult> {
  const resp = await fetch(`${DAEMON_URL}/triage-session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markdown }),
    signal,
  });
  if (!resp.ok) {
    throw new Error(`Laya daemon error (${resp.status}): ${await resp.text()}`);
  }
  return (await resp.json()) as TriageResult;
}

/**
 * Check Laya Daemon health
 */
export async function checkHealth(signal?: AbortSignal): Promise<{ ready: boolean; status?: string }> {
  const resp = await fetch(`${DAEMON_URL}/health`, { method: "GET", signal });
  if (!resp.ok) return { ready: false, status: `HTTP ${resp.status}` };
  return (await resp.json()) as { ready: boolean; status?: string };
}

/**
 * Resolve Obsidian Vault Root directory
 */
export function resolveVaultRoot(cwd: string, requested?: string): string | null {
  if (requested) {
    const candidate = path.resolve(cwd, requested);
    if (fs.existsSync(candidate)) return candidate;
  }
  let cur = cwd;
  for (let i = 0; i < 6; i++) {
    const directVault = path.resolve(cur, "Vaults", "AI");
    if (fs.existsSync(directVault)) return directVault;
    const subVault = path.resolve(cur, "Obsidian-AI", "Vaults", "AI");
    if (fs.existsSync(subVault)) return subVault;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

export function unqualifiedLinks(markdown: string): string[] {
  const links = [...markdown.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((m) => m[1].trim());
  return [...new Set(links.filter((target) => target && !target.includes("/") && !target.startsWith("#")))];
}

export function protocolProblems(markdown: string): string[] {
  const problems: string[] = [];
  if (!/^---\s*\r?\n[\s\S]*?\r?\n---/m.test(markdown)) problems.push("missing YAML frontmatter");
  if (!/#+\s+(?:1[.: ]+)?Context\s*(?:&|and)\s*Objective/i.test(markdown)) problems.push("missing Context & Objective section");
  if (!/#+\s+(?:3[.: ]+)?Discovered Knowledge/i.test(markdown)) problems.push("missing Discovered Knowledge section");
  if (!/(?:state_mutations|state mutations)/i.test(markdown)) problems.push("missing state_mutations telemetry");
  return problems;
}

export function formatRow(file: string, triage: TriageResult): string {
  const action = triage.flag_adr ? "[TRIGGER ADR]" : triage.compliance_score >= 1 ? "[PASS]" : "[REVIEW]";
  return `| ${file} | ${triage.p_needs_adr.toFixed(2)} | ${triage.p_has_gotcha.toFixed(2)} | ${triage.root_cause} | ${triage.compliance_score >= 1 ? "PASS" : "FAIL"} | ${action} |`;
}

export default function (pi: ExtensionAPI) {
  // 1. Session start status check
  pi.on("session_start", async (_event, ctx) => {
    try {
      const health = await checkHealth();
      ctx.ui?.setStatus?.("laya", health.ready ? "Laya: ready" : "Laya: warming up");
    } catch {
      ctx.ui?.setStatus?.("laya", "Laya: offline");
    }
  });

  // 2. CQRS State Barrier (tool_call)
  // Rejects writes/edits to State_<Project_ID>.md if line count > 150
  pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | void> => {
    const input = (event.input || {}) as Record<string, unknown>;
    const targetPath = extractTargetPath(input);
    if (!targetPath || !STATE_NOTE_REGEX.test(targetPath)) {
      return;
    }

    const lineCount = calculateProposedLines(targetPath, ctx.cwd, event.toolName, input);
    if (lineCount !== null && lineCount > STATE_LINE_LIMIT) {
      const fileName = path.basename(targetPath);
      return {
        block: true,
        reason: `[CQRS Write Barrier] State notes are limited to ${STATE_LINE_LIMIT} lines to preserve tight bounded context. Proposed write to '${fileName}' has ${lineCount} lines. Please compress, summarize, or archive older entries into Event/Topic notes.`,
      };
    }
  });

  // 3. Automatic Laya Sidecar Generation (tool_result)
  // On successful active session note write, generates <session>.md.triage.json
  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;

    const input = (event.input || {}) as Record<string, unknown>;
    const targetPath = extractTargetPath(input);
    if (!targetPath || !ACTIVE_SESSION_REGEX.test(targetPath)) {
      return;
    }

    const fullPath = path.isAbsolute(targetPath) ? targetPath : path.resolve(ctx.cwd, targetPath);
    if (!fs.existsSync(fullPath)) return;

    try {
      const markdown = await fs.promises.readFile(fullPath, "utf8");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);

      try {
        const result = await triageMarkdown(markdown, controller.signal);
        const sidecarPath = `${fullPath}.triage.json`;
        await fs.promises.writeFile(sidecarPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
        const base = path.basename(fullPath);
        const statusBadge = result.flag_adr ? " [TRIGGER ADR]" : result.compliance_score >= 1 ? " [PASS]" : " [REVIEW]";
        ctx.ui?.setStatus?.("laya", `Laya: ${result.compliance_score >= 1 ? "pass" : "review"}`);
        ctx.ui?.notify?.(`[Laya] Triage sidecar generated: ${base}.triage.json${statusBadge}`, "info");
      } catch {
        ctx.ui?.setStatus?.("laya", "Laya: unavailable");
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Non-blocking
    }
  });

  // 4. Register LLM Tool: obsidian_laya_triage
  pi.registerTool({
    name: "obsidian_laya_triage",
    label: "Obsidian Laya Triage",
    description: "Triage every pending active session for one project through the local Laya daemon without adding session Markdown to LLM context.",
    parameters: Type.Object({
      projectId: Type.String({ description: "Project identifier, e.g. lch_Obsidian-AI or _Template" }),
      vaultRoot: Type.Optional(Type.String({ description: "Vault root; defaults to Obsidian-AI/Vaults/AI or Vaults/AI" })),
      autoWriteSidecar: Type.Optional(Type.Boolean({ description: "Write <session>.triage.json beside each session (default true)" })),
    }),
    execute: async (_id, params, signal, _update, ctx) => {
      try {
        const health = await checkHealth(signal);
        if (!health.ready) throw new Error(`daemon status is ${health.status}; wait for model warmup`);

        const vault = resolveVaultRoot(ctx.cwd, params.vaultRoot);
        if (!vault) throw new Error("Could not find Obsidian-AI vault in workspace");

        const active = path.join(vault, "Projects", params.projectId, "Sessions", "Active");
        let files: string[] = [];
        try {
          const entries = await fs.promises.readdir(active, { withFileTypes: true });
          files = entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name).sort();
        } catch {
          // Active directory may not exist
        }

        const rows = [
          "| Session File | P(ADR) | P(Gotcha) | Root Cause | Compliant | Action |",
          "|---|---:|---:|---|---|---|",
        ];

        for (const file of files) {
          const sessionPath = path.join(active, file);
          const content = await fs.promises.readFile(sessionPath, "utf8");
          const result = await triageMarkdown(content, signal);
          if (params.autoWriteSidecar !== false) {
            await fs.promises.writeFile(`${sessionPath}.triage.json`, `${JSON.stringify(result, null, 2)}\n`, "utf8");
          }
          rows.push(formatRow(file, result));
        }

        if (files.length === 0) {
          rows.push("| *(none)* | - | - | - | - | - |");
        }

        return {
          content: [{ type: "text" as const, text: rows.join("\n") }],
          details: { vault, active, count: files.length },
        };
      } catch (error: any) {
        return {
          content: [{ type: "text" as const, text: `Laya triage unavailable: ${error?.message ?? String(error)}. Start daemon at ${DAEMON_URL}.` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  // 5. Register LLM Tool: obsidian_precommit_check
  pi.registerTool({
    name: "obsidian_precommit_check",
    label: "Obsidian Pre-commit Check",
    description: "Audit a drafted active-session Markdown note for Laya protocol compliance and path-qualified wikilinks before saving it.",
    parameters: Type.Object({
      markdown: Type.String({ description: "The drafted session Markdown" }),
    }),
    execute: async (_id, params, signal) => {
      try {
        const health = await checkHealth(signal);
        if (!health.ready) throw new Error(`daemon status is ${health.status}; wait for model warmup`);

        const result = await triageMarkdown(params.markdown, signal);
        const links = unqualifiedLinks(params.markdown);
        const problems = protocolProblems(params.markdown);
        const pass = result.compliance_score >= 1 && links.length === 0 && problems.length === 0;
        const feedback = [
          `Pre-commit ${pass ? "PASS" : "REVIEW"}: compliance ${result.compliance_score.toFixed(2)}; root cause ${result.root_cause}.`,
          links.length ? `Unqualified wikilinks: ${links.map((link) => `[[${link}]]`).join(", ")}.` : "All wikilinks are path-qualified.",
          problems.length ? `Protocol issues: ${problems.join("; ")}.` : "Frontmatter and telemetry structure present.",
        ];
        return {
          content: [{ type: "text" as const, text: feedback.join(" ") }],
          details: { ...result, unqualified_wikilinks: links, protocol_problems: problems, pass },
        };
      } catch (error: any) {
        return {
          content: [{ type: "text" as const, text: `Laya pre-commit check unavailable: ${error?.message ?? String(error)}` }],
          details: {},
          isError: true,
        };
      }
    },
  });

  // 6. Command: /laya-status
  pi.registerCommand("laya-status", {
    description: "Check status and health of the local Laya Triage daemon",
    handler: async (_args, ctx) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const start = performance.now();
        const health = await checkHealth(controller.signal);
        const latency = (performance.now() - start).toFixed(1);
        const vault = resolveVaultRoot(ctx.cwd);

        ctx.ui.notify(
          `Laya Daemon (${DAEMON_URL}): ${health.ready ? "READY" : "NOT READY"} (${latency}ms)\nVault: ${vault ?? "None found"}`,
          health.ready ? "info" : "warning"
        );
      } catch (err: any) {
        ctx.ui.notify(`Laya Daemon (${DAEMON_URL}): OFFLINE (${err.message})`, "error");
      } finally {
        clearTimeout(timer);
      }
    },
  });

  // 7. Command: /laya-triage [path or projectId]
  pi.registerCommand("laya-triage", {
    description: "Run Laya System 1 Triage on an active session or project: /laya-triage [path or projectId]",
    handler: async (argsString, ctx) => {
      const target = argsString.trim();
      const vault = resolveVaultRoot(ctx.cwd);

      // Case A: Specific file path given
      if (target && (target.endsWith(".md") || fs.existsSync(path.resolve(ctx.cwd, target)))) {
        const filePath = path.resolve(ctx.cwd, target);
        if (!fs.existsSync(filePath)) {
          ctx.ui.notify(`File not found: ${target}`, "error");
          return;
        }

        try {
          const markdown = await fs.promises.readFile(filePath, "utf8");
          const result = await triageMarkdown(markdown);
          const sidecarPath = `${filePath}.triage.json`;
          await fs.promises.writeFile(sidecarPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");

          const pass = result.compliance_score >= 1 ? "PASS" : "FAIL";
          const action = result.flag_adr ? "TRIGGER ADR" : pass === "PASS" ? "PASS" : "REVIEW";
          ctx.ui.notify(
            `Triage for ${path.basename(filePath)}:\nP(ADR): ${result.p_needs_adr.toFixed(2)} | P(Gotcha): ${result.p_has_gotcha.toFixed(2)} | Root Cause: ${result.root_cause} | ${pass} | ${action}`,
            result.flag_adr ? "warning" : "info"
          );
        } catch (err: any) {
          ctx.ui.notify(`Triage failed: ${err.message}`, "error");
        }
        return;
      }

      // Case B: Scan active sessions in project or vault
      if (!vault) {
        ctx.ui.notify("No Obsidian-AI vault found in workspace hierarchy.", "error");
        return;
      }

      try {
        const projectsDir = path.join(vault, "Projects");
        if (!fs.existsSync(projectsDir)) {
          ctx.ui.notify(`No Projects directory found in vault (${vault}).`, "warning");
          return;
        }

        let targetProjects: string[] = [];
        if (target) {
          targetProjects = [target];
        } else {
          targetProjects = (await fs.promises.readdir(projectsDir, { withFileTypes: true }))
            .filter((d) => d.isDirectory() && !d.name.startsWith("."))
            .map((d) => d.name);
        }

        let totalSessions = 0;
        let triageCount = 0;

        for (const proj of targetProjects) {
          const activeDir = path.join(projectsDir, proj, "Sessions", "Active");
          if (!fs.existsSync(activeDir)) continue;

          const entries = await fs.promises.readdir(activeDir, { withFileTypes: true });
          const mdFiles = entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name);

          for (const file of mdFiles) {
            totalSessions++;
            const fullPath = path.join(activeDir, file);
            const markdown = await fs.promises.readFile(fullPath, "utf8");
            const result = await triageMarkdown(markdown);
            await fs.promises.writeFile(`${fullPath}.triage.json`, `${JSON.stringify(result, null, 2)}\n`, "utf8");
            triageCount++;
          }
        }

        ctx.ui.notify(
          `Laya Triage complete: triaged ${triageCount} active session note(s) across ${targetProjects.length} project(s).`,
          "info"
        );
      } catch (err: any) {
        ctx.ui.notify(`Laya Triage scan failed: ${err.message}`, "error");
      }
    },
  });
}
