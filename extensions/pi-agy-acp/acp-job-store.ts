import { mkdirSync, lstatSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, realpathSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { AcpTaskResultSchema, type AcpTaskResult } from "./acp-results";
const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const Options = Type.Object({ preset: text(64), profile: Type.Optional(text(255)), model: Type.Optional(text(128)), mode: Type.Optional(text(32)) }, { additionalProperties: false });
export const JobRequestSchema = Type.Object({
  version: Type.Literal(1), providerJobId: Type.String({ pattern: "^acp-[a-f0-9]{64}$" }), inputDigest: hash, requestDigest: hash,
  prompt: text(1024 * 1024), promptDigest: hash, cwd: text(4096), runId: text(256), stepIndex: Type.Integer({ minimum: 0, maximum: 100000 }), agent: text(256), options: Options,
  preset: text(64), profiles: Type.Array(text(255), { minItems: 1, maxItems: 32 }), model: text(128), permissionPolicy: Type.Union([Type.Literal("read-only"), Type.Literal("edit-only")]), instructions: text(16384), description: text(1024), createdAt: text(64),
}, { additionalProperties: false });
export type AcpJobRequest = Static<typeof JobRequestSchema>;
export interface JobStartInput { prompt: string; promptDigest: string; cwd: string; runId: string; stepIndex: number; agent: string; options: Record<string, unknown>; sessionId?: string }
export interface JobSnapshot { preset: string; profiles: readonly string[]; model: string; permissionPolicy: "read-only" | "edit-only"; instructions: string; description: string }
export interface JobHandle { providerJobId: string; state: "queued" | "running" | "completed" | "failed" | "stopped" | "blocked"; failureCode?: string; failureMessage?: string }
const StatusSchema = Type.Object({ version: Type.Literal(1), providerJobId: Type.String({ pattern: "^acp-[a-f0-9]{64}$" }), requestDigest: hash, state: Type.Union([Type.Literal("queued"), Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("stopped"), Type.Literal("blocked")]), stage: text(64), dispatchIntent: Type.Boolean(), updatedAt: Type.Number({ minimum: 0 }) }, { additionalProperties: false });
export class AcpJobError extends Error { constructor(public readonly code: string, message: string) { super(message); } }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function jobIdFor(runId: string, stepIndex: number): string {
  if (typeof runId !== "string" || !runId.trim() || runId.length > 256 || !Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex > 100000) throw new AcpJobError("INVALID_REQUEST", "Invalid job run/step identity");
  return `acp-${digest(JSON.stringify([runId, stepIndex]))}`;
}
export function inputDigestFor(input: JobStartInput): string {
  if (!Value.Check(Options, input.options)) throw new AcpJobError("INVALID_REQUEST", "Only preset/profile/model/mode job options are supported");
  return digest(JSON.stringify([input.cwd, input.agent, input.promptDigest, input.options.preset, input.options.profile ?? null, input.options.model ?? null, input.options.mode ?? null]));
}
function requestDigest(r: Omit<AcpJobRequest, "requestDigest">): string { return digest(JSON.stringify(r)); }
export function makeJobRequest(input: JobStartInput, snapshot: JobSnapshot): AcpJobRequest {
  const base = { version: 1 as const, providerJobId: jobIdFor(input.runId, input.stepIndex), inputDigest: inputDigestFor(input), prompt: input.prompt, promptDigest: input.promptDigest, cwd: input.cwd, runId: input.runId, stepIndex: input.stepIndex, agent: input.agent, options: { ...input.options } as AcpJobRequest["options"], ...snapshot, profiles: [...snapshot.profiles], createdAt: new Date().toISOString() };
  const r = { ...base, requestDigest: requestDigest(base) }; validateRequest(r); return r;
}
function validateRequest(r: unknown): asserts r is AcpJobRequest {
  if (!Value.Check(JobRequestSchema, r)) throw new AcpJobError("CORRUPT_JOB", "Malformed durable job request");
  if (Buffer.byteLength(JSON.stringify(r)) > 2 * 1024 * 1024) throw new AcpJobError("INVALID_REQUEST", "Encoded durable request exceeds 2 MiB read limit");
  const { requestDigest: saved, ...base } = r;
  if (saved !== requestDigest(base) || r.providerJobId !== jobIdFor(r.runId, r.stepIndex) || r.promptDigest !== digest(r.prompt) || r.inputDigest !== inputDigestFor(r) || !isAbsolute(r.cwd) || r.options.preset !== r.preset) throw new AcpJobError("CORRUPT_JOB", "Durable job request identity mismatch");
}
export function defaultJobRoot(): string { return resolve(process.env.PI_AGY_JOB_ROOT ?? join(homedir(), ".pi", "agent", "agy-acp-jobs")); }
export class AcpJobStore {
  readonly root: string;
  constructor(root = defaultJobRoot()) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw new AcpJobError("UNSAFE_PATH", "Job root must be a real directory");
    this.root = realpathSync(root);
  }
  path(id: string): string {
    if (!/^acp-[a-f0-9]{64}$/.test(id)) throw new AcpJobError("INVALID_JOB_ID", "Invalid ACP job ID");
    const path = join(this.root, id);
    const st = lstatSync(path); if (st.isSymbolicLink() || !st.isDirectory()) throw new AcpJobError("UNSAFE_PATH", "Job path is not a real directory");
    return path;
  }
  private read(id: string, name: string, max = 2 * 1024 * 1024): unknown {
    const path = join(this.path(id), name), st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile() || st.size > max) throw new AcpJobError("CORRUPT_JOB", "Unsafe or oversized durable record");
    try { return JSON.parse(readFileSync(path, "utf8")); } catch { throw new AcpJobError("CORRUPT_JOB", "Invalid durable record JSON"); }
  }
  private atomic(id: string, name: string, value: unknown): void {
    const dir = this.path(id), target = join(dir, name), temporary = join(dir, `.${name}.${randomUUID()}.tmp`);
    try { if (lstatSync(target).isSymbolicLink()) throw new AcpJobError("UNSAFE_PATH", "Cannot replace symlink record"); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > 8 * 1024 * 1024) throw new AcpJobError("RECORD_TOO_LARGE", "Durable result exceeds 8 MiB");
    let fd: number | undefined;
    try { fd = openSync(temporary, "wx", 0o600); writeFileSync(fd, data); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temporary, target); }
    finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch {} }
  }
  create(r: AcpJobRequest): { created: boolean; request: AcpJobRequest } {
    validateRequest(r); const dir = join(this.root, r.providerJobId);
    try { mkdirSync(dir, { mode: 0o700 }); }
    catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      const existing = this.readRequest(r.providerJobId);
      if (existing.inputDigest !== r.inputDigest) throw new AcpJobError("IDENTITY_CONFLICT", "Job ID already binds a different request");
      return { created: false, request: existing };
    }
    this.atomic(r.providerJobId, "request.json", r);
    this.atomic(r.providerJobId, "status.json", { version: 1, providerJobId: r.providerJobId, requestDigest: r.requestDigest, state: "queued", stage: "allocated", dispatchIntent: false, updatedAt: Date.now() });
    return { created: true, request: r };
  }
  readRequest(id: string): AcpJobRequest { const r = this.read(id, "request.json"); validateRequest(r); if (r.providerJobId !== id) throw new AcpJobError("CORRUPT_JOB", "Job request stored under wrong ID"); return r; }
  readStatus(id: string): Static<typeof StatusSchema> {
    const s = this.read(id, "status.json"); if (!Value.Check(StatusSchema, s) || s.providerJobId !== id || s.requestDigest !== this.readRequest(id).requestDigest) throw new AcpJobError("CORRUPT_JOB", "Malformed durable job status"); return s;
  }
  claim(id: string): void {
    const r = this.readRequest(id), path = join(this.path(id), "worker.claim");
    const fd = openSync(path, "wx", 0o600); try { writeFileSync(fd, JSON.stringify({ version: 1, requestDigest: r.requestDigest, pid: process.pid })); fsyncSync(fd); } finally { closeSync(fd); }
    this.checkpoint(id, "claimed", false);
  }
  checkpoint(id: string, stage: string, dispatchIntent: boolean, now = Date.now()): void {
    const r = this.readRequest(id), terminal = stage === "terminal" ? this.terminal(id) : undefined;
    this.atomic(id, "status.json", { version: 1, providerJobId: id, requestDigest: r.requestDigest, state: terminal ? this.terminalState(terminal) : "running", stage, dispatchIntent, updatedAt: now });
  }
  private terminalState(result: AcpTaskResult): JobHandle["state"] { return result.status === "completed" ? "completed" : result.status === "aborted" ? "stopped" : result.status === "blocked" ? "blocked" : "failed"; }
  private validateResult(id: string, result: unknown): asserts result is AcpTaskResult {
    const r = this.readRequest(id);
    if (!Value.Check(AcpTaskResultSchema, result) || result.jobId !== id || result.agent !== r.preset || result.effective.cwd !== r.cwd || result.effective.permissionPolicy !== r.permissionPolicy || result.effective.enforcement !== "acp-permission-and-event-gate" || (result.effective.profile !== null && !r.profiles.includes(result.effective.profile)) || (result.effective.model !== null && result.effective.model !== r.model) || (result.effective.mode !== null && result.effective.mode !== "default") || result.profilesTried.some(p => !r.profiles.includes(p)) || (result.status === "completed" && (result.isError || result.failure !== null || !result.promptDispatched || result.attempts < 1 || result.effective.profile === null || result.effective.model !== r.model || result.effective.mode !== "default" || !["end_turn", "stop", "completed"].includes(result.stopReason))) || (result.status !== "completed" && (!result.isError || result.failure === null))) throw new AcpJobError("CORRUPT_JOB", "Durable result does not match request/policy");
  }
  publishResult(id: string, result: AcpTaskResult): void {
    this.validateResult(id, result);
    if (this.terminal(id)) throw new AcpJobError("TERMINAL_ALREADY_PUBLISHED", "Cannot replace an authoritative terminal result");
    this.atomic(id, "result.json", result);
  }
  private terminal(id: string): AcpTaskResult | undefined {
    try { const r = this.read(id, "result.json", 8 * 1024 * 1024); this.validateResult(id, r); return r; }
    catch (error: any) { if (error.code === "ENOENT") return undefined; throw error; }
  }
  status(id: string, now = Date.now()): JobHandle {
    this.readRequest(id);
    const terminal = this.terminal(id);
    if (terminal) return { providerJobId: id, state: this.terminalState(terminal), ...(terminal.failure ? { failureCode: terminal.failure.code, failureMessage: terminal.failure.message.slice(0, 4096).trim() || "ACP task failed" } : {}) };
    const s = this.readStatus(id);
    if (!["queued", "running"].includes(s.state) || s.stage === "launch-uncertain" || now - s.updatedAt > 30000 || s.updatedAt > now + 30000) return { providerJobId: id, state: "blocked", failureCode: "JOB_UNCERTAIN", failureMessage: "Worker heartbeat is stale; execution may continue. Do not replay or steal ownership." };
    return { providerJobId: id, state: s.state };
  }
  result(id: string): JobHandle & { output?: string; artifactPath?: string } {
    const handle = this.status(id), result = this.terminal(id);
    if (!result) return handle;
    const output = JSON.stringify(result);
    return { ...handle, output: Buffer.byteLength(output) <= 900000 ? output : "ACP result exceeds inline limit; inspect the persisted JSON artifact.", artifactPath: join(this.path(id), "result.json") };
  }
}
