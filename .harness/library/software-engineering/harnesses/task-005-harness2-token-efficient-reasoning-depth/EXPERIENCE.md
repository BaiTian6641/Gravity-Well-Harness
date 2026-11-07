---
docid: EXP-SOFT-TASK-005-HARNESS
title: "EXPERIENCE: task-005-harness2-token-efficient-reasoning-depth (Harness² BALANCED · 78.2% Tokens Saved)"
collection: experiment-knowledge
domain: software-engineering
task_id: task-005-harness2-token-efficient-reasoning-depth
status: active
repo: Harness2-RAG-antigravity
git_revision: f594372
created_at: "2026-11-07T03:24:00.721Z"
cue: "When tackling 'Validate Google Research Harness2 Propose-Probe-Compose loop with Adaptive Reasoning Depth' in 'software-engineering', use candidate-2-domain-rag-branched with balanced reasoning depth (thinkingCap=2048, model=flash, Workspace=branch) to achieve score=0.95 while saving 78.2% tokens."
tags: [harness2, propose-probe-compose, depth-balanced, token-efficient, software-engineering]
evidence_links:
  - ".harness/library/software-engineering/harnesses/task-005-harness2-token-efficient-reasoning-depth/harness/manifest.json"
  - ".harness/library/INDEX.md"
  - ".harness/library/software-engineering/harnesses/task-001-snapshot-isolation/EXPERIENCE.md"
  - ".harness/knowledge/project/ADR-001-memory-and-rag-architecture.md"
  - "adapters/harness2_antigravity_executor.py"
---

# EXPERIENCE: task-005-harness2-token-efficient-reasoning-depth (Harness² BALANCED · 78.2% Tokens Saved)

## 1. What Task or Problem Produced This Lesson?
- **Task ID**: `task-005-harness2-token-efficient-reasoning-depth`
- **Problem**: Validate Google Research Harness2 Propose-Probe-Compose loop with Adaptive Reasoning Depth (eco/balanced/deep), Cue-First RAG snippet pruning, and Early-Stop token efficiency guardrails

## 2. Which Repository and Revision Did It Apply To?
- **Repository**: `Harness2-RAG-antigravity`
- **Git Revision**: `f594372`
- **Domain**: `software-engineering`

## 3. What Was Actually Observed?
Contrastive evaluation across K=3 candidates (sequential mode) under frozen snapshot 'SNAP-20261107032400-09B4': candidate-2-domain-rag-branched (Domain-Specific Front (Cue-First RAG + Branched Subagent)) beat the unbounded baseline (score 0.95 vs 0.62, 0 tool errors vs 1) while consuming only 10,940 total probe tokens vs 50,100 unbounded tokens (39,160 tokens saved, -78.2%).

## 4. Which Evidence Supports the Conclusion?
- `.harness/library/software-engineering/harnesses/task-005-harness2-token-efficient-reasoning-depth/harness/manifest.json`
- `.harness/library/INDEX.md`
- `.harness/library/software-engineering/harnesses/task-001-snapshot-isolation/EXPERIENCE.md`
- `.harness/knowledge/project/ADR-001-memory-and-rag-architecture.md`
- `adapters/harness2_antigravity_executor.py`

## 5. Is the Conclusion Still Current?
- **Status**: `active`
- **Recorded At**: `2026-11-07T03:24:00.721Z`
