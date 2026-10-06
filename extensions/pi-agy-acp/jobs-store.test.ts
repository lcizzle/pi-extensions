import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpJobStore, makeJobRequest, jobIdFor, inputDigestFor } from "./acp-job-store";
const input = { prompt: "private task", promptDigest: "", cwd: process.cwd(), runId: "run", stepIndex: 0, agent: "agy-job-scout", options: { preset: "agy-scout" } };
const snapshot = { preset: "agy-scout", profiles: ["one"], model: "gemini-3.8-flash-high", permissionPolicy: "read-only" as const, instructions: "Read only", description: "Scout" };
function fixture() { const root = mkdtempSync(join(tmpdir(), "acp-job-store-")); const store = new AcpJobStore(root); return { root, store, cleanup: () => rmSync(root, { recursive: true, force: true }) }; }
function request() { const i = { ...input, promptDigest: require("node:crypto").createHash("sha256").update(input.prompt).digest("hex") }; return makeJobRequest(i, snapshot); }
test("deterministic identity binds request options and rejects mismatched prompt hash", () => {
  const r = request(); expect(r.providerJobId).toBe(jobIdFor("run", 0)); expect(r.prompt).toBe("private task");
  expect(inputDigestFor({ ...input, promptDigest: r.promptDigest, options: { preset: "agy-scout" } })).toBe(r.inputDigest);
  expect(() => makeJobRequest(input, snapshot)).toThrow(); expect(() => jobIdFor("run", -1)).toThrow();
});
test("exclusive creation is idempotent and different request identity cannot replace a job", () => {
  const f = fixture(); try {
    const r = request(); expect(f.store.create(r).created).toBe(true); expect(f.store.create(r).created).toBe(false);
    expect(() => f.store.create(makeJobRequest({ ...input, promptDigest: r.promptDigest, options: { preset: "agy-scout", profile: "other" } }, snapshot))).toThrow();
    expect(f.store.readRequest(r.providerJobId).prompt).toBe("private task");
    expect(JSON.stringify(f.store.status(r.providerJobId))).not.toContain("private task");
  } finally { f.cleanup(); }
});
test("claims never expire or steal ownership; stale status is uncertainty not stopped", () => {
  const f = fixture(); try {
    const r = request(); f.store.create(r); f.store.claim(r.providerJobId);
    expect(() => f.store.claim(r.providerJobId)).toThrow();
    f.store.checkpoint(r.providerJobId, "dispatch-intent", true, 1);
    const recovered = new AcpJobStore(f.root).status(r.providerJobId, 100000);
    expect(recovered.state).toBe("blocked"); expect(recovered.failureCode).toBe("JOB_UNCERTAIN");
    expect(f.store.readStatus(r.providerJobId).dispatchIntent).toBe(true);
    expect(() => f.store.claim(r.providerJobId)).toThrow();
  } finally { f.cleanup(); }
});
function terminal(r: ReturnType<typeof request>) {
  return { version: 1 as const, jobId: r.providerJobId, sessionId: "session", agent: r.preset, requested: { profile: null, model: null, mode: null }, effective: { profile: "one", model: r.model, mode: "default", cwd: r.cwd, permissionPolicy: r.permissionPolicy, enforcement: "acp-permission-and-event-gate" as const }, status: "completed" as const, text: "answer", modelId: r.model, profile: "one", stopReason: "end_turn", isError: false, failure: null, usage: null, promptDispatched: true, attempts: 1, profilesTried: ["one"], startedAt: r.createdAt, completedAt: r.createdAt, durationMs: 0 };
}
test("terminal result recovers even without final status publication, including fresh store", () => {
  const f = fixture(); try {
    const r = request(); f.store.create(r); f.store.claim(r.providerJobId); f.store.publishResult(r.providerJobId, terminal(r));
    const next = new AcpJobStore(f.root); expect(next.status(r.providerJobId).state).toBe("completed");
    expect(JSON.parse(next.result(r.providerJobId).output!).text).toBe("answer"); expect(next.result(r.providerJobId).artifactPath).toBe(join(f.root, r.providerJobId, "result.json"));
    expect(next.readStatus(r.providerJobId).state).toBe("running");
    expect(() => next.publishResult(r.providerJobId, terminal(r))).toThrow();
    next.checkpoint(r.providerJobId, "terminal", true); expect(next.readStatus(r.providerJobId).state).toBe("completed");
    unlinkSync(join(f.root, r.providerJobId, "result.json")); expect(next.status(r.providerJobId).state).toBe("blocked");
  } finally { f.cleanup(); }
});
test("corruption/truncation, invalid IDs, symlinks and wrong-policy results fail closed", () => {
  const f = fixture(); try {
    const r = request(); f.store.create(r);
    for (const id of ["../escape", "", "acp-" + "0".repeat(65)]) expect(() => f.store.status(id)).toThrow();
    expect(() => f.store.publishResult(r.providerJobId, { ...terminal(r), agent: "agy-builder" })).toThrow();
    expect(() => f.store.publishResult(r.providerJobId, { ...terminal(r), promptDispatched: false })).toThrow();
    expect(() => f.store.publishResult(r.providerJobId, { ...terminal(r), effective: { ...terminal(r).effective, permissionPolicy: "edit-only" } })).toThrow();
    const path = join(f.root, r.providerJobId, "status.json"); writeFileSync(path, "{"); expect(() => f.store.status(r.providerJobId)).toThrow();
    unlinkSync(path); symlinkSync(f.root, path, "junction"); expect(() => f.store.status(r.providerJobId)).toThrow();
  } finally { f.cleanup(); }
});
