import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { AcpJobProvider } from "./acp-job-provider";
import { validateExternalJobHandle, registerExternalJobProvider, getExternalJobProvider } from "pi-subagents/external-job-provider";
import { parse } from "yaml";
const prompt = "job task";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "acp-provider-"));
  const previous = process.env.MGWCLI_HOME; process.env.MGWCLI_HOME = join(root, "mgw");
  const profile = join(process.env.MGWCLI_HOME, "profiles", "one"); mkdirSync(join(profile, "acp-home", "antigravity-acp"), { recursive: true }); writeFileSync(join(profile, "profile.json"), '{"type":"shared"}'); writeFileSync(join(profile, "acp-home", "antigravity-acp", "acp_token.json"), '{}');
  const input = { prompt, promptDigest: createHash("sha256").update(prompt).digest("hex"), cwd: root, runId: "provider-run", stepIndex: 0, agent: "agy-job-scout", options: { preset: "agy-scout" } };
  return { root, input, cleanup: () => { if (previous === undefined) delete process.env.MGWCLI_HOME; else process.env.MGWCLI_HOME = previous; rmSync(root, { recursive: true, force: true }); } };
}
test("concurrent identical starts launch exactly once; restart reattach never launches", async () => {
  const f = fixture(); let starts = 0;
  const launcher = { check: async () => {}, launch: async () => { starts++; } };
  const provider = new AcpJobProvider(join(f.root, "jobs"), launcher);
  try {
    const [a, b] = await Promise.all([provider.start(f.input), provider.start(f.input)]); expect(a.providerJobId).toBe(b.providerJobId); expect(starts).toBe(1);
    const recovered = new AcpJobProvider(join(f.root, "jobs"), { check: async () => { throw Error("must not check"); }, launch: async () => { throw Error("must not launch"); } });
    expect((await recovered.reattach(a.providerJobId)).providerJobId).toBe(a.providerJobId);
    expect(validateExternalJobHandle("agy-acp", await recovered.result(a.providerJobId)).state).toBe("queued");
    await expect(recovered.start({ ...f.input, options: { preset: "agy-builder" } })).rejects.toThrow();
    await expect(recovered.start({ ...f.input, agent: "agy-job-reviewer-junior", options: { preset: "agy-builder" } })).rejects.toThrow();
    await expect(recovered.start({ ...f.input, agent: "agy-job-reviewer-specialist", options: { preset: "agy-builder" } })).rejects.toThrow();
  } finally { f.cleanup(); }
});
test("bad digest, forbidden modes/options, missing runtime never dispatch", async () => {
  const f = fixture(); let launches = 0;
  const provider = new AcpJobProvider(join(f.root, "jobs"), { check: async () => { throw Error("Bun unavailable"); }, launch: async () => { launches++; } });
  try {
    for (const input of [{ ...f.input, promptDigest: "wrong" }, { ...f.input, options: { preset: "agy-scout", mode: "yolo" } }, { ...f.input, options: { preset: "agy-scout", extra: true } }, f.input]) await expect(provider.start(input)).rejects.toThrow();
    expect(launches).toBe(0);
  } finally { f.cleanup(); }
});
test("public provider registration does not expose fake followUp or cancel", () => {
  const f = fixture();
  try { const provider = new AcpJobProvider(join(f.root, "jobs")); const dispose = registerExternalJobProvider(provider); expect(getExternalJobProvider("agy-acp")).toBe(provider); expect((provider as any).followUp).toBeUndefined(); expect((provider as any).cancel).toBeUndefined(); dispose(); expect(getExternalJobProvider("agy-acp")).toBeUndefined(); }
  finally { f.cleanup(); }
});
test("external agent definitions bind provider and corresponding enforced presets", () => {
  const base = dirname(import.meta.path);
  for (const role of ["builder", "reviewer", "scout"]) {
    const text = require("node:fs").readFileSync(join(base, "agents", `agy-job-${role}.md`), "utf8");
    const meta = parse(text.split("---")[1]); expect(meta.name).toBe(`agy-job-${role}`); expect(meta.runner).toEqual({ type: "external-job", provider: "agy-acp", options: { preset: `agy-${role}` } });
    expect(meta.tools).toBeUndefined(); expect(meta.model).toBeUndefined();
  }
  for (const subrole of ["reviewer-junior", "reviewer-specialist"]) {
    const text = require("node:fs").readFileSync(join(base, "agents", `agy-job-${subrole}.md`), "utf8");
    const meta = parse(text.split("---")[1]); expect(meta.name).toBe(`agy-job-${subrole}`); expect(meta.runner).toEqual({ type: "external-job", provider: "agy-acp", options: { preset: "agy-reviewer" } });
    expect(meta.tools).toBeUndefined(); expect(meta.model).toBeUndefined();
  }
});
