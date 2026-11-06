---
docid: EXP-SWE-001
title: "EXPERIENCE: Enforcing Snapshot Isolation Across Candidate Harness Probes"
collection: experiment-knowledge
domain: software-engineering
task_id: task-001-snapshot-isolation
status: active
repo: Harness2-RAG-antigravity
git_revision: 74bf28e
created_at: "2026-11-07T02:56:45Z"
cue: "When comparing K candidate harnesses in a Propose-Probe-Compose loop while local RAG indexing is active, lock a frozen snapshot_id so candidates cannot contaminate each other's retrieval context."
evidence_links:
  - ".harness/library/software-engineering/harnesses/task-001-snapshot-isolation/harness/manifest.json"
  - ".harness/knowledge/project/ADR-001-memory-and-rag-architecture.md"
tags: [snapshot-isolation, harness2, propose-probe-compose, rag, benchmark-consistency]
---

# EXPERIENCE: Enforcing Snapshot Isolation Across Candidate Harness Probes

## 1. What Task or Problem Produced This Lesson?
- **Task ID**: `task-001-snapshot-isolation`
- **Problem**: During a contrastive evaluation of $K=2$ candidate harnesses in a shared workspace, Candidate #1 wrote intermediate failure-analysis notes into the knowledge directory and triggered an index refresh. Candidate #2 subsequently retrieved Candidate #1's failure analysis during its own probe rollout, artificially inflating Candidate #2's performance and invalidating the contrastive comparison.

## 2. Which Repository and Revision Did It Apply To?
- **Repository**: `Harness2-RAG-antigravity`
- **Git Revision**: `74bf28e`
- **Domain**: `software-engineering`

## 3. What Was Actually Observed?
- **Baseline Harness (Unisolated Shared Index)**:
  - Candidate #2 retrieved 2 intermediate notes authored by Candidate #1 (`timestamp > probe_start_time`), causing attribution ambiguity during the `Compose` step.
- **Refined Harness (Snapshot Lock + Branched Subagent Workspaces)**:
  - Before invoking `harness-prober` subagents, the orchestrator called `harness_snapshot_lock(action="create", domain="software-engineering", k=2, mode="parallel")`.
  - Both Candidate #1 and Candidate #2 queried `harness_query` with the locked `snapshot_id` (`cutoff_timestamp = 2026-11-07T02:56:45Z`) and executed inside isolated `Workspace: "branch"` environments.
  - Zero cross-candidate leakage occurred (`0` post-cutoff documents returned during probing), and the `Composer` subagent cleanly attributed behavioral improvements to the candidate harness rules rather than leaked context.

## 4. Which Evidence Supports the Conclusion?
- Upstream Harness² specification (`google-research/harness2/blob/main/docs/EXPERIMENTS.md` & `harness2/core/library.py`): tasks within a domain are ordered and may read only earlier experience entries.
- Adopted Harness Configuration: [`./harness/manifest.json`](./harness/manifest.json)
- Automated verification test in `test/harness-ide.test.mjs` (`Snapshot Isolation blocks post-cutoff and candidate-status documents during active probe lock`).

## 5. Is the Conclusion Still Current?
- **Status**: `active`
- **Verified On**: `2026-11-07`
- **Promotion**: Promoted to architectural constraint in [`CONSTRAINTS-001`](../../../../knowledge/project/CONSTRAINTS-001-system-constraints.md).
