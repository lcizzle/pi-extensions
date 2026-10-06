import { spawn, spawnSync } from "node:child_process";
import { realpathSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { ExternalJobProvider, ExternalJobStartInput } from "pi-subagents/external-job-provider";
import { AcpJobStore, AcpJobError, defaultJobRoot, inputDigestFor, jobIdFor, makeJobRequest } from "./acp-job-store";
import { loadAcpPresets, resolveAcpPreset } from "./acp-presets";
import { ACP_MODELS, listProfiles } from "./pi-agy-acp";
export interface AcpWorkerLauncher { check(): Promise<void>; launch(jobDir: string, cwd: string): Promise<void> }
const worker = join(dirname(fileURLToPath(import.meta.url)), "acp-job-worker.ts");
export function nativeWorkerLauncher(): AcpWorkerLauncher {
  return {
    async check() {
      const p = spawnSync("bun", [worker, "--preflight"], { encoding: "utf8", timeout: 15000, windowsHide: true, maxBuffer: 65536 });
      if (p.error || p.status !== 0 || p.stdout.trim() !== "ACP_JOB_WORKER_READY_V1") throw new AcpJobError("WORKER_UNAVAILABLE", "Bun/ACP worker peer-package preflight failed; repair installation before starting a job");
    },
    launch: (jobDir, cwd) => new Promise((resolve, reject) => {
      const child = spawn("bun", [worker, jobDir], { cwd, detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", reject); child.once("spawn", () => { child.unref(); resolve(); });
    }),
  };
}
export class AcpJobProvider implements ExternalJobProvider {
  readonly name = "agy-acp";
  constructor(readonly root = defaultJobRoot(), private readonly launcher = nativeWorkerLauncher()) {}
  private store(): AcpJobStore { return new AcpJobStore(this.root); }
  async start(raw: ExternalJobStartInput) {
    if (typeof raw.prompt !== "string" || !raw.prompt.trim() || Buffer.byteLength(raw.prompt) > 1024 * 1024 || createHash("sha256").update(raw.prompt).digest("hex") !== raw.promptDigest) throw new AcpJobError("INVALID_REQUEST", "Invalid or oversized prompt/digest");
    const input = { ...raw, cwd: realpathSync(raw.cwd), options: { ...raw.options } };
    const id = jobIdFor(input.runId, input.stepIndex), inputDigest = inputDigestFor(input), store = this.store();
    const role = /^agy-job-(builder|reviewer|scout)(?:-[a-z0-9]+)?$/.exec(input.agent)?.[1];
    if (role && input.options.preset !== `agy-${role}`) throw new AcpJobError("PRESET_OVERRIDE_FORBIDDEN", "External agent role cannot select another preset");
    // Check existing identity before configuration/preflight. Recovery never launches another worker.
    try {
      lstatSync(join(store.root, id));
      const existing = store.readRequest(id);
      if (existing.inputDigest !== inputDigest) throw new AcpJobError("IDENTITY_CONFLICT", "Job ID already binds another request");
      return store.status(id);
    } catch (error: any) { if (error.code !== "ENOENT") throw error; if (error.path !== join(store.root, id)) throw new AcpJobError("JOB_UNCERTAIN", "Incomplete job allocation; do not redispatch"); }
    const profiles = listProfiles(), catalog = loadAcpPresets(input.cwd, ACP_MODELS.map(m => m.id));
    const resolved = resolveAcpPreset(catalog, { agent: input.options.preset as string, profile: input.options.profile as string | undefined, model: input.options.model as string | undefined, mode: input.options.mode as string | undefined }, profiles.find(p => p.authenticated)?.name ?? "shared-profile-01", profiles);
    const p = resolved.preset;
    const request = makeJobRequest(input, { preset: p.id, profiles: resolved.profiles, model: resolved.model, permissionPolicy: p.permissionPolicy, instructions: p.instructions, description: p.description });
    await this.launcher.check();
    const allocation = store.create(request);
    if (allocation.created) {
      try { await this.launcher.launch(store.path(id), request.cwd); }
      catch { store.checkpoint(id, "launch-uncertain", false); }
    }
    return store.status(id);
  }
  status(id: string) { return this.store().status(id); }
  result(id: string) { return this.store().result(id); }
  reattach(id: string) { return this.status(id); }
}
