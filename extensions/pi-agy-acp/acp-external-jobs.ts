import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerExternalJobProvider, getExternalJobProvider } from "pi-subagents/external-job-provider";
import { Type } from "typebox";
import { resolve } from "node:path";
import { AcpJobProvider } from "./acp-job-provider";
import { defaultJobRoot } from "./acp-job-store";
const key = Symbol.for("pi-agy-acp.external-job-registration.v1");
interface Registration { provider: AcpJobProvider; root: string; owners: Set<object>; dispose: () => void }
const shared = globalThis as typeof globalThis & { [key: symbol]: Registration | undefined };
/** Public registry ownership is process-global; disposing one session never drops a live sibling. */
export function acquireAcpJobProvider(root = defaultJobRoot()): () => void {
  root = resolve(root);
  let registration = shared[key];
  if (registration && (registration.root !== root || getExternalJobProvider("agy-acp") !== registration.provider)) throw Error("ACP external-job provider root/registration conflict");
  if (!registration) {
    if (getExternalJobProvider("agy-acp")) throw Error("Another extension owns agy-acp provider registration");
    const provider = new AcpJobProvider(root);
    registration = { provider, root, owners: new Set(), dispose: registerExternalJobProvider(provider) }; shared[key] = registration;
  }
  const owner = {}; registration.owners.add(owner);
  return () => { if (!registration!.owners.delete(owner)) return; if (!registration!.owners.size) { registration!.dispose(); if (shared[key] === registration) shared[key] = undefined; } };
}
const ResultSchema = Type.Object({ providerJobId: Type.String(), state: Type.Union([Type.Literal("queued"), Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("stopped"), Type.Literal("blocked")]), failureCode: Type.Optional(Type.String()), failureMessage: Type.Optional(Type.String()), output: Type.Optional(Type.String()), artifactPath: Type.Optional(Type.String()) });
export default function (pi: ExtensionAPI) {
  let release: (() => void) | undefined;
  pi.on("session_start", () => { release?.(); release = acquireAcpJobProvider(); });
  pi.on("session_shutdown", () => { release?.(); release = undefined; });
  pi.registerTool({
    name: "agy_acp_job", label: "Durable ACP Job", description: "Inspect or reattach an existing durable ACP external job by provider job ID. Never starts/replays work. Stopping a Pi run does not stop the detached ACP worker; no cancel/followUp API is implemented.",
    annotations: { readOnlyHint: true },
    parameters: Type.Object({ id: Type.String({ pattern: "^acp-[a-f0-9]{64}$" }), action: Type.Union([Type.Literal("status"), Type.Literal("result"), Type.Literal("reattach")]) }), outputSchema: ResultSchema,
    execute: async (_id, input) => {
      let result;
      try { const provider = getExternalJobProvider("agy-acp"); if (!provider) throw Error("ACP external provider is not registered; reload the package"); result = await (input.action === "result" ? provider.result(input.id) : input.action === "reattach" ? provider.reattach(input.id) : provider.status(input.id)); }
      catch (error: any) { result = { providerJobId: input.id, state: "blocked" as const, failureCode: error.code ?? "JOB_LOOKUP_FAILED", failureMessage: (error.message ?? "Job lookup failed").slice(0, 4096) }; }
      const data = { ...result };
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }], details: data, structuredContent: data, isError: ["blocked", "failed", "stopped"].includes(data.state) };
    },
  });
}
