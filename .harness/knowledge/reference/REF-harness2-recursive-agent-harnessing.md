---
docid: REF-HARNESS2
title: "Reference: Google Research Harness² Architecture & Recursive Agent Harnessing"
collection: reference-knowledge
domain: harness2
status: active
repo: google-research/harness2
git_revision: main
created_at: "2026-11-07T02:56:00Z"
tags: [harness2, propose-probe-compose, library, recursive-harnessing, reference]
---

# Reference: Google Research Harness² (`google-research/harness2`)

## 1. Core Paradigm: Recursive Agent Harnessing
Instead of updating model weights via fine-tuning or RL, **Harness²** (*Recursive Agent Harnessing for an Open World*, arXiv:2610.14224) optimizes the **execution harness**—the 8 modular scaffolding components surrounding a fixed foundation model:
1. **System Prompts** (`system_prompts`)
2. **Guardrails & Rules** (`rules`)
3. **Memory & Retrieval** (`memory`)
4. **Tool Guidance & Definitions** (`tools`)
5. **Helper Scripts** (`scripts`)
6. **Subagents** (`subagents`)
7. **Skills** (`skills`)
8. **Middleware Plugins** (`plugins`)

## 2. Two-Level Recursion

### A. Task-Level Recursion: `Propose -> Probe -> Compose`
When executing a task without ground-truth answer keys:
1. **Baseline Rollout**: Run the current base harness to observe an initial execution trajectory.
2. **Propose**: Analyze failure points, bottlenecks, or verification gaps in the trace and propose $K$ candidate harness modifications.
3. **Probe**: Execute the $K$ candidate harnesses under matched environment and knowledge settings (`--k K --mode parallel` or `--mode sequential`).
4. **Compose**: Contrast the resulting trajectories empirically (e.g., test pass rate, verification completeness, tool error reduction, step efficiency) and compose the supported refinements into an adopted task harness.

### B. Harnessing-Level Recursion: The Per-Domain Library (`harness2/core/library.py`)
Rather than accumulating every task-specific tweak into a bloated global prompt, Harness² maintains an isolated per-domain **Experience Library**:
- `<root>/<domain>/INDEX.md`: Browsable catalog of concise conditional cues (e.g., *"When debugging asynchronous subagent race conditions, inspect transcript step ordering and enforce snapshot locks..."*).
- `<root>/<domain>/harnesses/<task_id>/EXPERIENCE.md`: Detailed empirical record containing the problem context, behavioral contrast observed during probing, and supporting execution evidence.
- `<root>/<domain>/harnesses/<task_id>/harness/`: The complete adopted harness files that produced the verified improvement.
