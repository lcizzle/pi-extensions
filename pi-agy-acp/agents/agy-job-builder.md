---
name: agy-job-builder
description: Durable detached ACP file-edit job; enforced builder preset, no shell/tests
runner:
  type: external-job
  provider: agy-acp
  options:
    preset: agy-builder
async: true
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
---

Implement the approved task with narrow file edits and preserve repository constraints. The provider selects the enforced agy-builder preset and captures its approved profile/model bindings before dispatch. Do not execute shell commands/tests/delete/move/fetch or widen scope. Report changed files, validation actually performed, outstanding checks and risks. The parent runs tests separately. ACP protocol gates are not an OS sandbox; cancellation/monitor shutdown is not remote-stop proof.
