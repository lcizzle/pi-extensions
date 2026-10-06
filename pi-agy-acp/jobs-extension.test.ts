import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { Value } from "typebox/value";
import jobsExtension, { acquireAcpJobProvider } from "./acp-external-jobs";
import { getExternalJobProvider } from "pi-subagents/external-job-provider";
test("session registrations refcount siblings, stale disposer and reload safely", () => {
  const root = mkdtempSync(join(tmpdir(), "acp-registration-"));
  const a = acquireAcpJobProvider(root), b = acquireAcpJobProvider(root), first = getExternalJobProvider("agy-acp");
  try { a(); a(); expect(getExternalJobProvider("agy-acp")).toBe(first); b(); expect(getExternalJobProvider("agy-acp")).toBeUndefined(); const c = acquireAcpJobProvider(root); a(); expect(getExternalJobProvider("agy-acp")).toBeDefined(); c(); }
  finally { a(); b(); rmSync(root, { recursive: true, force: true }); }
});
test("job inspector schema carries lookup failures without launching workers", async () => {
  let tool: any; const events = new Map<string, any>();
  jobsExtension({ registerTool: (t: any) => { tool = t; }, on: (name: string, cb: any) => events.set(name, cb) } as any);
  const result = await tool.execute("id", { id: "acp-" + "0".repeat(64), action: "status" });
  expect(result.isError).toBe(true); expect(result.structuredContent.state).toBe("blocked"); expect(Value.Check(tool.outputSchema, result.structuredContent)).toBe(true); expect(result.details).toEqual(result.structuredContent);
  const root = mkdtempSync(join(tmpdir(), "acp-lifecycle-")), previous = process.env.PI_AGY_JOB_ROOT; process.env.PI_AGY_JOB_ROOT = root;
  try {
    events.get("session_start")(); expect(getExternalJobProvider("agy-acp")).toBeDefined();
    await tool.execute("id", { id: "acp-" + "0".repeat(64), action: "result" });
    await tool.execute("id", { id: "acp-" + "0".repeat(64), action: "reattach" });
    expect(() => acquireAcpJobProvider(join(root, "other"))).toThrow();
    events.get("session_start")(); expect(getExternalJobProvider("agy-acp")).toBeDefined();
    events.get("session_shutdown")(); expect(getExternalJobProvider("agy-acp")).toBeUndefined();
  } finally { events.get("session_shutdown")(); if (previous === undefined) delete process.env.PI_AGY_JOB_ROOT; else process.env.PI_AGY_JOB_ROOT = previous; rmSync(root, { recursive: true, force: true }); }
});
test.skipIf(!process.env.PI_SUBAGENTS_ROOT)("real package discovery accepts external jobs alongside native wrappers", async () => {
  const { discoverAgents } = await import(pathToFileURL(join(process.env.PI_SUBAGENTS_ROOT!, "src/agents/agents.js")).href);
  const cwd = mkdtempSync(join(tmpdir(), "acp-external-agents-")), fs = require("node:fs"), previous = process.env.PI_CODING_AGENT_DIR;
  fs.mkdirSync(join(cwd, ".pi")); fs.mkdirSync(join(cwd, "user")); process.env.PI_CODING_AGENT_DIR = join(cwd, "user"); fs.writeFileSync(join(cwd, ".pi/settings.json"), JSON.stringify({ packages: [dirname(import.meta.path)] }));
  try {
    const found = discoverAgents(cwd, "project"); expect(found.agentDiagnostics).toEqual([]);
    for (const role of ["builder", "reviewer", "scout"]) { const a = found.agents.find((a: any) => a.name === `agy-job-${role}`); expect(a.runner).toEqual({ type: "external-job", provider: "agy-acp", options: { preset: `agy-${role}` } }); expect(a.defaultAsync).toBe(true); }
  } finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(cwd, { recursive: true, force: true }); }
});
