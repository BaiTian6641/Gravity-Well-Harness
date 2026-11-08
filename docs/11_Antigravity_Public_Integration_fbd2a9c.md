# Gravity Well Harness — public Antigravity integration, context recovery, and default prompt

**Prepared:** 9 November 2026, Asia/Shanghai  
**Repository baseline:** `fbd2a9c9ead88f48a571cacc3f1f9b5fb6e88c6a`  
**Companions:** `09_Gravity_Well_Review_fbd2a9c.md` and `10_Gravity_Well_Improvement_Plan_fbd2a9c.md`  
**Status:** proposed integration changes and operating contract. This review did not install them, modify the repository, run a paid provider, or validate a native Antigravity host.

## 1. Supported integration strategy

Build the product around documented plugin components and project-owned execution. Treat each host surface as a separate compatibility target.

| Surface | Public capability to use | Gravity Well responsibility | Claim to avoid |
|---|---|---|---|
| IDE plugin | Rules, skills, hooks, and MCP components | Install validated components; expose task/context/RAG services | A plugin automatically gains arbitrary control over native agent sessions |
| IDE project rules | Supported project instruction files | Keep a compact, canonical operating contract | Replacing Google's undisclosed internal system prompt |
| Antigravity App sidecar | Documented process configuration and `agentapi` CLI commands | Optional App integration with explicit host/version support | Sidecar documentation proves native IDE panel support |
| Owned SDK agent | Public typed configuration, hooks, and lifecycle | Create, identify, observe, budget, and recover workers it owns | A configuration dictionary proves all nested settings took effect |
| Owned headless CLI | Documented JSON streaming and process lifecycle | Parse events; manage the process it launched; verify outputs | An undocumented control channel can manage arbitrary existing IDE agents |
| Standalone monitor | Project-owned local web service | Show truthful evidence and issue requests to the controller | Changing a graph node means the actual worker changed state |

The plugin documentation covers App, CLI, and IDE. The sidecar documentation explicitly limits that feature to the App. Its documented agent API exposes creating conversations and sending messages; these are not a general native-agent lifecycle API. [Plugins][P01] [Plugin construction][P02] [Sidecars][P03]

The project's advertised [Harness² Swarm & RAG Monitor](sidecar://harness-ide-monitor/) URI can remain as a qualified integration option. Provide a discoverable standalone URL for the tested path. Native IDE pane support remains unverified.

**Public does not mean permanently stable.** Record a supported version matrix, pin dependencies where possible, validate schemas, and test the capabilities you ship. Do not substitute language-server discovery, private RPCs, or extracted internal interfaces when a documented capability is absent.

## 2. Repair installation and packaging first

The runtime monitor no longer depends on the old language-server kit by default, which is real progress. However, `setup.mjs` still imports `antigravity-sidecar-kit/config` after that dependency was removed from package manifests. A fresh import resolution fails. The installer was not executed during this review. [Installer][C03] [Package][C04] [Monitor bootstrap][C27]

Make these changes:

1. Replace that dependency with small project-owned helpers for documented configuration, or use the official plugin installation flow.
2. Separate preflight/planning from writes. Verify every shipped entrypoint from a fresh package without inherited node_modules.
3. Report installation stages separately. A failed enable operation must not be followed by a success message.
4. Keep optional App sidecar registration separate from IDE plugin support.
5. Remove stale README/onboarding claims involving `GetAllCascadeTrajectories`, `JetboxWriteState`, or `ManageSidecar`. Their presence in old instructions does not establish a supported API. [README][C37] [Onboarding][C38]
6. Publish the actual bound standalone address after listener readiness. The current ordinary entrypoint stores port zero and emits no usable URL, even though a listener starts. [Entrypoint][C34] [Runtime helper][C27]

For a host-equipped release environment, use the documented validation/discovery commands:

```sh
agy plugin validate --strict ./plugin/harness-ide
agy plugin install ./plugin/harness-ide
agy plugin list --json
```

These are proposed release checks, not commands executed by this review. Record the Antigravity version and validation output. Installation discovery does not by itself prove MCP health or native visualization; test those separately. [Plugin construction][P02]

## 3. Correct the public SDK configuration

### 3.1 What is currently wrong

The adapter passes `max_iterations` and `max_tokens` inside budget configuration, and `enabled` inside compaction configuration. Those are not the fields of the reviewed public SDK models. Executing the actual public `BudgetConfig` and `CompactionConfig` class definitions offline left all budget limits and the compaction threshold unset. The full `LocalAgentConfig` and `Agent` were mocked in this check. [Current adapter][C21] [Budget schema][U01] [Compaction schema][U02]

The adapter also selects the shared project root as the SDK workspace, supplies a tier label instead of a verified model identifier, and has a TypeError fallback that drops configured controls. Remove that fallback: when required controls cannot be represented, fail configuration explicitly. Preserve the correctly bound operating instructions.

### 3.2 Typed configuration template

This is an illustrative implementation template based on the reviewed public types, not a live SDK smoke result. The caller must supply existing isolated directories, a configured model ID, and validated policy/hook/MCP objects. The numeric limits are example policy values, not recommendations for every model or task.

```python
import uuid
from pathlib import Path

from google.antigravity import LocalAgentConfig
from google.antigravity.types import (
    BudgetConfig,
    BudgetScope,
    CompactionConfig,
    SessionContinuationMode,
)


def build_worker_config(
    candidate_root: Path,
    session_dir: Path,
    validated_model_id: str,
    operating_prompt: str,
    validated_policies,
    installed_hooks,
    approved_mcp_servers,
):
    candidate_root = candidate_root.resolve(strict=True)
    session_dir = session_dir.resolve(strict=True)
    conversation_id = str(uuid.uuid4())

    budget = BudgetConfig(
        max_model_calls=12,
        max_tool_calls=50,
        max_total_tokens=80_000,
        scope=BudgetScope.LIFETIME,
    )
    compaction = CompactionConfig(token_threshold=48_000)

    if budget.max_model_calls != 12:
        raise ValueError("SDK did not preserve the model-call limit")
    if budget.max_total_tokens != 80_000:
        raise ValueError("SDK did not preserve the token limit")
    if compaction.token_threshold != 48_000:
        raise ValueError("SDK did not preserve the compaction threshold")

    config = LocalAgentConfig(
        workspaces=[str(candidate_root)],
        model=validated_model_id,
        system_instructions=operating_prompt,
        policies=validated_policies,
        hooks=installed_hooks,
        mcp_servers=approved_mcp_servers,
        budget_config=budget,
        compaction_config=compaction,
        conversation_id=conversation_id,
        session_continuation_mode=SessionContinuationMode.CREATE_ONLY,
        save_dir=str(session_dir),
    )
    return conversation_id, config
```

The public constructor exposes these configuration slots. Budget token semantics concern net uncached input plus output; they are not a context-window occupancy measurement. Compaction uses `token_threshold`, and its suitability must be checked against the selected model and intended output/tool reserve. [Constructor][U03] [Budget schema][U01] [Compaction schema][U02]

Before dispatch, validate the final effective configuration, not just this helper's input objects. Store a redacted configuration digest and limits with the run. Never log credentials.

For deliberate resume, load the controller's existing conversation ID and session directory, and use the public `RESUME` mode. `CREATE_OR_RESUME` is available but can hide a missing session by creating one; avoid it when the operation promises recovery of a particular worker. Use `LIFETIME` for a continuous cap, or `FORWARD_LOOKING` only when an explicit new budget allocation is intended. [Session and scope enums][U07] [Lifecycle][P06]

A workspace path is not an operating-system sandbox. The controller must still isolate candidate output, restrict available tools appropriately, and enforce the user's permission policy. Do not encode policy as an invented `{"terminal_execution":"auto"}` dictionary or use permissive fallback to make an incompatible configuration appear successful.

### 3.3 Harness² compatibility

Use upstream classes and the actual driver seam. The current adapter's locally defined `BenchPrompts` failed the real upstream type check despite having the same class name. Required spec fields, install modes, channel fields, and relative-file prompt materialization also need alignment. The real `Install` launcher has improved and should be retained. [Local compatibility types][C23] [Prompt adapter][C24] [Upstream spec][U04] [Upstream resolver][U05] [Substrate][U06]

Pin a tested Harness² revision and add one local-command benchmark through the actual upstream resolver/driver. Then exercise the same boundary with a live public SDK in a release environment. A test using the project's shadow classes cannot establish upstream compatibility.

## 4. Add an owned CLI adapter as an optional public route

The documented headless mode supports:

```sh
agy --input-format stream-json --output-format stream-json
```

Build an adapter around documented `init`, `step_update`, and `result` records. Wait for a result before sending the next prompt. Capture documented tool/subagent fields when present and retain their source event. The result's usage, turn count, and duration are cumulative for the session; account using ordered snapshots/deltas, not a sum of every result. [Headless CLI][P08]

The same documentation states that `control_request` and `control_response` are unsupported. Do not invent a cancellation protocol. For a process the controller launched, use the supported lifecycle mechanism available in that environment and wait for termination; closing stdin is not proof of immediate cancellation. For SDK cancellation, use the pinned public SDK's supported operation and observe its outcome.

Treat a successful CLI/model result as execution completion. The independent verifier still determines whether the requested task is correct. An owned CLI process does not grant control over unrelated native IDE conversations.

## 5. Hooks, events, and management semantics

Use the documented hook contracts exactly:

- `PreInvocation` can inject bounded context and can block invocation when an essential runtime contract is missing.
- `PostToolUse` supplies the call arguments and an error field; its output is an empty JSON object. It does not promise arbitrary tool-result payloads.
- `Stop` can request continuation, while its input includes stop reason and background-work state. [Hooks][P04]

Keep hook stdout protocol-only; send diagnostics to the appropriate log stream. Do not infer a real child conversation ID from a spawning tool's arguments. Discover identities through a documented result/event or the controller's own dispatch record.

A stop guard should ask for specific missing authorized work while budget and progress permit. It must respect cancellation, unrecoverable errors, exhausted budgets, and external blockers. Repeated “continue” responses without changed evidence would recreate a loop instead of fixing incompleteness.

Implement one event reducer for hooks, SDK/CLI events, and monitor views. Deduplicate before **all** side effects, including counters and status changes. Add source/session generation and ordering rules so old messages cannot resurrect terminal workers. The current hook deduplicates some invocation data while replayed messages still change recall counts and can restore RUNNING after cancellation. [Hook reducer][C32]

Commands and observations must remain distinct:

| User action | Controller result before acknowledgment | Authoritative completion |
|---|---|---|
| Start worker | START_REQUESTED | A registered executor reports a started session |
| Send context | DELIVERY_PENDING | The bound transport confirms delivery; worker acknowledgment records consumption |
| Cancel | CANCEL_REQUESTED | The owned worker/process is observed stopped |
| Recall/resume | RECOVERY_PENDING | The registered worker acknowledges the current recovery packet |
| Hide/reset graph | View annotation only | No execution state change |
| Complete task | Verification pending | Task-scoped verifier and integration evidence satisfy the requirements |

Current monitor handlers accept arbitrary session strings or caller-supplied acknowledgment flags in some routes. Fix the controller connection rather than adding more status fields. Native sessions with no documented control route should expose observation plus a clear unsupported-control state. [Monitor routes][C28] [Reducer][C29]

## 6. Long-context resilience

### 6.1 What public evidence supports

Official CLI release notes describe two relevant fixes:

- **v1.2.8, 22 September 2026:** prompt/context truncation budgeting changes.
- **v1.4.3, 20 October 2026:** losing recent subagent IDs after compaction because the initial prompt could consume the budget.

These are documented CLI host fixes. They do not establish that every IDE version has the same defect, or that the cause is specific to “Gemini 4 Argon.” Record the actual host/model/version in a reproduction before attributing a failure. A benchmark score does not establish that a particular implementation completes project workflows reliably. [CLI changelog][P09]

### 6.2 Three layers of task memory

1. **Authoritative task state:** current user objective/corrections, requirement revision, exact contracts, source revision, active workers, and verification references.
2. **Bounded recovery packet:** the small subset needed for the next action, with links/digests for larger evidence.
3. **Retrieval knowledge:** relevant code, documentation, and evaluated lessons; useful context, not permission to overwrite current instructions.

The present implementation has valuable freshness checks, output bounds, and wrong-session rejection. However, it can replace the recorded session with a caller's string and mark recovery complete without a registered executor or delivered packet. Its checkpoint records contract count instead of the registry revision. [Recovery][C20] [Checkpoint][C46]

### 6.3 Proposed recovery protocol

The following is an internal Gravity Well protocol, not an Antigravity API:

1. Controller pauses dispatch for the affected owned worker.
2. Capture the task requirement revision, actual contract-registry revision/digest, source tree digest, checkpoint revision, executor session identity, and session generation.
3. Construct a bounded packet with the current objective, latest user corrections, open requirements, exact affected declarations, approved constraints, evidence references, and one concrete next action.
4. Compute the digest over a canonical packet excluding its own digest field. Store the packet immutably.
5. Deliver it through the registered SDK/CLI/plugin pathway. Keep delivery status separate from model acknowledgment.
6. Accept acknowledgment only from the bound worker channel, with the expected task, attempt, session generation, checkpoint, ledger revision, and packet digest.
7. Recheck freshness before allowing resumed edits. A new correction or relevant source/contract change invalidates the packet.
8. On timeout or mismatch, remain RECOVERY_PENDING/FAILED and preserve the diagnostic reason.

A controller observation that bytes were delivered is stronger than a UI flag, but does not prove the model used them. Follow recovery with behavior checks: ask the worker to act on the newest correction and read the current exact declaration before editing it.

Reserve context for required state and the next tool/result. Bound tool output before injection, store large logs as artifacts, and retrieve only relevant evidence. Avoid repeated full ledgers, transcripts, and duplicated default rules. Do not hardcode an assumed model window such as the monitor's current `512000`; use verified model/configuration data or display unknown. [Current metrics][C30]

**Acceptance scenarios:** correction issued just before compaction; changed API units after checkpoint; missing prior session; stale worker generation; two workers with different packet digests; oversized tool output; restart after partially completed verification; cancellation during recovery. Execute at least one real compaction/resume scenario on each supported host adapter. A mocked acknowledgment is insufficient.

## 7. Proposed consolidated default operating prompt

The existing default rule already says much of the right thing. Its appended recovery section allows an “independent receipt” shorthand that should now be tightened to a verifier-issued result bound to the task, checks, and artifact tree. Prompt changes supplement the runtime work; they cannot make a missing verifier or disconnected executor function. [Current rule][C39]

Use the following as a **reviewable replacement/consolidation**, not another duplicate rule layered on top. For project/plugin rules, retain the front matter supported by the host. For owned SDK `system_instructions`, supply the body without front matter. Host and user policy remain authoritative. Public rule injection does not replace Google's internal system prompt. [Rules][P05] [SDK constructor][U03]

```markdown
---
trigger: always_on
description: Deliver complete authorized outcomes, preserve exact context, and verify claims against real execution evidence.
---

# Gravity Well operating contract

Follow the current user request, host policies, and project instructions. Match the
scope: a review requires a review; an implementation requires functioning behavior.
Use proportionate process for small tasks.

## Own the requested outcome

Before substantial work, identify the complete user workflow, the components it
crosses, and acceptance conditions for each requested behavior. Keep a concise
requirement ledger distinguishing planned, implemented, verified, and blocked.

Trace each important action through its real request handler, executor, durable
state, returned result, and visible behavior. Check settings, callbacks, consumers,
errors, cancellation, and restart behavior where applicable. A scaffold, screenshot,
HTTP success, type check, or finished model response alone does not prove a feature.

Inspect existing code and both ends of every changed contract. Use supported public
APIs and verify version-sensitive names against primary documentation. State a
missing capability accurately; do not substitute a private interface.

Continue authorized work through integration and meaningful verification. Resolve
routine reversible choices yourself. Ask only when a material unresolved choice,
permission, or missing dependency prevents correct work. Respect denied permission.

## Execute and verify honestly

Use registered executors and isolated candidate workspaces. Label simulations as
synthetic and reference fixtures as test/reference workloads. Neither proves general
model-driven improvement. Missing credentials, unavailable tools, unconsumed
settings, and failed executions must retain accurate outcomes.

Choose checks that would fail if the requested behavior were absent. Exercise the
actual affected boundary and a meaningful failure path. Inspect the delivered
artifacts and final integrated state. Identify mocked and untested boundaries.

Only a verifier-owned result bound to the current task, requirement revision,
attempt, check set, and input/output artifacts can justify verified. A receipt name,
signature, model assertion, or pre-existing file alone is insufficient. A correct
no-change result is valid when the actual checked tree and reason are recorded.

Do not invent measurements, worker events, checks, savings, or completion claims.
Preserve observed failures. Keep incomplete usage totals and unknown values explicit.

## Delegate with responsibility

Give each worker an objective, acceptance conditions, scope, current source and
contract references, relevant corrections, budget, and return format. Do not assume
a child inherits the parent conversation. Use isolated edits or explicit ownership.

Track registered worker/session identities. Sending a request does not establish
delivery, consumption, cancellation, or completion. The parent owns integration and
must verify combined results against the original requirements.

## Recover exact context

For substantial tasks, maintain durable current requirements, user corrections,
contracts, evidence references, active workers, and the next action. Keep summaries
small and link large logs instead of repeatedly injecting them.

After compaction, restart, or handoff, reload authoritative state and compare its
revisions with current files. Re-read exact declarations before editing identifiers,
schemas, units, storage keys, or API signatures. Retrieved lessons guide navigation;
current instructions and source resolve conflicts.

Acknowledge recovery only through the bound executor channel with the current
packet digest and identities. If delivery, freshness, or session ownership cannot
be established, report recovery pending or blocked; do not claim resumption.

## Learn and finish accurately

Treat proposed lessons and harness changes as candidates until independently
evaluated. Compare real configurations on matched inputs and retain regressions.
Keep permissions and user constraints outside automatic optimization. Promote only
with applicable evidence and an available rollback path.

Before ending, compare every requested behavior with the integrated result. Check
for disconnected components, placeholders, silent fallbacks, and open requirements.
Complete remaining authorized work when possible. If blocked, identify the exact
boundary and the concrete next step.

Report what works, the evidence supporting it, and material limits. Never describe
the whole task as complete while an essential requested behavior remains unfinished.
```

Do not add instructions to reveal hidden reasoning, demand arbitrary thought-token counts, or force endless retries. Runtime budgets, complete acceptance conditions, independent verification, and bounded recovery are the enforceable controls.

## 8. Third-party model integration

Keep model routing behind executor capability declarations. The public SDK documents `LocalOpenAIAgentConfig` for compatible local OpenAI-style servers; use that route only for combinations actually tested. A compatible chat response is not proof of tool execution, cancellation, session recovery, or verification. [Local models][P07]

For other providers, implement explicit adapters against their published APIs with separate authentication, model IDs, tool/schema support, usage semantics, and session limits. Reject unsupported required capabilities instead of silently falling back to a weaker worker.

Each adapter should declare: execute tools, structured output, resumable sessions, cancellation, usage reporting, and context controls. Validate those claims behaviorally. Route code changes to an executor capable of producing artifacts, not merely to a model cooperation/chat endpoint.

## 9. Release gate and evidence record

Maintain a small compatibility manifest containing Gravity Well commit, Antigravity surface/version, SDK version/source revision, Harness² revision, OS/runtime, configured model, and tested capabilities. Keep credentials out of it.

A supported release should demonstrate:

1. Fresh package preflight and official plugin validation.
2. Packaged MCP request reaching the selected real executor and verifier.
3. A configured failing verifier actually failing, with argv preserved.
4. Isolated candidate changes, including deletion, integrated and rechecked.
5. Task-bound receipts and preserved historical evidence after a later success.
6. Actual worker start, cancellation, recovery delivery, and stale-packet rejection.
7. Truthful monitor metrics with unknown/incomplete values retained.
8. A held-out task showing a measured harness improvement before promotion.

The current local suite passed 19/19. Additional focused probes exposed the defects documented in the review. Live SDK execution, native plugin/sidecar hosting, and real host compaction remain release checks to perform in the appropriate environment. Do not describe those untested boundaries as validated.

## Source references

[C03]: https://github.com/BaiTian6641/Gravity-Well-Harness/blob/fbd2a9c9ead88f48a571cacc3f1f9b5fb6e88c6a/setup.mjs#L16-L74
[C04]: https://github.com/BaiTian6641/Gravity-Well-Harness/blob/fbd2a9c9ead88f48a571cacc3f1f9b5fb6e88c6a/package.json#L15-L24
[C20]: https://github.com/BaiTian6641/Gravity-Well-Harness/blob/fbd2a9c9ead88f48a571cacc3f1f9b5fb6e88c6a/src/context-resilience.mjs#L1210-L1460
[C21]: https://github.com/BaiTian6641/Gravity-Well-Harness/blob/fbd2a9c9ead88f48a571cacc3f1f9b5fb6e88c6a/adapters/harness2_antigravity_executor.py#L1666-L1810
[C23]: https://github.com/BaiTian6641/Gravity-Well-Harness/blob/fbd2a9c9ead88f48a571cacc3f1f9b5fb6e88c6a/adapters/harness2_antigravity_executor.py#L298-L385
[C24]: https://github.com/BaiTian6641/Gravity-Well-Harness/blob/fbd2a9c9ead88f48a571cacc3f1f9b5fb6e88c6a/adapters/harness2_antigravity_executor.py#L1140-L1184
[C27]: https://github.com/BaiTian6641/Gravity-Well-Harness/blob/fbd2a9c9ead88f48a571cacc3f1f9b5fb6e88c6a/sidecars/harness-ide-monitor/server.mjs#L1-L198
[C28]: https://github.com/BaiTian6641/Gravity-Well-Harness/blob/fbd2a9c9ead88f48a571cacc3f1f9b5fb6e88c6a/sidecars/harness-ide-monitor/server.mjs#L3957-L4104
[C29]: https://github.com/BaiTian6641/Gravity-Well-Harness/blob/fbd2a9c9ead88f48a571cacc3f1f9b5fb6e88c6a/sidecars/harness-ide-monitor/server.mjs#L282-L425
[C30]: https://github.com/BaiTian6641/Gravity-Well-Harness/blob/fbd2a9c9ead88f48a571cacc3f1f9b5fb6e88c6a/sidecars/harness-ide-monitor/server.mjs#L3055-L3255
[C32]: https://github.com/BaiTian6641/Gravity-Well-Harness/blob/fbd2a9c9ead88f48a571cacc3f1f9b5fb6e88c6a/plugin/harness-ide/scripts/hooks/post-tool-use.mjs#L223-L402
[C34]: https://github.com/BaiTian6641/Gravity-Well-Harness/blob/fbd2a9c9ead88f48a571cacc3f1f9b5fb6e88c6a/sidecars/harness-ide-monitor/server.mjs#L4333-L4343
[C37]: https://github.com/BaiTian6641/Gravity-Well-Harness/blob/fbd2a9c9ead88f48a571cacc3f1f9b5fb6e88c6a/README.md#L1-L90
[C38]: https://github.com/BaiTian6641/Gravity-Well-Harness/blob/fbd2a9c9ead88f48a571cacc3f1f9b5fb6e88c6a/.agents/skills/turn-into-harness-ide/SKILL.md#L15-L24
[C39]: https://github.com/BaiTian6641/Gravity-Well-Harness/blob/fbd2a9c9ead88f48a571cacc3f1f9b5fb6e88c6a/.agents/rules/gravity-well-default.md#L1-L79
[C46]: https://github.com/BaiTian6641/Gravity-Well-Harness/blob/fbd2a9c9ead88f48a571cacc3f1f9b5fb6e88c6a/src/context-resilience.mjs#L1106-L1148
[P01]: https://antigravity.google/docs/plugins/
[P02]: https://antigravity.google/docs/build-plugins/
[P03]: https://antigravity.google/docs/sidecars/
[P04]: https://antigravity.google/docs/hooks/
[P05]: https://antigravity.google/docs/rules/
[P06]: https://antigravity.google/docs/sdk/lifecycle/
[P07]: https://antigravity.google/docs/sdk/local-models/
[P08]: https://antigravity.google/docs/cli/headless/
[P09]: https://antigravity.google/docs/changelog?tab=cli
[U01]: https://github.com/google-antigravity/antigravity-sdk-python/blob/75ba22bd00afae2f46393ff31f30c3f0df52982f/google/antigravity/types.py#L1343-L1376
[U02]: https://github.com/google-antigravity/antigravity-sdk-python/blob/75ba22bd00afae2f46393ff31f30c3f0df52982f/google/antigravity/types.py#L864-L875
[U03]: https://github.com/google-antigravity/antigravity-sdk-python/blob/75ba22bd00afae2f46393ff31f30c3f0df52982f/google/antigravity/connections/local/local_connection_config.py#L215-L266
[U04]: https://github.com/google-research/harness2/blob/6868817518876de8fd170c6a8354daca273b6191/harness2/core/spec.py#L89-L169
[U05]: https://github.com/google-research/harness2/blob/6868817518876de8fd170c6a8354daca273b6191/harness2/core/spec.py#L253-L289
[U06]: https://github.com/google-research/harness2/blob/6868817518876de8fd170c6a8354daca273b6191/harness2/substrate/base.py#L26-L78
[U07]: https://github.com/google-antigravity/antigravity-sdk-python/blob/75ba22bd00afae2f46393ff31f30c3f0df52982f/google/antigravity/types.py#L1315-L1340

