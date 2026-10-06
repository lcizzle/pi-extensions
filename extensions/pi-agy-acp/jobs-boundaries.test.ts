import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AcpJobStore, makeJobRequest } from "./acp-job-store";
import { nativeWorkerLauncher } from "./acp-job-provider";
function f() {
  const root = mkdtempSync(join(tmpdir(), "acp-boundary-")), store = new AcpJobStore(root), prompt = "task";
  const r = makeJobRequest({ prompt, promptDigest: createHash("sha256").update(prompt).digest("hex"), cwd: root, runId: "boundary", stepIndex: 0, agent: "agy-job-scout", options: { preset: "agy-scout" } }, { preset: "agy-scout", profiles: ["unavailable"], model: "gemini-pro-agent", permissionPolicy: "read-only", instructions: "Read only", description: "Scout" }); store.create(r);
  const result = { version: 1 as const, jobId: r.providerJobId, sessionId: "s", agent: r.preset, requested: { profile: null, model: null, mode: null }, effective: { profile: "unavailable", model: r.model, mode: "default", cwd: root, permissionPolicy: "read-only" as const, enforcement: "acp-permission-and-event-gate" as const }, status: "completed" as const, text: "answer", modelId: r.model, profile: "unavailable", stopReason: "end_turn", isError: false, failure: null, usage: null, promptDispatched: true, attempts: 1, profilesTried: ["unavailable"], startedAt: r.createdAt, completedAt: r.createdAt, durationMs: 0 };
  return { root, store, r, result, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
for (const [status, expected] of [["incomplete", "failed"], ["failed", "failed"], ["aborted", "stopped"], ["blocked", "blocked"]] as const) test(`remote ${status} maps to ${expected} without false success`, () => {
  const t = f(); try { t.store.publishResult(t.r.providerJobId, { ...t.result, status, isError: true, failure: { code: status === "incomplete" ? "TOKEN_LIMIT" : status === "aborted" ? "ABORTED" : "ACP_FAILED", message: "failure" } }); expect(t.store.status(t.r.providerJobId).state).toBe(expected); }
  finally { t.cleanup(); }
});
test("encoded request must fit the persisted read bound before allocation", () => {
  const t = f(); try { const prompt = "\u0000".repeat(450000); expect(() => makeJobRequest({ prompt, promptDigest: createHash("sha256").update(prompt).digest("hex"), cwd: t.root, runId: "encoded", stepIndex: 0, agent: "agy-job-scout", options: { preset: "agy-scout" } }, { preset: "agy-scout", profiles: ["one"], model: t.r.model, permissionPolicy: "read-only", instructions: "Read", description: "Scout" })).toThrow(); }
  finally { t.cleanup(); }
});
test("large outputs return bounded notice and full artifact; oversized/corrupt records reject", () => {
  const t = f(); try {
    expect(() => t.store.publishResult(t.r.providerJobId, { ...t.result, text: "x".repeat(9 * 1024 * 1024) })).toThrow();
    t.store.publishResult(t.r.providerJobId, { ...t.result, text: "x".repeat(1024 * 1024) }); const r = t.store.result(t.r.providerJobId); expect(r.output!.length).toBeLessThan(1000); expect(r.artifactPath).toBeDefined();
    writeFileSync(join(t.root, t.r.providerJobId, "result.json"), '{"version":2}'); expect(() => t.store.status(t.r.providerJobId)).toThrow();
  } finally { t.cleanup(); }
});
test("native worker launch is exercised safely with empty fake auth home (no mgw prompt)", async () => {
  const t = f(), previous = process.env.MGWCLI_HOME; process.env.MGWCLI_HOME = join(t.root, "empty-home");
  try {
    await nativeWorkerLauncher().launch(t.store.path(t.r.providerJobId), t.root);
    let handle = t.store.status(t.r.providerJobId), deadline = Date.now() + 15000;
    while (["queued", "running"].includes(handle.state) && Date.now() < deadline) { await new Promise(r => setTimeout(r, 50)); handle = t.store.status(t.r.providerJobId); }
    expect(handle.state).toBe("blocked"); expect(handle.failureCode).toBe("PROFILE_POOL_EXHAUSTED"); expect(JSON.parse(t.store.result(t.r.providerJobId).output!).promptDispatched).toBe(false); expect(JSON.parse(t.store.result(t.r.providerJobId).output!).modelId).toBe(t.r.model);
  } finally { if (previous === undefined) delete process.env.MGWCLI_HOME; else process.env.MGWCLI_HOME = previous; for (let i = 0; i < 20; i++) { try { t.cleanup(); break; } catch (e) { if (e.code === 'EBUSY') await new Promise(r => setTimeout(r, 50)); else throw e; } } }
}, 20000);
