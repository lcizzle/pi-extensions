import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type TranscriptContext,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync, mkdirSync, realpathSync, renameSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { defaultAcpPresets, loadAcpPresets, resolveAcpPreset, presetAllowsKind, AcpPresetError, type AcpPermissionPolicy, type ResolvedAcpPreset } from "./acp-presets";
import { AcpTaskResultSchema, normalizeAcpUsage, type AcpTaskResult, type AcpResultUsage, type AcpFailureCode } from "./acp-results";
import { win32 } from "node:path";
import { createAcpRuntime, runtimeState, bindRuntimeApi, withProfileOperation, claimProfileManager, releaseProfileManager } from "./acp-runtime";
export { createAcpRuntime, withProfileOperation } from "./acp-runtime";

export interface AcpModelDefinition {
  readonly id: string;
  readonly name: string;
  readonly effort: "high" | "medium" | "low";
  readonly description: string;
}

export const ACP_MODELS: readonly AcpModelDefinition[] = [
  { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", effort: "high", description: "Default - fast & high reasoning" },
  { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)", effort: "medium", description: "Fast & balanced reasoning" },
  { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)", effort: "low", description: "Fastest response time" },
  { id: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)", effort: "high", description: "Deep reasoning & architecture" },
  { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)", effort: "low", description: "Pro model with low thinking" },
  { id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)", effort: "high", description: "Previous generation high reasoning" },
  { id: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)", effort: "medium", description: "Previous generation balanced reasoning" },
  { id: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)", effort: "low", description: "Previous generation low reasoning" },
  { id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)", effort: "high", description: "Legacy 3.6 flash high reasoning" },
  { id: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)", effort: "medium", description: "Legacy 3.6 flash medium reasoning" },
  { id: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Low)", effort: "low", description: "Legacy 3.6 flash low reasoning" },
];

export const ACP_MODES = [
  { id: "auto_edit", name: "Auto Edit (Auto-approve file edits)", description: "Recommended for coding" },
  { id: "default", name: "Default (Ask permission for edits)", description: "Prompts for each change" },
  { id: "yolo", name: "YOLO (Auto-approve all tool actions)", description: "Unrestricted execution" },
] as const;

export interface ProfileInfo {
  readonly name: string;
  readonly type: "shared" | "normal";
  readonly authenticated: boolean;
}

export function listProfiles(): ProfileInfo[] {
  const root = process.env.MGWCLI_HOME ?? join(process.env.LOCALAPPDATA ?? "", "mgwcli");
  const profilesDir = join(root, "profiles");
  if (!existsSync(profilesDir)) return [];

  const profiles: ProfileInfo[] = [];
  try {
    for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      const metaFile = join(profilesDir, name, "profile.json");
      if (!existsSync(metaFile)) continue;
      try {
        const meta = JSON.parse(readFileSync(metaFile, "utf8"));
        if (meta.type !== "shared" && meta.type !== "normal") continue;
        const tokenFile = join(profilesDir, name, "acp-home", "antigravity-acp", "acp_token.json");
        profiles.push({
          name,
          type: meta.type,
          authenticated: existsSync(tokenFile),
        });
      } catch {}
    }
  } catch {}

  // Prioritize authenticated profiles, then sort alphabetically
  return profiles.sort((a, b) => {
    if (a.authenticated !== b.authenticated) return a.authenticated ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
}

export interface QuotaBucketInfo {
  readonly remainingPercent: number;
  readonly resetAt?: string;
}

export interface ProfileQuotaData {
  readonly profile: string;
  readonly updatedAt?: string;
  readonly geminiFiveHour?: QuotaBucketInfo;
  readonly geminiWeekly?: QuotaBucketInfo;
  readonly thirdPartyFiveHour?: QuotaBucketInfo;
  readonly thirdPartyWeekly?: QuotaBucketInfo;
  readonly summary?: string;
}

export function formatRelativeTime(resetAt?: string): string | undefined {
  if (!resetAt) return undefined;
  const ms = Date.parse(resetAt) - Date.now();
  if (!Number.isFinite(ms)) return undefined;
  if (ms <= 0) return "ready";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours < 24) return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

export function getProfileQuota(profile: string): ProfileQuotaData | undefined {
  const root = process.env.MGWCLI_HOME ?? join(process.env.LOCALAPPDATA ?? "", "mgwcli");
  const cacheFile = join(root, "profiles", profile, "quota-cache.json");
  if (!existsSync(cacheFile)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(cacheFile, "utf8"));
    const gemini = raw.quota?.gemini;
    const thirdParty = raw.quota?.thirdParty;
    return {
      profile,
      updatedAt: raw.updatedAt,
      geminiFiveHour: gemini?.fiveHour,
      geminiWeekly: gemini?.weekly,
      thirdPartyFiveHour: thirdParty?.fiveHour,
      thirdPartyWeekly: thirdParty?.weekly,
      summary: raw.summary,
    };
  } catch {
    return undefined;
  }
}

export interface AcpMcpServerConfig {
  readonly name: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly transport?: string;
}

export function loadProjectMcpServers(cwd: string): AcpMcpServerConfig[] {
  const candidates = [
    join(cwd, ".mcp.json"),
    join(cwd, ".pi", "mcp.json"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const raw = JSON.parse(readFileSync(candidate, "utf8"));
        const servers = raw.mcpServers ?? {};
        const parsed: AcpMcpServerConfig[] = [];
        for (const [name, cfg] of Object.entries(servers)) {
          if (!cfg || typeof cfg !== "object") continue;
          const s = cfg as any;
          parsed.push({
            name,
            ...(s.command ? { command: String(s.command) } : {}),
            ...(Array.isArray(s.args) ? { args: s.args.map(String) } : {}),
            ...(s.env && typeof s.env === "object" ? { env: s.env } : {}),
            ...(s.url ? { url: String(s.url) } : {}),
            ...(s.transport ? { transport: String(s.transport) } : {}),
          });
        }
        return parsed;
      } catch {}
    }
  }
  return [];
}

export function formatBucketDisplay(bucket?: QuotaBucketInfo): string {
  if (!bucket) return "-";
  const pct = `${bucket.remainingPercent}%`;
  const rel = formatRelativeTime(bucket.resetAt);
  if (rel && rel !== "ready") return `${pct} (${rel})`;
  if (rel === "ready" && bucket.remainingPercent < 100) return `${pct} (ready)`;
  return pct;
}

export interface RateLimitRecord {
  readonly profile: string;
  readonly limitedAt: number;
  readonly resetAt: number;
  readonly reason: string;
}

// Forward helper access to the current extension's session scope.
const rateLimitedProfiles = new Proxy(new Map<string, RateLimitRecord>(), {
  get(_target, key) {
    const map = runtimeState().rateLimitedProfiles;
    const value = Reflect.get(map, key, map);
    return typeof value === "function" ? value.bind(map) : value;
  },
});

export function isRateLimitOrQuotaError(error: unknown): boolean {
  if (!error) return false;
  const msg = typeof error === "string" ? error : (error as any)?.message ?? String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes("resource_exhausted") ||
    lower.includes("429") ||
    lower.includes("too many requests") ||
    lower.includes("quota exceeded") ||
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("exceeded your current quota") ||
    lower.includes("free tier limit") ||
    lower.includes("resource has been exhausted") ||
    lower.includes("exhausted its capacity") ||
    lower.includes("model is overloaded") ||
    lower.includes("capacity exceeded")
  );
}

export function markProfileRateLimited(profile: string, reason = "Rate limit hit"): void {
  const quota = getProfileQuota(profile);
  let resetAt = Date.now() + 15 * 60 * 1000; // default 15m cooldown
  if (quota?.geminiFiveHour?.resetAt) {
    const parsed = Date.parse(quota.geminiFiveHour.resetAt);
    if (Number.isFinite(parsed) && parsed > Date.now()) {
      resetAt = parsed;
    }
  }
  rateLimitedProfiles.set(profile, {
    profile,
    limitedAt: Date.now(),
    resetAt,
    reason,
  });
}

export function isProfileRateLimited(profile: string): boolean {
  const record = rateLimitedProfiles.get(profile);
  if (!record) return false;
  if (Date.now() >= record.resetAt) {
    rateLimitedProfiles.delete(profile);
    return false;
  }
  return true;
}

export function clearProfileRateLimit(profile: string): void {
  rateLimitedProfiles.delete(profile);
}

export function getRateLimitedProfiles(): ReadonlyMap<string, RateLimitRecord> {
  return runtimeState().rateLimitedProfiles;
}

export function getAutoSwitchEnabled(): boolean {
  return runtimeState().autoSwitchEnabledState;
}

export function setAutoSwitchEnabled(enabled: boolean): void {
  runtimeState().autoSwitchEnabledState = enabled;
}

export function findNextHealthyProfile(currentProfile: string): ProfileInfo | undefined {
  const allProfiles = listProfiles();
  const candidates: Array<{ profile: ProfileInfo; remainingPct: number; isRateLimited: boolean }> = [];

  for (const p of allProfiles) {
    if (!p.authenticated) continue;
    if (p.name === currentProfile) continue;

    const rateLimited = isProfileRateLimited(p.name);
    const quota = getProfileQuota(p.name);
    const remainingPct = quota?.geminiFiveHour?.remainingPercent ?? 100;

    candidates.push({
      profile: p,
      remainingPct,
      isRateLimited: rateLimited,
    });
  }

  // Filter out actively rate-limited profiles
  const notRateLimited = candidates.filter((c) => !c.isRateLimited);

  // Priority 1: not rate limited AND remainingPct > 2
  const healthy = notRateLimited.filter((c) => c.remainingPct > 2);
  if (healthy.length > 0) {
    healthy.sort((a, b) => b.remainingPct - a.remainingPct);
    return healthy[0]!.profile;
  }

  // Priority 2: not rate limited even if low quota
  if (notRateLimited.length > 0) {
    notRateLimited.sort((a, b) => b.remainingPct - a.remainingPct);
    return notRateLimited[0]!.profile;
  }

  return undefined;
}

export function renderProfileLimitsTable(profiles: ProfileInfo[]): string {
  const active = getActiveProfile();
  const autoSwitch = getAutoSwitchEnabled();

  const lines: string[] = [
    `### ⚡ Antigravity Profile Quotas & Limits`,
    "",
    `| Profile | Type | Auth | Gemini (5-Hour) | Gemini (Weekly) | 3rd Party (5h/Wk) | Status |`,
    `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |`,
  ];

  for (const p of profiles) {
    const isAct = p.name === active;
    const isRatelimited = isProfileRateLimited(p.name);
    const quota = getProfileQuota(p.name);

    const nameCol = isAct ? `**${p.name}** *(Active)*` : p.name;
    const authCol = p.authenticated ? "✅ Ready" : "❌ No Auth";

    const g5h = quota?.geminiFiveHour;
    const gWk = quota?.geminiWeekly;
    const tp5h = quota?.thirdPartyFiveHour;
    const tpWk = quota?.thirdPartyWeekly;

    const g5hStr = formatBucketDisplay(g5h);
    const gWkStr = formatBucketDisplay(gWk);
    const tpStr = tp5h && tpWk ? `${tp5h.remainingPercent}% / ${tpWk.remainingPercent}%` : "-";

    let statusCol = "Available";
    if (!p.authenticated) {
      statusCol = "Unauthenticated";
    } else if (isRatelimited) {
      const rec = rateLimitedProfiles.get(p.name);
      const wait = rec ? formatRelativeTime(new Date(rec.resetAt).toISOString()) : undefined;
      statusCol = `🚫 Rate Limited${wait ? ` (${wait})` : ""}`;
    } else if (g5h && g5h.remainingPercent <= 2) {
      statusCol = "⚠️ Low Quota (<=2%)";
    } else if (isAct) {
      statusCol = "🟢 Active";
    }

    lines.push(`| ${nameCol} | ${p.type} | ${authCol} | ${g5hStr} | ${gWkStr} | ${tpStr} | ${statusCol} |`);
  }

  lines.push("");
  lines.push(`- **Auto-Switching:** \`${autoSwitch ? "Enabled" : "Disabled"}\` (automatically switches to next healthy profile on rate limit / 429)`);
  lines.push(`- **Commands:** \`/agy-acp-limits --refresh\` to fetch live, \`/agy-acp-autoswitch [on|off]\` to toggle auto-switching.`);

  return lines.join("\n");
}

export function renderSingleProfileQuota(profileName: string): string {
  const quota = getProfileQuota(profileName);
  const profiles = listProfiles();
  const info = profiles.find((p) => p.name.toLowerCase() === profileName.toLowerCase());
  const isAct = (info?.name ?? profileName) === getActiveProfile();
  const isLimited = isProfileRateLimited(info?.name ?? profileName);

  if (!quota && !info) {
    return `❌ Profile **${profileName}** not found. Available: ${profiles.map((p) => p.name).join(", ")}`;
  }

  const name = info?.name ?? profileName;
  const auth = info?.authenticated ? "✅ Authenticated" : "❌ Not Authenticated";
  const limitedText = isLimited ? `🚫 **Rate Limited** (active cooldown)` : `✅ Healthy`;

  const lines: string[] = [
    `### ⚡ Quota Limits: **${name}** ${isAct ? "*(Active)*" : ""}`,
    `- **Account Status:** ${auth} | ${limitedText}`,
    `- **Profile Type:** \`${info?.type ?? "shared"}\``,
  ];

  if (quota) {
    if (quota.updatedAt) {
      lines.push(`- **Cache Updated:** ${quota.updatedAt}`);
    }
    lines.push("");
    lines.push(`**Gemini Models:**`);
    lines.push(`- **5-Hour Window:** **${quota.geminiFiveHour?.remainingPercent ?? "-"}%** remaining (Resets: ${quota.geminiFiveHour?.resetAt ? `${formatRelativeTime(quota.geminiFiveHour.resetAt)} [${quota.geminiFiveHour.resetAt}]` : "ready"})`);
    lines.push(`- **Weekly Window:** **${quota.geminiWeekly?.remainingPercent ?? "-"}%** remaining (Resets: ${quota.geminiWeekly?.resetAt ? `${formatRelativeTime(quota.geminiWeekly.resetAt)} [${quota.geminiWeekly.resetAt}]` : "ready"})`);

    lines.push("");
    lines.push(`**Third-Party Models:**`);
    lines.push(`- **5-Hour Window:** **${quota.thirdPartyFiveHour?.remainingPercent ?? "-"}%** remaining`);
    lines.push(`- **Weekly Window:** **${quota.thirdPartyWeekly?.remainingPercent ?? "-"}%** remaining`);
  } else {
    lines.push("");
    lines.push(`*No cached quota data available. Run \`/agy-acp-limits ${name} --refresh\` to query live quota.*`);
  }

  return lines.join("\n");
}

export async function refreshLiveQuota(profile?: string): Promise<{ success: boolean; message: string }> {
  return new Promise((resolve) => {
    const args = ["agy", "quota"];
    if (profile) args.push(profile);
    args.push("--refresh");
    const child = spawn("mgwcli.exe", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve({ success: false, message: "Quota refresh timed out." });
    }, 45000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ success: true, message: stdout.trim() || "Quota refreshed successfully." });
      } else {
        resolve({ success: false, message: stderr.trim() || `Quota refresh exited with code ${code}` });
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ success: false, message: err.message });
    });
  });
}

export interface LeaseRecoveryResult {
  readonly recovered: boolean;
  readonly locked: boolean;
  readonly lockedByPid?: number;
  readonly message?: string;
}

/** Compatibility command: ownership recovery is delegated exclusively to mgwcli. */
export function autoRecoverProfileLease(profile: string): LeaseRecoveryResult {
  // mgwcli alone validates/reclaims ownership. Never inspect PIDs or unlink its records.
  return { recovered: false, locked: false, message: `Ownership for ${profile} is managed by mgwcli. No lease files were changed.` };
}

export interface PersistedAcpSession {
  readonly sessionId: string;
  readonly profile: string;
  readonly modelId?: string;
  readonly modeId?: string;
  readonly cwd: string;
  readonly sessionTurnCount: number;
  readonly cumulativeInputTokens: number;
  readonly cumulativeOutputTokens: number;
  readonly lastUsed: number;
}

export function canonicalAcpCwd(cwd: string): string {
  let canonical = cwd;
  try { canonical = realpathSync(cwd); } catch {}
  return win32.normalize(canonical).replace(/[\\/]+$/, "").toLowerCase();
}

function isPathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Resolve an explicit scout workspace without widening it across the caller's workspace (and any contained vault). */
export function resolveScoutWorkspaceRoot(workspaceRoot: string, parentCwd: string): string {
  if (!isAbsolute(workspaceRoot)) throw new Error("workspaceRoot must be an absolute path");
  const target = realpathSync(workspaceRoot);
  if (!statSync(target).isDirectory()) throw new Error("workspaceRoot must resolve to an existing directory");
  const parent = realpathSync(parentCwd);
  if (isPathWithin(parent, target) || isPathWithin(target, parent)) {
    throw new Error("workspaceRoot must be separate from the parent workspace; use a single repository root rather than a nested or broad parent directory");
  }
  return target;
}

export function getSessionCachePath(cwd: string, sessionId = runtimeState().sessionId, profile = getActiveProfile()): string {
  const root = process.env.MGWCLI_HOME ?? join(process.env.LOCALAPPDATA ?? "", "mgwcli");
  const dir = join(root, "acp-sessions");
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {}
  }
  const hash = createHash("sha256").update(JSON.stringify([sessionId, canonicalAcpCwd(cwd), profile.toUpperCase()])).digest("hex");
  return join(dir, `session-${hash}.json`);
}

export function savePersistedSession(cwd: string, data: PersistedAcpSession, sessionId = runtimeState().sessionId): void {
  try {
    const file = getSessionCachePath(cwd, sessionId, data.profile);
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try { writeFileSync(temporary, JSON.stringify(data, null, 2), { encoding: "utf8", flag: "wx" }); renameSync(temporary, file); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  } catch {}
}

export function loadPersistedSession(cwd: string, sessionId = runtimeState().sessionId, profile = getActiveProfile()): PersistedAcpSession | undefined {
  try {
    const file = getSessionCachePath(cwd, sessionId, profile);
    if (!existsSync(file)) return undefined;
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (raw && typeof raw.sessionId === "string" && raw.sessionId.length > 0 && raw.profile === profile && canonicalAcpCwd(raw.cwd) === canonicalAcpCwd(cwd)) {
      return raw as PersistedAcpSession;
    }
  } catch {}
  return undefined;
}

export function clearPersistedSession(cwd: string, sessionId = runtimeState().sessionId, profile = getActiveProfile()): void {
  try {
    const file = getSessionCachePath(cwd, sessionId, profile);
    if (existsSync(file)) {
      unlinkSync(file);
    }
  } catch {}
}

export interface AcpToolCallLocation {
  readonly path?: string;
  readonly line?: number;
}

export interface AcpToolCallInfo {
  readonly toolCallId: string;
  readonly title?: string;
  readonly name?: string;
  readonly kind?: string;
  readonly status?: string;
  readonly locations?: readonly AcpToolCallLocation[];
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
}

export interface AcpPermissionOption {
  readonly optionId: string;
  readonly name?: string;
  readonly kind?: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export interface AcpPermissionRequest {
  readonly sessionId: string;
  readonly toolCall: AcpToolCallInfo;
  readonly options: readonly AcpPermissionOption[];
}

/**
 * Selects an approval option from the given permission options.
 * Prioritizes allow_always if requested, then allow_once / allow, then non-reject fallbacks.
 */
export function selectAcpPermissionOption(
  options: readonly AcpPermissionOption[],
  allowAlways = true,
): string | undefined {
  if (!options || options.length === 0) return undefined;

  // 1. Prefer allow_always if requested and available
  if (allowAlways) {
    const alwaysOpt = options.find(
      (o) =>
        o.kind === "allow_always" ||
        o.optionId === "allow_always" ||
        o.optionId === "allow-always" ||
        false,
    );
    if (alwaysOpt) return alwaysOpt.optionId;
  }

  // 2. Prefer allow_once / allow
  const allowOpt = options.find(
    (o) =>
      o.kind === "allow_once" ||
      o.kind === "allow" ||
      o.optionId === "allow_once" ||
      o.optionId === "allow-once" ||
      o.optionId === "allow",
  );
  if (allowOpt) return allowOpt.optionId;

  return undefined;
}

/**
 * Selects a rejection option from the given permission options.
 */
export function selectAcpRejectOption(options: readonly AcpPermissionOption[]): string | undefined {
  if (!options || options.length === 0) return undefined;
  const rejectOpt = options.find((o) => {
    const id = o.optionId.toLowerCase();
    const kind = (o.kind ?? "").toLowerCase();
    const name = (o.name ?? "").toLowerCase();
    return (
      kind.includes("reject") ||
      kind.includes("deny") ||
      id.includes("reject") ||
      id.includes("deny") ||
      name.includes("reject") ||
      name.includes("deny")
    );
  });
  return rejectOpt?.optionId;
}

export async function decideAcpPermission(mode: string, request: AcpPermissionRequest, confirm?: (request: AcpPermissionRequest) => Promise<boolean>): Promise<string | undefined> {
  const reject = () => selectAcpRejectOption(request.options);
  if (mode === "yolo") return selectAcpPermissionOption(request.options, true) ?? reject();
  if (mode !== "default" && mode !== "auto_edit") return reject();
  if (mode === "auto_edit" && request.toolCall.kind === "edit") return selectAcpPermissionOption(request.options, false) ?? reject();
  try { if (confirm && await confirm(request)) return selectAcpPermissionOption(request.options, false) ?? reject(); } catch {}
  return reject();
}

export interface AcpPromptEventHandlers {
  readonly onChunk?: (text: string) => void;
  readonly onThought?: (thought: string) => void;
  readonly onToolCall?: (toolCall: AcpToolCallInfo) => void;
  readonly onToolCallUpdate?: (toolCallUpdate: AcpToolCallInfo) => void;
  readonly onUsageUpdate?: (usage: { used: number; size: number }) => void;
  readonly onPermissionRequest?: (request: AcpPermissionRequest) => Promise<string | undefined>;
}

/**
 * Streaming parser that splits combined message streams containing <thought> / <thinking>
 * tags into separate thought and text chunks for Pi's reasoning drawer.
 */
export class ThoughtStreamParser {
  private inThought = false;
  private buffer = "";

  constructor(
    private readonly onThoughtDelta: (delta: string) => void,
    private readonly onTextDelta: (delta: string) => void,
  ) {}

  public feed(chunk: string): void {
    this.buffer += chunk;
    this.process();
  }

  private process(): void {
    while (this.buffer.length > 0) {
      if (!this.inThought) {
        // Search for opening tag: <thought> or <thinking>
        const match = this.buffer.match(/<(thought|thinking)>/i);
        if (match && match.index !== undefined) {
          const before = this.buffer.slice(0, match.index);
          if (before) this.onTextDelta(before);
          this.inThought = true;
          this.buffer = this.buffer.slice(match.index + match[0].length);
        } else {
          // Check for possible partial opening tag at the end (e.g. "<th")
          const partialMatch = this.buffer.match(/<[a-z]{0,8}$/i);
          if (partialMatch && partialMatch.index !== undefined && partialMatch.index > 0) {
            const emitText = this.buffer.slice(0, partialMatch.index);
            this.buffer = this.buffer.slice(partialMatch.index);
            if (emitText) this.onTextDelta(emitText);
            break;
          } else if (!partialMatch) {
            this.onTextDelta(this.buffer);
            this.buffer = "";
          } else {
            break; // buffer only contains partial tag prefix, wait for next chunk
          }
        }
      } else {
        // In thought: search for closing tag: </thought> or </thinking>
        const match = this.buffer.match(/<\/(thought|thinking)>/i);
        if (match && match.index !== undefined) {
          const thoughtText = this.buffer.slice(0, match.index);
          if (thoughtText) this.onThoughtDelta(thoughtText);
          this.inThought = false;
          this.buffer = this.buffer.slice(match.index + match[0].length);
        } else {
          const partialMatch = this.buffer.match(/<\/[a-z]{0,8}$/i);
          if (partialMatch && partialMatch.index !== undefined && partialMatch.index > 0) {
            const emitThought = this.buffer.slice(0, partialMatch.index);
            this.buffer = this.buffer.slice(partialMatch.index);
            if (emitThought) this.onThoughtDelta(emitThought);
            break;
          } else if (!partialMatch) {
            this.onThoughtDelta(this.buffer);
            this.buffer = "";
          } else {
            break;
          }
        }
      }
    }
  }

  public flush(): void {
    if (this.buffer) {
      if (this.inThought) {
        this.onThoughtDelta(this.buffer);
      } else {
        this.onTextDelta(this.buffer);
      }
      this.buffer = "";
    }
  }
}

export function getActiveProfile(): string {
  const activeProfileState = runtimeState().activeProfileState;
  if (activeProfileState) return activeProfileState;
  const profiles = listProfiles();
  const firstAuth = profiles.find((p) => p.authenticated) ?? profiles[0];
  return firstAuth?.name ?? "shared-profile-01";
}

export function setActiveProfile(profile: string): void {
  runtimeState().activeProfileState = profile;
  // Close/switch only at the serialized operation boundary, never during a sibling task.
  updateAcpStatusBar();
}

export function getActiveMode(): string {
  return runtimeState().activeModeState;
}

export function setActiveMode(mode: string): void {
  if (!ACP_MODES.some(m => m.id === mode)) throw Error(`Unsupported ACP mode: ${mode}`);
  runtimeState().activeModeState = mode;
  updateAcpStatusBar();
}

export type AcpBarMode = "auto" | "on" | "off";
// Status is updated on session/turn events; no process-global resize listener.

export function getAcpBarMode(): AcpBarMode {
  return runtimeState().acpBarModeState;
}

export function setAcpBarMode(mode: AcpBarMode): void {
  runtimeState().acpBarModeState = mode;
}

export function formatCompactTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(2)}M`;
}

export interface AcpBarRenderOptions {
  readonly profile?: string;
  readonly turns?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly consumedTokens?: number;
  readonly maxContext?: number;
  readonly isStreaming?: boolean;
}

/**
 * Formats compact status line for Pi's footer:
 * 0T/0↓/0↑/0.00% (Profile)
 * - Turns: e.g. 0T, 4T
 * - Prompt tokens (input): e.g. 0↓, 1.3k↓
 * - Completion tokens (output): e.g. 0↑, 412↑
 * - Context capacity: e.g. 0.00%, 0.16%
 * - Active profile: e.g. (shared-profile-01)
 */
export function formatAcpStatusBar(options?: AcpBarRenderOptions): string | undefined {
  const { acpBarModeState, globalAcpManager } = runtimeState();
  if (acpBarModeState === "off") return undefined;

  const profile = options?.profile ?? getActiveProfile();
  const turns = options?.turns ?? globalAcpManager?.sessionTurnCount ?? 0;
  const promptTokens = options?.promptTokens ?? globalAcpManager?.cumulativeInputTokens ?? 0;
  const completionTokens = options?.completionTokens ?? globalAcpManager?.cumulativeOutputTokens ?? 0;
  const consumed = options?.consumedTokens ?? (promptTokens + completionTokens);
  const maxContext = options?.maxContext ?? 1048576; // 1.0M tokens
  const pct = ((consumed / maxContext) * 100).toFixed(2);

  const pStr = formatCompactTokens(promptTokens);
  const cStr = formatCompactTokens(completionTokens);

  return `${turns}T/${pStr}↓/${cStr}↑/${pct}% (${profile})`;
}

/**
 * Updates Pi's status bar / footer row with latest Antigravity ACP metrics.
 */
export function updateAcpStatusBar(ui?: ExtensionUIContext, options?: AcpBarRenderOptions): void {
  const { acpBarModeState, lastExtensionUi, isCurrentModelAntigravity } = runtimeState();
  const targetUi = ui ?? lastExtensionUi;
  if (!targetUi) return;

  if (acpBarModeState === "off") {
    try {
      targetUi.setStatus("acp", undefined);
    } catch {}
    return;
  }

  // If in auto mode and active model is NOT Antigravity, hide status bar to avoid cluttering other providers
  if (acpBarModeState === "auto" && !isCurrentModelAntigravity) {
    try {
      targetUi.setStatus("acp", undefined);
    } catch {}
    return;
  }

  const text = formatAcpStatusBar(options);
  try {
    targetUi.setStatus("acp", text);
    targetUi.setStatus("acp_tool", undefined);
  } catch {}
}


// Injected conversation turns from /agy-acp slash command executions
interface InjectedContextTurn {
  readonly prompt: string;
  readonly response: string;
  readonly timestamp: number;
}
// Injected context is owned by the extension factory below.

/**
 * Builds full transcript prompt from Pi's normalized conversation transcript for ACP.
 * Used for initial session turn (turn 0) or fresh sessions.
 */
export function buildPromptFromContext(context: TranscriptContext): string {
  const messages = context.messages;
  if (!messages || messages.length === 0) return "";

  const userMessages = messages.filter((m) => m.role === "user");
  const assistantMessages = messages.filter((m) => m.role === "assistant");

  // Single user turn with no prior assistant history: pass prompt directly
  if (userMessages.length === 1 && assistantMessages.length === 0 && !getCurrentSystemPrompt(messages).trim()) {
    const last = userMessages[0]!;
    if (typeof last.content === "string") return last.content;
    if (Array.isArray(last.content)) {
      return last.content.map((c: any) => c.text ?? "").join("\n").trim();
    }
  }

  const systemPrompt = getCurrentSystemPrompt(messages);
  const parts: string[] = systemPrompt.trim() ? [`[System Instructions]\n${systemPrompt.trim()}`] : [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const isLast = i === messages.length - 1;

    if (msg.role === "system") {
      continue; // Replayed once above, including structured prompt sections.
    } else if (msg.role === "user") {
      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content.map((c: any) => c.text ?? "").join("\n");
      }
      if (text.trim()) {
        if (isLast) {
          parts.push(`[Current User Request]\n${text.trim()}`);
        } else {
          parts.push(`[User]:\n${text.trim()}`);
        }
      }
    } else if (msg.role === "assistant") {
      const texts: string[] = [];
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text" && (block as any).text?.trim()) {
            texts.push((block as any).text.trim());
          }
        }
      }
      if (texts.length > 0) {
        parts.push(`[Assistant]:\n${texts.join("\n")}`);
      }
    } else if (msg.role === "toolResult") {
      const toolText = Array.isArray(msg.content)
        ? msg.content.map((c: any) => c.text ?? "").join("\n")
        : String(msg.content ?? "");
      if (toolText.trim()) {
        parts.push(`[Tool Result (${msg.toolCallId})]:\n${toolText.trim()}`);
      }
    }
  }

  return parts.join("\n\n");
}

export function buildPromptBlocksFromContext(context: TranscriptContext): any[] {
  const promptText = buildPromptFromContext(context);
  const blocks: any[] = [{ type: "text", text: promptText }];

  const lastMsg = context.messages[context.messages.length - 1];
  if (lastMsg && lastMsg.role === "user" && Array.isArray(lastMsg.content)) {
    for (const item of lastMsg.content) {
      if ((item as any).type === "image" && (item as any).data) {
        blocks.push({
          type: "image",
          data: (item as any).data,
          mimeType: (item as any).mimeType || "image/png",
        });
      }
    }
  }

  return blocks;
}

/**
 * Extracts only the newest user turn (plus tool results/images since the last assistant response).
 * Used when continuing an ongoing ACP session so ACP's native memory is preserved without duplication.
 */
export function buildLatestTurnPromptBlocks(context: TranscriptContext): any[] {
  const messages = context.messages;
  if (!messages || messages.length === 0) return [{ type: "text", text: "" }];

  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }

  if (lastAssistantIndex === -1) {
    return buildPromptBlocksFromContext(context);
  }

  const newMessages = messages.slice(lastAssistantIndex + 1);
  const parts: string[] = [];
  const imageBlocks: any[] = [];

  for (const msg of newMessages) {
    if (msg.role === "system") {
      const systemPrompt = getCurrentSystemPrompt(messages);
      if (systemPrompt.trim() && !parts.some(p => p.startsWith("[System Instructions]"))) parts.push(`[System Instructions]\n${systemPrompt.trim()}`);
    } else if (msg.role === "toolResult") {
      const toolText = Array.isArray(msg.content)
        ? msg.content.map((c: any) => c.text ?? "").join("\n")
        : String(msg.content ?? "");
      if (toolText.trim()) {
        parts.push(`[Tool Result (${msg.toolCallId})]:\n${toolText.trim()}`);
      }
    } else if (msg.role === "user") {
      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if ((item as any).type === "text" && (item as any).text) {
            text += (item as any).text;
          } else if ((item as any).type === "image" && (item as any).data) {
            imageBlocks.push({
              type: "image",
              data: (item as any).data,
              mimeType: (item as any).mimeType || "image/png",
            });
          }
        }
      }
      if (text.trim()) {
        parts.push(text.trim());
      }
    }
  }

  const promptText = parts.join("\n\n") || "(continue)";
  return [{ type: "text", text: promptText }, ...imageBlocks];
}

/**
 * Fast character-based token estimator conforming to Gemini tokenizer ratios
 * (~3.8 characters per token for English & source code; 258 tokens per image).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 3.8));
}

export function estimatePromptBlocksTokens(blocks: any[]): number {
  let count = 0;
  for (const block of blocks) {
    if (block.type === "text" && block.text) {
      count += estimateTokens(block.text);
    } else if (block.type === "image") {
      count += 258;
    }
  }
  return count;
}

export interface AcpTurnUsage {
  readonly input: number;
  readonly output: number;
  readonly total: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly source?: "reported" | "estimated" | "mixed";
}

/**
 * Persistent ACP Manager that keeps the `mgwcli agy acp serve <profile>` daemon
 * and active session alive across conversation turns, eliminating multi-second cold starts
 * and tracking cumulative token usage.
 */
export class PersistentAcpManager {
  public profile: string;
  public cwd: string;
  public child?: ChildProcess;
  public currentSessionId?: string;
  public currentModelId?: string;
  public currentModeId?: string;
  public sessionTurnCount: number = 0;
  public lastPiMessageCount: number = 0;
  public isBusy: boolean = false;
  public lastUsed: number = Date.now();

  // Cumulative token usage across the active session
  public cumulativeInputTokens: number = 0;
  public cumulativeOutputTokens: number = 0;
  public cumulativeTotalTokens: number = 0;
  public lastTurnUsage?: AcpTurnUsage;

  private rpcIdCounter: number = 1;
  private responses = new Map<number | string, (res: any) => void>();
  private onChunkCallback?: (chunk: string) => void;
  private activePromptHandlers?: AcpPromptEventHandlers;
  private activeRpcResetTimer?: () => void;
  private activeToolCalls = new Set<string>();
  private activePermissionRequests = new Set<number | string>();
  private quiescenceTimer?: NodeJS.Timeout;
  private activePromptRpcId?: string;
  private activePromptBlocks?: any[];
  private activeCollectedOutput: string = "";
  private latestTurnUsageUpdate?: any;
  private hasEmittedTextInTurn: boolean = false;
  private rl?: readline.Interface;
  private stderrOutput: string = "";
  private idleTimer?: NodeJS.Timeout;
  private startingPromise?: Promise<void>;

  public scheduleQuiescenceCheck(_delayMs = 6000): void {
    // Silence is not terminal evidence. sendRpc owns the inactivity deadline.
  }

  public clearQuiescenceTimer(): void {
    if (this.quiescenceTimer) {
      clearTimeout(this.quiescenceTimer);
      this.quiescenceTimer = undefined;
    }
  }

  public readonly piSessionId: string;
  private activeSessionId?: string;
  private activeMode?: string;
  private activePermissionPolicy?: AcpPermissionPolicy;
  private toolKinds = new Map<string, unknown>();
  public promptDispatched = false;
  private closingPromise?: Promise<void>;
  private closeFailure?: unknown;

  constructor(
    profile: string,
    cwd: string,
    private readonly spawnProcess: typeof spawn = spawn,
    public readonly mcpServers: readonly AcpMcpServerConfig[] = loadProjectMcpServers(cwd),
  ) {
    this.profile = profile;
    this.cwd = cwd;
    this.piSessionId = runtimeState().sessionId;
  }

  public isAlive(): boolean {
    return !!this.child && !this.child.killed && this.child.exitCode === null;
  }

  private touch(): void {
    if (!this.isAlive()) return;
    this.lastUsed = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // Idle shutdown after 30 minutes of inactivity
    this.idleTimer = setTimeout(() => {
      if (!this.isBusy) {
        void this.close().catch(() => { /* Sticky failure is surfaced on the next request. */ });
      }
    }, 30 * 60 * 1000);
  }

  public async ensureStarted(signal?: AbortSignal, onStatus?: (status: string) => void): Promise<void> {
    if (this.closeFailure) throw this.closeFailure;
    if (this.isAlive()) {
      this.touch();
      return;
    }

    if (this.startingPromise) {
      return this.startingPromise;
    }

    this.startingPromise = (async () => {
      try {
        onStatus?.(`Starting persistent Antigravity ACP server (${this.profile})...`);
        this.stderrOutput = "";

        this.child = this.spawnProcess(
          "mgwcli.exe",
          ["agy", "acp", "serve", this.profile, "--allow-browser-auth", "--confirm-config"],
          {
            cwd: this.cwd,
            stdio: ["pipe", "pipe", "pipe"],
            env: process.env,
          },
        );

        this.rl = readline.createInterface({ input: this.child.stdout!, crlfDelay: Infinity });

        this.child.stderr?.on("data", (chunk) => {
          this.stderrOutput = (this.stderrOutput + chunk.toString("utf8")).slice(-32768);
        });

        this.child.on("error", (err) => {
          for (const [, cb] of this.responses) {
            cb({ error: { message: `ACP process spawn error: ${err.message}` } });
          }
          this.responses.clear();
        });

        this.child.on("exit", (code) => {
          this.currentSessionId = undefined;
          this.child = undefined;
          this.sessionTurnCount = 0;
          for (const [, cb] of this.responses) {
            cb({ error: { message: `ACP server exited with code ${code}. Stderr: ${this.stderrOutput}` } });
          }
          this.responses.clear();
        });

        this.rl.on("line", async (line) => {
          if (!line.trim()) return;
          try {
            const msg = JSON.parse(line);
            if (msg.params?.sessionId === this.activeSessionId || msg.id === this.activePromptRpcId) this.activeRpcResetTimer?.();
            if (msg.method === "session/update") {
              if (!this.activeSessionId || msg.params?.sessionId !== this.activeSessionId) return;
              const update = msg.params?.update;
              if (update) {
                const type = update.sessionUpdate;
                if (type === "agent_thought_chunk") {
                  this.clearQuiescenceTimer();
                  const thought = update.content?.text ?? update.thought ?? "";
                  if (thought) {
                    this.activePromptHandlers?.onThought?.(thought);
                  }
                } else if (type === "agent_message_chunk") {
                  const chunk = update.content?.text ?? "";
                  if (chunk) {
                    this.hasEmittedTextInTurn = true;
                    this.activePromptHandlers?.onChunk?.(chunk);
                    if (this.onChunkCallback) {
                      this.onChunkCallback(chunk);
                    }
                    if (this.activeToolCalls.size === 0 && this.activePermissionRequests.size === 0) {
                      this.scheduleQuiescenceCheck(6000);
                    }
                  }
                } else if (type === "tool_call") {
                  if (!this.auditPresetTool(update)) return;
                  const toolId = (update as any).toolCallId || (update as any).id || `tool-${Date.now()}`;
                  this.activeToolCalls.add(toolId);
                  this.clearQuiescenceTimer();
                  this.activePromptHandlers?.onToolCall?.(update);
                } else if (type === "tool_call_update") {
                  if (!this.auditPresetTool(update)) return;
                  if (update.status === "completed" || update.status === "failed" || (update as any).status === "cancelled") {
                    const toolId = (update as any).toolCallId || (update as any).id;
                    if (toolId) {
                      this.activeToolCalls.delete(toolId);
                    } else {
                      this.activeToolCalls.clear();
                    }
                    if (this.activeToolCalls.size === 0 && this.hasEmittedTextInTurn) {
                      this.scheduleQuiescenceCheck(6000);
                    }
                  }
                  this.activePromptHandlers?.onToolCallUpdate?.(update);
                } else if (type === "usage_update") {
                  this.latestTurnUsageUpdate = update;
                  this.activePromptHandlers?.onUsageUpdate?.(update);
                  if (this.activeToolCalls.size === 0 && this.hasEmittedTextInTurn) {
                    this.scheduleQuiescenceCheck(1500);
                  }
                }
              }
            } else if (
              msg.method === "session/request_permission" ||
              msg.method === "session/requestPermission"
            ) {
              if (msg.id !== undefined) {
                this.activePermissionRequests.add(msg.id);
                this.clearQuiescenceTimer();
              }
              await this.handleIncomingPermissionRequest(msg);
              if (msg.id !== undefined) {
                this.activePermissionRequests.delete(msg.id);
                if (this.activeToolCalls.size === 0 && this.hasEmittedTextInTurn) {
                  this.scheduleQuiescenceCheck(6000);
                }
              }
            } else if (msg.id !== undefined && msg.method !== undefined) {
              this.sendError(msg.id, -32601, `Method '${msg.method}' is not implemented by client`);
            }

            // Strictly process incoming responses to client requests:
            // A JSON-RPC response MUST NOT have a method and MUST match a registered response ID
            if (msg.method === undefined && msg.id !== undefined && this.responses.has(msg.id)) {
              this.clearQuiescenceTimer();
              this.responses.get(msg.id)!(msg);
              this.responses.delete(msg.id);
            }
          } catch {}
        });

        // 1. Initialize
        onStatus?.("Initializing ACP protocol...");
        await this.sendRpc("initialize", {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "pi-agy-acp", version: "1.0.0" },
        }, 60000, signal);

        // 2. Authenticate
        onStatus?.("Authenticating personal OAuth session...");
        await this.sendRpc("authenticate", { methodId: "oauth-personal" }, 60000, signal);

        this.touch();
      } catch (error) {
        await this.close();
        throw error;
      } finally {
        this.startingPromise = undefined;
      }
    })();

    return this.startingPromise;
  }

  public async ensureSession(
    modelId: string,
    modeId: string,
    forceNew = false,
    signal?: AbortSignal,
    onStatus?: (status: string) => void,
  ): Promise<string> {
    if (!ACP_MODES.some(m => m.id === modeId)) throw Error(`Unsupported ACP mode: ${modeId}`);
    await this.ensureStarted(signal, onStatus);

    if (forceNew) {
      if (this.currentSessionId) {
        await this.sendRpc("session/close", { sessionId: this.currentSessionId }, 5000).catch(() => undefined);
      }
      clearPersistedSession(this.cwd, this.piSessionId, this.profile);
      this.currentSessionId = undefined;
      this.sessionTurnCount = 0;
      this.cumulativeInputTokens = 0;
      this.cumulativeOutputTokens = 0;
      this.cumulativeTotalTokens = 0;
    }

    if (!this.currentSessionId) {
      // Check if we can resume a persisted session from disk
      const stored = loadPersistedSession(this.cwd, this.piSessionId, this.profile);
      if (stored && stored.sessionId && stored.profile === this.profile) {
        try {
          onStatus?.(`Resuming persisted ACP session (${stored.sessionId.slice(0, 8)}...)...`);
          await this.sendRpc("session/resume", {
            sessionId: stored.sessionId,
            cwd: this.cwd,
            mcpServers: this.mcpServers,
          }, 30000, signal);

          this.currentSessionId = stored.sessionId;
          this.sessionTurnCount = stored.sessionTurnCount ?? 0;
          this.currentModelId = stored.modelId;
          this.currentModeId = stored.modeId;
          this.cumulativeInputTokens = stored.cumulativeInputTokens ?? 0;
          this.cumulativeOutputTokens = stored.cumulativeOutputTokens ?? 0;
          this.cumulativeTotalTokens = this.cumulativeInputTokens + this.cumulativeOutputTokens;
          onStatus?.(`Resumed ACP session (${this.sessionTurnCount} turns, ~${this.cumulativeTotalTokens.toLocaleString()} tokens).`);
        } catch {
          // Stale or unresumable session on server, discard and allocate fresh
          clearPersistedSession(this.cwd, this.piSessionId, this.profile);
          this.currentSessionId = undefined;
        }
      }

      if (!this.currentSessionId) {
        onStatus?.("Creating ACP conversation session...");
        const res = await this.sendRpc("session/new", {
          cwd: this.cwd,
          mcpServers: this.mcpServers,
        }, 60000, signal);
        this.currentSessionId = res?.sessionId;
        if (!this.currentSessionId) throw new Error("ACP server failed to allocate a sessionId.");
        this.sessionTurnCount = 0;
        this.currentModelId = undefined;
        this.currentModeId = undefined;
        this.cumulativeInputTokens = 0;
        this.cumulativeOutputTokens = 0;
        this.cumulativeTotalTokens = 0;

        savePersistedSession(this.cwd, {
          sessionId: this.currentSessionId,
          profile: this.profile,
          modelId: undefined,
          modeId: undefined,
          cwd: this.cwd,
          sessionTurnCount: 0,
          cumulativeInputTokens: 0,
          cumulativeOutputTokens: 0,
          lastUsed: Date.now(),
        }, this.piSessionId);
      }
    }

    if (modelId && this.currentModelId !== modelId) {
      await this.sendRpc("session/set_config_option", {
        sessionId: this.currentSessionId,
        configId: "model",
        value: modelId,
      }, 10000, signal);
      this.currentModelId = modelId;
    }

    if (modeId && this.currentModeId !== modeId) {
      await this.sendRpc("session/set_config_option", {
        sessionId: this.currentSessionId,
        configId: "mode",
        value: modeId,
      }, 10000, signal);
      this.currentModeId = modeId;
    }

    this.touch();
    return this.currentSessionId!;
  }

  public async resetSession(): Promise<void> {
    if (this.currentSessionId && this.isAlive()) {
      await this.sendRpc("session/close", { sessionId: this.currentSessionId }, 5000).catch(() => undefined);
    }
    clearPersistedSession(this.cwd, this.piSessionId, this.profile);
    this.currentSessionId = undefined;
    this.sessionTurnCount = 0;
    this.lastPiMessageCount = 0;
    this.cumulativeInputTokens = 0;
    this.cumulativeOutputTokens = 0;
    this.cumulativeTotalTokens = 0;
    this.lastTurnUsage = undefined;
  }

  public sendRpc(method: string, params: any, timeoutMs = 60000, signal?: AbortSignal): Promise<any> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(Error("Request was aborted"));
      if (!this.isAlive() || !this.child?.stdin?.writable) return reject(Error("ACP server process is not running"));
      const id = `pi-${Date.now()}-${this.rpcIdCounter++}`;
      let timer: NodeJS.Timeout;
      let settled = false;
      const finish = (res: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.responses.delete(id);
        if (this.activePromptRpcId === id) { this.activePromptRpcId = undefined; this.activeRpcResetTimer = undefined; }
        if (res.error) reject(Error(res.error.message ?? `ACP error on ${method}`));
        else resolve(res.result);
      };
      const cancel = () => {
        if (method === "session/prompt") {
          try { this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: params.sessionId } })}\n`); } catch {}
        }
      };
      const onAbort = () => { cancel(); finish({ error: { message: "Request was aborted" } }); };
      const resetTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => { cancel(); finish({ error: { message: `ACP request '${method}' timed out after ${timeoutMs}ms of inactivity.` } }); }, timeoutMs);
      };
      if (method === "session/prompt") { this.activePromptRpcId = id; this.activeRpcResetTimer = resetTimer; }
      this.responses.set(id, finish);
      resetTimer();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      try {
        if (method === "session/prompt") this.promptDispatched = true;
        this.child!.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, error => { if (error) finish({ error: { message: error.message } }); });
      } catch (error: any) { finish({ error: { message: error.message } }); }
    });
  }

  public sendResponse(id: number | string, result: unknown): void {
    if (!this.child?.stdin?.writable) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
    } catch {}
  }

  public sendError(id: number | string, code: number, message: string, data?: unknown): void {
    if (!this.child?.stdin?.writable) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, data } })}\n`);
    } catch {}
  }

  private auditPresetTool(update: any): boolean {
    if (!this.activePermissionPolicy) return true;
    const id = update.toolCallId ?? update.id;
    const kind = update.kind ?? (id ? this.toolKinds.get(id) : undefined);
    if (id && update.kind !== undefined) this.toolKinds.set(id, update.kind);
    if (presetAllowsKind(this.activePermissionPolicy, kind)) return true;
    this.failPresetCeiling(`Prohibited or unclassified tool activity (${String(kind)}) under ${this.activePermissionPolicy}`);
    return false;
  }

  private failPresetCeiling(message: string): void {
    try { this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.activeSessionId } })}\n`); } catch {}
    const id = this.activePromptRpcId;
    if (id) this.responses.get(id)?.({ error: { message: `CEILING_VIOLATION_OBSERVED: ${message}` } });
  }

  private async handleIncomingPermissionRequest(msg: any): Promise<void> {
    if (msg.id === undefined) return;
    const params = msg.params ?? {};
    const request: AcpPermissionRequest = { sessionId: params.sessionId, toolCall: params.toolCall ?? {}, options: Array.isArray(params.options) ? params.options : [] };
    const promptId = this.activePromptRpcId;
    let decision: string | undefined;
    if (this.isBusy && request.sessionId === this.activeSessionId) {
      try {
        if (this.activePermissionPolicy) {
          const allowed = presetAllowsKind(this.activePermissionPolicy, request.toolCall.kind);
          decision = request.options.find(o => o.kind === (allowed ? "allow_once" : "reject_once"))?.optionId;
          if (!allowed) {
            this.sendResponse(msg.id, { outcome: decision ? { outcome: "selected", optionId: decision } : { outcome: "cancelled" } });
            this.failPresetCeiling(`Permission request for ${String(request.toolCall.kind)} denied under ${this.activePermissionPolicy}`);
            return;
          }
        } else {
          decision = this.activePromptHandlers?.onPermissionRequest
            ? await this.activePromptHandlers.onPermissionRequest(request)
            : await decideAcpPermission(this.activeMode ?? "default", request);
        }
      } catch {}
    }
    if (!this.isBusy || this.activePromptRpcId !== promptId || !request.options.some(o => o.optionId === decision)) decision = undefined;
    this.sendResponse(msg.id, { outcome: decision ? { outcome: "selected", optionId: decision } : { outcome: "cancelled" } });
  }

  public async prompt(
    promptBlocks: any[],
    signal?: AbortSignal,
    handlersOrChunk?: AcpPromptEventHandlers | ((chunk: string) => void),
    taskSession?: { id: string; mode: string; permissionPolicy?: AcpPermissionPolicy },
  ): Promise<{ stopReason: string; usage: AcpTurnUsage }> {
    const handlers: AcpPromptEventHandlers =
      typeof handlersOrChunk === "function" ? { onChunk: handlersOrChunk } : handlersOrChunk ?? {};
    if (this.isBusy) throw Error("ACP manager is busy");
    if (!(taskSession?.id ?? this.currentSessionId)) throw Error("ACP session is missing");
    this.activeSessionId = taskSession?.id ?? this.currentSessionId;
    if (taskSession?.permissionPolicy && taskSession.mode !== "default") throw Error("Preset tasks require permission-gated mode default");
    this.activeMode = taskSession?.mode ?? this.currentModeId;
    this.activePermissionPolicy = taskSession?.permissionPolicy;
    this.toolKinds.clear();
    this.activePromptHandlers = handlers;
    this.isBusy = true;
    this.hasEmittedTextInTurn = false;
    this.activeToolCalls.clear();
    this.activePermissionRequests.clear();
    this.latestTurnUsageUpdate = undefined;
    this.activePromptBlocks = promptBlocks;
    this.activeCollectedOutput = "";
    this.clearQuiescenceTimer();

    let collectedOutput = "";
    const origChunk = handlers.onChunk;
    (handlers as any).onChunk = (chunk: string) => {
      collectedOutput += chunk;
      this.activeCollectedOutput = collectedOutput;
      origChunk?.(chunk);
    };
    this.touch();

    try {
      const res = await this.sendRpc("session/prompt", {
        sessionId: this.activeSessionId,
        prompt: promptBlocks,
      }, 300000, signal);
      if (!res || !["end_turn", "stop", "completed", "max_tokens"].includes(res.stopReason)) throw Error(`ACP prompt did not complete successfully: ${res?.stopReason ?? "missing terminal reason"}`);
      if (!taskSession) this.sessionTurnCount++;
      const rawStop = res.stopReason;

      const usage = normalizeAcpUsage(res.usage ?? this.latestTurnUsageUpdate?.usage ?? this.latestTurnUsageUpdate, estimatePromptBlocksTokens(promptBlocks), estimateTokens(collectedOutput));

      if (!taskSession) {
        this.lastTurnUsage = usage;
        this.cumulativeInputTokens += usage.input;
        this.cumulativeOutputTokens += usage.output;
        this.cumulativeTotalTokens += usage.total;
      }

      if (this.currentSessionId && !taskSession) {
        savePersistedSession(this.cwd, {
          sessionId: this.currentSessionId,
          profile: this.profile,
          modelId: this.currentModelId,
          modeId: this.currentModeId,
          cwd: this.cwd,
          sessionTurnCount: this.sessionTurnCount,
          cumulativeInputTokens: this.cumulativeInputTokens,
          cumulativeOutputTokens: this.cumulativeOutputTokens,
          lastUsed: Date.now(),
        }, this.piSessionId);
      }

      return { stopReason: rawStop, usage };
    } catch (error) {
      await this.close();
      throw error;
    } finally {
      this.clearQuiescenceTimer();
      this.activeToolCalls.clear();
      this.activePermissionRequests.clear();
      this.activePromptRpcId = undefined;
      this.activePromptBlocks = undefined;
      this.activeCollectedOutput = "";
      this.latestTurnUsageUpdate = undefined;
      this.hasEmittedTextInTurn = false;
      this.isBusy = false;
      this.activeSessionId = undefined;
      this.activeMode = undefined;
      this.activePermissionPolicy = undefined;
      this.toolKinds.clear();
      this.activePromptHandlers = undefined;
      this.touch();
    }
  }

  public async close(): Promise<void> {
    if (this.closeFailure) throw this.closeFailure;
    if (this.closingPromise) return this.closingPromise;
    this.closingPromise = this.closeInternal();
    try { await this.closingPromise; }
    catch (error) { this.closeFailure = error; throw error; }
    finally { this.closingPromise = undefined; }
  }

  private async closeInternal(): Promise<void> {
    for (const [, cb] of this.responses) cb({ error: { message: "ACP manager closed" } });
    this.responses.clear();
    this.rl?.close();
    this.rl = undefined;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.clearQuiescenceTimer();
    this.activeToolCalls.clear();
    this.activePermissionRequests.clear();
    this.activePromptRpcId = undefined;
    this.activePromptBlocks = undefined;
    this.activeCollectedOutput = "";
    this.latestTurnUsageUpdate = undefined;
    this.hasEmittedTextInTurn = false;
    const child = this.child;
    this.child = undefined;
    this.currentSessionId = undefined;
    this.sessionTurnCount = 0;
    this.lastPiMessageCount = 0;
    this.cumulativeInputTokens = 0;
    this.cumulativeOutputTokens = 0;
    this.cumulativeTotalTokens = 0;
    this.lastTurnUsage = undefined;

    if (!child) { releaseProfileManager(this); return; }
    child.stdin?.end();
    if (child.exitCode === null) {
      await new Promise<void>((resolve, reject) => {
        let killTimer: NodeJS.Timeout;
        const cleanup = () => { clearTimeout(killTimer); clearTimeout(deadline); child.off("exit", exited); };
        const exited = () => { cleanup(); resolve(); };
        const deadline = setTimeout(() => { cleanup(); reject(Error("ACP process cleanup uncertain; mgwcli ownership retained")); }, 5000);
        killTimer = setTimeout(() => { try { child.kill(); } catch {} }, 2500);
        child.once("exit", exited);
        if (child.exitCode !== null) exited();
      });
    }
    releaseProfileManager(this);
  }
}

export async function getOrCreateAcpManager(profile: string, cwd: string, mcpServers?: readonly AcpMcpServerConfig[]): Promise<PersistentAcpManager> {
  const state = runtimeState();
  const resolvedMcpServers = mcpServers ?? loadProjectMcpServers(cwd);
  let manager = state.globalAcpManager;
  if (manager && (manager.profile !== profile || canonicalAcpCwd(manager.cwd) !== canonicalAcpCwd(cwd) || manager.piSessionId !== state.sessionId || JSON.stringify(manager.mcpServers) !== JSON.stringify(resolvedMcpServers))) {
    await manager.close(); manager = undefined;
  }
  manager ??= new PersistentAcpManager(profile, cwd, state.spawnProcess, resolvedMcpServers);
  await claimProfileManager(manager);
  state.globalAcpManager = manager;
  manager.promptDispatched = false;
  return manager;
}

export interface RunAcpRequest {
  readonly profile?: string;
  readonly agent?: string;
  readonly prompt: string;
  readonly promptBlocks?: any[];
  readonly modelId?: string;
  readonly modeId?: string;
  readonly cwd: string;
  /** Optional isolated workspace root for read-only scout tasks. */
  readonly workspaceRoot?: string;
  /** Explicit MCP config; [] disables project MCP servers for isolated workspace overrides. */
  readonly mcpServers?: readonly AcpMcpServerConfig[];
  readonly signal?: AbortSignal;
  readonly onChunk?: (text: string) => void;
  readonly onStatus?: (status: string) => void;
  /** Trusted durability hook. Synchronous failure prevents prompt dispatch; not model-facing. */
  readonly onCheckpoint?: (point: { stage: "dispatch-intent"; sessionId: string; profile: string }) => void;
}

export type RunAcpResult = AcpTaskResult;

/**
 * Executes a one-off or delegated ACP task.
 * If the target profile matches the active profile and the daemon is idle,
 * it runs on the warm server with a dedicated session (<2s start).
 */
async function executeAcpTaskInternal(request: RunAcpRequest & { profile: string }, result: RunAcpResult, preset?: ResolvedAcpPreset): Promise<void> {
  const modelId = request.modelId ?? "gemini-3.8-flash-high";
  const modeId = request.modeId ?? "auto_edit";
  const collectedChunks: string[] = [];
  let mgr: PersistentAcpManager | undefined;
  let stage = "startup";

  // Delegated work uses the shared protocol implementation and a dedicated session.
  {
    try {
      mgr = await getOrCreateAcpManager(request.profile, request.cwd, request.mcpServers);
      if (mgr.isBusy) throw Error("ACP manager is busy");
        await mgr.ensureStarted(request.signal, request.onStatus);
        result.effective.profile = request.profile;
        stage = "session";
        request.onStatus?.(`Creating delegated task session in ${request.cwd}...`);
        const taskSessionRes = await mgr.sendRpc("session/new", {
          cwd: request.cwd,
          mcpServers: mgr.mcpServers,
        }, 60000, request.signal);
        const taskSessionId = taskSessionRes?.sessionId;
        if (typeof taskSessionId !== "string" || !taskSessionId) throw new Error("Failed to allocate delegated session.");
        result.sessionId = taskSessionId;
        stage = "model";

        if (modelId) {
          await mgr.sendRpc("session/set_config_option", {
            sessionId: taskSessionId,
            configId: "model",
            value: modelId,
          }, 10000, request.signal);
          result.effective.model = modelId;
        }
        stage = "mode";
        if (modeId) {
          await mgr.sendRpc("session/set_config_option", {
            sessionId: taskSessionId,
            configId: "mode",
            value: modeId,
          }, 10000, request.signal);
          result.effective.mode = modeId;
        }

        request.onStatus?.(`Running task with ${modelId}...`);
        const promptPayload = request.promptBlocks ?? [{ type: "text", text: request.prompt }];
        if (preset) promptPayload.unshift({ type: "text", text: `[ACP preset ${preset.preset.id}; permission ceiling ${preset.preset.permissionPolicy}; no shell execution]\n${preset.preset.instructions}` });
        stage = "prompt";

        // Temporarily pipe chunks
        const ui = runtimeState().lastExtensionUi;
        const handlers: AcpPromptEventHandlers = {
          onChunk: chunk => { collectedChunks.push(chunk); request.onChunk?.(chunk); },
          onPermissionRequest: permission => decideAcpPermission(modeId, permission, ui ? async req => ui.confirm("ACP Permission Request", req.toolCall.title ?? req.toolCall.name ?? "Allow tool action?") : undefined),
        };

        request.onCheckpoint?.({ stage: "dispatch-intent", sessionId: taskSessionId, profile: request.profile });
        const promptRes = await mgr.prompt(promptPayload, request.signal, handlers, { id: taskSessionId, mode: modeId, permissionPolicy: preset?.preset.permissionPolicy });
        result.stopReason = promptRes.stopReason;
        result.usage = promptRes.usage as AcpResultUsage;
        result.status = promptRes.stopReason === "max_tokens" ? "incomplete" : "completed";
        result.isError = result.status !== "completed";
        if (result.isError) setTaskFailure(result, "TOKEN_LIMIT", "Task reached the token limit; output is incomplete", "incomplete");
        stage = "cleanup";
        if (mgr.isAlive()) await mgr.sendRpc("session/close", { sessionId: taskSessionId }, 5000);
    } catch (error: any) {
      setTaskFailure(result, stage === "cleanup" ? "CLEANUP_FAILED" : "ACP_FAILED", error?.message ?? String(error), "failed");
      try { await mgr?.close(); } catch (cleanupError: any) { setTaskFailure(result, "CLEANUP_FAILED", `${result.error}; ${cleanupError?.message ?? String(cleanupError)}`, "failed"); }
    } finally {
      result.text = collectedChunks.join("");
      result.promptDispatched = mgr?.promptDispatched ?? false;
    }
  }
}

/**
 * Top-level ACP task execution with automatic rate-limit detection and profile auto-switching.
 */
function setTaskFailure(result: RunAcpResult, code: AcpFailureCode, message: string, status: RunAcpResult["status"]): void {
  if (code !== "CLEANUP_FAILED" && /CEILING_VIOLATION_OBSERVED/.test(message)) { code = "CEILING_VIOLATION_OBSERVED"; status = "blocked"; }
  else if (code !== "CLEANUP_FAILED" && /abort/i.test(message)) { code = "ABORTED"; status = "aborted"; }
  result.status = status; result.isError = true; result.error = message; result.failure = { code, message };
  if (status !== "incomplete") result.stopReason = status === "aborted" ? "aborted" : "error";
}

export async function executeAcpTask(request: RunAcpRequest): Promise<RunAcpResult> {
  const started = Date.now();
  const result: RunAcpResult = {
    version: 1, jobId: randomUUID(), sessionId: null, agent: request.agent ?? null,
    requested: { profile: request.profile ?? null, model: request.modelId ?? null, mode: request.modeId ?? null },
    effective: { profile: null, model: null, mode: null, cwd: request.cwd, permissionPolicy: "mode", enforcement: "session-mode" },
    status: "failed", text: "", modelId: request.modelId ?? "gemini-3.8-flash-high", profile: null, stopReason: "error", isError: true, failure: null, usage: null, promptDispatched: false,
    attempts: 0, profilesTried: [], startedAt: new Date(started).toISOString(), completedAt: new Date(started).toISOString(), durationMs: 0,
  };
  try {
    const state = runtimeState();
    request = { ...request, promptBlocks: request.promptBlocks ? structuredClone(request.promptBlocks) : undefined, signal: request.signal ? AbortSignal.any([request.signal, state.lifecycle.signal]) : state.lifecycle.signal };
    if (request.signal?.aborted) throw Error("ACP request aborted before dispatch");
    if (request.workspaceRoot !== undefined) {
      if (request.agent !== "agy-scout") throw new AcpPresetError("PRESET_OVERRIDE_FORBIDDEN", "workspaceRoot is supported only for the read-only agy-scout preset");
      const workspaceRoot = resolveScoutWorkspaceRoot(request.workspaceRoot, request.cwd);
      request = { ...request, cwd: workspaceRoot, mcpServers: [] };
      result.effective.cwd = workspaceRoot;
    }
    let preset: ResolvedAcpPreset | undefined;
    if (request.agent !== undefined) {
      if (state.presetLoadError) throw new AcpPresetError("PRESET_CONFIG_INVALID", state.presetLoadError);
      preset = resolveAcpPreset(state.presetCatalog ?? defaultAcpPresets(), { agent: request.agent, profile: request.profile, model: request.modelId, mode: request.modeId }, getActiveProfile(), listProfiles());
      request = { ...request, modelId: preset.model, modeId: preset.mode };
      result.effective.permissionPolicy = preset.preset.permissionPolicy;
      result.effective.enforcement = "acp-permission-and-event-gate";
    }
    if (!ACP_MODES.some(m => m.id === (request.modeId ?? "auto_edit"))) throw new Error("Unsupported ACP mode");
    if (!request.prompt.trim() && !request.promptBlocks?.length) throw Error("ACP task prompt is empty");
    let currentProfile = preset?.profiles[0] ?? request.profile ?? getActiveProfile();
    result.modelId = request.modelId ?? "gemini-3.8-flash-high";
    for (let attempt = 0; attempt < 4; attempt++) {
      result.sessionId = null; result.effective.profile = null; result.effective.model = null; result.effective.mode = null;
      result.profile = currentProfile;
      await withProfileOperation(currentProfile, request.signal, async () => {
        result.attempts++; result.profilesTried.push(currentProfile);
        await executeAcpTaskInternal({ ...request, profile: currentProfile, promptBlocks: request.promptBlocks ? structuredClone(request.promptBlocks) : undefined }, result, preset);
      });
      if (!result.isError || result.promptDispatched || result.failure?.code === "CLEANUP_FAILED" || !isRateLimitOrQuotaError(result.error) || !getAutoSwitchEnabled() || request.signal?.aborted || attempt === 3) break;
      markProfileRateLimited(currentProfile, result.error ?? "Rate limit");
      const next = preset ? preset.profiles.find(p => !result.profilesTried.includes(p) && !isProfileRateLimited(p)) : findNextHealthyProfile(currentProfile)?.name;
      if (!next) break;
      request.onStatus?.(`Rate limit on ${currentProfile}. Retrying task on ${next} before dispatch...`);
      if (!preset) setActiveProfile(next);
      currentProfile = next;
      result.failure = null; delete result.error;
    }
  } catch (error: any) {
    setTaskFailure(result, error instanceof AcpPresetError ? error.code : result.attempts === 0 && !/abort/i.test(error?.message ?? "") ? "INVALID_REQUEST" : "ACP_FAILED", error?.message ?? String(error), error instanceof AcpPresetError ? "blocked" : "failed");
  } finally {
    result.durationMs = Math.max(0, Date.now() - started); result.completedAt = new Date().toISOString();
  }
  return result;
}

/**
 * Primary streamSimple provider implementation for Pi.
 * Allows Pi to use Antigravity ACP as its primary model agent via /model.
 * Stays warm and alive across turns, delivering instant responses and accurate token usage reporting.
 * Automatically recovers from rate limits / 429 errors by switching to the next healthy profile and retrying.
 */
export function streamSimpleAcp(
  model: Model<any>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const modeId = getActiveMode();
  const cwd = runtimeState().cwd;
  const lastExtensionUi = runtimeState().lastExtensionUi;
  const signal = options?.signal ? AbortSignal.any([options.signal, runtimeState().lifecycle.signal]) : runtimeState().lifecycle.signal;

  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };

  (async () => {
    let currentProfile = getActiveProfile();
    const maxRetries = 3;
    let attempt = 0;
    const collectedChunks: string[] = [];

    // Track active blocks: thinking and text
    let thinkingBlockIndex = -1;
    let textBlockIndex = -1;
    let isThinkingActive = false;
    let isTextActive = false;

    const endThinking = () => {
      if (isThinkingActive && thinkingBlockIndex >= 0) {
        isThinkingActive = false;
        const block = output.content[thinkingBlockIndex] as ThinkingContent;
        stream.push({ type: "thinking_end", contentIndex: thinkingBlockIndex, content: block.thinking, partial: output });
      }
    };

    const endText = () => {
      if (isTextActive && textBlockIndex >= 0) {
        isTextActive = false;
        const block = output.content[textBlockIndex] as TextContent;
        stream.push({ type: "text_end", contentIndex: textBlockIndex, content: block.text, partial: output });
      }
    };

    const handleThoughtChunk = (chunk: string) => {
      if (!chunk) return;
      if (!isThinkingActive) {
        endText();
        isThinkingActive = true;
        thinkingBlockIndex = output.content.length;
        output.content.push({ type: "thinking", thinking: "" });
        stream.push({ type: "thinking_start", contentIndex: thinkingBlockIndex, partial: output });
      }
      const block = output.content[thinkingBlockIndex] as ThinkingContent;
      block.thinking += chunk;
      stream.push({ type: "thinking_delta", contentIndex: thinkingBlockIndex, delta: chunk, partial: output });
    };

    const handleTextChunk = (chunk: string) => {
      if (!chunk) return;
      collectedChunks.push(chunk);
      if (!isTextActive) {
        endThinking();
        isTextActive = true;
        try {
          lastExtensionUi?.setWorkingMessage(undefined);
        } catch {}
        textBlockIndex = output.content.length;
        output.content.push({ type: "text", text: "" });
        stream.push({ type: "text_start", contentIndex: textBlockIndex, partial: output });
      }
      const block = output.content[textBlockIndex] as TextContent;
      block.text += chunk;
      stream.push({ type: "text_delta", contentIndex: textBlockIndex, delta: chunk, partial: output });
    };

    const parser = new ThoughtStreamParser(handleThoughtChunk, handleTextChunk);

    while (attempt <= maxRetries) {
      attempt++;
      try {
        if (signal.aborted) {
          throw new Error("Request was aborted before execution started.");
        }

        if (!cwd) throw Error("ACP provider has no bound session working directory");
        const { mgr, promptResult } = await withProfileOperation(currentProfile, signal, async () => {
        const mgr = await getOrCreateAcpManager(currentProfile, cwd);

        // Detect conversation reset or rollback in Pi context
        const piMsgCount = context.messages?.length ?? 0;
        const isFreshPiSession =
          piMsgCount <= 1 || (mgr.lastPiMessageCount > 0 && piMsgCount < mgr.lastPiMessageCount);

        // Ensure warm server & session are active (resuming if available)
        await mgr.ensureSession(model.id, modeId, isFreshPiSession, signal);

        // Determine prompt: full context for fresh session (turn 0), incremental turn for ongoing session
        const promptBlocks =
          mgr.sessionTurnCount === 0
            ? buildPromptBlocksFromContext(context)
            : buildLatestTurnPromptBlocks(context);

        if (attempt === 1) {
          stream.push({ type: "start", partial: output });
        }

        const promptResult = await mgr.prompt(
          promptBlocks,
          signal,
          {
            onChunk: (chunk) => {
              parser.feed(chunk);
            },
            onThought: (thought) => {
              handleThoughtChunk(thought);
            },
            onToolCall: (toolCall) => {
              endThinking();
              const title = toolCall.title || toolCall.name || "Running tool...";
              const loc = toolCall.locations?.[0]?.path ? ` (${toolCall.locations[0].path})` : "";
              try {
                lastExtensionUi?.setWorkingMessage(`🔧 ${title}${loc}`);
              } catch {}
            },
            onToolCallUpdate: (toolCallUpdate) => {
              if (toolCallUpdate.status === "completed" || toolCallUpdate.status === "failed") {
                try {
                  lastExtensionUi?.setWorkingMessage(undefined);
                } catch {}
              }
            },
            onPermissionRequest: async (request) => {
              const toolTitle = request.toolCall.title || request.toolCall.name || "Tool action";
              const loc = request.toolCall.locations?.[0]?.path ? ` (${request.toolCall.locations[0].path})` : "";

              return decideAcpPermission(modeId, request, lastExtensionUi ? async () => lastExtensionUi.confirm("ACP Permission Request", `Allow Antigravity ACP to execute: ${toolTitle}${loc}?`) : undefined);
            },
          },
        );

        return { mgr, promptResult };
        });
        parser.flush();
        endThinking();
        endText();
        try {
          lastExtensionUi?.setWorkingMessage(undefined);
          lastExtensionUi?.setStatus("acp_tool", undefined);
        } catch {}

        mgr.lastPiMessageCount = context.messages?.length ?? 0;
        output.stopReason = promptResult.stopReason === "max_tokens" ? "length" : "stop";

        // Populate authoritative usage metadata for Pi's token accounting & /usage command
        output.usage = {
          input: promptResult.usage.input,
          output: promptResult.usage.output,
          cacheRead: promptResult.usage.cacheRead,
          cacheWrite: promptResult.usage.cacheWrite,
          totalTokens: promptResult.usage.total,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };

        // Update Pi status bar row immediately with latest turn & cumulative token consumption
        updateAcpStatusBar(lastExtensionUi);

        if (output.content.length === 0) {
          const fallbackText = collectedChunks.join("") || "(Empty response from Antigravity ACP)";
          output.content.push({ type: "text", text: fallbackText });
          stream.push({ type: "text_start", contentIndex: 0, partial: output });
          stream.push({ type: "text_end", contentIndex: 0, content: fallbackText, partial: output });
        }

        stream.push({ type: "done", reason: output.stopReason, message: output });
        stream.end();
        return;
      } catch (error: any) {
        try {
          lastExtensionUi?.setWorkingMessage(undefined);
          lastExtensionUi?.setStatus("acp_tool", undefined);
        } catch {}

        const isAborted = signal.aborted;
        if (isAborted) {
          output.stopReason = "aborted";
          output.errorMessage = "Request was aborted by user.";
          stream.push({ type: "error", reason: output.stopReason, error: output });
          stream.end();
          return;
        }

        const isRateLimit = isRateLimitOrQuotaError(error);
        if (isRateLimit && !runtimeState().globalAcpManager?.promptDispatched && getAutoSwitchEnabled() && attempt <= maxRetries) {
          markProfileRateLimited(currentProfile, error?.message ?? "Rate limit");
          const nextHealthy = findNextHealthyProfile(currentProfile);

          if (nextHealthy) {
            const switchMsg = `⚠️ Rate limit on ${currentProfile}. Auto-switching to ${nextHealthy.name}...`;
            try {
              lastExtensionUi?.notify(switchMsg, "warning");
            } catch {}

            const notice = `\n\n*[Rate limit reached on ${currentProfile}. Auto-switching to ${nextHealthy.name}...]*\n\n`;
            handleTextChunk(notice);

            setActiveProfile(nextHealthy.name);
            currentProfile = nextHealthy.name;
            continue;
          }
        }

        output.stopReason = "error";
        let errMsg = error instanceof Error ? error.message : String(error);
        if (isRateLimit) {
          errMsg = `Rate limit reached on ${currentProfile}. All alternative profiles are currently exhausted or rate-limited. (${errMsg})`;
        }
        output.errorMessage = errMsg;
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
        return;
      }
    }
  })();

  return stream;
}

export default function piAgyAcpExtension(hostPi: ExtensionAPI) {
  const scope = createAcpRuntime();
  const pi = bindRuntimeApi(hostPi, scope);
  let lastExtensionUi: ExtensionUIContext | undefined;
  let isCurrentModelAntigravity = true;
  const acpInjectedHistory: InjectedContextTurn[] = [];
  // 1. Register Provider: "antigravity"
  // Exposes all 11 Gemini ACP models to Pi's /model selector and primary agent loop.
  pi.registerProvider("antigravity", {
    name: "Antigravity ACP",
    baseUrl: "http://localhost/antigravity",
    apiKey: "antigravity-local",
    api: "antigravity-acp" as any,
    models: ACP_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: m.effort === "high" || m.effort === "medium",
      thinkingLevelMap: {
        off: m.effort === "low" ? "low" : null,
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: null,
        max: null,
      },
      input: ["text", "image"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1048576,
      maxTokens: 65536,
    })),
    streamSimple: streamSimpleAcp,
  });

  // 2. Command: /agy-acp-profile - View or switch the active ACP profile
  pi.registerCommand("agy-acp-profile", {
    description: "Switch active Antigravity profile: /agy-acp-profile [profileName]",
    handler: async (argsString: string, ctx: ExtensionContext) => {
      lastExtensionUi = ctx.ui;
      const profiles = listProfiles();
      const target = argsString.trim();

      if (target) {
        const found = profiles.find((p) => p.name.toLowerCase() === target.toLowerCase());
        if (!found) {
          ctx.ui.notify(`Profile "${target}" not found. Available: ${profiles.map((p) => p.name).join(", ")}`, "error");
          return;
        }
        setActiveProfile(found.name);
        updateAcpStatusBar(ctx.ui);
        ctx.ui.notify(`Active Antigravity ACP profile set to: ${found.name}`, "info");
        return;
      }

      if (ctx.hasUI) {
        const choices = profiles.map((p) => {
          const current = p.name === getActiveProfile() ? " (Active)" : "";
          const authTag = p.authenticated ? " [Ready]" : " [Needs Auth]";
          const isLimited = isProfileRateLimited(p.name);
          const quota = getProfileQuota(p.name);
          let quotaTag = "";
          if (quota?.geminiFiveHour) {
            const pct = quota.geminiFiveHour.remainingPercent;
            const rel = formatRelativeTime(quota.geminiFiveHour.resetAt);
            const relStr = rel && rel !== "ready" ? ` (${rel})` : "";
            quotaTag = ` [G: ${pct}%${relStr}]`;
          }
          const limitTag = isLimited ? " [🚫 Rate Limited]" : "";
          return `${p.name}${current}${quotaTag}${limitTag}${authTag}`;
        });
        const choice = await ctx.ui.select("Select Active Antigravity ACP Profile:", choices);
        if (choice) {
          const cleanName = choice.split(" ")[0]!;
          setActiveProfile(cleanName);
          updateAcpStatusBar(ctx.ui);
          ctx.ui.notify(`Active Antigravity ACP profile set to: ${cleanName}`, "info");
        }
      } else {
        ctx.ui.notify(`Current ACP profile: ${getActiveProfile()}. Available: ${profiles.map((p) => p.name).join(", ")}`, "info");
      }
    },
  });

  // 3. Command: /agy-acp-mode - View or switch the active ACP execution mode
  pi.registerCommand("agy-acp-mode", {
    description: "Switch active ACP session mode: /agy-acp-mode [auto_edit|default|yolo]",
    handler: async (argsString: string, ctx: ExtensionContext) => {
      lastExtensionUi = ctx.ui;
      const target = argsString.trim().toLowerCase();

      if (target) {
        const found = ACP_MODES.find((m) => m.id === target);
        if (!found) {
          ctx.ui.notify(`Invalid mode "${target}". Choose from: auto_edit, default, yolo`, "error");
          return;
        }
        setActiveMode(found.id);
        updateAcpStatusBar(ctx.ui);
        ctx.ui.notify(`Active ACP mode set to: ${found.id} (${found.name})`, "info");
        return;
      }

      if (ctx.hasUI) {
        const choices = ACP_MODES.map((m) => {
          const current = m.id === getActiveMode() ? " (Active)" : "";
          return `${m.id}${current} - ${m.description}`;
        });
        const choice = await ctx.ui.select("Select ACP Session Mode:", choices);
        if (choice) {
          const cleanId = choice.split(" ")[0]!;
          setActiveMode(cleanId);
          updateAcpStatusBar(ctx.ui);
          ctx.ui.notify(`Active ACP mode set to: ${cleanId}`, "info");
        }
      } else {
        ctx.ui.notify(`Current ACP mode: ${getActiveMode()}`, "info");
      }
    },
  });

  // 4. Command: /agy-acp-restart - Restart the persistent server daemon
  pi.registerCommand("agy-acp-restart", {
    description: "Restart the persistent Antigravity ACP background server daemon",
    handler: async (_args: string, ctx: ExtensionContext) => {
      lastExtensionUi = ctx.ui;
      if (scope.state.globalAcpManager) {
        ctx.ui.notify("Stopping persistent ACP daemon...", "info");
        await scope.state.globalAcpManager.close();
        scope.state.globalAcpManager = undefined;
      }
      updateAcpStatusBar(ctx.ui);
      ctx.ui.notify("Persistent ACP server daemon stopped. Next prompt will start a fresh daemon.", "info");
    },
  });

  // 5. Command: /agy-acp-reset - Reset the active ACP conversation session
  pi.registerCommand("agy-acp-reset", {
    description: "Reset active ACP conversation session while keeping daemon warm: /agy-acp-reset",
    handler: async (_args: string, ctx: ExtensionContext) => {
      lastExtensionUi = ctx.ui;
      if (scope.state.globalAcpManager) {
        await withProfileOperation(scope.state.globalAcpManager.profile, scope.state.lifecycle.signal, () => scope.state.globalAcpManager!.resetSession());
        updateAcpStatusBar(ctx.ui);
        ctx.ui.notify("ACP conversation session reset. Daemon remains warm and ready.", "info");
      } else {
        ctx.ui.notify("No active ACP daemon running.", "info");
      }
    },
  });

  // 6. Command: /agy-acp-recover - Check and auto-recover any stale profile locks
  pi.registerCommand("agy-acp-recover", {
    description: "Check and auto-recover stale ACP process-tree locks: /agy-acp-recover [profileName]",
    handler: async (argsString: string, ctx: ExtensionContext) => {
      const target = argsString.trim() || getActiveProfile();
      const res = autoRecoverProfileLease(target);
      if (res.recovered) {
        ctx.ui.notify(res.message ?? `Stale lock recovered for ${target}`, "info");
      } else if (res.locked) {
        ctx.ui.notify(res.message ?? `Profile ${target} is currently locked by active process PID ${res.lockedByPid}`, "error");
      } else {
        ctx.ui.notify(res.message ?? "Ownership is managed by mgwcli; no recovery was attempted.", "info");
      }
    },
  });

  // 7. Command: /agy-acp-auth - Interactive browser authentication for an ACP profile
  pi.registerCommand("agy-acp-auth", {
    description: "Authenticate an Antigravity profile in browser: /agy-acp-auth [profile] [--reset-home]",
    handler: async (argsString: string, ctx: ExtensionContext) => {
      lastExtensionUi = ctx.ui;
      const tokens = argsString.trim().split(/\s+/).filter(Boolean);
      const wantsResetHome = tokens.includes("--reset-home") || tokens.includes("-r");
      const targetFromArg = tokens.find((t) => !t.startsWith("-"));

      const profiles = listProfiles();
      let targetProfile = targetFromArg;

      if (!targetProfile) {
        if (ctx.hasUI) {
          const choices = profiles.map((p) => {
            const authTag = p.authenticated ? "✅ Ready (Re-authenticate)" : "❌ Needs Auth";
            const activeTag = p.name === getActiveProfile() ? " [Active]" : "";
            return `${p.name} - ${authTag}${activeTag}`;
          });
          const choice = await ctx.ui.select("Select Profile to Authenticate:", choices);
          if (!choice) return;
          targetProfile = choice.split(" ")[0]!;
        } else {
          targetProfile = getActiveProfile();
        }
      }

      const found = profiles.find((p) => p.name.toLowerCase() === targetProfile!.toLowerCase());
      if (!found) {
        ctx.ui.notify(`Profile "${targetProfile}" not found. Available: ${profiles.map((p) => p.name).join(", ")}`, "error");
        return;
      }
      targetProfile = found.name;

      let resetHome = wantsResetHome;
      if (ctx.hasUI && !wantsResetHome) {
        const resetChoice = await ctx.ui.select(`Authentication Mode for ${targetProfile}:`, [
          "Standard Auth (Keep existing home directory settings)",
          "Protected Reset Auth (--reset-home: recreate canonical Windows DACL & clean home)",
        ]);
        if (!resetChoice) return;
        resetHome = resetChoice.startsWith("Protected");
      }

      ctx.ui.notify(`Starting personal OAuth login for ${targetProfile}...`, "info");

      const args = ["agy", "acp", "auth", targetProfile, "--allow-browser-auth", "--confirm-config"];
      if (resetHome) args.push("--reset-home");

      ctx.ui.notify(`Launching browser for ${targetProfile}... Please complete login in Google account.`, "info");

      const res = await withProfileOperation(targetProfile, scope.state.lifecycle.signal, async () => {
        const manager = await getOrCreateAcpManager(targetProfile!, ctx.cwd);
        await manager.close();
        return new Promise<{ success: boolean; message: string }>((resolve) => {
        const child = spawn("mgwcli.exe", args, {
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        });

        let stdout = "";
        let stderr = "";
        const signal = scope.state.lifecycle.signal;
        const aborted = () => { try { child.kill(); } catch {} resolve({ success: false, message: "Authentication aborted." }); };
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();

        child.stdout?.on("data", (d) => {
          const str = d.toString();
          stdout += str;
          if (str.includes("http://") || str.includes("https://")) {
            ctx.ui.notify(`Auth URL: ${str.trim()}`, "info");
          }
        });

        child.stderr?.on("data", (d) => {
          const str = d.toString();
          stderr += str;
          if (str.includes("http://") || str.includes("https://")) {
            ctx.ui.notify(`Auth URL: ${str.trim()}`, "info");
          }
        });

        const timer = setTimeout(() => {
          try { child.kill(); } catch {}
          resolve({ success: false, message: "Authentication timed out after 5 minutes." });
        }, 300000);

        child.on("close", (code) => {
          signal.removeEventListener("abort", aborted);
          clearTimeout(timer);
          if (code === 0) {
            resolve({ success: true, message: stdout.trim() || "Authenticated successfully." });
          } else {
            resolve({ success: false, message: stderr.trim() || stdout.trim() || `Exit code ${code}` });
          }
        });

        child.on("error", (err) => {
          signal.removeEventListener("abort", aborted);
          clearTimeout(timer);
          resolve({ success: false, message: err.message });
        });
        });
      });

      if (res.success) {
        ctx.ui.notify(`✅ Profile "${targetProfile}" successfully authenticated!`, "info");
        // Clear any rate-limit cooldown since fresh login was performed
        clearProfileRateLimit(targetProfile);
        // Switch to this profile if current profile was unauthenticated
        const currentActive = listProfiles().find((p) => p.name === getActiveProfile());
        if (!currentActive?.authenticated) {
          setActiveProfile(targetProfile);
        }
        updateAcpStatusBar(ctx.ui);
        // Refresh live quota in background
        void refreshLiveQuota(targetProfile);
      } else {
        ctx.ui.notify(`❌ Authentication failed for ${targetProfile}: ${res.message}`, "error");
      }
    },
  });

  // 8. Command: /agy-acp-usage - View detailed token usage & context window consumption
  pi.registerCommand("agy-acp-usage", {
    description: "Display current Antigravity ACP session token usage and context capacity: /agy-acp-usage",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const active = getActiveProfile();
      const globalAcpManager = scope.state.globalAcpManager;
      const model = globalAcpManager?.currentModelId ?? "gemini-3.8-flash-high";
      const turns = globalAcpManager?.sessionTurnCount ?? 0;
      const input = globalAcpManager?.cumulativeInputTokens ?? 0;
      const output = globalAcpManager?.cumulativeOutputTokens ?? 0;
      const total = input + output;
      const maxContext = 1048576; // 1.0M tokens
      const pct = ((total / maxContext) * 100).toFixed(3);

      const summary = [
        `**Antigravity ACP Token Usage**`,
        `- Active Profile: **${active}**`,
        `- Model: **${model}**`,
        `- Conversation Turns: **${turns}**`,
        `- Prompt Tokens (Input): **${input.toLocaleString()}**`,
        `- Completion Tokens (Output): **${output.toLocaleString()}**`,
        `- Total Tokens Consumed: **${total.toLocaleString()}**`,
        `- Context Window: **${maxContext.toLocaleString()}** tokens`,
        `- Context Capacity Used: **${pct}%**`,
      ].join("\n");

      await pi.sendMessage({
        customType: "agy-acp-usage",
        content: summary,
        display: true,
      }, { triggerTurn: false });
    },
  });

  // 9. Command: /agy-acp-status - View current Antigravity configuration & daemon state
  pi.registerCommand("agy-acp-status", {
    description: "Show current Antigravity ACP configuration, daemon state, and ready profiles: /agy-acp-status",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const profiles = listProfiles();
      const active = getActiveProfile();
      const mode = getActiveMode();
      const authCount = profiles.filter((p) => p.authenticated).length;
      const globalAcpManager = scope.state.globalAcpManager;
      const isWarm = globalAcpManager?.isAlive() ?? false;
      const pid = globalAcpManager?.child?.pid;
      const persisted = loadPersistedSession(ctx.cwd);
      const turns = globalAcpManager?.sessionTurnCount ?? persisted?.sessionTurnCount ?? 0;
      const sessionId = globalAcpManager?.currentSessionId ?? persisted?.sessionId ?? "none";
      const totalTokens = globalAcpManager?.cumulativeTotalTokens ?? ((persisted?.cumulativeInputTokens ?? 0) + (persisted?.cumulativeOutputTokens ?? 0));
      const sessionOrigin = globalAcpManager?.currentSessionId
        ? `Active (memory, ${turns} turn${turns === 1 ? "" : "s"})`
        : persisted?.sessionId
        ? `Persisted on disk (resumable across restarts, ${turns} turn${turns === 1 ? "" : "s"})`
        : "None (new session will be allocated)";

      const activeQuota = getProfileQuota(active);
      const quotaSummary = activeQuota?.geminiFiveHour
        ? `G: ${formatBucketDisplay(activeQuota.geminiFiveHour)} / ${formatBucketDisplay(activeQuota.geminiWeekly)}`
        : "no cached quota";
      const autoSwitchStatus = getAutoSwitchEnabled() ? "Enabled (auto-retry on limit)" : "Disabled";

      const summary = [
        `**Antigravity ACP Status**`,
        `- Active Profile: **${active}**`,
        `- Active Mode: **${mode}**`,
        `- Active Quota: **${quotaSummary}**`,
        `- Auto-Switching: **${autoSwitchStatus}**`,
        `- Daemon Status: **${isWarm ? `Warm / Alive (PID: ${pid})` : "Stopped / Inactive"}**`,
        `- Active Session: \`${sessionId}\` [${sessionOrigin}, ~${totalTokens.toLocaleString()} tokens]`,
        `- Total Profiles: ${profiles.length} (${authCount} authenticated)`,
        `- Models Available: ${ACP_MODELS.length} (switch via \`/model antigravity/<id>\`)`,
        `- Ready Profiles: ${profiles.filter((p) => p.authenticated).map((p) => p.name).join(", ") || "none"}`,
      ].join("\n");

      await pi.sendMessage({
        customType: "agy-acp-status",
        content: summary,
        display: true,
      }, { triggerTurn: false });
    },
  });

  // 9. Command: /agy-acp-bar - Configure Antigravity status bar display in Pi's footer
  pi.registerCommand("agy-acp-bar", {
    description: "Toggle Antigravity status bar: /agy-acp-bar [on|off]",
    handler: async (argsString: string, ctx: ExtensionContext) => {
      lastExtensionUi = ctx.ui;
      const arg = argsString.trim().toLowerCase();
      if (arg === "off") {
        setAcpBarMode("off");
        ctx.ui.setStatus("acp", undefined);
        ctx.ui.notify("Antigravity ACP status bar disabled.", "info");
        return;
      }
      if (arg === "on" || arg === "auto") {
        setAcpBarMode(arg as AcpBarMode);
        updateAcpStatusBar(ctx.ui);
        ctx.ui.notify("Antigravity ACP status bar enabled: 0T/0↓/0↑/0.00% (Profile)", "info");
        return;
      }
      if (ctx.hasUI) {
        const choices = [
          `on (Active) - Show status bar: 0T/0↓/0↑/0.00% (Profile)`,
          `off - Hide the status bar row`,
        ];
        const choice = await ctx.ui.select("Antigravity ACP Status Bar:", choices);
        if (choice) {
          const mode = choice.startsWith("off") ? "off" : "auto";
          setAcpBarMode(mode);
          updateAcpStatusBar(ctx.ui);
          ctx.ui.notify(`Antigravity ACP status bar: ${mode}`, "info");
        }
      } else {
        ctx.ui.notify(`Current ACP bar mode: ${getAcpBarMode()}. Options: on, off`, "info");
      }
    },
  });

  // 10. Command: /agy-acp-limits - View profile quota limits and auto-switching status
  const limitsCommandHandler = async (argsString: string, ctx: ExtensionContext) => {
    lastExtensionUi = ctx.ui;
    const tokens = argsString.trim().split(/\s+/).filter(Boolean);
    const wantsRefresh = tokens.includes("--refresh") || tokens.includes("-r") || tokens.includes("refresh");
    const targetProfile = tokens.find((t) => !t.startsWith("-") && t !== "refresh");

    if (wantsRefresh) {
      ctx.ui.notify(targetProfile ? `Refreshing quota for ${targetProfile}...` : "Refreshing quotas for all profiles...", "info");
      const res = await refreshLiveQuota(targetProfile);
      if (!res.success) {
        ctx.ui.notify(`Quota refresh warning: ${res.message}`, "warning");
      } else {
        ctx.ui.notify("Quota data updated successfully!", "info");
      }
    }

    const profiles = listProfiles();
    let content: string;
    if (targetProfile) {
      content = renderSingleProfileQuota(targetProfile);
    } else {
      content = renderProfileLimitsTable(profiles);
    }

    await pi.sendMessage({
      customType: "agy-acp-limits",
      content,
      display: true,
    }, { triggerTurn: false });
  };

  pi.registerCommand("agy-acp-limits", {
    description: "View Antigravity ACP profile quotas & rate limits: /agy-acp-limits [profile] [--refresh]",
    handler: limitsCommandHandler,
  });

  pi.registerCommand("agy-acp-quota", {
    description: "Alias for /agy-acp-limits",
    handler: limitsCommandHandler,
  });

  // 11. Command: /agy-acp-autoswitch - Configure rate limit auto-switching
  pi.registerCommand("agy-acp-autoswitch", {
    description: "Configure automatic profile switching on rate limit: /agy-acp-autoswitch [on|off]",
    handler: async (argsString: string, ctx: ExtensionContext) => {
      lastExtensionUi = ctx.ui;
      const arg = argsString.trim().toLowerCase();
      if (arg === "on" || arg === "enable" || arg === "true") {
        setAutoSwitchEnabled(true);
        ctx.ui.notify("Antigravity profile auto-switching: ENABLED", "info");
        return;
      }
      if (arg === "off" || arg === "disable" || arg === "false") {
        setAutoSwitchEnabled(false);
        ctx.ui.notify("Antigravity profile auto-switching: DISABLED", "info");
        return;
      }

      if (ctx.hasUI) {
        const current = getAutoSwitchEnabled();
        const choices = [
          `on ${current ? "(Active)" : ""}- Enable automatic profile switching on rate limit / 429`,
          `off ${!current ? "(Active)" : ""}- Disable automatic switching (fail prompt on limit)`,
        ];
        const choice = await ctx.ui.select("Antigravity Rate-Limit Auto-Switching:", choices);
        if (choice) {
          const enable = choice.startsWith("on");
          setAutoSwitchEnabled(enable);
          ctx.ui.notify(`Antigravity auto-switching: ${enable ? "ENABLED" : "DISABLED"}`, "info");
        }
      } else {
        ctx.ui.notify(`Antigravity auto-switching is currently ${getAutoSwitchEnabled() ? "ENABLED" : "DISABLED"}. Options: on, off`, "info");
      }
    },
  });

  // 12. Slash Command: /agy-acp (Delegated task execution)
  const acpCommandHandler = async (argsString: string, ctx: ExtensionContext) => {
    const raw = argsString.trim();
    const profiles = listProfiles();

    if (profiles.length === 0) {
      ctx.ui.notify("No mgwcli shared profiles found. Create one with: mgwcli agy profile create <name> --shared", "error");
      return;
    }

    let selectedProfile: string | undefined;
    let selectedModel: string | undefined;
    let selectedMode: string | undefined;
    let selectedAgent: string | undefined;
    let prompt = "";

    const tokens = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    const promptTokens: string[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i]!;
      if (tok === "--agent" && i + 1 < tokens.length) {
        selectedAgent = tokens[++i]!.replace(/^["']|["']$/g, "");
      } else if (tok === "--model" && i + 1 < tokens.length) {
        const val = tokens[++i]!.replace(/^["']|["']$/g, "");
        const matched = ACP_MODELS.find((m) => m.id.toLowerCase().includes(val.toLowerCase()));
        if (matched) selectedModel = matched.id;
        else selectedModel = val;
      } else if (tok === "--mode" && i + 1 < tokens.length) {
        selectedMode = tokens[++i]!.replace(/^["']|["']$/g, "");
      } else if (tok === "--effort" && i + 1 < tokens.length) {
        const effort = tokens[++i]!.toLowerCase();
        const matched = ACP_MODELS.find((m) => m.effort === effort);
        if (matched) selectedModel = matched.id;
      } else if (!selectedProfile && profiles.some((p) => p.name.toLowerCase() === tok.toLowerCase())) {
        selectedProfile = tok;
      } else {
        promptTokens.push(tok.replace(/^["']|["']$/g, ""));
      }
    }

    prompt = promptTokens.join(" ").trim();

    if (ctx.hasUI) {
      if (!selectedProfile && !selectedAgent) selectedProfile = getActiveProfile();

      if (promptTokens.length === 0) {
        const modelChoices = ACP_MODELS.map((m) => {
          const isDef = m.id === "gemini-3.8-flash-high" ? " (Default)" : "";
          return `${m.name}${isDef} - ${m.description}`;
        });
        const modelChoice = selectedAgent ? undefined : await ctx.ui.select("Select Model & Reasoning Effort:", modelChoices);
        if (modelChoice) {
          const found = ACP_MODELS.find((m) => modelChoice.startsWith(m.name));
          if (found) selectedModel = found.id;
        }

        const inputPrompt = await ctx.ui.input("Enter task for Antigravity ACP:", "e.g. Inspect the auth module and propose a test plan");
        if (!inputPrompt?.trim()) return;
        prompt = inputPrompt.trim();
      }
    } else {
      if (!selectedProfile && !selectedAgent) selectedProfile = getActiveProfile();
      if (!prompt) {
        ctx.ui.notify("Usage: /agy-acp [--agent <id>] [profile] [--model <modelId>] [--mode <mode>] <prompt>", "error");
        return;
      }
    }

    ctx.ui.notify(`Starting ACP task (${selectedAgent ?? selectedProfile ?? "active profile"})...`, "info");

    const result = await executeAcpTask({
      profile: selectedProfile,
      agent: selectedAgent,
      prompt,
      modelId: selectedModel,
      modeId: selectedMode ?? (selectedAgent ? undefined : getActiveMode()),
      cwd: ctx.cwd,
      onStatus: (status) => {
        if (ctx.hasUI) ctx.ui.notify(status, "info");
      },
    });

    if (result.isError) {
      ctx.ui.notify(`ACP Task failed: ${result.error}`, "error");
      await pi.sendMessage({
        customType: "agy-acp-result",
        content: `**Antigravity ACP ${result.status}** [${result.profile ?? "no profile"} | ${result.effective.model ?? "model not applied"}]:\n\n${result.error}\n\n${result.text}`,
        details: result,
        display: true,
      }, { deliverAs: "steer", triggerTurn: false });
    } else {
      ctx.ui.notify("Antigravity ACP task completed!", "info");
      // Record in injected history so subsequent turns in Pi retain awareness of this task
      acpInjectedHistory.push({
        prompt,
        response: result.text,
        timestamp: Date.now(),
      });

      const tokensNote = result.usage ? ` (${result.usage.total.toLocaleString()} tokens, ${result.usage.source})` : "";

      await pi.sendMessage({
        customType: "agy-acp-result",
        content: `**Antigravity ACP Output** [${result.profile} | ${result.effective.model}${tokensNote}]:\n\n${result.text}`,
        details: result,
        display: true,
      }, { deliverAs: "steer", triggerTurn: false });
      updateAcpStatusBar(ctx.ui);
    }
  };

  pi.registerCommand("agy-acp", {
    description: "Run Antigravity ACP: /agy-acp [--agent <id>] [profile] [--model <id>] [--mode <mode>] <prompt>",
    handler: acpCommandHandler,
  });

  // 13. Context Injection: Feed previous /agy-acp slash command results into LLM context
  pi.on("context", async (event) => {
    if (acpInjectedHistory.length === 0) return;
    const messages = [...event.messages];

    for (const item of acpInjectedHistory) {
      const exists = messages.some(
        (m) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.includes(item.prompt),
      );
      if (!exists) {
        messages.push({
          role: "user",
          content: `[Previous Antigravity ACP Task]:\n${item.prompt}`,
          timestamp: item.timestamp,
        } as any);
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: item.response }],
          api: "antigravity-acp" as any,
          provider: "antigravity",
          model: "gemini-3.8-flash-high",
          usage: { input: estimateTokens(item.prompt), output: estimateTokens(item.response), cacheRead: 0, cacheWrite: 0, totalTokens: estimateTokens(item.prompt) + estimateTokens(item.response), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: item.timestamp + 1,
        } as any);
      }
    }
    return { messages };
  });

  // 14. Event Hooks: Maintain Status Bar across session, model, and turn transitions
  pi.on("session_start", async (event, ctx) => {
    lastExtensionUi = ctx.hasUI ? ctx.ui : undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    if (scope.state.sessionId !== sessionId) {
      scope.state.lifecycle.abort();
      await scope.state.globalAcpManager?.close();
      scope.state.globalAcpManager = undefined;
      scope.state.lifecycle = new AbortController();
      scope.state.sessionId = sessionId;
    }
    if (ctx.model) {
      isCurrentModelAntigravity = ctx.model.provider === "antigravity";
      scope.state.isCurrentModelAntigravity = isCurrentModelAntigravity;
    }
    acpInjectedHistory.length = 0;
    scope.state.presetCatalog = undefined;
    scope.state.presetLoadError = undefined;
    try { scope.state.presetCatalog = loadAcpPresets(ctx.cwd, ACP_MODELS.map(m => m.id)); }
    catch (error: any) {
      scope.state.presetLoadError = error?.message ?? String(error);
      if (ctx.hasUI) ctx.ui.notify(`ACP presets disabled: ${scope.state.presetLoadError}`, "error");
    }
    // Only reset ACP session if Pi explicitly starts a brand new conversation session (not resume, startup, or reload)
    if (event?.reason === "new") {
      if (scope.state.globalAcpManager) await scope.state.globalAcpManager.resetSession();
      else clearPersistedSession(ctx.cwd);
    }
    updateAcpStatusBar(ctx.ui);
  });

  pi.on("model_select", async (event, ctx) => {
    lastExtensionUi = ctx.ui;
    isCurrentModelAntigravity = event.model.provider === "antigravity";
    scope.state.isCurrentModelAntigravity = isCurrentModelAntigravity;
    updateAcpStatusBar(ctx.ui);
  });

  pi.on("turn_start", async (_event, ctx) => {
    lastExtensionUi = ctx.ui;
    if (isCurrentModelAntigravity) {
      updateAcpStatusBar(ctx.ui, { isStreaming: true });
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    lastExtensionUi = ctx.ui;
    try {
      ctx.ui.setStatus("acp_tool", undefined);
    } catch {}
    if (isCurrentModelAntigravity) {
      updateAcpStatusBar(ctx.ui, { isStreaming: false });
    }
  });

  pi.on("session_shutdown", async () => {
    scope.state.lifecycle.abort();
    await scope.state.globalAcpManager?.close();
    scope.state.globalAcpManager = undefined;
    scope.state.lastExtensionUi = undefined;
    acpInjectedHistory.length = 0;
  });

  const presetCatalogView = () => ({ version: 1, error: scope.state.presetLoadError ?? null, presets: scope.state.presetLoadError ? [] : Object.values(scope.state.presetCatalog ?? defaultAcpPresets()).map(p => ({ id: p.id, description: p.description, model: p.model, mode: "default", permissionPolicy: p.permissionPolicy, profiles: p.profiles === "active" ? [getActiveProfile()] : [...p.profiles], enforcement: "acp-permission-and-event-gate" })) });
  pi.registerCommand("agy-acp-agents", { description: "List enforced ACP presets and account bindings", handler: async (_args, ctx) => { ctx.ui.notify(JSON.stringify(presetCatalogView(), null, 2), scope.state.presetLoadError ? "error" : "info"); } });
  pi.registerTool({
    name: "agy_acp_agents", label: "ACP Agent Presets", description: "Discover enforced ACP role presets, pinned models and approved profile pools. Permission ceilings are not OS sandboxes; constrained presets do not allow shell execution.",
    parameters: Type.Object({}),
    execute: async () => { const catalog = presetCatalogView(); return { content: [{ type: "text" as const, text: JSON.stringify(catalog) }], details: catalog, isError: !!catalog.error }; },
  });

  // 15. Register Tool for Pi's Primary Agent
  pi.registerTool({
    name: "agy_acp_task",
    label: "Antigravity ACP Subagent",
    description: "Delegate a task through Antigravity ACP. Select agent from agy_acp_agents for enforced model/profile/permission ceilings; preset overrides cannot widen permissions. Without agent, use legacy session modes. Presets are protocol gates, not OS sandboxes. Returns structured outcomes including partial output and failures.",
    parameters: Type.Object({
      task: Type.String({ description: "Detailed description of the task for the Antigravity agent." }),
      agent: Type.Optional(Type.String({ description: "Enforced preset ID, e.g. agy-builder, agy-reviewer or agy-scout. Discover with agy_acp_agents." })),
      profile: Type.Optional(Type.String({ description: "Target mgwcli shared profile (e.g. shared-profile-01). Defaults to active profile." })),
      model: Type.Optional(Type.String({ description: "Model ID: gemini-3.8-flash-high, gemini-pro-agent, etc. Defaults to gemini-3.8-flash-high." })),
      mode: Type.Optional(Type.String({ description: "Session mode: auto_edit (default), default, or yolo." })),
      workspaceRoot: Type.Optional(Type.String({ description: "Absolute existing repository directory to expose as the read-only scout workspace. Allowed only with agent=agy-scout; project MCP servers are disabled for this override. Prefer a single repo root, not a broad parent directory." })),
    }),
    outputSchema: AcpTaskResultSchema,
    async execute(_toolCallId, input, signal, onUpdate, ctx) {
      const result = await executeAcpTask({
        profile: input.profile,
        agent: input.agent,
        prompt: input.task,
        modelId: input.model,
        modeId: input.mode ?? (input.agent ? undefined : getActiveMode()),
        cwd: ctx.cwd,
        workspaceRoot: input.workspaceRoot,
        signal,
        onStatus: (status) => onUpdate?.({ content: [{ type: "text", text: status }], details: { status } }),
      });

      return {
        content: [{ type: "text" as const, text: result.isError ? `Antigravity ACP ${result.status}: ${result.error}\n\n${result.text}` : result.text || `Task completed with status: ${result.stopReason}` }],
        isError: result.isError,
        details: result,
        structuredContent: result,
        usage: result.usage ? { input: result.usage.input, output: result.usage.output, cacheRead: result.usage.cacheRead, cacheWrite: result.usage.cacheWrite, totalTokens: result.usage.total, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } : undefined,
      };
    },
  });
}
