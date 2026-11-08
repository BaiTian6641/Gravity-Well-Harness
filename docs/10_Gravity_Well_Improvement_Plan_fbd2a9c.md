# Gravity Well Harness — Improvement Plan (`10_Gravity_Well_Improvement_Plan_fbd2a9c.md`)

**Prepared:** 9 November 2026, Asia/Shanghai  
**Repository baseline:** `fbd2a9c9ead88f48a571cacc3f1f9b5fb6e88c6a`  
**Companions:** `09_Gravity_Well_Review_fbd2a9c.md` and `11_Antigravity_Public_Integration_fbd2a9c.md`

---

## Release Milestones & 10 Work Packages (`WP1–WP10`)

### Milestone A — Dependable Local Execution

#### WP1: Distribution, Clean-Package Preflight & Standalone Readiness
- Remove `antigravity-sidecar-kit/config` from `setup.mjs` and replace with project-owned helpers (`src/config-helpers.mjs` or inline in `setup.mjs`) reading/writing `~/.gemini/config/config.json`.
- Separate preflight validation (`verifyCleanPackagePreflight`) from installation writes and check all shipped entrypoints (`setup.mjs`, `mcp/harness-rag-server.mjs`, `plugin/harness-ide/scripts/mcp-entry.mjs`, `sidecars/harness-ide-monitor/server.mjs`, `sidecars/harness-ide-monitor/launch.mjs`, hooks, and `src/*.mjs`).
- Fix standalone monitor startup (`sidecars/harness-ide-monitor/server.mjs`) so direct invocation awaits listener readiness, persists the actual bound port and URL (`http://127.0.0.1:<port>/?token=...`) in `.harness/monitor-runtime.json`, and prints the ready URL.
- Remove stale `GetAllCascadeTrajectories`, `JetboxWriteState`, and `ManageSidecar` claims from `README.md` and `.agents/skills/turn-into-harness-ide/SKILL.md`.
- Consolidate `.agents/rules/gravity-well-default.md` and `plugin/harness-ide/rules/gravity-well-default.md` with the canonical operating contract in `11_Antigravity_Public_Integration_fbd2a9c.md`.

#### WP2: Executable+Argv Command Contract, Shared MCP Schemas & Run/Message Idempotency
- Preserve `{ command, args, env, cwd, shell }` across `registerExecutor`, `registerVerifier`, `resolveExecutor`, `resolveVerifier`, `runHarness2Loop`, `harness_run_loop`, and `harness_self_improve`.
- Default command execution to `spawnSync(command, args, { shell: false, ... })` so `command: "node", args: ["verify.mjs"]` executes `verify.mjs` directly and fails when `verify.mjs` exits non-zero.
- Record full checker invocation details (`command`, `args`, `cwd`, `exitCode`, `stdout`, `stderr`, `checks`) in candidate results and receipts.
- Add run-level `requestId` reservation and payload-hash idempotency (`.harness/loop-requests.json`) to `runHarness2Loop` so replaying the same `requestId` returns the stored result without re-running the executor, while a mutated payload with the same `requestId` fails with `REQUEST_ID_PAYLOAD_CONFLICT`.
- Update `injectSubagentMessage` (`src/model-hub.mjs`) so reusing a `messageId` with different content (`message`, `recipient`, `sender`, `taskId`) throws/returns `MESSAGE_ID_PAYLOAD_CONFLICT`.
- Synchronize MCP `initialize` version negotiation and all 16 tool `inputSchema` definitions in `mcp/harness-rag-server.mjs`.

#### WP3: Candidate Workspace Isolation, Tree Diff Manifests & Post-Integration Verification
- Execute and verify every candidate strictly inside its isolated `candidateDir` (`cwd: candidateDir`, never projecting unverified candidate files into `rootDir` before or during candidate evaluation).
- Capture complete tree manifests (`captureTreeManifest`: relative file path $\rightarrow$ `{ sha256, size, mode }`) for `inputTree` (initial workspace state) and each candidate's `outputTree`, computing exact tree diffs (`added`, `modified`, `deleted`, `modeChanged`).
- If all candidates fail verification, leave `rootDir` completely untouched (no leaked undeclared files).
- When a winning candidate passes candidate verification (`phase: "candidate"`), verify that `rootDir` still matches `inputTree.treeHash`, apply the winner's additions, modifications, **deletions**, and mode changes atomically to `rootDir`, and execute a dedicated **post-integration verification** (`phase: "post_integration"`) on `rootDir`.

#### WP4: Task-Bound & Check-Bound Verification Authority (`evidenceSchemaVersion: "2.0"`)
- Bind `taskId`, `reqId`, `requirementRevision`, `attemptId`, `lessonRevisionId`, `phase`, `workerId`, `evaluatorId`, `inputTreeHash`, `outputTreeHash`, `artifactHashes`, and canonicalized `checks` (including each check's `name`, `passed`, `score`, `exitCode`, `command`, `args`) into both `createSignedVerdict` / `verifySignedVerdict` and `createEvaluationReceipt` / `verifyEvaluationReceipt`.
- Reject cross-task verdicts/receipts (`VERDICT_TASK_ID_MISMATCH` / `RECEIPT_TASK_ID_MISMATCH`), mutated check `passed` flags (`INVALID_VERDICT_SIGNATURE` / `RECEIPT_SIGNATURE_MISMATCH`), and mismatched requirement revisions.
- Support independently verified no-change results (`changeKind: "verified_no_change"`) when an unchanged workspace tree passes a real registered verifier (`verifierExecuted && passedVerification`).

---

### Milestone B — Supported Managed Agents & Recovery

#### WP6: Public Antigravity SDK Configuration & Upstream Harness² Compatibility
- Update `adapters/harness2_antigravity_executor.py` to construct `BudgetConfig(max_model_calls=..., max_tool_calls=..., max_total_tokens=..., scope=BudgetScope.LIFETIME)` and `CompactionConfig(token_threshold=...)` using the exact public `google.antigravity.types` field names.
- Validate that the constructed SDK objects preserve `max_model_calls`, `max_tool_calls`, `max_total_tokens`, and `token_threshold`; remove any `TypeError` fallback that silently drops controls.
- Require an isolated candidate directory (`workspaces=[str(candidate_root.resolve(strict=True))]`), a validated concrete model ID (rejecting unmapped tier labels), `SessionContinuationMode.CREATE_ONLY` (or `RESUME` for explicit recovery), and `save_dir=str(session_dir.resolve(strict=True))`.
- Add optional owned headless CLI adapter (`agy --input-format stream-json --output-format stream-json`) parsing `init`, `step_update`, and cumulative `result` deltas.
- Align `BenchPrompts`, `HarnessSpec`, `Install`, `Channel`, and `Substrate` with upstream `harness2` classes so `isinstance` / upstream resolver validation succeeds, and run the Python verifier once per verification phase and tree identity.

#### WP7: Controller-Owned Worker Sessions & Transport-Backed Recovery
- Add controller-owned session lifecycle management in `src/context-resilience.mjs` (`registerExecutorSession`, `deliverRecoveryPacket`, `acknowledgeRecoveryPacket`, `requestSessionCancel`, `observeSessionStopped`).
- Record `contractRevision` and `contractDigest` in `createCheckpoint`.
- Require a registered active executor session and recorded transport delivery before `acknowledgeRecoveryPacket` can transition a session from `RECOVERY_PENDING` / `DELIVERY_PENDING` to `RUNNING`, validating `taskId`, `attemptId`, `sessionGeneration`, `checkpointId`, `ledgerRevision`, `contractRevision`, and `packetDigest`.
- In `sidecars/harness-ide-monitor/server.mjs`:
  - Reject cancellation of nonexistent/unregistered sessions (`UNREGISTERED_EXECUTOR_SESSION`); registered sessions enter `CANCEL_REQUESTED` until observed stopped (`CANCELLED`).
  - Ignore caller-supplied `executorAck: true` booleans on `/api/swarm/recall`; require a controller-verified session delivery & acknowledgment token.
  - Keep `/api/swarm/reset` as a view-only annotation reset (`viewAnnotation`) that never marks observed workers `COMPLETED`, and isolate `demoMode` mutations into `subagent-swarm-demo.json`.

#### WP9: Unified Event Reduction & Phase-Based Usage Accounting
- Sum `executorTokens` + `verifierTokens` across all executed phases (`100 + 25 = 125`), preserve recorded calls and usage on failure paths, and eliminate fixed `28000` unmeasured baselines in Python when no measured baseline is provided.
- Deduplicate hook/message events in `post-tool-use.mjs` and `server.mjs` **before** any counter increments (`recallCount`, `toolCallsCount`, `estimatedTokens`) or status changes, and enforce monotonic sequence/generation ordering so replayed events cannot resurrect `CANCELLED` / `COMPLETED` / `FAILED` workers.
- Preserve `null` / `unavailable` / `incomplete` in monitor summary aggregations (never coercing unknown worker totals to `0`), mark formula-derived latency as `estimated` / `unavailable` (never `observed`), and remove hardcoded `512000` context window defaults when unverified.

---

### Milestone C — Reversible, Measured Improvement

#### WP5: Historical Evidence Preservation, Transactional Lesson Promotion & Rollback
- Store immutable copies of verified artifacts inside each lesson revision directory (`.harness/library/<domain>/harnesses/<taskId>/revisions/<lessonRevisionId>/artifacts/`) alongside `receipt.json`, `EXPERIENCE.md`, and `manifest.json`.
- Separate historical receipt verification (`verifyEvaluationReceipt(..., { mode: "historical" })`, which validates against the revision's immutable artifact store and recorded hashes) from current-workspace applicability (`mode: "current_workspace"` / `checkReceiptApplicability`).
- Update `rollbackActiveLesson` to validate historical receipt integrity, restore the target revision's `EXPERIENCE.md`, `manifest.json`, and archived artifacts (when requested), and transactionally replace superseded cues for `taskId` in `.harness/library/<domain>/INDEX.md` and the RAG index.

#### WP8: Connected `harness_self_improve` & Adaptive Candidate Execution
- Unify the execution request contract between `harness_run_loop` and `harness_self_improve` so `harness_self_improve` forwards `executor_id`, `verifier_id`, `command`, `args`, `verifier_command`, `verifier_args`, `required_artifacts`, `request_id`, `baseline_tokens`, and `held_out_check` into `runHarness2Loop`.
- Enhance `registered-command-or-sdk-executor` so candidate harness configurations (`HARNESS_CANDIDATE_ID`, `HARNESS_REASONING_DEPTH`, `HARNESS_THINKING_CAP`, candidate manifest overrides, or candidate scripts) execute in each isolated candidate workspace, while keeping the reference scheduler workload available.

#### WP10: Paired Baselines, Held-Out Evaluation Gates & Release Compatibility Manifest
- Require a verified paired baseline comparison and/or held-out task evaluation (`pairedBaseline` / `heldOutCheck`) before automatically promoting a lesson to `status: "active"` (otherwise recording it as `status: "candidate"` with verified artifacts delivered).
- Maintain a machine-readable compatibility manifest (`.harness/compatibility-manifest.json`) and add Test 20 covering the complete release demonstration (clean-package preflight, failing argv verifier, candidate deletion & isolation, cross-task & mutated-check evidence rejection, historical rollback after v2 artifact replacement, transport-backed recovery, replay protection, and held-out self-improvement).
