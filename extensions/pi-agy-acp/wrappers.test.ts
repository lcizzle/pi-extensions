import { test, expect } from "bun:test";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import extension from "./pi-agy-acp";
import { defaultAcpPresets } from "./acp-presets";
const root = dirname(fileURLToPath(import.meta.url));
const names = ["agy-builder", "agy-reviewer", "agy-scout"];
function manifest() { return JSON.parse(readFileSync(join(root, "package.json"), "utf8")); }
function agent(name: string) {
  const file = join(root, "agents", `${name}.md`), raw = readFileSync(file, "utf8");
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/); expect(match).not.toBeNull();
  return { file, meta: parse(match![1]), prompt: match![2] };
}
test("local package exposes explicit ACP extensions and agent directory", () => {
  const m = manifest(); expect(m.name).toBe("pi-agy-acp"); expect(m.private).toBe(true);
  expect(m.pi.extensions).toEqual(["./pi-agy-acp.ts", "./acp-external-jobs.ts"]); expect(m["pi-subagents"].agents).toEqual(["./agents"]);
  expect(m.dependencies).toEqual({ "pi-subagents": "0.75.0" }); expect(m.peerDependencies["@earendil-works/pi-coding-agent"]).toBe("*");
  for (const path of [...m.pi.extensions, ...m["pi-subagents"].agents]) expect(existsSync(join(root, path))).toBe(true);
});
for (const name of names) test(`${name} is a narrow transport with valid child-only provider and preset routing`, () => {
  const { file, meta: m, prompt } = agent(name);
  expect(m.name).toBe(name); expect(m.tools).toEqual(["agy_acp_agents", "agy_acp_task"]);
  expect(m.extensions).toBeNull(); expect(m.subagentOnlyExtensions).toEqual(["../pi-agy-acp.ts"]);
  expect(resolve(dirname(file), m.subagentOnlyExtensions[0])).toBe(join(root, "pi-agy-acp.ts"));
  expect(m.defaultContext).toBe("fresh"); expect(m.systemPromptMode).toBe("replace");
  for (const field of ["inheritProjectContext", "inheritGlobalContext", "inheritSkills", "allowNestedSubagents"]) expect(m[field]).toBe(false);
  expect(m.model).toBeUndefined(); expect(m.defaultReads).toBeUndefined(); expect(m.output).toBeUndefined();
  expect(m.acceptanceRole).toBe(name === "agy-builder" ? "writer" : "read-only");
  expect(m.mutationTools).toEqual(["agy_acp_task"]); // remote tool can mutate if prompt routing is ignored, even in reviewer wrapper
  expect(defaultAcpPresets()[name]).toBeDefined(); expect(prompt).toContain(`agent: "${name}"`);
  expect(prompt).toContain("Do not retry"); expect(prompt).toContain("structuredContent"); expect(prompt).toContain("not an OS sandbox");
  expect(prompt).toContain("unchanged"); expect(prompt).toContain("antigravity/");
});
test("wrapper allowlisted tools actually register when provider loads", () => {
  const tools = new Map<string, any>();
  extension({ registerTool: (t: any) => tools.set(t.name, t), registerCommand() {}, registerProvider() {}, on() {} } as any);
  for (const name of names) for (const tool of agent(name).meta.tools) expect(tools.has(tool)).toBe(true);
  expect(tools.get("agy_acp_task").parameters.properties.agent).toBeDefined(); expect(tools.get("agy_acp_task").outputSchema).toBeDefined();
});
test.skipIf(!process.env.PI_SUBAGENTS_ROOT)("installed pi-subagents discovers package and resolves native child launch contracts", async () => {
  const installed = process.env.PI_SUBAGENTS_ROOT!;
  const { discoverAgents } = await import(pathToFileURL(join(installed, "src/agents/agents.js")).href);
  const { resolvePiLaunchToolPlan } = await import(pathToFileURL(join(installed, "src/api/child-tool-plan.js")).href);
  const cwd = mkdtempSync(join(tmpdir(), "acp-wrapper-discovery-")), previous = process.env.PI_CODING_AGENT_DIR;
  mkdirSync(join(cwd, ".pi")); mkdirSync(join(cwd, "user")); process.env.PI_CODING_AGENT_DIR = join(cwd, "user");
  writeFileSync(join(cwd, ".pi/settings.json"), JSON.stringify({ packages: [root] }));
  try {
    const found = discoverAgents(cwd, "project");
    expect(found.agentDiagnostics).toEqual([]);
    for (const name of names) {
      const a = found.agents.find((a: any) => a.name === name); expect(a).toBeDefined();
      expect(a.source).toBe("package"); expect(a.subagentOnlyExtensions).toEqual([join(root, "pi-agy-acp.ts")]);
      expect(a.extensions).toEqual([]); expect(a.tools).toEqual(["agy_acp_agents", "agy_acp_task"]);
      const plan = resolvePiLaunchToolPlan({ ...a, agentName: name, cwd });
      expect(plan.disableAmbientExtensions).toBe(true); expect(plan.configuredExtensions).toEqual([join(root, "pi-agy-acp.ts")]);
      expect(plan.effectiveToolAllowlist).toEqual(["agy_acp_agents", "agy_acp_task"]);
      expect(plan.fanoutAuthorized).toBe(false);
    }
  } finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(cwd, { recursive: true, force: true }); }
});
