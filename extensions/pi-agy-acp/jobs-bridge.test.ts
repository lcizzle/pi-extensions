import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { registerExternalJobProvider } from "pi-subagents/external-job-provider";
import { AcpJobProvider } from "./acp-job-provider";
import { AcpJobStore } from "./acp-job-store";
import { runAcpJobWorker } from "./acp-job-worker";
test.skipIf(!process.env.PI_SUBAGENTS_ROOT)("real external runner/file bridge starts once and recovery uses reattach/result only", async () => {
  const installed = process.env.PI_SUBAGENTS_ROOT!;
  const { runExternalJob } = await import(pathToFileURL(join(installed, "src/runs/shared/external-job-runner.js")).href);
  const { serviceExternalJobBridgeRequests } = await import(pathToFileURL(join(installed, "src/runs/shared/external-job-bridge.js")).href);
  const root = mkdtempSync(join(tmpdir(), "acp-file-bridge-")), asyncDir = join(root, "async"), jobs = join(root, "jobs"); mkdirSync(asyncDir);
  const previous = process.env.MGWCLI_HOME; process.env.MGWCLI_HOME = join(root, "mgw");
  const home = join(process.env.MGWCLI_HOME, "profiles", "one"); mkdirSync(join(home, "acp-home", "antigravity-acp"), { recursive: true }); writeFileSync(join(home, "profile.json"), '{"type":"shared"}'); writeFileSync(join(home, "acp-home", "antigravity-acp", "acp_token.json"), '{}');
  let starts = 0;
  const provider = new AcpJobProvider(jobs, { check: async () => {}, launch: async dir => {
    starts++;
    await runAcpJobWorker(dir, { execute: async request => {
      request.onCheckpoint!({ stage: "dispatch-intent", sessionId: "s", profile: "one" });
      const r = new AcpJobStore(jobs).readRequest(basename(dir));
      return { version: 1, jobId: "temporary", sessionId: "s", agent: r.preset, requested: { profile: null, model: null, mode: null }, effective: { profile: "one", model: r.model, mode: "default", cwd: r.cwd, permissionPolicy: r.permissionPolicy, enforcement: "acp-permission-and-event-gate" }, status: "completed", text: "bridge answer", modelId: r.model, profile: "one", stopReason: "end_turn", isError: false, failure: null, usage: null, promptDispatched: true, attempts: 1, profilesTried: ["one"], startedAt: r.createdAt, completedAt: r.createdAt, durationMs: 0 };
    } });
  } });
  let dispose = registerExternalJobProvider(provider);
  const timer = setInterval(() => serviceExternalJobBridgeRequests(asyncDir), 10);
  const input = { provider: "agy-acp", options: { preset: "agy-scout" }, prompt: "scout", cwd: root, runId: "bridge-run", stepIndex: 0, agent: "agy-job-scout", asyncDir, onExternalJob: (s: any) => writeFileSync(join(asyncDir, "status.json"), JSON.stringify({ steps: [{ externalJob: s }] })) };
  try {
    const first = await runExternalJob(input); expect(first.exitCode).toBe(0); expect(JSON.parse(first.output).text).toBe("bridge answer"); expect(starts).toBe(1);
    dispose(); const recovered = new AcpJobProvider(jobs, { check: async () => { throw Error("recovery must not preflight"); }, launch: async () => { throw Error("recovery must not launch"); } }); dispose = registerExternalJobProvider(recovered);
    const second = await runExternalJob(input); expect(second.exitCode).toBe(0); expect(second.externalJob.providerJobId).toBe(first.externalJob.providerJobId); expect(starts).toBe(1); expect(second.output).toBe(first.output);
  } finally { clearInterval(timer); dispose(); if (previous === undefined) delete process.env.MGWCLI_HOME; else process.env.MGWCLI_HOME = previous; rmSync(root, { recursive: true, force: true }); }
}, 20000);
