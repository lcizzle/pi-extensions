import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import extension, { decideAcpPermission, autoRecoverProfileLease, createAcpRuntime, withProfileOperation, getSessionCachePath, PersistentAcpManager, executeAcpTask, setActiveMode, getActiveMode, buildPromptFromContext, buildLatestTurnPromptBlocks } from "./pi-agy-acp";
const previousHome = process.env.MGWCLI_HOME;
const home = mkdtempSync(join(tmpdir(), "acp-hardening-"));
beforeAll(() => { process.env.MGWCLI_HOME = home; });
afterAll(() => { if (previousHome === undefined) delete process.env.MGWCLI_HOME; else process.env.MGWCLI_HOME = previousHome; rmSync(home, { recursive: true, force: true }); });

const options = [{ optionId: "yes", kind: "allow_once" }, { optionId: "always", kind: "allow_always" }, { optionId: "no", kind: "reject_once" }];
describe("fail-closed permissions", () => {
  test("default and unknown modes never approve headless", async () => {
    for (const mode of ["default", "invalid", "auto_edit"]) {
      expect(await decideAcpPermission(mode, { sessionId: "s", toolCall: { toolCallId: "t", kind: "execute" }, options })).toBe("no");
    }
  });
  test("auto_edit grants only classified edits once; yolo grants explicitly", async () => {
    const request = { sessionId: "s", toolCall: { toolCallId: "t", kind: "edit" }, options };
    expect(await decideAcpPermission("auto_edit", request)).toBe("yes");
    expect(await decideAcpPermission("yolo", request)).toBe("always");
    expect(await decideAcpPermission("default", request, async () => true)).toBe("yes");
    expect(await decideAcpPermission("default", request, async () => false)).toBe("no");
    expect(await decideAcpPermission("default", request, async () => { throw Error("UI unavailable"); })).toBe("no");
  });
  test("ambiguous permission options never receive an implicit grant", async () => {
    expect(await decideAcpPermission("yolo", { sessionId: "s", toolCall: { toolCallId: "t" }, options: [{ optionId: "proceed" }] })).toBeUndefined();
  });
});

describe("ownership and isolation", () => {
  test("lease recovery never deletes a dead/corrupt managed record", () => {
    const home = mkdtempSync(join(tmpdir(), "acp-lease-"));
    const old = process.env.MGWCLI_HOME;
    process.env.MGWCLI_HOME = home;
    try {
      const fs = require("node:fs");
      fs.mkdirSync(join(home, ".acp-profile-owners"));
      const path = join(home, ".acp-profile-owners", createHash("sha256").update("TEST").digest("hex") + ".json");
      for (const data of ["not json", JSON.stringify({ version: 2, phase: "active", supervisor: { pid: 99999999 }, child: { pid: 99999998 } })]) {
        writeFileSync(path, data);
        expect(autoRecoverProfileLease("test").recovered).toBe(false);
        expect(readFileSync(path, "utf8")).toBe(data);
      }
    } finally { if (old === undefined) delete process.env.MGWCLI_HOME; else process.env.MGWCLI_HOME = old; rmSync(home, { recursive: true, force: true }); }
  });
  test("cache separates Pi sessions and profiles, normalizes cwd aliases", () => {
    const a = createAcpRuntime(); const b = createAcpRuntime();
    a.state.sessionId = "parent"; b.state.sessionId = "child";
    a.state.activeProfileState = "one"; b.state.activeProfileState = "one";
    const first = a.run(() => getSessionCachePath("D:/Projects/work"));
    expect(b.run(() => getSessionCachePath("D:/Projects/work"))).not.toBe(first);
    a.state.activeProfileState = "two";
    expect(a.run(() => getSessionCachePath("D:/Projects/work"))).not.toBe(first);
    a.state.activeProfileState = "one";
    expect(a.run(() => getSessionCachePath("D:\\Projects\\work\\."))).toBe(first);
  });
  test("same-profile operations serialize; an aborted queued task cannot dispatch", async () => {
    let release!: () => void; let active = false; let dispatched = false;
    let markStarted!: () => void;
    const started = new Promise<void>(r => { markStarted = r; });
    const first = withProfileOperation("queue-test", undefined, async () => { active = true; await new Promise<void>(r => { release = r; markStarted(); }); active = false; });
    await started;
    const controller = new AbortController();
    const second = withProfileOperation("QUEUE-TEST", controller.signal, async () => { dispatched = true; expect(active).toBe(false); });
    const observed = second.catch(error => error);
    controller.abort(); release(); await first;
    expect((await observed).message).toContain("abort");
    expect(dispatched).toBe(false);
    await withProfileOperation("queue-test", undefined, async () => { dispatched = true; });
    expect(dispatched).toBe(true);
  });
});

function fakeProcess() {
  const child = new EventEmitter() as any;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.killed = false; child.exitCode = null;
  child.kill = () => { child.killed = true; child.exitCode = 0; child.emit("exit", 0); };
  child.stdin.on("finish", () => child.kill());
  return child;
}
function harness(failMethod?: string, hangPrompt = false) {
  const calls: any[] = []; const children: any[] = [];
  let sequence = 0;
  const spawn = () => {
    const child = fakeProcess(); children.push(child);
    child.stdin.on("data", (data: Buffer) => {
      for (const line of data.toString().trim().split("\n")) {
        const call = JSON.parse(line); calls.push(call);
        if (!call.method || call.id === undefined) continue;
        queueMicrotask(() => {
          if (call.method === failMethod) { child.stdout.write(JSON.stringify({ id: call.id, error: { message: "RESOURCE_EXHAUSTED" } }) + "\n"); return; }
          let result: any = {};
          if (call.method === "session/new") result = { sessionId: `s-${++sequence}` };
          if (call.method === "session/prompt") {
            if (hangPrompt) return;
            const update = (sessionId: string, text: string) => child.stdout.write(JSON.stringify({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { text } } } }) + "\n");
            update("wrong-session", "LEAK"); update(call.params.sessionId, "answer");
            result = { stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
          }
          child.stdout.write(JSON.stringify({ id: call.id, result }) + "\n");
        });
      }
    });
    return child;
  };
  return { spawn, calls, children };
}

describe("integrated isolation and execution", () => {
  test("delegated tasks use one protocol path and ignore wrong-session updates", async () => {
    const scope = createAcpRuntime(); const server = harness();
    (scope.state as any).spawnProcess = server.spawn;
    const chunks: string[] = [];
    const result = await scope.run(() => executeAcpTask({ profile: "test", cwd: "D:/Projects/work", prompt: "task", onChunk: t => chunks.push(t) }));
    expect(result.text).toBe("answer"); expect(chunks).toEqual(["answer"]);
    expect(result.usage?.total).toBe(7); expect(server.children.length).toBe(1);
    expect(scope.state.globalAcpManager?.currentSessionId).toBeUndefined();
    await scope.state.globalAcpManager?.close();
  });
  test("simultaneous profile changes in one scope cannot close an active task", async () => {
    const scope = createAcpRuntime(); const server = harness();
    scope.state.spawnProcess = server.spawn as any;
    const results = await scope.run(() => Promise.all([
      executeAcpTask({ profile: "parallel-one", cwd: "D:/Projects/work", prompt: "one" }),
      executeAcpTask({ profile: "parallel-two", cwd: "D:/Projects/work", prompt: "two" }),
    ]));
    expect(results.map(r => r.text)).toEqual(["answer", "answer"]);
    const methods = server.calls.filter(c => ["session/prompt", "session/close"].includes(c.method));
    expect(methods.map(c => c.method)).toEqual(["session/prompt", "session/close", "session/prompt", "session/close"]);
    await scope.state.globalAcpManager?.close();
  });
  test("different runtimes hand off the same profile only after the previous task ends", async () => {
    const a = createAcpRuntime(); const b = createAcpRuntime(); const server = harness();
    a.state.spawnProcess = server.spawn as any; b.state.spawnProcess = server.spawn as any;
    const results = await Promise.all([
      a.run(() => executeAcpTask({ profile: "shared-test", cwd: "D:/Projects/a", prompt: "a" })),
      b.run(() => executeAcpTask({ profile: "shared-test", cwd: "D:/Projects/b", prompt: "b" })),
    ]);
    expect(results.map(r => r.text)).toEqual(["answer", "answer"]);
    expect(server.children[0].exitCode).toBe(0);
    await b.state.globalAcpManager?.close();
  });
  test("delegated usage does not mutate primary conversation counters", async () => {
    const server = harness();
    const manager = new PersistentAcpManager("metrics", "D:/Projects/work", server.spawn as any);
    await manager.ensureSession("gemini-3.8-flash-high", "default", true);
    const primaryId = manager.currentSessionId;
    manager.cumulativeInputTokens = 30; manager.cumulativeOutputTokens = 10; manager.cumulativeTotalTokens = 40;
    const result = await manager.prompt([{ type: "text", text: "task" }], undefined, {}, { id: "task-metrics", mode: "default" });
    expect(result.usage.total).toBe(7);
    expect(manager.currentSessionId).toBe(primaryId);
    expect(manager.cumulativeInputTokens).toBe(30); expect(manager.cumulativeOutputTokens).toBe(10); expect(manager.cumulativeTotalTokens).toBe(40);
    expect(manager.sessionTurnCount).toBe(0); await manager.close();
  });
  test("model failure cannot dispatch or silently fall back", async () => {
    const scope = createAcpRuntime(); const server = harness("session/set_config_option");
    (scope.state as any).spawnProcess = server.spawn; scope.state.autoSwitchEnabledState = false;
    const result = await scope.run(() => executeAcpTask({ profile: "test-config", cwd: "D:/Projects/work", prompt: "task" }));
    expect(result.isError).toBe(true); expect(result.promptDispatched).toBe(false);
    expect(server.children.length).toBe(1); expect(server.calls.some(c => c.method === "session/prompt")).toBe(false);
  });
  test("quota failure after dispatch cannot replay a potentially mutating task", async () => {
    const scope = createAcpRuntime(); const server = harness("session/prompt");
    (scope.state as any).spawnProcess = server.spawn;
    const result = await scope.run(() => executeAcpTask({ profile: "test-quota", cwd: "D:/Projects/work", prompt: "task" }));
    expect(result.isError).toBe(true); expect(result.promptDispatched).toBe(true);
    expect(server.calls.filter(c => c.method === "session/prompt").length).toBe(1);
    expect(server.children.length).toBe(1);
  });
  test("runtime modes and caches do not leak across simultaneous scopes", async () => {
    const a = createAcpRuntime(); const b = createAcpRuntime();
    a.run(() => setActiveMode("yolo")); b.run(() => setActiveMode("default"));
    expect(a.run(getActiveMode)).toBe("yolo"); expect(b.run(getActiveMode)).toBe("default");
  });
  test("session shutdown aborts queued work and closes only its bound manager", async () => {
    const events = new Map<string, any>(); const providers = new Map<string, any>();
    const host: any = { registerCommand() {}, registerTool() {}, registerProvider: (name: string, provider: any) => providers.set(name, provider), on: (name: string, handler: any) => events.set(name, handler) };
    extension(host);
    const ctx: any = { cwd: "D:/Projects/child", hasUI: false, ui: { setStatus() {} }, sessionManager: { getSessionId: () => "child-identity" } };
    await events.get("session_start")({}, ctx);
    await events.get("session_shutdown")({}, ctx);
    const model: any = { id: "gemini-3.8-flash-high", api: "antigravity-acp", provider: "antigravity" };
    const output = await providers.get("antigravity").streamSimple(model, { messages: [{ role: "user", content: "task" }] }).result();
    expect(output.stopReason).toBe("aborted");
  });
});

describe("instruction isolation", () => {
  test("single-user optimization cannot drop system instructions", () => {
    const prompt = buildPromptFromContext({ messages: [{ role: "system", content: "Do not modify protected files", timestamp: 0 }, { role: "user", content: "Fix bug" }] } as any);
    expect(prompt).toContain("Do not modify protected files");
    expect(prompt).toContain("Fix bug");
  });
  test("ongoing turns preserve new system instructions", () => {
    const blocks = buildLatestTurnPromptBlocks({ messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }, { role: "system", content: "Now read-only", timestamp: 0 }, { role: "user", content: "Review" }] } as any);
    expect(blocks[0].text).toContain("Now read-only");
  });
});

describe("RPC lifecycle", () => {
  test("closing a manager rejects pending requests and is idempotent", async () => {
    const manager = new PersistentAcpManager("test", "D:/Projects/work");
    manager.child = fakeProcess();
    const pending = manager.sendRpc("test", {}, 10000);
    const observed = pending.catch(error => error);
    await manager.close(); expect((await observed).message).toContain("closed"); await manager.close();
    expect(manager.isAlive()).toBe(false);
  });
  test("timeout sends cancellation and removes the response callback", async () => {
    const manager = new PersistentAcpManager("timeout", "D:/Projects/work");
    const child = fakeProcess(); manager.child = child;
    const writes: string[] = []; child.stdin.on("data", (d: Buffer) => writes.push(d.toString()));
    await expect(manager.sendRpc("session/prompt", { sessionId: "task-timeout" }, 10)).rejects.toThrow("timed out");
    expect(writes.some(x => x.includes("session/cancel") && x.includes("task-timeout"))).toBe(true);
    expect((manager as any).responses.size).toBe(0); await manager.close();
  });
  test("process exit settles a real pending prompt without waiting for timeout", async () => {
    const server = harness(undefined, true);
    const manager = new PersistentAcpManager("exit", "D:/Projects/work", server.spawn as any);
    await manager.ensureSession("gemini-3.8-flash-high", "default", true);
    const pending = manager.prompt([{ type: "text", text: "task" }]).catch(error => error);
    server.children[0].kill();
    expect((await pending).message).toContain("exited");
    expect(manager.isBusy).toBe(false); await manager.close();
  });
  test("abort cancels the delegated session, not the primary conversation", async () => {
    const server = harness(undefined, true);
    const manager = new PersistentAcpManager("abort", "D:/Projects/work", server.spawn as any);
    await manager.ensureSession("gemini-3.8-flash-high", "default", true);
    const controller = new AbortController();
    const pending = manager.prompt([{ type: "text", text: "task" }], controller.signal, {}, { id: "delegated", mode: "default" }).catch(error => error);
    controller.abort(); expect((await pending).message).toContain("aborted");
    expect(server.calls.some(c => c.method === "session/cancel" && c.params.sessionId === "delegated")).toBe(true);
    expect(manager.isAlive()).toBe(false);
  });
  test("uncertain cleanup remains sticky and cannot reopen ownership", async () => {
    const manager = new PersistentAcpManager("uncertain", "D:/Projects/work");
    const child = new EventEmitter() as any;
    child.exitCode = null; child.killed = false; child.stdin = { end() {} }; child.kill = () => true;
    manager.child = child;
    await expect(manager.close()).rejects.toThrow("cleanup uncertain");
    await expect(manager.close()).rejects.toThrow("cleanup uncertain");
  }, 8000);
  test("failed configuration is not reported as applied", async () => {
    const manager = new PersistentAcpManager("test", "D:/Projects/work");
    manager.child = fakeProcess(); manager.currentSessionId = "existing";
    manager.sendRpc = async (method: string) => { if (method === "session/set_config_option") throw Error("unsupported model"); return {}; };
    await expect(manager.ensureSession("unknown", "default")).rejects.toThrow("unsupported model");
    expect(manager.currentModelId).toBeUndefined(); await manager.close();
  });
});
