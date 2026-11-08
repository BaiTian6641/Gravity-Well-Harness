# Gravity Well Harness — Review of `fbd2a9c` (`09_Gravity_Well_Review_fbd2a9c.md`)

**Prepared:** 9 November 2026, Asia/Shanghai  
**Repository baseline:** `fbd2a9c9ead88f48a571cacc3f1f9b5fb6e88c6a` (compared against `c98e2822d1b18bcc3b9b36ba1b27f17499005fc2`)  
**Companions:** `10_Gravity_Well_Improvement_Plan_fbd2a9c.md` and `11_Antigravity_Public_Integration_fbd2a9c.md`

---

## 1. Confirmed Repairs Since `c98e282`

| Area | Current Assessment |
|---|---|
| Packaged execution | A registered command executor and verifier can now be selected through the actual packaged MCP process, produce an artifact, and record a lesson. |
| Default execution policy | A request without a real executor no longer silently defaults to successful simulation. |
| Sequential early stopping | In the exercised combined execution/verification path, later candidates do not run after the first accepted candidate. |
| Candidate inputs | Ordinary source inputs are staged, and a source-tree digest is captured. |
| JavaScript usage completeness | Mixed known/unknown candidate usage preserves an unknown total instead of treating the known subtotal as complete. |
| Repeated successful tasks | Separate lesson revisions are retained instead of overwriting the preceding lesson text. |
| Frozen RAG snapshots | Captured bytes now consistently drive snapshot metadata, features, hashes, and corpus statistics. |
| Context validation | Unsigned-evidence, stale-contract, missing-file, wrong-session, and invalid-budget cases reject as expected. |
| Monitor worker cards | Fabricated default measurements have been removed on exercised worker cards; unknown values remain unknown. |
| Private runtime dependency | The monitor's default language-server polling/theme integration has been removed. |
| Distribution consistency | Core modules, MCP entry, and default rule match their packaged copies. |

---

## 2. Eight P1 Issues Blocking a Reliability Release (`F01–F08`)

### F01 (P1) — Fresh installation still imports the removed dependency (`setup.mjs`)
- Both `package.json` manifests have empty dependencies, but `setup.mjs` lines 16–74 still import `antigravity-sidecar-kit/config` (`CONFIG_JSON_PATH`, `GLOBAL_CONFIG_DIR`, `GLOBAL_SIDECARS_DIR`, `readJsonSafe`, `updateAgySidecarConfig`, `writeJsonNoBom`).
- A clean resolution check without leftover `node_modules` fails with `ERR_MODULE_NOT_FOUND`.
- **Required repair**: Replace the installer helper with project-owned handling of documented configuration, include every shipped entrypoint in clean-package preflight, separate preflight from writes, report installation stages accurately, and remove stale `GetAllCascadeTrajectories` / `JetboxWriteState` / `ManageSidecar` claims in `README.md` and `.agents/skills/turn-into-harness-ide/SKILL.md`.

### F02 (P1) — A configured failing verifier can be skipped while the task becomes verified
- Registering `command: "node", args: ["verify.mjs"]` stores `args` in the registry, but resolution passes only `entry.command` to the shell-string runner. An empty `node` invocation exits `0`, which is interpreted as verification success even though `verify.mjs` never ran.
- Furthermore, the successful receipt path can omit the evaluator's actual checks.
- **Required repair**: Use an explicit executable-plus-argument-array contract (`command` + `args` via `spawnSync`/`execFileSync` with `shell: false` by default, and explicit `shell: true` only when `shell` mode is requested). Record the actual checker invocation (`command`, `args`, `cwd`, `exitCode`, `stdout`, `stderr`), check results, logs, and artifact identities, and embed the evaluator's actual checks in the signed receipt.

### F03 (P1) — Candidate isolation and final integration do not preserve the evaluated result
- Probe 1: A candidate deleted `obsolete.txt` and created `ready.txt`; its verifier passed, but the final delivered workspace still contained `obsolete.txt`.
- Probe 2: A rejected candidate created an undeclared file; the next candidate's evaluator saw it, and the file remained in the real workspace after the overall run failed.
- **Root cause**: `runHarness2Loop` projects candidate output into the shared workspace before evaluation, cleanup removes only declared artifacts, and final materialization copies files without representing deletions.
- **Required repair**: Execute and verify strictly within isolated candidate trees (`candidateDir`); compute full tree manifests representing additions, edits, deletions, and file modes; apply the winning candidate's tree delta atomically against the expected input-tree identity (`inputTreeHash`); and verify the integrated workspace (`post_integration` verification phase). Rejected candidates must leave the project completely unchanged.

### F04 (P1) — SDK configuration still loses its intended controls & Harness² upstream compatibility
- `adapters/harness2_antigravity_executor.py` supplies `{"budget_config": {"max_iterations": 6, "max_tokens": 8192}, "compaction_config": {"enabled": True}}`.
- Public `google.antigravity.types.BudgetConfig` exposes `max_model_calls`, `max_tool_calls`, `max_total_tokens` (and token caps), and `scope` (`BudgetScope.LIFETIME` / `FORWARD_LOOKING`); `CompactionConfig` uses `token_threshold`.
- Evaluating the official model definitions offline left the supplied limits unset while project-level validation reported success.
- The adapter also needs to pass the isolated candidate workspace (`workspaces=[str(candidate_root)]`), a verified model ID (not an unmapped tier label), `SessionContinuationMode.CREATE_ONLY` (or `RESUME` for explicit recovery), and `save_dir=str(session_dir)`, and must remove the `TypeError` fallback that catches configuration errors and silently drops required controls.
- For Harness² compatibility: align `BenchPrompts`, `HarnessSpec`, `Install`, `Channel`, and relative-file prompt materialization with upstream `harness2` classes so the real upstream resolver accepts them.

### F05 (P1) — Signed evidence is not sufficiently bound to its task and checks
- A signed verdict for task A could mark an unrelated requirement in task B `verified`.
- Changing a check's `passed` value did not invalidate the signature.
- Attempt and lesson-revision identity fields (`attemptId`, `lessonRevisionId`, `phase`, `inputTreeHash`, `outputTreeHash`, `requirementRevision`, `workerId`) are not consistently bound in the authenticated payload.
- **Required repair**: Bind `taskId`, `reqId`, `requirementRevision`, `attemptId`, `lessonRevisionId`, `phase`, `workerId`, full canonical `checks` (including each check's `name`, `passed`, `score`, `exitCode`, `command`, `args`), `inputTreeHash`, `outputTreeHash`, and `artifactHashes` into one shared versioned HMAC-SHA256 evidence payload (`evidenceSchemaVersion: "2.0"`). Support independently verified no-change results (`changeKind: "verified_no_change"`) when an unchanged artifact satisfies a real registered verifier.

### F06 (P1) — Retained lesson text does not yet provide reliable historical evidence or rollback
- Old receipts validate artifact hashes against the current mutable workspace (`rootDir`). After version 2 replaced a version-1 artifact, the version-1 receipt failed validation and `rollbackActiveLesson` failed.
- Updating a lesson's cue changed `EXPERIENCE.md` but left the old cue in the domain `INDEX.md`.
- **Required repair**: Store immutable evidence snapshots per attempt/revision under `.harness/library/<domain>/harnesses/<taskId>/revisions/<lessonRevisionId>/`, separate historical receipt verification (`mode: "historical"`) from current-workspace applicability (`mode: "current_workspace"` / `checkReceiptApplicability`), restore historical artifacts/manifests during `rollbackActiveLesson`, and update `EXPERIENCE.md`, `active.json`, `INDEX.md` cues (replacing superseded cues for the same `taskId`), and the RAG index transactionally.

### F07 (P1) — Recovery and worker controls still accept caller assertions as executor events
- `restoreSubagentFromCheckpoint` accepted a caller-provided session ID, and `acknowledgeRecoveryPacket` returned `RUNNING` with zero executor sessions created and no packet delivered to a worker.
- In the monitor: a nonexistent session string can result in `CANCELLED`; a caller-provided `executorAck` flag can make recall appear successful; `/api/swarm/reset` can mark observed workers complete; and demo actions can affect the real observation store.
- **Required repair**: Controller owns registered worker/session handles (`registerExecutorSession`, `recordPacketDelivery`, `recordWorkerAcknowledgment`, `requestWorkerCancel`, `observeWorkerStopped`). Requests express desired states (`START_REQUESTED`, `DELIVERY_PENDING`, `RECOVERY_PENDING`, `CANCEL_REQUESTED`); only actual registered executor events transition to `RUNNING`, `CANCELLED`, or `COMPLETED`. Keep presentation reset (`viewAnnotation`) and demo state (`subagent-swarm-demo.json`) completely separate from the real observation store.

### F08 (P1) — The public self-improvement route (`harness_self_improve`) is still disconnected
- `harness_run_loop` forwards registered executor/verifier selection, whereas `harness_self_improve` does not forward those selectors (`executor_id`, `verifier_id`, `command`, `args`, `verifier_command`, `verifier_args`, `required_artifacts`, `request_id`, `baseline_tokens`, `held_out_check`) into the execution path.
- `registered-command-or-sdk-executor` resolves only to a fixed scheduler writer instead of executing arbitrary registered/candidate commands or SDK workers where candidate harness configurations change behavior.
- **Required repair**: Share one serializable execution request contract across `harness_run_loop` and `harness_self_improve`, allow candidate harness variations to affect real execution in `registered-command-or-sdk-executor` (while preserving the scheduler reference workload under `registered-scheduler-executor` and backward-compatible scheduler tasks), and require paired baseline + held-out evaluation before promoting a lesson to `active`.

---

## 3. Seven Additional Findings (`F09–F15`)

- **F09 — Usage accounting**: Executor usage of `100` plus verifier usage of `25` became `100` instead of `125`. Some failure paths lost recorded calls and usage. Python still produced fixed-baseline (`28000`) savings when no measured aggregate baseline was supplied.
- **F10 — Idempotency**: Reusing a packaged run `request_id` executed the task twice. A `messageId` conflict in `injectSubagentMessage` returned the original success instead of rejecting changed content (`MESSAGE_ID_PAYLOAD_CONFLICT`).
- **F11 — Monitor measurements**: Summaries converted unknown (`null`) values to `0`, and formula-derived timing was labeled `observed`. Hardcoded `512000` context window limits were used without model verification.
- **F12 — Event replay**: Replaying an older hook/message incremented recall/tool counters and resurrected a `CANCELLED` worker back to `RUNNING`.
- **F13 — Standalone startup**: Direct startup of `sidecars/harness-ide-monitor/server.mjs` stored `port: 0` in `.harness/monitor-runtime.json` before listener readiness and emitted no usable URL.
- **F14 — MCP conformance**: Version negotiation and advertised tool `inputSchema` definitions were out of sync with supported handler fields.
- **F15 — Python verification**: The same checker could run twice with different environments, producing contradictory outcomes.
