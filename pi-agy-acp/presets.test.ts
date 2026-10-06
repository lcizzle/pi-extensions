import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAcpPresets, resolveAcpPreset, presetAllowsKind } from "./acp-presets";
import { normalizeAcpUsage, AcpTaskResultSchema } from "./acp-results";
import { Value } from "typebox/value";
import { createAcpRuntime, executeAcpTask } from "./pi-agy-acp";
const models = ["gemini-3.8-flash-high", "gemini-pro-agent"];
const profiles = [{ name: "one", authenticated: true }, { name: "two", authenticated: true }];
function resolve(agent: string, overrides = {}, catalog = loadAcpPresets("missing-dir", models)) {
  return resolveAcpPreset(catalog, { agent, ...overrides }, "one", profiles);
}
test("built-in presets bind model/profile/default mode and are deeply frozen", () => {
  const catalog = loadAcpPresets("missing-dir", models);
  const r = resolve("agy-reviewer", {}, catalog);
  expect(r.profiles).toEqual(["one"]); expect(r.mode).toBe("default"); expect(r.preset.permissionPolicy).toBe("read-only");
  expect(Object.isFrozen(catalog)).toBe(true); expect(Object.isFrozen(catalog["agy-reviewer"])).toBe(true);
  expect(Object.isFrozen(r.profiles)).toBe(true);
});
test("conflicting caller overrides and missing profiles fail closed", () => {
  for (const overrides of [{ mode: "yolo" }, { mode: "auto_edit" }, { model: "wrong" }, { profile: "two" }]) expect(() => resolve("agy-reviewer", overrides)).toThrow();
  expect(() => resolve("unknown")).toThrow();
  expect(() => resolveAcpPreset(loadAcpPresets("missing-dir", models), { agent: "agy-scout" }, "absent", profiles)).toThrow();
});
test("permission ceilings deny unknown/delete/execute even to builder", () => {
  for (const policy of ["read-only", "edit-only"] as const) {
    for (const kind of [undefined, "execute", "delete", "move", "fetch", "other", "EDIT"]) expect(presetAllowsKind(policy, kind)).toBe(false);
    for (const kind of ["read", "search", "think"]) expect(presetAllowsKind(policy, kind)).toBe(true);
  }
  expect(presetAllowsKind("read-only", "edit")).toBe(false); expect(presetAllowsKind("edit-only", "edit")).toBe(true);
});
test("operator config pins finite pools; explicit pins cannot fail over; invalid config rejects", () => {
  const cwd = mkdtempSync(join(tmpdir(), "acp-presets-")); mkdirSync(join(cwd, ".pi"));
  const file = join(cwd, ".pi", "agy-acp-presets.json");
  try {
    writeFileSync(file, JSON.stringify({ version: 1, presets: { "agy-reviewer": { profiles: ["one", "two"], model: models[0] } } }));
    const catalog = loadAcpPresets(cwd, models);
    expect(resolve("agy-reviewer", {}, catalog).profiles).toEqual(["one", "two"]);
    expect(resolve("agy-reviewer", { profile: "two" }, catalog).profiles).toEqual(["two"]);
    expect(Object.isFrozen(catalog["agy-reviewer"].profiles)).toBe(true);
    for (const config of ["bad json", { version: 2, presets: {} }, { version: 1, presets: { "agy-scout": { permissionPolicy: "edit-only" } } }, { version: 1, presets: { "agy-builder": { profiles: [] } } }, { version: 1, presets: { "agy-builder": { mode: "yolo" } } }, { version: 1, presets: { "agy-builder": { model: "unknown" } } }]) {
      writeFileSync(file, typeof config === "string" ? config : JSON.stringify(config)); expect(() => loadAcpPresets(cwd, models)).toThrow();
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
test("usage provenance distinguishes measured, missing, partial and invalid reports", () => {
  expect(normalizeAcpUsage({ inputTokens: 5, outputTokens: 2 }, 10, 8)).toEqual({ input: 5, output: 2, total: 7, cacheRead: 0, cacheWrite: 0, source: "reported" });
  expect(normalizeAcpUsage({}, 10, 8).source).toBe("estimated");
  expect(normalizeAcpUsage({ input: 5 }, 10, 8)).toMatchObject({ input: 5, output: 8, total: 13, source: "mixed" });
  expect(normalizeAcpUsage({ input: -1, output: NaN }, 10, 8)).toMatchObject({ input: 10, output: 8, source: "estimated" });
});
test("invalid inputs and already-aborted tasks return schema-valid structured failures without spawn", async () => {
  const scope = createAcpRuntime(); let spawned = false;
  scope.state.spawnProcess = (() => { spawned = true; throw Error("must not spawn"); }) as any;
  const controller = new AbortController(); controller.abort();
  for (const request of [{ modeId: "invalid" }, { agent: "missing" }, { signal: controller.signal }]) {
    const r = await scope.run(() => executeAcpTask({ profile: "test", cwd: "D:/Projects/work", prompt: "task", ...request }));
    expect(Value.Check(AcpTaskResultSchema, r)).toBe(true); expect(r.isError).toBe(true); expect(r.promptDispatched).toBe(false); expect(r.effective.model).toBeNull();
  }
  expect(spawned).toBe(false);
});
