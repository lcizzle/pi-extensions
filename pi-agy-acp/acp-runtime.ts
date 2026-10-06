import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { PersistentAcpManager, RateLimitRecord, AcpBarMode } from "./pi-agy-acp";
import type { AcpPresetCatalog } from "./acp-presets";

export interface AcpRuntimeState {
  sessionId: string;
  readonly runtimeId: string;
  cwd?: string;
  lifecycle: AbortController;
  rateLimitedProfiles: Map<string, RateLimitRecord>;
  autoSwitchEnabledState: boolean;
  activeProfileState?: string;
  activeModeState: string;
  acpBarModeState: AcpBarMode;
  lastExtensionUi?: ExtensionUIContext;
  isCurrentModelAntigravity: boolean;
  acpInjectedHistory: Array<{ prompt: string; response: string; timestamp: number }>;
  globalAcpManager?: PersistentAcpManager;
  presetCatalog?: AcpPresetCatalog;
  presetLoadError?: string;
  /** Deterministic process seam for hermetic tests; not model-facing configuration. */
  spawnProcess?: typeof import("node:child_process").spawn;
}
const storage = new AsyncLocalStorage<AcpRuntimeState>();
function newState(): AcpRuntimeState {
  return { sessionId: randomUUID(), runtimeId: randomUUID(), lifecycle: new AbortController(), rateLimitedProfiles: new Map(), autoSwitchEnabledState: true, activeModeState: "auto_edit", acpBarModeState: "auto", isCurrentModelAntigravity: true, acpInjectedHistory: [] };
}
// Compatibility for direct exported-helper callers. Extension instances always bind their own scope.
const helperState = newState();
export function runtimeState(): AcpRuntimeState { return storage.getStore() ?? helperState; }
export function createAcpRuntime() {
  const state = newState();
  return { state, run<T>(callback: () => T): T { return storage.run(state, callback); } };
}

interface ProfileRegistry { tails: Map<string, Promise<void>>; owners: Map<string, PersistentAcpManager> }
const key = Symbol.for("pi-agy-acp.profile-operations.v1");
const globalRegistry = globalThis as typeof globalThis & { [key: symbol]: ProfileRegistry };
const registry = globalRegistry[key] ??= { tails: new Map(), owners: new Map() };
export function profileKey(profile: string): string {
  const root = process.env.MGWCLI_HOME ?? join(process.env.LOCALAPPDATA ?? "", "mgwcli");
  return `${root.toLowerCase()}:${profile.toUpperCase()}`;
}
export async function withProfileOperation<T>(profile: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  // A scope has one warm manager; serialize its profile changes as well as each account.
  return enqueue(`runtime:${runtimeState().runtimeId}`, signal, () => enqueue(profileKey(profile), signal, operation));
}
async function enqueue<T>(key: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  const previous = registry.tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => gate);
  registry.tails.set(key, tail);
  try {
    if (signal?.aborted) throw Error("ACP request aborted while queued");
    // Wait abortably, but retain our place until prior work has released the profile.
    await new Promise<void>((resolve, reject) => {
      const abort = () => { signal?.removeEventListener("abort", abort); reject(Error("ACP request aborted while queued")); };
      signal?.addEventListener("abort", abort, { once: true });
      previous.then(() => { signal?.removeEventListener("abort", abort); resolve(); });
      if (signal?.aborted) abort();
    });
    if (signal?.aborted) throw Error("ACP request aborted while queued");
    return await operation();
  } finally {
    // An aborted waiter cannot release successors ahead of its predecessor.
    void previous.then(() => { release(); if (registry.tails.get(key) === tail) registry.tails.delete(key); });
  }
}
export async function claimProfileManager(manager: PersistentAcpManager): Promise<void> {
  const key = profileKey(manager.profile);
  const previous = registry.owners.get(key);
  if (previous && previous !== manager) await previous.close();
  registry.owners.set(key, manager);
}
export function releaseProfileManager(manager: PersistentAcpManager): void {
  const key = profileKey(manager.profile);
  if (registry.owners.get(key) === manager) registry.owners.delete(key);
}

/** Bind every host callback, including provider streams, to one extension/session scope. */
export function bindRuntimeApi(host: ExtensionAPI, scope: ReturnType<typeof createAcpRuntime>): ExtensionAPI {
  const bind = (handler: Function, contextIndex?: number) => function (...args: any[]) {
    return scope.run(() => {
      const ctx = contextIndex === undefined ? undefined : args[contextIndex] as ExtensionContext;
      if (ctx) { scope.state.cwd = ctx.cwd; scope.state.lastExtensionUi = ctx.hasUI ? ctx.ui : undefined; }
      return handler(...args);
    });
  };
  return new Proxy(host, {
    get(target, property) {
      if (property === "registerCommand") return (name: string, config: any) => target.registerCommand(name, { ...config, handler: bind(config.handler, 1) });
      if (property === "registerTool") return (tool: any) => target.registerTool({ ...tool, execute: bind(tool.execute, 4) });
      if (property === "registerProvider") return (name: string, config: any) => target.registerProvider(name, { ...config, streamSimple: bind(config.streamSimple) });
      if (property === "on") return (event: any, handler: Function) => target.on(event, bind(handler, 1) as any);
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
