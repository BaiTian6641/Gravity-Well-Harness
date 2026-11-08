Review result
I reviewed [c98e282](https://github.com/BaiTian6641/Gravity-Well-Harness/commit/c98e2822d1b18bcc3b9b36ba1b27f17499005fc2), the update after the previously reviewed a9d2e21.
The project has made substantial, measurable progress. All 18 repository tests passed in my isolated run. I would still request changes before treating the system as a reliable autonomous harness with automatic self-improvement.
The most important remaining issue is that execution, verification, and knowledge promotion still follow different rules across JavaScript, Python, and the context ledger. Some individual safeguards now work correctly, but a different execution path can still turn an unchecked or simulated result into active knowledge.
I created two Markdown documents:
Current review: 07_Gravity_Well_Review_c98e282.md — approximately 3,900 words, including confirmed fixes, nine prioritized findings, reproduction results, and source references.
Detailed implementation and public integration plan: 08_Gravity_Well_Implementation_Plan_c98e282.md — approximately 4,700 words, including eight work packages, proposed runtime contracts, supported SDK configuration, context recovery, default instructions, and release acceptance tests.
What improved
The new revision resolves several specific failures from the previous review.
Area
Confirmed progress
Default model invocation
Missing credentials now fail by default. Explicit simulation is identified as simulation.
Concurrent message dispatch
Two simultaneous requests with the same ID now produce one model invocation in the reproduced case.
Failed self-improvement
A failed cycle leaves the completion counter unchanged and does not broadcast an adopted lesson.
JavaScript verification
A changed artifact without an evaluator now returns delivered_unverified.
Candidate outputs
Declared required artifacts are captured separately, and the winning candidate’s artifacts are restored.
Python launcher
The new candidate launcher executes a fixture through the adapter’s local Install and benchmark harness_dir paths.
SDK response handling
Failure prose in a clean output directory no longer counts as a deliverable.
SDK usage
The previous clipping of reported thinking tokens is fixed.
Context validation
Failed JSON verdicts, source files presented as verdicts, and symbols appearing only inside string literals now reject.
Recovery
Missing recovery tokens and tokens predating a newer ledger revision now reject.
Filesystem containment
The previously demonstrated nested checkpoint-directory symlink case now rejects without outside writes.
Context summary
The tested summary now preserves the latest correction and open requirement despite a long objective.
Monitor
One ordinary read no longer creates seven fictional workers. Standalone authentication now defaults to enabled.
Packaging
Source modules, packaged copies, MCP entry, and default rule remain synchronized.
These are real improvements, supported by the [new regression test](https://github.com/BaiTian6641/Gravity-Well-Harness/blob/c98e2822d1b18bcc3b9b36ba1b27f17499005fc2/test/harness-ide.test.mjs#L2145-L2625), [message reservation implementation](https://github.com/BaiTian6641/Gravity-Well-Harness/blob/c98e2822d1b18bcc3b9b36ba1b27f17499005fc2/src/model-hub.mjs#L1911-L2205), and [context recovery changes](https://github.com/BaiTian6641/Gravity-Well-Harness/blob/c98e2822d1b18bcc3b9b36ba1b27f17499005fc2/src/context-resilience.mjs#L1020-L1256).
Highest-priority remaining findings
1. The Python receipt bridge can now publish unchecked or simulated results as active knowledge
This is the most consequential regression I found.
In a real local Python execution, the task requested a functional scheduler with cancellation. The command only wrote TODO text. The loop nevertheless:
Scored the result 1.0.
Issued a real local evaluation receipt.
Recorded an active, non-synthetic lesson.
Ran no functional acceptance check.
The new receipt bridge signs the adapter’s own passing score. It does not add the missing independent verification.
A second case used an explicitly mocked SDK exception with simulation deliberately allowed. The fallback summary contained [SIMULATED], but the aggregate reported synthetic:false and recorded an active lesson through the real local RAG pipeline. The code infers simulation from credential presence instead of preserving which execution route actually ran. See the [Python execution/scoring path](https://github.com/BaiTian6641/Gravity-Well-Harness/blob/c98e2822d1b18bcc3b9b36ba1b27f17499005fc2/adapters/harness2_antigravity_executor.py#L705-L852) and [new receipt bridge](https://github.com/BaiTian6641/Gravity-Well-Harness/blob/c98e2822d1b18bcc3b9b36ba1b27f17499005fc2/adapters/harness2_antigravity_executor.py#L1935-L2035).
Recommended correction: make Python, JavaScript, and the context ledger consume one authoritative verifier result. A receipt should seal an already established result. Simulation provenance must survive fallback, aggregation, reporting, and promotion.
2. The packaged MCP loop still cannot select a real executor and verifier
Through the actual packaged stdio entry:
Request
Result
Ordinary harness_run_loop, with no simulation flag
status:simulated, synthetic:true, passedVerification:true
Corresponding strict request
NO_VERIFIED_EXECUTION_OR_EVALUATOR
The improved JavaScript loop accepts executor/evaluator functions when called directly. The MCP handler supplies neither those functions nor a registered implementation selected by an ID. Functions used in local tests cannot be supplied as JSON tool arguments. See the [MCP loop handler](https://github.com/BaiTian6641/Gravity-Well-Harness/blob/c98e2822d1b18bcc3b9b36ba1b27f17499005fc2/mcp/harness-rag-server.mjs#L845-L874).
There is also still an upstream Harness² compatibility problem. Google’s real resolve_prompts() rejects the adapter’s local BenchPrompts class. The new test imports a local replacement helper. A real upstream Install is ignored by an exact local-class check, although the adapter’s own Install and benchmark launcher now work. Compare the [adapter types](https://github.com/BaiTian6641/Gravity-Well-Harness/blob/c98e2822d1b18bcc3b9b36ba1b27f17499005fc2/adapters/harness2_antigravity_executor.py#L290-L362) with the [actual upstream specification](https://github.com/google-research/harness2/blob/6868817518876de8fd170c6a8354daca273b6191/harness2/core/spec.py).
Recommended correction: introduce server-registered executor_id and verifier_id values, connect the packaged tool to them, and test with the actual upstream types and resolver.
3. The new SDK workspace and budget arguments do not match the public SDK
The adapter now passes these fields:
workspace_root=... max_steps=... thinking_budget_tokens=...
The current public SDK uses workspaces, budget_config, and other explicit configuration fields. The unsupported arguments do not configure the intended controls. The public workspace default is the process working directory. This is supported by the [pinned public constructor](https://github.com/google-antigravity/antigravity-sdk-python/blob/75ba22bd00afae2f46393ff31f30c3f0df52982f/google/antigravity/connections/local/local_connection_config.py#L106-L266), compared with the [adapter’s SDK branch](https://github.com/BaiTian6641/Gravity-Well-Harness/blob/c98e2822d1b18bcc3b9b36ba1b27f17499005fc2/adapters/harness2_antigravity_executor.py#L1515-L1688).
The plan includes a constructor using the documented fields:
Intended control
Public configuration
Candidate workspace
workspaces=[...]
Selected model
model=...
Call/token budgets
budget_config=types.BudgetConfig(...)
Compaction threshold
compaction_config=types.CompactionConfig(...)
Session identity
conversation_id
New/resumed session
session_continuation_mode
Persistence
save_dir
Runtime integration
hooks, mcp_servers, policies
The evidence here is official source inspection plus an explicitly mocked configuration fixture—not a live SDK execution.
Recommended correction: assert the effective configuration before starting the worker. A model name, workspace label, or budget written into a prompt or result object does not configure runtime behavior.
4. Early stopping still runs all candidates, then undercounts their work
A sequential three-candidate fixture invoked all three executors and all three evaluators.
Its supplied usage totaled 600, but the result reported:
100 tokens.
One provider call.
The other candidates as early-stopped with zero tokens.
99.8% savings against a fixed, unexecuted baseline.
The stop decision occurs while formatting trajectories, after the work has already happened.
A second fixture with usage [100, null] reported a complete-looking total of 100 and a savings percentage. Unknown usage is still treated as zero during aggregation. See [candidate dispatch](https://github.com/BaiTian6641/Gravity-Well-Harness/blob/c98e2822d1b18bcc3b9b36ba1b27f17499005fc2/src/rag-engine.mjs#L3095-L3268), [trajectory accounting](https://github.com/BaiTian6641/Gravity-Well-Harness/blob/c98e2822d1b18bcc3b9b36ba1b27f17499005fc2/src/rag-engine.mjs#L3544-L3678), and [aggregate totals](https://github.com/BaiTian6641/Gravity-Well-Harness/blob/c98e2822d1b18bcc3b9b36ba1b27f17499005fc2/src/rag-engine.mjs#L3786-L3955).
Recommended correction: execute and evaluate one candidate before deciding whether to dispatch the next. Count every executed phase, including failed and unselected work. Publish savings only against a measured comparable baseline.
5. A normal repeat run can break lesson and receipt consistency
Two successful executions of the same task produced this result:
State
First execution
Second execution
Execution status
Succeeded
Succeeded
Recorded lesson
Active
Candidate
Composed harness status
Active
Active
Recorded lesson receipt
Present
Null
New receipt verification
Valid
Lesson-digest mismatch
The new receipt picks up the previous lesson’s digest. Recording then constructs new timestamped content, downgrades it because of the mismatch, and overwrites the existing task’s lesson. The aggregate result still describes an active composed harness. See [receipt creation](https://github.com/BaiTian6641/Gravity-Well-Harness/blob/c98e2822d1b18bcc3b9b36ba1b27f17499005fc2/src/rag-engine.mjs#L1895-L2089) and [experience recording](https://github.com/BaiTian6641/Gravity-Well-Harness/blob/c98e2822d1b18bcc3b9b36ba1b27f17499005fc2/src/rag-engine.mjs#L2274-L2478).
Recommended correction: distinguish stable task identity from unique attempt and lesson-revision identities. Seal immutable content, then atomically publish the active revision. A new failed or inconsistent attempt must preserve the previous valid lesson.
6. Context recovery is stronger, but completion and acknowledgment still lack sufficient authority
The earlier failed-verdict, string-literal, missing-token, and stale-token cases are fixed.
Remaining cases include:
Caller-authored passing JSON can mark a requirement verified without a checker running.
Receipt inspection checks signature format rather than authenticating it through the receipt verifier.
Changing evidence and an unregistered consumer can leave the requirement verified.
With the correct token, an incorrect advertised checkpoint_revision and an incorrect supplied executor_session_id are ignored because of field-name mismatches.
Token-only acknowledgment succeeds without worker delivery.
The Python loop ignores persistent stop state.
Packaged model/message handlers omit task identity, preventing the new direct-helper stop check from seeing it.
These were checked against the [context evidence code](https://github.com/BaiTian6641/Gravity-Well-Harness/blob/c98e2822d1b18bcc3b9b36ba1b27f17499005fc2/src/context-resilience.mjs#L452-L634), [recovery implementation](https://github.com/BaiTian6641/Gravity-Well-Harness/blob/c98e2822d1b18bcc3b9b36ba1b27f17499005fc2/src/context-resilience.mjs#L1020-L1256), and [packaged mappings](https://github.com/BaiTian6641/Gravity-Well-Harness/blob/c98e2822d1b18bcc3b9b36ba1b27f17499005fc2/mcp/harness-rag-server.mjs#L845-L955).
Recommended correction: normalize one public schema, validate current evidence dependencies, bind recovery to an owned executor session, and enforce stop state at the shared execution boundary.
7. Monitor improvements are real, but worker cards and controls remain misleading
The previous “one read creates seven completed workers” case is fixed.
A recorded worker with no usage data still displays:
195,000 tokens.
64.2k context.
$0.21 cost.
16 steps.
2m15s duration.
Transcript character estimates also become “observed” usage, while skills, compaction, latency, and trend data can be inferred without corresponding events.
Cancel and recall for a recorded fixture worker returned successful execution states without an executor. The new code also writes those states into telemetry. That makes the stores agree, but it does not establish that a process stopped or a conversation resumed. See [worker cards](https://github.com/BaiTian6641/Gravity-Well-Harness/blob/c98e2822d1b18bcc3b9b36ba1b27f17499005fc2/sidecars/harness-ide-monitor/server.mjs#L1699-L1737), [lifecycle mutation](https://github.com/BaiTian6641/Gravity-Well-Harness/blob/c98e2822d1b18bcc3b9b36ba1b27f17499005fc2/sidecars/harness-ide-monitor/server.mjs#L171-L267), and [control routes](https://github.com/BaiTian6641/Gravity-Well-Harness/blob/c98e2822d1b18bcc3b9b36ba1b27f17499005fc2/sidecars/harness-ide-monitor/server.mjs#L3690-L3754).
Recommended correction: separate graph annotations from execution state. Controls need a registered executor, a command request, and an acknowledgment. Measurements need a value, quality, source, and timestamp.
Public Antigravity integration assessment
The removal of the old direct private RPCs remains a good change. The remaining issue is narrower: normal monitor startup still uses community-kit helpers that depend on language-server runtime metadata, lifecycle probing, and stylesheet discovery. These are source traces, not native requests executed during this review. The entry points remain in the [monitor imports](https://github.com/BaiTian6641/Gravity-Well-Harness/blob/c98e2822d1b18bcc3b9b36ba1b27f17499005fc2/sidecars/harness-ide-monitor/server.mjs#L7-L98) and [startup](https://github.com/BaiTian6641/Gravity-Well-Harness/blob/c98e2822d1b18bcc3b9b36ba1b27f17499005fc2/sidecars/harness-ide-monitor/server.mjs#L3977-L3986).
Google’s current Sidecars documentation identifies the Antigravity App surface. It documents background-process configuration and conversation commands. It does not establish the repository’s auxiliary IDE-pane schema as a stable public contract. [Google Antigravity Docs](https://antigravity.google/docs/sidecars/?utm_source=chatgpt.com)
For your public-API-only requirement, I recommend this product boundary:
Need
Supported direction
IDE customization
Documented plugin, rules, MCP, agents, and hooks
Owned execution
Public SDK with explicit workspace/model/budget/session configuration
Visualization
Authenticated standalone monitor consuming harness events
App background integration
Documented App sidecar configuration and capabilities
Third-party models
Separate documented provider adapters, or the published local OpenAI-compatible SDK route where appropriate
Google documents the plugin components and IDE hooks directly. Its SDK also documents a local OpenAI-compatible connection option, which is a useful future route once the executor contract is reliable. [Google Antigravity Docs](https://antigravity.google/docs/plugins/?utm_source=chatgpt.com)
The plan removes private language-server metadata/style dependencies from the default route. Native-pane support should require a specific public contract and a surface/version integration test.
Detailed improvement sequence
The implementation document provides file targets, implementation steps, and acceptance tests for each work package.
Order
Work package
Required proof
1
Authoritative verification across runtimes
TODO output, stale files, assertion-only evidence, and simulation cannot become verified or active knowledge.
2
Real distributed execution
An installed MCP request selects a real executor/verifier; actual upstream types and public SDK configuration work.
3
Complete candidate isolation and truthful accounting
Candidates receive identical complete inputs; stopped callbacks never run; all executed work is counted.
4
Immutable, repeatable learning
Two valid attempts retain valid receipts; failed later work preserves prior active knowledge.
5
Executor-bound recovery
A restarted worker receives current state, follows a later correction, and respects stop state on every route.
6
Real controls and measurement provenance
Cancellation requires acknowledgment; unknown metrics remain unavailable; event replay is idempotent.
7
Public Antigravity integration
The default installation works without private language-server dependencies and reports activation/health accurately.
8
Consistent retrieval and qualified self-improvement
Snapshots are coherent; resource metadata matches content; improvement is measured against an executed baseline and held-out tasks.
The proposed architecture assigns separate owners to task state, execution, verification, evidence, promotion, and visualization. This is especially important for your self-improvement goal: the component proposing an improvement should not also be able to declare its own evidence valid.
Default prompt and long-context work
The existing default rule is already useful and remains correctly distributed. It addresses complete implementation, connected functionality, exact contracts, checkpoints, and evidence. I would preserve it and make the runtime enforce those requirements. See the [current operating rule](https://github.com/BaiTian6641/Gravity-Well-Harness/blob/c98e2822d1b18bcc3b9b36ba1b27f17499005fc2/.agents/rules/gravity-well-default.md).
The plan includes a compact addition centered on:
Loading the current task and requirement revision before work.
Tracing the user action through the actual executor and returned behavior.
Reporting execution, delivery, verification, and learning separately.
Preserving simulation and failure provenance.
Reloading current task state after restart.
Prioritizing user corrections and unresolved work over narrative history.
For long context, keep authoritative records, a bounded recovery packet, and retrieved evidence as distinct forms of state. Use documented native hooks for supported native events and SDK persistence/compaction for SDK-owned sessions. The public SDK supports lifecycle hooks and persisted sessions; those controls still need to be connected to Gravity Well’s ledger and recovery protocol. [Google Antigravity Docs](https://antigravity.google/docs/sdk/lifecycle/?utm_source=chatgpt.com)
This review does not establish an Argon-specific memory defect. The reproduced problems occur in harness logic and controlled response fixtures. The proposed fixes should therefore be tested across models, including any third-party models you add.
Validation and the next release milestone
The review used isolated local tests, actual packaged MCP processes, real local commands and RAG operations, current upstream source/types, and explicitly mocked SDK/provider responses where identified. No paid provider calls or native installation/compaction tests were performed. The reviewed source checkout remains unchanged.
The Stage-16 evidence also deserves a precise qualification: all ten recorded source hashes match the reviewed checkout, and its lesson/manifest digests match. I independently obtained the reported 18 passing tests. The remaining findings concern behavior those tests do not cover.
I recommend making the next release demonstration a small application with working job creation and cancellation, submitted through the installed MCP interface. It should include one meaningful failed candidate, a correction added after checkpoint, a resumed worker, a valid promoted lesson, a repeat run of the same task, and a real acknowledged control action. Passing that scenario would establish a much stronger foundation for expanding the swarm and adding providers.
Project navigation target: Harness² Swarm & RAG Monitor. Native IDE-pane availability was not validated in this review. /grill-me
