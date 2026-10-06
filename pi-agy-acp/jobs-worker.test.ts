import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { AcpJobStore, makeJobRequest } from "./acp-job-store";
import { runAcpJobWorker } from "./acp-job-worker";
import { createAcpRuntime, executeAcpTask } from "./pi-agy-acp";
function wire() {
  const calls: any[] = []; const child = new EventEmitter() as any;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false; child.exitCode = null;
  child.kill = () => { child.exitCode = 0; child.emit("exit", 0); }; child.stdin.on("finish", child.kill);
  child.stdin.on("data", (buf: Buffer) => { for (const line of buf.toString().trim().split("\n")) { const c = JSON.parse(line); calls.push(c); if (!c.method || !c.id) continue; queueMicrotask(() => child.stdout.write(JSON.stringify({ id: c.id, result: c.method === "session/new" ? { sessionId: "session" } : c.method === "session/prompt" ? { stopReason: "end_turn" } : {} }) + "\n")); } });
  return { calls, spawn: () => child };
}
test("checkpoint failure prevents real wire prompt dispatch", async () => {
  const scope = createAcpRuntime(), server = wire(); scope.state.spawnProcess = server.spawn as any;
  const r = await scope.run(() => executeAcpTask({ cwd: process.cwd(), profile: "fixture", prompt: "task", onCheckpoint: () => { throw Error("disk checkpoint failed"); } }));
  expect(r.isError).toBe(true); expect(r.promptDispatched).toBe(false); expect(server.calls.some(c => c.method === "session/prompt")).toBe(false);
});
test("worker claims once, persists before execution, publishes restart-readable terminal", async () => {
  const root = mkdtempSync(join(tmpdir(), "acp-worker-")); const store = new AcpJobStore(root);
  const prompt = "task", request = makeJobRequest({ prompt, promptDigest: createHash("sha256").update(prompt).digest("hex"), cwd: process.cwd(), runId: "worker", stepIndex: 0, agent: "agy-job-scout", options: { preset: "agy-scout" } }, { preset: "agy-scout", profiles: ["one"], model: "gemini-3.8-flash-high", permissionPolicy: "read-only", instructions: "Read only", description: "Scout" });
  store.create(request);
  try {
    let executions = 0;
    await runAcpJobWorker(store.path(request.providerJobId), { execute: async (r: any) => {
      executions++; r.onCheckpoint({ stage: "dispatch-intent" }); expect(store.readStatus(request.providerJobId).dispatchIntent).toBe(true);
      const before = store.readStatus(request.providerJobId).updatedAt;
      await new Promise(resolve => setTimeout(resolve, 2100));
      expect(store.readStatus(request.providerJobId).updatedAt).toBeGreaterThan(before);
      return { version: 1, jobId: "old", sessionId: "s", agent: request.preset, requested: { profile: null, model: null, mode: null }, effective: { profile: "one", model: request.model, mode: "default", cwd: request.cwd, permissionPolicy: "read-only", enforcement: "acp-permission-and-event-gate" }, status: "completed", text: "answer", modelId: request.model, profile: "one", stopReason: "end_turn", isError: false, failure: null, usage: null, promptDispatched: true, attempts: 1, profilesTried: ["one"], startedAt: request.createdAt, completedAt: request.createdAt, durationMs: 0 };
    } });
    expect(executions).toBe(1); expect(new AcpJobStore(root).status(request.providerJobId).state).toBe("completed");
    await expect(runAcpJobWorker(store.path(request.providerJobId))).rejects.toThrow(); expect(executions).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
