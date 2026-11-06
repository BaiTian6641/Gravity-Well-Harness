---
name: harness2-loop
description: "Execute Google Research's Harness² recursive agent harnessing loop (Propose -> Probe -> Compose + Per-Domain Experience Library) in Antigravity using either native branched subagent swarms (Workspace: branch) with Snapshot Isolation or the Python AntigravityExecutor / harness2 CLI."
---

# Harness² Recursive Agent Harnessing Loop (`harness2-loop`)

Use this skill when the user wants to optimize the agent's execution harness, compare $K$ candidate strategies or prompt/rule/skill refinements, run a **Propose $\rightarrow$ Probe $\rightarrow$ Compose** cycle, or integrate with `google-research/harness2`.

---

## 1. Choose the Execution Integration Level

`harness-ide` supports two execution modes (configurable in `.harness/config.json` or the `[Harness² Swarm & RAG Monitor](sidecar://harness-ide-monitor/)` Settings tab):

### Mode A: Native Antigravity Subagent Swarm (Default — Recommended inside IDE)
Antigravity directly orchestrates the **Propose $\rightarrow$ Probe $\rightarrow$ Compose** loop using isolated branched workspaces (`Workspace: "branch"`) and frozen RAG snapshot locks:

1. **Step 1 — Pre-Loop Retrieval**:
   - Call `harness_query(query="<task domain and problem>", collection="experiment-knowledge")` to inspect existing `INDEX.md` conditional cues and prior `EXPERIENCE.md` lessons.
   - Call `harness_query(query="<architecture constraints>", collection="project-knowledge")` to check active ADRs and constraints.
2. **Step 2 — Freeze Knowledge Snapshot (`Snapshot Isolation`)**:
   - Call `harness_snapshot_lock(action="create", domain="<domain>", k=K, mode="parallel")`.
   - Record the returned `snapshotId` and `cutoffTimestamp`. This guarantees that Candidate #1 through Candidate #$K$ read the exact same historical knowledge and cannot leak intermediate notes to one another.
3. **Step 3 — Propose ($K$ Candidates)**:
   - Either formulate $K$ contrastive harness candidates directly or invoke the `harness-proposer` subagent (`invoke_subagent(TypeName="harness-proposer", Role="Harness2 Proposer", Prompt="...")`).
   - Each candidate modifies one or more of the 8 Harness² components (`system_prompts`, `rules`, `skills`, `subagents`, `hooks`, `tools`, `scripts`, `plugins`).
4. **Step 4 — Probe ($K$ Isolated Branched Subagents)**:
   - For each candidate $i \in \{1..K\}$, call `invoke_subagent`:
     - `TypeName`: `"harness-prober"` (or `"self"`)
     - `Role`: `"Harness2 Prober #i"`
     - `Workspace`: `"branch"` (creates an isolated workspace branch so file edits do not collide!)
     - `Prompt`: Include the task, Candidate #$i$'s harness instructions, and the mandatory `snapshot_id` (`snapshotId`).
5. **Step 5 — Compose & Reflect**:
   - Once all $K$ prober subagents report back, invoke `harness-composer` (or synthesize directly) to contrast the execution trajectories, test results, and error rates without requiring ground-truth labels.
   - Adopt the winning harness configuration into the main workspace.
   - Call `harness_record_experience` with `status: "active"` and all 5 provenance fields (`task_id`, `problem`, `observed_behavior`, `supporting_evidence`, `adopted_harness`).
   - Call `harness_snapshot_lock(action="release")` to unlock the knowledge index for subsequent tasks.
   - Surface `[Harness² Swarm & RAG Monitor](sidecar://harness-ide-monitor/)` in your response so the user can inspect the swarm tree and new `EXPERIENCE.md` entry.

---

### Mode B: Python `harness2` CLI & `AntigravityExecutor` Adapter
When running benchmarks (`JobBench`, `LAB`, `WorkBuddy-Bench`, or `harness2-demo`) via Python:

1. **Run Standalone Adapter Demo / Propose-Probe-Compose Cycle**:
   ```bash
   python adapters/harness2_antigravity_executor.py --task-id task-002-verification --domain software-engineering --k 2 --mode parallel
   ```
2. **Use with Upstream `google-research/harness2`**:
   - Clone upstream `harness2` into a Python 3.12+ `uv` environment (`uv venv --python 3.12 .venv && uv pip install -e '.[render]'`).
   - Import `AntigravityExecutor` from `adapters/harness2_antigravity_executor.py` to execute candidate harnesses through the `google-antigravity` Python SDK or `agy` CLI while syncing adopted lessons directly into `.harness/library/<domain>/`.
