import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { Value } from "typebox/value";
import extension, { createAcpRuntime, executeAcpTask, PersistentAcpManager, withProfileOperation, getActiveProfile, ACP_MODELS, resolveScoutWorkspaceRoot } from "./pi-agy-acp";
import { AcpTaskResultSchema } from "./acp-results";
import { loadAcpPresets } from "./acp-presets";
const home = mkdtempSync(join(tmpdir(), "acp-presets-wire-"));
const oldHome = process.env.MGWCLI_HOME;
beforeAll(() => {
  process.env.MGWCLI_HOME = home;
  for (const name of ["one", "two", "outside"]) {
    const path = join(home, "profiles", name); mkdirSync(join(path, "acp-home", "antigravity-acp"), { recursive: true });
    writeFileSync(join(path, "profile.json"), JSON.stringify({ type: "shared" })); writeFileSync(join(path, "acp-home", "antigravity-acp", "acp_token.json"), "{}");
  }
});
afterAll(() => { if (oldHome === undefined) delete process.env.MGWCLI_HOME; else process.env.MGWCLI_HOME = oldHome; rmSync(home, { recursive: true, force: true }); });
type Behavior = { fail?: (call: any, profile: string) => string | undefined; stop?: string; usage?: unknown; action?: "permission" | "event" | "update"; kind?: string; hang?: boolean; onPrompt?: () => void; exit?: boolean };
function wire(behavior: Behavior = {}) {
  const calls: any[] = [], children: any[] = [];
  let session = 0;
  function spawn(_exe: string, args: string[]) {
    const profile = args[3]; const child = new EventEmitter() as any; children.push(child);
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false; child.exitCode = null;
    child.kill = () => { child.killed = true; child.exitCode = 0; child.emit("exit", 0); };
    child.stdin.on("finish", child.kill);
    const emit = (msg: any) => child.stdout.write(JSON.stringify(msg) + "\n");
    let pending: any;
    const finish = (call: any) => emit({ id: call.id, result: { stopReason: behavior.stop ?? "end_turn", ...(behavior.usage === undefined ? {} : { usage: behavior.usage }) } });
    child.stdin.on("data", (data: Buffer) => {
      for (const line of data.toString().trim().split("\n")) {
        const c = JSON.parse(line); calls.push({ ...c, profile });
        if (!c.method) { if (pending && c.id === "permission-1") { const saved = pending; pending = undefined; queueMicrotask(() => finish(saved)); } continue; }
        if (c.id === undefined) continue;
        queueMicrotask(() => {
          const failure = behavior.fail?.(c, profile);
          if (failure) { emit({ id: c.id, error: { message: failure } }); return; }
          if (c.method === "session/prompt") {
            emit({ method: "session/update", params: { sessionId: "wrong", update: { sessionUpdate: "tool_call", toolCallId: "wrong", kind: "execute" } } });
            emit({ method: "session/update", params: { sessionId: c.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { text: "partial answer" } } } });
            behavior.onPrompt?.();
            if (behavior.exit) { child.kill(); return; }
            if (behavior.hang) return;
            if (behavior.action === "permission") {
              pending = c;
              emit({ id: "permission-1", method: "session/request_permission", params: { sessionId: c.params.sessionId, toolCall: { toolCallId: "t", kind: behavior.kind }, options: [{ optionId: "yes", kind: "allow_once" }, { optionId: "always", kind: "allow_always" }, { optionId: "no", kind: "reject_once" }] } });
            } else {
              if (behavior.action) {
                emit({ method: "session/update", params: { sessionId: c.params.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "t", kind: behavior.kind } } });
                if (behavior.action === "update") emit({ method: "session/update", params: { sessionId: c.params.sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed" } } });
              }
              finish(c);
            }
            return;
          }
          emit({ id: c.id, result: c.method === "session/new" ? { sessionId: `task-${++session}` } : {} });
        });
      }
    });
    return child;
  }
  return { spawn, calls, children };
}
function scopeFor(server: ReturnType<typeof wire>) { const scope = createAcpRuntime(); scope.state.activeProfileState = "one"; scope.state.spawnProcess = server.spawn as any; return scope; }
function valid(result: unknown) { expect(Value.Check(AcpTaskResultSchema, JSON.parse(JSON.stringify(result)))).toBe(true); }
const task = { agent: "agy-reviewer", cwd: home, prompt: "Review; do not mutate" };
test("scout workspace root must be absolute, existing, and disjoint from the parent workspace", () => {
  const target = mkdtempSync(join(tmpdir(), "acp-scout-workspace-"));
  try {
    expect(resolveScoutWorkspaceRoot(target, home)).toBe(target);
    expect(() => resolveScoutWorkspaceRoot("relative/path", home)).toThrow(/absolute path/);
    expect(() => resolveScoutWorkspaceRoot(tmpdir(), home)).toThrow(/separate from the parent workspace/);
    mkdirSync(join(home, "nested"));
    expect(() => resolveScoutWorkspaceRoot(join(home, "nested"), home)).toThrow(/separate from the parent workspace/);
    expect(() => resolveScoutWorkspaceRoot(join(target, "missing"), home)).toThrow();
  } finally { rmSync(target, { recursive: true, force: true }); }
});
test("explicit scout workspace disables that repository's project MCP servers", async () => {
  const target = mkdtempSync(join(tmpdir(), "acp-scout-workspace-"));
  writeFileSync(join(target, ".mcp.json"), JSON.stringify({ mcpServers: { obsidian: { command: "vault-server" } } }));
  const server = wire(); const scope = scopeFor(server);
  try {
    const result = await scope.run(() => executeAcpTask({ ...task, agent: "agy-scout", workspaceRoot: target }));
    valid(result);
    expect(result.status).toBe("completed");
    expect(result.effective.cwd).toBe(target);
    const sessions = server.calls.filter(call => call.method === "session/new");
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every(call => call.params.cwd === target && Array.isArray(call.params.mcpServers) && call.params.mcpServers.length === 0)).toBe(true);
  } finally { await scope.state.globalAcpManager?.close(); rmSync(target, { recursive: true, force: true }); }
});
test("workspace root is rejected for non-scout presets", async () => {
  const target = mkdtempSync(join(tmpdir(), "acp-scout-workspace-"));
  const scope = scopeFor(wire());
  try {
    const result = await scope.run(() => executeAcpTask({ ...task, workspaceRoot: target }));
    valid(result);
    expect(result.failure?.code).toBe("PRESET_OVERRIDE_FORBIDDEN");
  } finally { await scope.state.globalAcpManager?.close(); rmSync(target, { recursive: true, force: true }); }
});
test("invalid scout workspace root fails before dispatch", async () => {
  const scope = scopeFor(wire());
  const result = await scope.run(() => executeAcpTask({ ...task, agent: "agy-scout", workspaceRoot: "relative/path" }));
  valid(result);
  expect(result.failure?.code).toBe("INVALID_REQUEST");
  expect(result.attempts).toBe(0);
});
for (const [agent, kind, allowed] of [["agy-reviewer", "read", true], ["agy-reviewer", "edit", false], ["agy-scout", "execute", false], ["agy-builder", "edit", true], ["agy-builder", "delete", false], ["agy-builder", undefined, false]] as const) {
  test(`wire permission ceiling ${agent}/${kind}: ${allowed}`, async () => {
    const server = wire({ action: "permission", kind }); const scope = scopeFor(server);
    let asked = false; scope.state.lastExtensionUi = { confirm: async () => { asked = true; return true; } } as any;
    try {
      const r = await scope.run(() => executeAcpTask({ ...task, agent })); valid(r);
      expect(r.status).toBe(allowed ? "completed" : "blocked"); expect(asked).toBe(false);
      const decision = server.calls.find(c => c.id === "permission-1"); expect(decision.result.outcome.optionId).toBe(allowed ? "yes" : "no");
      expect(server.calls.filter(c => c.method === "session/set_config_option").map(c => c.params.value)).toEqual(["gemini-3.8-flash-high", "default"]);
      expect(r.effective.permissionPolicy).toBe(agent === "agy-builder" ? "edit-only" : "read-only"); expect(r.sessionId).toBe("task-1");
    } finally { await scope.state.globalAcpManager?.close(); }
  });
}
test("observed prohibited tool action cancels and blocks, retaining partial output", async () => {
  const server = wire({ action: "event", kind: "edit" }); const scope = scopeFor(server);
  const r = await scope.run(() => executeAcpTask(task)); valid(r);
  expect(r.failure?.code).toBe("CEILING_VIOLATION_OBSERVED"); expect(r.text).toBe("partial answer"); expect(r.promptDispatched).toBe(true);
  expect(server.calls.some(c => c.method === "session/cancel" && c.params.sessionId === r.sessionId)).toBe(true);
});
test("partial tool updates inherit audited kind; read event remains permitted", async () => {
  const server = wire({ action: "update", kind: "read" }); const scope = scopeFor(server);
  try { const r = await scope.run(() => executeAcpTask(task)); valid(r); expect(r.status).toBe("completed"); }
  finally { await scope.state.globalAcpManager?.close(); }
});
test("manager policy overrides even a malicious permission callback", async () => {
  const server = wire({ action: "permission", kind: "execute" }); const scope = scopeFor(server);
  await scope.run(async () => {
    const mgr = new PersistentAcpManager("one", home, server.spawn as any); await mgr.ensureStarted(); let callback = false;
    await expect(mgr.prompt([{ type: "text", text: "task" }], undefined, { onPermissionRequest: async () => { callback = true; return "always"; } }, { id: "independent", mode: "default", permissionPolicy: "read-only" })).rejects.toThrow("CEILING_VIOLATION");
    expect(callback).toBe(false); await mgr.close();
  });
});
for (const [stop, expected] of [["max_tokens", "incomplete"], ["missing", "failed"], ["end_turn", "completed"]] as const) {
  test(`truthful terminal outcome ${stop}`, async () => {
    const server = wire({ stop, usage: { inputTokens: 5, outputTokens: 2 } }); const scope = scopeFor(server);
    try { const r = await scope.run(() => executeAcpTask(task)); valid(r); expect(r.status).toBe(expected); expect(r.isError).toBe(expected !== "completed"); expect(r.text).toBe("partial answer"); if (expected !== "failed") expect(r.usage?.source).toBe("reported"); }
    finally { await scope.state.globalAcpManager?.close(); }
  });
}
test("configuration failure records only acknowledged model, no mode, and cannot dispatch", async () => {
  const server = wire({ fail: c => c.params?.configId === "mode" ? "unsupported mode" : undefined }); const scope = scopeFor(server);
  const r = await scope.run(() => executeAcpTask(task)); valid(r); expect(r.effective.model).toBe("gemini-3.8-flash-high"); expect(r.effective.mode).toBeNull(); expect(r.promptDispatched).toBe(false);
});
test("cleanup failure retains terminal output/usage and never claims success", async () => {
  const server = wire({ usage: { input: 5, output: 2 }, fail: c => c.method === "session/close" ? "close refused" : undefined }); const scope = scopeFor(server);
  const r = await scope.run(() => executeAcpTask(task)); valid(r); expect(r.failure?.code).toBe("CLEANUP_FAILED"); expect(r.status).toBe("failed"); expect(r.usage?.total).toBe(7); expect(r.text).toBe("partial answer");
});
test("abort after dispatch is structured, preserves partial text, sends cancellation", async () => {
  const abort = new AbortController(); const server = wire({ hang: true, onPrompt: () => abort.abort() }); const scope = scopeFor(server);
  const r = await scope.run(() => executeAcpTask({ ...task, signal: abort.signal })); valid(r); expect(r.status).toBe("aborted"); expect(r.text).toBe("partial answer"); expect(r.promptDispatched).toBe(true); expect(server.calls.some(c => c.method === "session/cancel")).toBe(true);
});
test("process exit is structured failure rather than successful silence", async () => {
  const server = wire({ exit: true }); const scope = scopeFor(server);
  const r = await scope.run(() => executeAcpTask(task)); valid(r); expect(r.status).toBe("failed"); expect(r.text).toBe("partial answer"); expect(r.promptDispatched).toBe(true);
});
function pooled(scope: ReturnType<typeof createAcpRuntime>) {
  mkdirSync(join(home, ".pi"), { recursive: true });
  writeFileSync(join(home, ".pi", "agy-acp-presets.json"), JSON.stringify({ version: 1, presets: { "agy-reviewer": { profiles: ["one", "two"] } } }));
  scope.state.presetCatalog = loadAcpPresets(home, ACP_MODELS.map(m => m.id));
}
test("quota failover stays inside captured pool and never changes parent's profile", async () => {
  const server = wire({ fail: (c, p) => p === "one" && c.method === "authenticate" ? "RESOURCE_EXHAUSTED" : undefined }); const scope = scopeFor(server); pooled(scope);
  try { const r = await scope.run(() => executeAcpTask(task)); valid(r); expect(r.status).toBe("completed"); expect(r.profilesTried).toEqual(["one", "two"]); expect(r.profile).toBe("two"); expect(scope.run(getActiveProfile)).toBe("one"); expect(r.attempts).toBe(2); }
  finally { await scope.state.globalAcpManager?.close(); }
});
test("explicit profile pin cannot fail over even on quota", async () => {
  const server = wire({ fail: c => c.method === "authenticate" ? "RESOURCE_EXHAUSTED" : undefined }); const scope = scopeFor(server); pooled(scope);
  const r = await scope.run(() => executeAcpTask({ ...task, profile: "one" })); valid(r); expect(r.profilesTried).toEqual(["one"]); expect(server.children.length).toBe(1);
});
test("queued task captures preset and active profile before configuration changes", async () => {
  const server = wire(); const scope = scopeFor(server);
  let release!: () => void; let started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  const first = scope.run(() => withProfileOperation("one", undefined, async () => { await new Promise<void>(r => { release = r; started(); }); }));
  await ready;
  const pending = scope.run(() => executeAcpTask(task));
  scope.state.activeProfileState = "outside"; scope.state.presetLoadError = "config now invalid";
  release(); await first;
  try { const r = await pending; valid(r); expect(r.status).toBe("completed"); expect(r.profile).toBe("one"); }
  finally { await scope.state.globalAcpManager?.close(); }
});
test("queued cancellation returns no-spawn structured failure", async () => {
  const server = wire(); const scope = scopeFor(server); let release!: () => void, started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  const first = scope.run(() => withProfileOperation("one", undefined, async () => { await new Promise<void>(r => { release = r; started(); }); })); await ready;
  const abort = new AbortController(); const pending = scope.run(() => executeAcpTask({ ...task, signal: abort.signal })); abort.abort();
  const r = await pending; valid(r); expect(r.status).toBe("aborted"); expect(r.attempts).toBe(0); expect(server.children.length).toBe(0); release(); await first;
});
test("tool and command expose presets; schema/data parity on all early failures", async () => {
  const tools = new Map<string, any>(), commands = new Map<string, any>(), events = new Map<string, any>(), messages: any[] = [];
  const host: any = { registerCommand: (n: string, c: any) => commands.set(n, c), registerTool: (c: any) => tools.set(c.name, c), registerProvider() {}, on: (n: string, h: any) => events.set(n, h), sendMessage: async (m: any) => messages.push(m) };
  extension(host);
  const ctx: any = { cwd: home, hasUI: false, ui: { setStatus() {}, notify() {} }, sessionManager: { getSessionId: () => "tool-test" } };
  await events.get("session_start")({}, ctx);
  const catalog = await tools.get("agy_acp_agents").execute("catalog", {}, undefined, undefined, ctx); expect(catalog.details.presets.length).toBe(3);
  expect(tools.get("agy_acp_task").parameters.properties.workspaceRoot).toBeDefined();
  for (const input of [{ task: "test", agent: "missing" }, { task: "test", agent: "agy-reviewer", mode: "yolo" }, { task: "test", mode: "wrong" }]) {
    const r = await tools.get("agy_acp_task").execute("task", input, undefined, undefined, ctx);
    expect(r.isError).toBe(true); expect(Value.Check(tools.get("agy_acp_task").outputSchema, r.structuredContent)).toBe(true); expect(r.details).toEqual(r.structuredContent);
  }
  await commands.get("agy-acp").handler("--agent agy-reviewer --mode yolo test", ctx);
  expect(messages[0].details.failure.code).toBe("PRESET_OVERRIDE_FORBIDDEN"); valid(messages[0].details);
  writeFileSync(join(home, ".pi", "agy-acp-presets.json"), "invalid"); await events.get("session_start")({}, ctx);
  const broken = await tools.get("agy_acp_task").execute("task", { task: "test", agent: "agy-builder" }, undefined, undefined, ctx);
  expect(broken.structuredContent.failure.code).toBe("PRESET_CONFIG_INVALID"); valid(broken.structuredContent);
  await events.get("session_shutdown")({}, ctx);
});
