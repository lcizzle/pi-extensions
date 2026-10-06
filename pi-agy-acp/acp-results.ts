import { Type, type Static } from "typebox";
const nullableString = Type.Union([Type.String(), Type.Null()]);
export const AcpUsageSchema = Type.Object({ input: Type.Number({ minimum: 0 }), output: Type.Number({ minimum: 0 }), total: Type.Number({ minimum: 0 }), cacheRead: Type.Number({ minimum: 0 }), cacheWrite: Type.Number({ minimum: 0 }), source: Type.Union([Type.Literal("reported"), Type.Literal("estimated"), Type.Literal("mixed")]) });
export type AcpResultUsage = Static<typeof AcpUsageSchema>;
export const AcpFailureCodeSchema = Type.Union([Type.Literal("PRESET_CONFIG_INVALID"), Type.Literal("PRESET_NOT_FOUND"), Type.Literal("PRESET_OVERRIDE_FORBIDDEN"), Type.Literal("PROFILE_POOL_EXHAUSTED"), Type.Literal("INVALID_REQUEST"), Type.Literal("CEILING_VIOLATION_OBSERVED"), Type.Literal("ABORTED"), Type.Literal("TOKEN_LIMIT"), Type.Literal("CLEANUP_FAILED"), Type.Literal("ACP_FAILED")]);
export type AcpFailureCode = Static<typeof AcpFailureCodeSchema>;
export const AcpTaskResultSchema = Type.Object({
  version: Type.Literal(1), jobId: Type.String(), sessionId: nullableString, agent: nullableString,
  requested: Type.Object({ profile: nullableString, model: nullableString, mode: nullableString }),
  effective: Type.Object({ profile: nullableString, model: nullableString, mode: nullableString, cwd: Type.String(), permissionPolicy: Type.Union([Type.Literal("mode"), Type.Literal("read-only"), Type.Literal("edit-only")]), enforcement: Type.Union([Type.Literal("session-mode"), Type.Literal("acp-permission-and-event-gate")]) }),
  status: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("aborted"), Type.Literal("blocked"), Type.Literal("incomplete")]),
  text: Type.String(), modelId: Type.String(), profile: nullableString, stopReason: Type.String(), isError: Type.Boolean(), error: Type.Optional(Type.String()),
  failure: Type.Union([Type.Object({ code: AcpFailureCodeSchema, message: Type.String() }), Type.Null()]),
  usage: Type.Union([AcpUsageSchema, Type.Null()]), promptDispatched: Type.Boolean(), attempts: Type.Integer({ minimum: 0 }), profilesTried: Type.Array(Type.String()),
  startedAt: Type.String(), completedAt: Type.String(), durationMs: Type.Number({ minimum: 0 }),
});
export type AcpTaskResult = Static<typeof AcpTaskResultSchema>;
const count = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
export function normalizeAcpUsage(raw: any, estimatedInput: number, estimatedOutput: number): AcpResultUsage {
  const ri = raw?.inputTokens ?? raw?.input, ro = raw?.outputTokens ?? raw?.output;
  const input = count(ri) ? ri : estimatedInput, output = count(ro) ? ro : estimatedOutput;
  const rt = raw?.totalTokens ?? raw?.total;
  return { input, output, total: count(rt) && rt >= input + output ? rt : input + output,
    cacheRead: count(raw?.cachedReadTokens) ? raw.cachedReadTokens : 0, cacheWrite: count(raw?.cachedWriteTokens) ? raw.cachedWriteTokens : 0,
    source: count(ri) && count(ro) ? "reported" : count(ri) || count(ro) || count(rt) ? "mixed" : "estimated" };
}
