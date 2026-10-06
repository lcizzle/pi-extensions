import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type AcpPermissionPolicy = "read-only" | "edit-only";
export class AcpPresetError extends Error {
  constructor(public readonly code: "PRESET_CONFIG_INVALID" | "PRESET_NOT_FOUND" | "PRESET_OVERRIDE_FORBIDDEN" | "PROFILE_POOL_EXHAUSTED", message: string) { super(message); }
}
export interface AcpPreset {
  readonly id: string;
  readonly description: string;
  readonly instructions: string;
  readonly model: string;
  readonly profiles: "active" | readonly string[];
  readonly permissionPolicy: AcpPermissionPolicy;
}
export type AcpPresetCatalog = Readonly<Record<string, AcpPreset>>;
export interface ResolvedAcpPreset { readonly preset: AcpPreset; readonly profiles: readonly string[]; readonly model: string; readonly mode: "default" }
function invalid(message: string): never { throw new AcpPresetError("PRESET_CONFIG_INVALID", message); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function freezePreset(p: AcpPreset): AcpPreset { return Object.freeze({ ...p, profiles: p.profiles === "active" ? "active" : Object.freeze([...p.profiles]) }); }
export function defaultAcpPresets(): AcpPresetCatalog {
  const base = { model: "gemini-3.8-flash-high", profiles: "active" as const };
  return Object.freeze(Object.fromEntries([
    { ...base, id: "agy-builder", description: "Implement file edits, without shell execution", permissionPolicy: "edit-only" as const, instructions: "Implement the requested changes. Use only read/search/think/edit actions. Do not execute commands, delete or move files. Report changes and checks that still need to be run." },
    { ...base, id: "agy-reviewer", description: "Read-only independent code review", permissionPolicy: "read-only" as const, instructions: "Review the requested code without changing files or executing commands. Identify concrete correctness, security and maintainability issues with file references. State residual verification gaps." },
    { ...base, id: "agy-scout", description: "Read-only exploration and research", permissionPolicy: "read-only" as const, instructions: "Explore the requested workspace using read/search/think actions only. Do not change files or execute commands. Return findings and relevant file paths." },
  ].map(p => [p.id, freezePreset(p)])));
}
/** Operator-owned project configuration is trusted code configuration, not a sandbox boundary. */
export function loadAcpPresets(cwd: string, models: readonly string[]): AcpPresetCatalog {
  const catalog = { ...defaultAcpPresets() };
  const path = join(cwd, ".pi", "agy-acp-presets.json");
  let raw: string;
  try {
    if (statSync(path).size > 65536) invalid("ACP preset configuration exceeds 64 KiB");
    raw = readFileSync(path, "utf8");
  } catch (error: any) { if (error.code === "ENOENT") return Object.freeze(catalog); throw new AcpPresetError("PRESET_CONFIG_INVALID", `Cannot read ACP preset configuration: ${error.message}`); }
  let config: unknown;
  try { config = JSON.parse(raw); } catch { invalid("Invalid ACP preset configuration JSON"); }
  if (!object(config) || config.version !== 1 || !object(config.presets) || Object.keys(config).some(k => !["version", "presets"].includes(k))) invalid("Expected {version:1,presets:{...}} ACP configuration");
  if (Object.keys(config.presets).length > 64) invalid("At most 64 configured ACP presets are supported");
  for (const [id, value] of Object.entries(config.presets)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || ["constructor", "prototype"].includes(id) || !object(value)) invalid(`Invalid ACP preset: ${id}`);
    if (Object.keys(value).some(k => !["description", "instructions", "model", "profiles", "permissionPolicy"].includes(k))) invalid(`Unknown property in ACP preset ${id}`);
    const base = Object.hasOwn(catalog, id) ? catalog[id] : undefined;
    const p = { ...base, ...value, id } as unknown as AcpPreset;
    if (typeof p.description !== "string" || !p.description.trim() || p.description.length > 1024 || typeof p.instructions !== "string" || !p.instructions.trim() || p.instructions.length > 16384) invalid(`Preset ${id} requires bounded description and instructions`);
    if (typeof p.model !== "string" || !models.includes(p.model)) invalid(`Unsupported model in preset ${id}`);
    if (!["read-only", "edit-only"].includes(p.permissionPolicy) || (base && p.permissionPolicy !== base.permissionPolicy)) invalid(`Forbidden permission policy in preset ${id}`);
    if (p.profiles !== "active" && (!Array.isArray(p.profiles) || p.profiles.length === 0 || p.profiles.length > 32 || p.profiles.some(p => typeof p !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(p)) || new Set(p.profiles.map(p => p.toLowerCase())).size !== p.profiles.length)) invalid(`Invalid profile pool in preset ${id}`);
    catalog[id] = freezePreset(p);
  }
  return Object.freeze(catalog);
}
export function resolveAcpPreset(catalog: AcpPresetCatalog, request: { agent: string; profile?: string; model?: string; mode?: string }, activeProfile: string, available: readonly { name: string; authenticated: boolean }[]): ResolvedAcpPreset {
  const preset = Object.hasOwn(catalog, request.agent) ? catalog[request.agent] : undefined;
  if (!preset) throw new AcpPresetError("PRESET_NOT_FOUND", `Unknown ACP preset: ${request.agent}`);
  if ((request.model !== undefined && request.model !== preset.model) || (request.mode !== undefined && request.mode !== "default")) throw new AcpPresetError("PRESET_OVERRIDE_FORBIDDEN", `Preset ${preset.id} pins model ${preset.model} and permission-gated mode default`);
  const pool = preset.profiles === "active" ? [activeProfile] : [...preset.profiles];
  if (request.profile !== undefined && !pool.some(p => p.toLowerCase() === request.profile!.toLowerCase())) throw new AcpPresetError("PRESET_OVERRIDE_FORBIDDEN", `Profile is outside preset ${preset.id}'s pool`);
  const selected = request.profile === undefined ? pool : pool.filter(p => p.toLowerCase() === request.profile!.toLowerCase());
  // Canonical account spelling prevents alias confusion. Never add an unapproved account.
  const profiles = selected.map(p => available.find(a => a.name.toLowerCase() === p.toLowerCase() && a.authenticated)?.name).filter((p): p is string => !!p);
  if (!profiles.length) throw new AcpPresetError("PROFILE_POOL_EXHAUSTED", `No authenticated profiles in preset ${preset.id}'s selected pool`);
  return Object.freeze({ preset, profiles: Object.freeze(profiles), model: preset.model, mode: "default" });
}
export function presetAllowsKind(policy: AcpPermissionPolicy, kind: unknown): boolean {
  return ["read", "search", "think"].includes(kind as string) || (policy === "edit-only" && kind === "edit");
}
