import { dirname, basename, resolve } from "node:path";
import { AcpJobStore } from "./acp-job-store";
import { defaultAcpPresets } from "./acp-presets";
import { createAcpRuntime, executeAcpTask, ACP_MODELS, type RunAcpRequest, type RunAcpResult } from "./pi-agy-acp";

/** Separate process owns execution and persistence; parent shutdown only drops monitoring. */
export async function runAcpJobWorker(jobDir: string, hooks: { execute?: (request: RunAcpRequest) => Promise<RunAcpResult>; configureRuntime?: (scope: ReturnType<typeof createAcpRuntime>) => void } = {}): Promise<void> {
  jobDir = resolve(jobDir);
  const store = new AcpJobStore(dirname(jobDir)), id = basename(jobDir), r = store.readRequest(id);
  if (store.path(id) !== jobDir) throw Error("Invalid worker job path");
  const builtin = defaultAcpPresets()[r.preset];
  if (!ACP_MODELS.some(m => m.id === r.model) || (builtin && builtin.permissionPolicy !== r.permissionPolicy)) throw Error("Invalid captured model/policy");
  store.claim(id); // Permanent exclusive claim. Never restart this worker from stale heartbeat/PID.
  const scope = createAcpRuntime();
  scope.state.sessionId = id;
  scope.state.activeProfileState = r.profiles[0];
  scope.state.presetCatalog = Object.freeze({ ...defaultAcpPresets(), [r.preset]: Object.freeze({ id: r.preset, description: r.description, instructions: r.instructions, model: r.model, profiles: Object.freeze([...r.profiles]), permissionPolicy: r.permissionPolicy }) });
  hooks.configureRuntime?.(scope); // Trusted deterministic fake-process seam; never read from durable requests.
  const controller = new AbortController();
  let dispatchIntent = false, stage = "running";
  const heartbeat = setInterval(() => { try { store.checkpoint(id, stage, dispatchIntent); } catch { controller.abort(); } }, 2000);
  try {
    const result = await scope.run(() => (hooks.execute ?? executeAcpTask)({ agent: r.preset, prompt: r.prompt, cwd: r.cwd, signal: controller.signal,
      onCheckpoint: () => { dispatchIntent = true; stage = "dispatch-intent"; store.checkpoint(id, stage, true); },
    }));
    // No terminal success until the account-owning process has been closed/released.
    try { await scope.state.globalAcpManager?.close(); }
    catch (error: any) { const message: string = error?.message ?? "Worker cleanup uncertain"; result.status = "failed"; result.isError = true; result.stopReason = "error"; result.error = message; result.failure = { code: "CLEANUP_FAILED", message }; }
    result.jobId = id;
    result.modelId = r.model; // Captured intended model, even if authentication preflight failed.
    result.requested = { profile: r.options.profile ?? null, model: r.options.model ?? null, mode: r.options.mode ?? null };
    // A preflight failure has no applied server configuration but still binds this captured ceiling.
    result.effective.permissionPolicy = r.permissionPolicy;
    result.effective.enforcement = "acp-permission-and-event-gate";
    store.publishResult(id, result); // Authoritative result first; final checkpoint is optional for recovery.
    stage = "terminal";
    store.checkpoint(id, stage, dispatchIntent);
  } finally {
    clearInterval(heartbeat);
    await scope.state.globalAcpManager?.close();
  }
}
if ((import.meta as ImportMeta & { main?: boolean }).main) {
  if (process.argv[2] === "--preflight") process.stdout.write("ACP_JOB_WORKER_READY_V1\n");
  else runAcpJobWorker(process.argv[2] ?? "").catch(() => { process.exitCode = 1; });
}
