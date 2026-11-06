---
docid: EXP-LOG-001
title: "Experiment Log: Failed vs. Adopted Approaches in Agent Harness & Memory Trials"
collection: experiment-knowledge
domain: software-engineering
task_id: exp-log-001-memory-trials
status: active
repo: Harness2-RAG-antigravity
git_revision: 74bf28e
created_at: "2026-11-07T02:56:50Z"
tags: [experiments, failure-analysis, training, memory, rag, harness2]
evidence_links:
  - ".harness/library/software-engineering/harnesses/task-001-snapshot-isolation/EXPERIENCE.md"
  - ".harness/knowledge/project/ADR-001-memory-and-rag-architecture.md"
---

# Experiment Log: Failed vs. Adopted Approaches in Agent Harness & Memory Trials

## 1. Summary of Evaluated Approaches

| Approach | Conditions Tested | Observed Outcome | Status |
| :--- | :--- | :--- | :--- |
| **Full-History Prompt Stuffing** | Multi-stage coding & research sessions (>15 turns, >50k tokens of prior logs) | Context window saturation, higher latency, and instruction drift where old speculative notes overrode current repository tests. | **Failed / Rejected** |
| **Unisolated Shared RAG Index During Parallel Probes** | $K=2$ parallel candidate probes writing intermediate scratch notes to a live index | Candidate #2 retrieved Candidate #1's intermediate failure note mid-probe, contaminating the contrastive evaluation. | **Failed / Rejected** |
| **Accumulating All Past Task Tweaks into Global System Prompt** | Sequential tasks across heterogeneous domains | Bloated system instructions caused contradictory constraints across domains. | **Failed / Rejected** |
| **QMD + Local Hybrid RAG over Per-Domain Harness² Library with Snapshot Locks** | 3 separated collections (`project`, `experiment`, `reference`) + frozen `snapshot_id` during probing | High precision retrieval of prior decisions (`ADR-*`) and conditional cues (`INDEX.md`) with zero cross-candidate leakage. | **Adopted (`active`)** |

## 2. Detailed Failure Conditions & Lessons

### Failure Case A: Unfiltered Speculative Notes vs. Empirical Evidence
- **Condition**: When early brainstorming notes ("we proposed trying X next") were stored in the same unweighted bucket as verified experiment conclusions ("experiment showed Y under settings Z").
- **Failure Mode**: Subsequent agents treated unverified proposals as established architectural facts.
- **Adopted Fix**: Every `EXPERIENCE.md` and experiment note now requires explicit `status: active | candidate | superseded` frontmatter and 5-part provenance (Task, Repo/Revision, Observed Behavior, Supporting Evidence, Currency). By default, planning queries prioritize `status: active`.
