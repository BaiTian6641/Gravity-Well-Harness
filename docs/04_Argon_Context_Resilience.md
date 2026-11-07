# Gravity Well Harness — Gemini 4 Argon, Completion Quality, and Context Resilience

**Review date:** 7 November 2026 (UTC).  
**Repository baseline:** [`c619f9dd4212b892c372f9491a2ce7b2e8be1c8a`](https://github.com/BaiTian6641/Gravity-Well-Harness/tree/c619f9dd4212b892c372f9491a2ce7b2e8be1c8a).  
**Status:** Proposed design and operating guidance. The rules are ready to copy; the runtime mechanisms below still require implementation and evaluation.

## 1. What needs to improve

The target behavior is straightforward: an agent should understand the requested system, connect its components, verify the resulting user workflow, and preserve the decisions needed to continue reliably. A high model benchmark score does not establish that a particular IDE session, tool configuration, context policy, or implementation workflow delivers this behavior.

Treat the reported “lazy” behavior as several measurable failure modes:

| Failure mode | Observable symptom | Harness response |
| --- | --- | --- |
| Premature completion | The agent stops after a scaffold or a small subset of requirements | Requirement ledger and evidence-based completion gate |
| Incomplete wiring | A control, configuration field, or interface exists but has no runtime consumer | Contract map and a test crossing the actual boundary |
| Lost project context | Later work contradicts an earlier requirement or architecture decision | Durable task state and compact, versioned worker handoffs |
| Identifier drift | Renamed keys, wrong units, or invented symbols appear after a long session | Exact contract registry and re-reading declarations before dependent edits |
| Misleading success | Missing credentials or failed execution produces a plausible success response | Typed failure states and no implicit simulation fallback |
| Excessive context | Repeated logs, instructions, schemas, and history crowd out relevant information | Bounded retrieval, references to artifacts, and focused sessions |

The current repository itself has several of these problems. Its `runHarness2Loop()` calculates scores and tokens without executing the requested task; the monitor generates some metrics from elapsed time. A stronger prompt cannot make those measurements real. Repair the underlying mechanisms as described in documents 01 and 02.

## 2. What the public evidence establishes

### 2.1 A relevant open issue exists

The official Antigravity CLI tracker contains [issue #1245][LC1], opened on 14 October 2026 and still open when checked. Its author reports compaction around 250–276k tokens while using Argon, followed by loss of exact identifiers, numeric scales, and storage keys, plus cache misses. The report also describes fields that were declared but never wired into downstream behavior. These are first-person observations, not an independently reproduced diagnosis of every Argon session.

There is also direct vendor confirmation: on 4 November 2026, Google forum staff stated that Gemini models including Gemini 4 Argon in the **Antigravity App** automatically compact at approximately 250K tokens, that this threshold is currently fixed, and that a configurability request had been passed to engineering. [LC9] This establishes an App behavior at that date. It does not establish the same limit for the standalone IDE, SDK, every model, or future releases.

The separate forum discussion [LC2] includes claims based on private runtime inspection. Those details are unnecessary for this plan and are not an implementation specification. No binary patching, private configuration keys, hidden transports, or extraction of the vendor's internal prompt is proposed.

### 2.2 Google has acknowledged related compaction defects through release notes

The official changelog records that CLI **1.4.10**, dated 29 October 2026, fixed subagents losing their assigned task and parent ID after compaction. It also improved post-compaction size reporting. This supports including version checks and task recovery in the harness. It does **not** prove that every reported threshold, cache, or cross-file consistency problem was fixed. [LC3]

### 2.3 Supported controls differ by product surface

The CLI documents `/context` for inspection and context-management workflows such as starting a new conversation, branching, and disabling unnecessary MCP servers. Its public headless stream includes checkpoint steps. [LC4][LC5] However, Google's FAQ restricts wrapping the consumer CLI inside third-party coding agents or applications; direct scripts and CI are the stated headless use case. Therefore use the public SDK with independent, authorized API credentials for Gravity Well's managed workers. A CLI adapter is conditional on a specifically supported usage arrangement, not enabled by default merely because the command is public. [LC10]

The Python SDK exposes a public `CompactionConfig(token_threshold=...)` and an `on_compaction` hook. These apply to an SDK-created runtime. They do not establish a way to change the internal compaction policy of an already running IDE conversation. [LC6]

**Conclusion:** Build recovery around supported events and durable state. Do not promise to unlock a native IDE context limit. When the host does not publish a control or metric, show that limitation and use a supported fresh session or SDK worker.

## 3. Default prompt deployment

The companion file **`03_gravity_well_default.md`** is an engineering rules file. Its YAML uses `trigger: always_on`, and its content is intentionally much smaller than a full project handbook.

Recommended initial deployment is a single project rule at:

```text
.agents/rules/gravity-well-default.md
```

For a reusable default across projects, the documented global modular-rule location is:

```text
~/.gemini/config/rules/gravity-well-default.md
```

Choose one scope and copy the companion file there after reconciling it with existing rules. Keep only one active copy. Do not also paste the entire file into `AGENTS.md`, `GEMINI.md`, every worker prompt, and a session hook. Those two plain-Markdown instruction files do not use this rule frontmatter. Redundant injection increases context and can introduce conflicts. [LC7]

Antigravity documents project/global rule discovery, `always_on` activation, a 24,000-byte per-file limit, and a 20,000-token aggregate budget for active rules. Oversized rules can be truncated or demoted to pointers. [LC7] Verify that the selected host loads the rule; a file existing on disk is insufficient evidence.

For SDK workers, pass the Markdown body of the operating contract through `system_instructions`, preferably as a `SystemInstructionSection` inside `TemplatedSystemInstructions`. This preserves the SDK's normal scaffolding. The raw `CustomSystemInstructions` route bypasses that scaffolding and is not the recommended default. The YAML discovery metadata belongs to the native rule file, not the SDK section. This supplies your instructions through a supported interface; it does not extract Antigravity's private built-in prompt. [LC8][LC11]

The rule addresses completion discipline, source inspection, contract wiring, honest verification, delegation, context recovery, and evidence-based learning. Its success must be measured. It cannot guarantee obedience or correct an implementation that lies about execution.

## 4. Enforce completion outside the prompt

### 4.1 Maintain a requirement ledger

For substantial tasks, create a task-scoped ledger. Suggested project-owned structure:

```json
{
  "taskId": "task-example",
  "revision": 4,
  "requirements": [
    {
      "id": "REQ-01",
      "behavior": "A submitted job executes and returns a durable result",
      "state": "implemented",
      "implementationRefs": ["src/jobs/submit.ts", "src/worker/execute.ts"],
      "acceptanceChecks": ["job-survives-restart"],
      "evidenceRefs": [],
      "blockedBy": null
    }
  ]
}
```

These names describe a **proposed Gravity Well format**, not existing Antigravity APIs. Transition to `verified` only after a check produces evidence tied to the current revision. Preserve the original request and subsequent user corrections so a summary cannot silently shrink the scope.

### 4.2 Verify complete functional paths

For an integration feature, identify its actual entry point, validation, executor, persistence, event/result transport, and consumer. A feature does not pass because all those symbols exist. Exercise the connection.

Examples for this repository:

- Submit an agent task; verify an actual process or public runtime session starts, produces a known artifact, and finishes with an observed result.
- Send a message to worker B; verify B acknowledges that message ID and worker A does not consume it.
- Change a retrieval backend; verify the next query reaches that backend or returns an explicit unsupported configuration error.
- Restart the coordinator; verify a completed result remains readable and a previously running task becomes recovered or unknown according to actual executor state.
- Remove provider credentials; verify the UI and MCP response report unavailable, with no successful fabricated answer.

For a small text or cosmetic change, use a correspondingly small check. The goal is meaningful verification, not a compulsory large test suite for every edit.

### 4.3 Separate outcome verification from model self-assessment

Use model critique to identify likely omissions. Use independent programmatic or observable checks to establish whether required behavior occurred. A model that grades its own output highly has provided an opinion, not execution evidence.

A task can be `implemented_unverified` when a live external dependency is unavailable. That status should preserve useful work and clearly identify the missing boundary. It must not silently become `succeeded`.

## 5. Durable context architecture

### 5.1 Use three layers

| Layer | Contents | Update policy |
| --- | --- | --- |
| Stable operating contract | Small default rule, non-negotiable project constraints, permission boundaries | Change deliberately; keep a version and digest |
| Task state | Objective, accepted scope, requirement ledger, exact contracts, progress, worker ownership | Update at meaningful milestones and before handoffs |
| Retrieved evidence | Relevant source excerpts, test outputs, documentation and past lessons | Fetch on demand with provenance and a bounded budget |

Keep raw logs, full transcripts, screenshots, and large documents outside the active prompt, with scoped artifact references. Persisting them does not mean automatically injecting them.

### 5.2 Preserve exact contracts

The contract registry should contain the details that prose summaries commonly blur:

- Symbol, field, enum, route, event, configuration and storage-key names.
- Units, numeric ranges, nullability, defaults, ordering and cardinality.
- Producer and consumer files plus their content digests.
- The specific tests or observed examples establishing the contract.
- Migration status when old and new versions coexist.

Do not attempt to maintain a second complete copy of the source code. Store references and exact high-impact values. If a referenced file changed, invalidate the relevant entry and re-read the declaration.

### 5.3 Write a resumable checkpoint

Suggested checkpoint contents:

```yaml
schema_version: 1
task_id: task-example
checkpoint_revision: 12
base_commit: <actual-commit>
working_tree_digest: <digest-or-explicit-unavailable>
objective_ref: objective.md
requirement_ledger_ref: requirements.json
contract_registry_ref: contracts.json
open_requirements: [REQ-03, REQ-07]
completed_evidence_refs: [evidence/run-17.json]
active_workers:
  - worker_id: worker-b
    executor_session_id: <observed-session-id>
    ownership: [src/worker/]
pending_messages: [message-27]
material_user_corrections: []
known_failures: [restart-recovery-check]
next_action: Re-read the job result schema and repair restart recovery.
```

This is a project-owned template. Fill values from observed state; do not fabricate commits, session IDs, digests, or evidence locations.

Checkpoint writes need atomic replacement or a transaction. Store the immutable checkpoint revision before updating the “current” pointer. A crash during a checkpoint must leave the previous checkpoint readable.

## 6. Recovery after compaction or handoff

1. **Observe the boundary through a supported route.** For SDK workers, use the public compaction hook. For a CLI workflow whose usage is separately supported, use its documented checkpoint step. For native sessions without an equivalent event, checkpoint proactively at milestones and have the next invocation read the current task state. Do not invent a native `PreCompact` hook.
2. **Persist a bounded checkpoint.** Record the requirement ledger and exact contracts before intentionally rotating a worker. An unexpected host compaction should still find the last durable checkpoint.
3. **Reload the task state.** Reconcile checkpoint revision, current repository revision, dirty files, pending worker results, and user corrections.
4. **Re-read exact dependencies.** Before editing code that depends on a prior declaration, reload that declaration and relevant consumers. Verify spelling, types, units, defaults, and persistence keys.
5. **Resume one concrete action.** Continue from the next incomplete requirement, not from an invented reconstruction of the entire conversation.
6. **Verify the recovered behavior.** Run a relevant cross-component check before issuing a new completion claim.

If the same task repeatedly compacts without progress, stop expanding the prompt. Create a focused worker/session from the durable checkpoint and a narrower file set. Record the failure reason; avoid an unbounded automatic re-prompt loop.

## 7. Context budgets and accounting

### 7.1 Initial policy to evaluate

Use a bounded working set even when a model advertises a large window. As a conservative **starting experiment**, target approximately 64–96k active tokens for a complex coding worker and persist task checkpoints at milestones, before reaching the selected compaction threshold. For an SDK worker, trial a 96k compaction threshold as shown below. Rotate to a focused worker after repeated compactions without measurable progress, a completed subtask, or a meaningful change of scope; do not wait for a larger active-token threshold that compaction might prevent it from reaching.

An alternative experiment, when the runtime exposes the necessary controls, is checkpoint preparation below 96k followed by worker rotation near 128k **without the 96k automatic-compaction setting**. Compare these policies separately. All these numbers are proposed Gravity Well values, not official Antigravity settings or a measured optimum. Smaller local models require lower limits.

Calculate the usable ceiling from the selected model/runtime's verified limit, expected output, tool-result allowance, and uncertainty reserve. Never allow a fixed project threshold to exceed a smaller provider limit. Unknown native usage should remain unknown; use milestone-based checkpoints and bounded payload sizes instead of pretending to know the remaining window.

### 7.2 Keep accounting semantically correct

Record provider, runtime version, model identifier, measurement source, and whether a value is measured, estimated, or unavailable. Separate cumulative billed tokens from the active context size. Avoid summing per-step cumulative usage more than once. Cached tokens and thinking tokens may already be included in other counters; normalize each provider's documented semantics before adding or calculating cost.

Exact system-prompt categories, hidden reasoning content, cache-hit percentages, and native context contents are not prerequisites for a useful monitor. Show reliable aggregate measurements and inspectable inputs you own. Remove the current wall-clock formulas and synthetic token-speed curves.

### 7.3 Preserve stable prompt prefixes

Keep the operating contract and tool catalog stable within a run. Append new task evidence and message deltas in controlled places. Avoid rewriting the entire system prefix on each timer tick or re-injecting the same RAG paragraphs on every invocation. These changes can reduce avoidable context growth; cache improvements still need measurement because the provider controls caching.

## 8. Supported SDK configuration example

The following illustrates the documented public configuration surface. **96,000 is an experimental project value**, not a recommended universal threshold:

```python
from google.antigravity import CompactionConfig, LocalAgentConfig, types

config = LocalAgentConfig(
    system_instructions=types.TemplatedSystemInstructions(
        identity="You are a Gravity Well engineering worker.",
        sections=[types.SystemInstructionSection(
            title="Engineering operating contract",
            content=operating_contract_markdown_body,
        )],
    ),
    workspaces=[isolated_workspace],
    compaction_config=CompactionConfig(token_threshold=96_000),
)
```

Use a pinned SDK version, independently authorized API credentials, explicit tool and filesystem policies, a task-specific state directory, and verified model configuration before starting the agent. Define the two example variables from validated local state before use. The SDK example is an integration template, not code executed during this review. Test configuration acceptance and checkpoint events against the selected release. Do not assume the same setting changes App or IDE sessions. [LC6][LC8][LC11]

## 9. Evaluation plan

### 9.1 Separate prompt benefit from runtime benefit

Run a small controlled comparison before adopting the new default broadly:

| Variant | Change | Question |
| --- | --- | --- |
| A | Existing rules and behavior | What is the baseline failure rate? |
| B | New default rule only | Does completion discipline improve? |
| C | Rule plus requirement ledger and functional checks | Do disconnected features stop passing? |
| D | C plus durable checkpoints, contract registry, and scoped recovery | Does correctness survive long sessions and compaction? |

Use the same task inputs, repository commit, model/version, permission scope, and approximate resource budget. Start with six representative tasks and at least three trials each where cost permits. Expand only when results are inconclusive. Include both short tasks and long multi-file tasks so the policy does not improve one by harming the other.

### 9.2 Required regression cases

| ID | Case | Acceptance condition |
| --- | --- | --- |
| CTX-01 | A field uses milliseconds in one module and seconds in another | Unit mismatch is caught before completion |
| CTX-02 | An exact storage key must survive checkpointing | Producer and consumer retain the exact same key |
| CTX-03 | A requirement arrives after the initial plan | It remains present after handoff/compaction |
| CTX-04 | A subagent is resumed after context reduction | Task, parent ID, ownership, and open checks are restored |
| CTX-05 | A checkpoint references a file changed by another worker | The stale contract is invalidated and re-read |
| CTX-06 | A UI control has no backend consumer | The requirement cannot become verified |
| CTX-07 | Credentials required by the selected provider are absent | The run reports unavailable; no simulated success; explicitly credential-free local backends remain valid |
| CTX-08 | A tool returns a large log | Full log is stored; bounded evidence and a reference enter context |
| CTX-09 | The checkpoint process is interrupted | The preceding complete checkpoint remains recoverable |
| CTX-10 | The context metric is unavailable | UI says unavailable and milestone recovery still works |
| CTX-11 | A retrieved note conflicts with source or a newer requirement | Resolve by provenance and revision; re-read source for exact present contracts while retaining approved requirements that intentionally require changing that source |
| CTX-12 | A task repeatedly makes no progress | Bounded escalation or focused restart occurs, without endless retries |

Measure accepted requirement coverage, functional path pass rate, cross-file consistency failures, recovery failures, false completion claims, human corrections, latency, and actual provider cost. Treat a lower token count as useful only when outcome quality remains acceptable. Do not score success from the presence of desired words in a candidate prompt.

## 10. Immediate actions and limits

The default rule can be trialed immediately in one project. Verify host rule loading, maintain a small objective/requirements/checkpoint set, and re-read exact declarations after resuming. Use a tested Antigravity release incorporating relevant fixes; capture the actual installed version rather than relying on a possibly stale download-page label.

The next implementation should make requirement completion, message delivery, snapshots, and measured execution trustworthy. Add the context recovery machinery to that foundation. A system that records fabricated successful runs will otherwise learn the wrong lessons more efficiently.

These measures aim to reduce failure exposure and recover lost working context. They are not a claim that Argon's underlying long-context reasoning, Antigravity's native compaction policy, or provider-side caching has been repaired.

## Sources

[LC1]: https://github.com/google-antigravity/antigravity-cli/issues/1245
[LC2]: https://discuss.ai.google.dev/t/1m-advertised-context-vs-a-256k-compaction-clamp-in-the-shipped-binaries-plus-quota-and-agy-p-policy-questions-desktop-2-29-0-cli-1-5-1/198430
[LC3]: https://antigravity.google/docs/changelog/
[LC4]: https://antigravity.google/docs/cli/commands/context/
[LC5]: https://antigravity.google/docs/cli/headless/
[LC6]: https://github.com/google-antigravity/antigravity-sdk-python/blob/main/google/antigravity/CHANGELOG.md
[LC7]: https://antigravity.google/docs/rules/
[LC8]: https://antigravity.google/docs/sdk/overview/
[LC9]: https://discuss.ai.google.dev/t/enable-larger-than-250k-gemini-context-sizes-in-antigravity-desktop/198191
[LC10]: https://antigravity.google/docs/faq/
[LC11]: https://antigravity.google/docs/sdk/personas/

- **LC1:** Official issue tracker, user-authored bug report; open status checked through GitHub. Reports are evidence of observed behavior, not a universal vendor guarantee.
- **LC2:** User-authored forum report; included for the status of public discussion, not as an implementation specification.
- **LC9:** Direct Google staff response concerning the App; checked independently from the second-hand discussion.
- **LC3–LC8:** Official product documentation or official SDK source. Mutable web documentation was checked on the review date; runtime compatibility must be pinned and tested separately.
