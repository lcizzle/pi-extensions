# pi-agy-acp

Antigravity ACP provider and delegated task tool for Pi, backed by `mgwcli.exe`.
Load `pi-agy-acp.ts` as an extension. Existing `/agy-acp-*` commands and the `agy_acp_task` tool remain available.

## Hardening behavior

- Each extension/Pi session owns its profile selection, UI, server and conversation cache. Caches are keyed by Pi session ID, canonical working directory and profile. Older cwd-only caches are intentionally not resumed.
- Operations serialize per runtime and account within a Pi process. Sharing an account across separate processes still uses mgwcli's ownership rules; use distinct profiles for independent background agents.
- Delegated tasks use dedicated ACP sessions, not the primary conversation. Notifications are matched to the active ACP session.
- `default` requires interactive approval. Without UI, permission requests are rejected/cancelled.
- `auto_edit` automatically approves only server-classified `edit` actions, once. Other permission requests require UI approval or are rejected. `yolo` is the explicit broad-approval mode. ACP classification is not an operating-system sandbox.
- `/agy-acp-recover` no longer deletes ownership files. Recovery remains mgwcli's responsibility; uncertain process-tree ownership requires operator-managed recovery.
- Silence does not imply success. Missing terminal responses time out. Model/mode configuration failures are errors.
- Rate-limit profile retries are allowed only before prompt dispatch, never after potentially mutating work has started.
- Shutdown aborts queued/active requests and closes the server. Uncertain cleanup remains a sticky failure; it is not bypassed by starting another server.

## Enforced agent presets

Discover bindings with `/agy-acp-agents` or `agy_acp_agents`, then select a preset:

```text
/agy-acp --agent agy-reviewer Review the auth module
/agy-acp --agent agy-builder Add the requested validation
agy_acp_task({agent: "agy-scout", task: "Locate authentication entry points"})
```

- `agy-reviewer` / `agy-scout`: allow server-classified `read`, `search`, `think` actions once.
- `agy-builder`: additionally allow `edit` once. **No shell, delete, move, fetch or unclassified actions.** It reports checks to run separately, rather than executing tests.
- All presets pin a model (default `gemini-3.8-flash-high`) and force server mode `default` so permission callbacks cannot be bypassed by `auto_edit`/`yolo`. The client ceiling overrides UI approval and custom permission callbacks. Observed prohibited tool activity causes cancellation/failure, retaining partial text; it cannot undo activity already executed.
- Profiles default to the active profile captured at invocation. Model/mode/profile overrides must match the preset's bindings. An explicit profile pins the task to that account without failover.
- `agy_acp_task` accepts optional `workspaceRoot` only with `agent: "agy-scout"`. It must be an absolute existing directory separate from (not inside or above) the parent workspace. The effective cwd is reported in the result. For example:
  ```js
  agy_acp_task({ agent: "agy-scout", workspaceRoot: "D:/Projects/PI-Extensions", task: "Inspect pi-agy-acp and report findings; read-only." })
  ```
  This changes the ACP workspace to that selected repository; it does not enable shell or editing. Project MCP servers are disabled for an explicit workspace override so target `.mcp.json` files cannot grant vault access. Select a narrow repo root, never a drive or broad parent directory. Without the option, the task continues to use the parent Pi workspace.
- These are **ACP permission/event gates, not OS sandboxes or general filesystem confinement**. The selected workspace remains a powerful read scope; the server is trusted to classify actions and honor permission/cancel messages. Stopping/cancelling a task does not prove remote work stopped. Using a preset does not protect against an uncooperative server.

Operator-owned `.pi/agy-acp-presets.json` is optional, trusted project configuration. It is validated at `session_start` and frozen for that session; queued tasks capture their policy/account pool before waiting. Reload/start the session to apply edits. Invalid configuration disables preset calls (and reports a discovery error), without silently reverting to permissive defaults. Legacy free-form calls remain available.

```json
{
  "version": 1,
  "presets": {
    "agy-builder": {"profiles": ["shared-profile-01"], "model": "gemini-3.8-flash-high"},
    "agy-reviewer": {"profiles": ["shared-profile-02", "shared-profile-05"], "model": "gemini-pro-agent"}
  }
}
```

Built-ins accept description/instructions/model/profile binding overrides but their permission policy cannot change. Custom IDs require `description`, `instructions`, a registered `model`, `profiles` (`"active"` or a nonempty finite account list), and `permissionPolicy` (`"read-only"` or `"edit-only"`). Unknown properties/unsupported models are rejected. Only authenticated profiles in the captured pool are eligible for pre-dispatch quota failover; preset failover does not alter the parent's active profile. Configuration is not a security boundary against processes/agents able to edit trusted project files.

## Structured delegated results

`agy_acp_task` declares an output schema and returns identical `details` / `structuredContent` on success and failures (`isError: true`, not an exception). `/agy-acp` messages also retain the complete result in `details` and display the actual selected account/acknowledged model.

Version 1 includes:

- `jobId` (correlation only, **not** a durable job/recovery handle), ACP `sessionId`, `agent`.
- `requested` profile/model/mode; `effective` profile/model/mode/cwd/policy/enforcement. Effective fields stay null until authentication/configuration RPC acknowledgments; acknowledgments describe requested configuration, not independently verified backend model identity.
- `status`: `completed`, `failed`, `aborted`, `blocked`, `incomplete`. `max_tokens` is incomplete/error, never successful completion.
- `text` (including partial output), `stopReason`, `failure` code/message, legacy `modelId` (selected/intended model), `profile` (last attempted account), `error` and `isError`.
- `usage` or null; `source` is `reported`, `estimated` or `mixed`. Missing input/output counts use estimates, never fabricated measured zero counts. Totals may be derived; cache counts default to zero when absent. Failed prompts without a terminal usage report return null usage.
- `promptDispatched`, `attempts`, `profilesTried`, start/end timestamps and duration. No replay after dispatch. Cleanup failure is an error even after receiving terminal output; available text/usage are retained.

Free-form task calls without `agent` preserve legacy permission modes and account switching. These one-off calls do not themselves create durable jobs; use the separate external-job agents below for durable execution/recovery.

## Native pi-subagents wrappers (step 3)

The package ships `agents/agy-builder.md`, `agy-reviewer.md` and `agy-scout.md`, based on the bundled worker/reviewer/scout personas. They are ordinary native Pi children, **not** external-job runners. Each discovers the matching preset, invokes `agy_acp_task` once and returns the versioned ACP result JSON unchanged. A wrapper adds a Pi driver model call (and its cost) around the remote ACP task.

### Install and discover

Install `pi-subagents` separately, then install this directory as a local Pi package in your **target project**:

```sh
pi install npm:pi-subagents
pi install -l D:/Projects/PI-Extensions/pi-agy-acp
```

Use the actual package path if your checkout is elsewhere. Reload Pi after installation and grant project trust when prompted. The manifest explicitly exposes `pi-agy-acp.ts` and `acp-external-jobs.ts` as extensions and `./agents` for pi-subagents package-agent discovery. Do not also load a second copy through a separate extension entry. Loading the `.ts` file alone does not install the agent catalog. No installer is run automatically and no user/project settings are modified by this repository change.

Confirm availability with `subagent({action: "list", capabilities: true})`. A user/project agent with the same name or settings overrides can replace these package definitions; inspect the effective configuration if results differ.

```js
subagent({
  agent: "agy-scout",
  task: "Locate authentication entry points in src/auth. Read-only; include exact paths and line references.",
  async: true,
  output: ".agents/tmp/agy-scout-result.json"
})
```

Supply approved tasks similarly to `agy-builder` or review handoffs to `agy-reviewer`. Use isolated worktrees/one writer per workspace for mutations. Normal Pi artifact routing writes the wrapper's final JSON text; wrappers do not write context/progress files themselves.

### Required configuration and boundaries

- The **Pi driver model must support native Pi tool calling**. It inherits the ordinary pi-subagents model selection unless you pin a tool-capable model through settings or the launch's `model` field. **Do not use `antigravity/*` as that driver:** its ACP provider cannot emit Pi tool calls. The preset's remote `model` binding is separate; changing the Pi driver does not change it.
- Child configuration is loaded from the actual task `cwd`: put `.pi/agy-acp-presets.json` there, including operator-selected profile bindings. A child has its own extension state: the parent's `/agy-acp-profile` selection is **not inherited**. With no profile binding, the child's active-profile fallback is the first authenticated mgwcli account, not necessarily the parent's chosen account. Bind distinct profiles for independent background processes; mgwcli still controls cross-process ownership.
- Frontmatter disables unrelated ambient extensions and explicitly loads `../pi-agy-acp.ts` through `subagentOnlyExtensions`. Only `agy_acp_agents` and `agy_acp_task` are allowlisted; no native shell/filesystem tools or nested delegation. Missing provider/tools fail child preflight rather than being replaced silently. Custom Pi driver providers may need their own explicitly loaded extension; the empty ambient list intentionally does not supply it.
- Wrappers use fresh context with project/global instructions and skills inheritance disabled. **The parent must include relevant repository rules, scope, target/diff paths, constraints and required context in the explicit handoff.** They are transport roles, not independent vault stewards. The parent owns task/session governance.
- Preset selection in wrapper Markdown is **prompt-level routing**, not a new hard boundary. The allowlisted task tool still has its free-form API. Validate returned top-level `agent`, `effective.permissionPolicy` and `effective.enforcement` before relying on the expected role. Builder expects `edit-only`; reviewer/scout expect `read-only`. Existing preset ceilings are code-enforced ACP gates, not OS sandboxing.
- A native Pi child completing does **not** mean its ACP task succeeded or its review verdict passed. Inspect JSON `status`, `isError` and `failure`, then the review findings in `text`. This baseline does not map remote errors to pi-subagents runner state/`structuredOutput`; it returns JSON text, not a durable provider job. Missing/malformed JSON is unverified output, not success. Do not replay failed/dispatched tasks automatically. Cancellation is not remote-stop proof.
- Builder cannot run shell/tests; the parent must perform verification separately. Durable external-job agents below avoid the native wrapper driver and propagate ACP terminal state to the external runner.

## Durable external jobs (step 4)

`acp-external-jobs.ts` registers the public pi-subagents provider **`agy-acp`** and `agy_acp_job` inspection tool. Use `agy-job-builder`, `agy-job-reviewer` or `agy-job-scout` instead of their native-wrapper counterparts:

```js
subagent({agent: "agy-job-reviewer", task: "Review src/auth against the supplied requirements; include evidence and verdict.", async: true})
```

These are `runner.type: external-job` agents. No Pi wrapper model is needed: the assembled handoff goes to a dedicated detached Bun worker, which invokes the **enforced** preset through the existing ACP executor. Known external-role names cannot select another preset. Parent-supplied project instructions are included by external-agent prompt assembly; skills/nested Pi delegation are not granted. Builder remains edit-only without shell/tests.

### Prerequisites

- Install/load the main pi-subagents extension separately. This package declares `pi-subagents: 0.75.0` as a runtime dependency for its **public provider API**, not another loaded owner extension. Local Pi packages do not install dependencies automatically; provision this dependency and compatible host peer packages in the package's normal Node/Bun module resolution tree before installing/reloading. The development checkout uses its existing SDK dependencies. Do not bundle independent host SDK copies into Pi extension distributions.
- **Bun on PATH** and peer packages resolvable from `acp-job-worker.ts` are required for the detached worker. Each new start runs a fixed, no-job worker preflight (15-second bound) before allocating a job; failure creates no dispatch. No process/probe runs merely on extension factory/session startup. Tested with Bun1.4.2 and pi-subagents0.75.0 on Windows.
- Configure approved profile pools/model bindings in the actual task cwd `.pi/agy-acp-presets.json`. At admission, the provider validates/freeze-captures preset instructions/model/policy/account pool. Later configuration changes do not widen queued/running jobs. The worker does not inherit the parent's active-profile or auto-switch UI state; only captured eligible accounts are used for pre-dispatch quota failover.

### Durable identity, persistence and recovery

- Jobs live under `~/.pi/agent/agy-acp-jobs`, or operator environment `PI_AGY_JOB_ROOT`. Keep the root stable across restarts. IDs are `acp-<SHA256(runId,stepIndex)>`; identities also bind canonical cwd, agent/options and actual prompt digest. Identical start requests reuse existing jobs, including after restart; conflicting requests fail. The provider never starts another worker for an existing/incomplete allocation.
- Each job has a private `request.json` (including prompt and captured policy), `worker.claim` (exclusive permanent ownership), `status.json` (heartbeat/stage/dispatch intent), and authoritative `result.json`. Publication uses same-directory temporary files, file flush and rename. Result is written **before** final status; a valid terminal result repairs observation even if final status publication was interrupted. Invalid/truncated/version-mismatched records and symlink/junction paths fail closed.
- A synchronous durable dispatch-intent checkpoint precedes the actual ACP prompt write. If checkpoint persistence fails, that prompt is not dispatched. Intent is conservative: it does not prove the prompt was received. Once a worker has claimed a job, its claim is never stolen/removed based on PID or elapsed time, even before dispatch.
- Worker stdio is ignored/unreferenced, and its lifetime is independent of the initiating Pi session/monitor. A new provider can observe a live worker or harvest its persisted terminal result without importing old callbacks or sending another prompt. A stale/future-skewed heartbeat (30 seconds) reports **blocked / `JOB_UNCERTAIN`**, not stopped/dead. The job might still be executing and can later produce a terminal result. Never replay uncertain work.
- Inspect an existing provider job ID using `agy_acp_job({id: "acp-…", action: "status"})`, `result` or `reattach`. Reattachment is observation, never execution. The pi-subagents recovery bridge likewise calls `reattach`/`result` when it already has provider metadata. It must not call a new start to recover an existing job. Job IDs appear in external-run metadata, distinct from Pi run IDs.
- Completed ACP outcomes map to external `completed`; incomplete/token-limit and failures map to `failed`; ACP abort to `stopped`; permission/policy block to `blocked`. Full versioned ACP JSON is returned with its persisted artifact path. Inline data is capped below the public1MiB bridge limit; larger results use a bounded notice plus full artifact. Results over8MiB fail publication and remain uncertain rather than claiming success. An external completed task is still not a PASS review verdict; inspect findings in `text`.

### Limits, privacy and operator ownership

**No `followUp` or cancellation provider API is implemented.** The dedicated task conversation closes; resume cannot truthfully continue it. **Stopping a Pi run/session stops monitoring, not the detached ACP worker.** Worker cancellation due to its own I/O/error also is not remote-stop proof. Use operator-owned mgwcli recovery for process-tree/lease concerns; this extension never deletes mgwcli ownership records or kills a PID inferred from stale metadata.

Storage is trusted same-user state, not an ACL, authentication token or OS sandbox. Prompt/output artifacts may contain sensitive task content; authentication files and environment snapshots are not copied into job records. Private modes (`0700` directories/`0600` files) are best-effort and do not establish Windows ACLs—choose an operator-private root. Symlink checks are not a defense against a malicious same-user process racing filesystem changes. No automatic retention/deletion runs; archive/delete only after separately establishing the worker and remote work have ended. Deleting job identity/claim files destroys non-replay protection. Process-restart publication is tested; arbitrary filesystem/power-loss durability is not guaranteed. Runtime binaries, installed modules, cwd configuration and server tool classifications remain operator-trusted; ACP gates are not filesystem confinement.

## Tests

Run all suites explicitly (the original filename predates Bun's discovery convention):

```sh
bun test ./pi-agy-acp/*.test.ts ./pi-agy-acp/test-pi-agy-acp.ts
bun test --coverage ./pi-agy-acp/*.test.ts ./pi-agy-acp/test-pi-agy-acp.ts
```

Tests use temporary mgwcli homes and fake ACP processes; they do not require account credentials or run real coding tasks.
Wrapper tests use the development checkout's `yaml` dependency. Set `PI_SUBAGENTS_ROOT` to an installed pi-subagents package directory to additionally exercise its real package discovery and shared native child launch-plan resolver; otherwise that integration check is explicitly skipped. Tested against pi-subagents 0.75.0. Durable tests additionally launch a real detached Bun worker with fake ACP wire processes, verify survival after its launcher exits, new-provider result recovery and duplicate-worker claim rejection. A production worker launch with an empty fake auth home verifies headless preflight blocking without mgwcli dispatch. No live model-driven wrapper/provider invocation is claimed.

Coverage does not establish OS isolation or remote cancellation guarantees. No live mutating ACP smoke test is performed.
