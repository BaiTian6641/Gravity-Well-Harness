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
| `task-003-interactive-hierarchy-live-pulse` | `software-engineering` | When implementing interactive agent hierarchy DAG maps with real-time live telemetry in an Antigravity UI sidecar, combine transform3d(panX, panY) scale(zoomScale) with individual node offsets, a floating hover inspector card, 1s /api/live-pulse delta checks, and non-destructive in-place DOM patching so live updates never reset pan/zoom/drag state. | Interactive Hierarchy Canvas Gestures (Pan/Zoom/Node-Drag), Rich Hover Preview & 1s Real-Time Live Pulse | `active` | [`software-engineering/harnesses/task-003-interactive-hierarchy-live-pulse/EXPERIENCE.md`](./software-engineering/harnesses/task-003-interactive-hierarchy-live-pulse/EXPERIENCE.md) |
| `task-004-realtime-telemetry-and-hot-reload` | `software-engineering` | When Auxiliary Pane sidecar statistics appear frozen or fail to update after setup.mjs, ensure apiFetch injects X-Sidecar-Token from script src token fallback, format compact tokens with 3 decimals (>=5M) and seconds on multi-hour durations, advance all RUNNING nodes and context analytics via a 1s wall-clock ticker, and use a zero-downtime /api/reload + launcher retry loop. | Real-Time 1s Telemetry Streaming, Token Auth Fallback & Zero-Downtime Sidecar Hot-Reload | `active` | [`software-engineering/harnesses/task-004-realtime-telemetry-and-hot-reload/EXPERIENCE.md`](./software-engineering/harnesses/task-004-realtime-telemetry-and-hot-reload/EXPERIENCE.md) |
| `task-005-harness2-token-efficient-reasoning-depth` | `software-engineering` | When tackling 'Validate Google Research Harness2 Propose-Probe-Compose loop with Adaptive Reasoning Depth' in 'software-engineering', use candidate-2-domain-rag-branched with balanced reasoning depth (thinkingCap=2048, model=flash, Workspace=branch) to achieve score=0.95 while saving 78.2% tokens. | EXPERIENCE: task-005-harness2-token-efficient-reasoning-depth (Harness² BALANCED · 78.2% Tokens Saved) | `active` | [`software-engineering/harnesses/task-005-harness2-token-efficient-reasoning-depth/EXPERIENCE.md`](./software-engineering/harnesses/task-005-harness2-token-efficient-reasoning-depth/EXPERIENCE.md) |
| `task-006-subagent-lifecycle-recall-and-2d-grid` | `software_engineering` | When encountering tasks matching 'task-006-subagent-lifecycle-recall-and-2d-grid' in domain 'software_engineering', apply the verified harness configuration. | Accurate Subagent Completion Status Check, Hide Inactive First + Recall to Rejoin Network Graph, and 2D Multi-Column Grid Layout | `active` | [`software_engineering/harnesses/task-006-subagent-lifecycle-recall-and-2d-grid/EXPERIENCE.md`](./software_engineering/harnesses/task-006-subagent-lifecycle-recall-and-2d-grid/EXPERIENCE.md) |
