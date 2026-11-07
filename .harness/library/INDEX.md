---
docid: LIB-INDEX-ROOT
title: "Harness² Master Experience Library Index"
collection: experiment-knowledge
domain: all
status: active
repo: Harness2-RAG-antigravity
git_revision: HEAD
created_at: "2026-11-07T02:56:30Z"
tags: [index, harness2, experience-library, cues]
---

# Harness² Experience Library — Master Index (`INDEX.md`)

> **Usage for Agent**: Before proposing a harness refinement or planning a complex task, scan the conditional cues below. When a cue matches your current task context, call `harness_get` on the linked `EXPERIENCE.md` to inspect the full empirical evidence and adopted harness configuration before acting.

## Domain Catalogs
- [`software-engineering`](./software-engineering/INDEX.md) — Agent harness refinements, subagent swarm isolation, retrieval lifecycle, and verification guardrails.

---

## Active Experience Cues Across Domains

| ID / Task | Domain | Conditional Cue (*When...*) | Adopted Strategy Summary | Status | Evidence Link |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `task-001-snapshot-isolation` | `software-engineering` | **When** running $K$ parallel or sequential candidate harness probes (`Propose -> Probe -> Compose`) over a shared local RAG knowledge base | Lock a frozen `snapshot_id` (`cutoff_timestamp` + `git_revision`) before spawning `harness-prober` subagents in `Workspace: "branch"`, and exclude `status: candidate` notes until `Compose` finishes. | `active` | [`software-engineering/harnesses/task-001-snapshot-isolation/EXPERIENCE.md`](./software-engineering/harnesses/task-001-snapshot-isolation/EXPERIENCE.md) |
| `task-002-gravity-well-swarm-hierarchy-context-dna` | `software-engineering` | When visualizing multi-tier subagent swarms, context window token DNA, or switching workspaces in Antigravity Auxiliary Pane sidecars, combine GetAllCascadeTrajectories + resolveActiveWorkspace with active-workspace.json state sync and tiered SVG Bezier DAG rendering. | EXPERIENCE: Multi-Tier Subagent Swarm Hierarchy, Context DNA Analytics & Smooth Workspace Switching | `active` | [`software-engineering/harnesses/task-002-gravity-well-swarm-hierarchy-context-dna/EXPERIENCE.md`](./software-engineering/harnesses/task-002-gravity-well-swarm-hierarchy-context-dna/EXPERIENCE.md) |
