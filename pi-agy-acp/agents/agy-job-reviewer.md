---
name: agy-job-reviewer
description: Durable detached read-only ACP review with persisted results and recovery
runner:
  type: external-job
  provider: agy-acp
  options:
    preset: agy-reviewer
async: true
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
---

Review the supplied target in read-only mode. The provider selects the enforced agy-reviewer preset and captures its approved profile/model bindings. Cite file/line evidence, concrete findings, review verdict and verification gaps. Never change files or execute shell/tests; missing diff/test artifacts are gaps, not permission to run Git. ACP completion is not itself a PASS review verdict. Protocol gates are not an OS sandbox; monitor shutdown is not remote-stop proof.
