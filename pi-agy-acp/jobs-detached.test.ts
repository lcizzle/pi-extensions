import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { AcpJobStore, makeJobRequest } from "./acp-job-store";
import { AcpJobProvider, nativeWorkerLauncher } from "./acp-job-provider";
test("actual detached Bun fake-wire worker survives launcher exit; new provider harvests once", async () => {
  const root = mkdtempSync(join(tmpdir(), "acp-detached-")); const store = new AcpJobStore(join(root, "jobs"));
  const prompt = "detached task", r = makeJobRequest({ prompt, promptDigest: createHash("sha256").update(prompt).digest("hex"), cwd: root, runId: "detached", stepIndex: 0, agent: "agy-job-scout", options: { preset: "agy-scout" } }, { preset: "agy-scout", profiles: ["one"], model: "gemini-3.8-flash-high", permissionPolicy: "read-only", instructions: "Read only", description: "Scout" });
  store.create(r);
  const home = join(root, "mgw"), profile = join(home, "profiles", "one", "acp-home", "antigravity-acp"); mkdirSync(profile, { recursive: true }); writeFileSync(join(home, "profiles", "one", "profile.json"), '{"type":"shared"}'); writeFileSync(join(profile, "acp_token.json"), '{}');
  const fixture = join(root, "worker.ts"), launcher = join(root, "launcher.ts");
  writeFileSync(fixture, `import {runAcpJobWorker} from ${JSON.stringify(join(dirname(import.meta.path), "acp-job-worker.ts"))};
import {EventEmitter} from 'node:events'; import {PassThrough} from 'node:stream';
await runAcpJobWorker(process.argv[2], {configureRuntime(scope) {scope.state.spawnProcess = (() => {
 const child = new EventEmitter(); Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),killed:false,exitCode:null});
 child.kill=()=>{child.exitCode=0;child.killed=true;child.emit('exit',0)};child.stdin.on('finish',()=>child.kill());
 child.stdin.on('data', data=>{for(const line of data.toString().trim().split('\\n')){const c=JSON.parse(line);if(!c.id||!c.method)continue;
 const reply=()=>{if(c.method==='session/prompt')child.stdout.write(JSON.stringify({method:'session/update',params:{sessionId:c.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{text:'durable answer'}}}})+'\\n');
 child.stdout.write(JSON.stringify({id:c.id,result:c.method==='session/new'?{sessionId:'fake-session'}:c.method==='session/prompt'?{stopReason:'end_turn',usage:{inputTokens:4,outputTokens:2}}:{}})+'\\n')};
 if(c.method==='session/prompt')setTimeout(reply,1200);else queueMicrotask(reply)}});return child;})}});
`);
  writeFileSync(launcher, `import{spawn}from'node:child_process';const c=spawn('bun',[${JSON.stringify(fixture)},process.argv[2]],{detached:true,stdio:'ignore'});c.once('spawn',()=>c.unref());`);
  try {
    await nativeWorkerLauncher().check(); // actual trusted entry loads required peer packages, without job dispatch
    const parent = spawnSync("bun", [launcher, store.path(r.providerJobId)], { env: { ...process.env, MGWCLI_HOME: home }, timeout: 15000 }); expect(parent.status).toBe(0);
    const recovered = new AcpJobProvider(store.root);
    const deadline = Date.now() + 15000;
    let handle = recovered.reattach(r.providerJobId);
    while (["queued", "running"].includes(handle.state) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 50)); handle = recovered.reattach(r.providerJobId); }
    expect(handle.state).toBe("completed");
    const result = recovered.result(r.providerJobId); expect(JSON.parse(result.output!).text).toBe("durable answer"); expect(JSON.parse(result.output!).usage.source).toBe("reported");
    expect(store.readStatus(r.providerJobId).dispatchIntent).toBe(true);
    const duplicate = spawnSync("bun", [fixture, store.path(r.providerJobId)], { env: { ...process.env, MGWCLI_HOME: home }, timeout: 15000 }); expect(duplicate.status).not.toBe(0);
    expect(recovered.result(r.providerJobId).output).toBe(result.output);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 40000);
