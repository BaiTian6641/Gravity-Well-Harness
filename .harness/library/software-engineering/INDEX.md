---
docid: LIB-INDEX-SWE
title: "Harness² Experience Library Index — software-engineering"
collection: experiment-knowledge
domain: software-engineering
status: active
repo: Harness2-RAG-antigravity
git_revision: HEAD
created_at: "2026-11-07T02:56:40Z"
tags: [index, software-engineering, harness2, experience-library]
---

# Domain Index: `software-engineering` (`INDEX.md`)

Tasks within `software-engineering` execute in order and may read only earlier `active` entries when running under a Harness² snapshot lock.

## Entries

1. **[`task-001-snapshot-isolation`](./harnesses/task-001-snapshot-isolation/EXPERIENCE.md)** (`2026-11-07T02:56:45Z`, `status: active`)
   - **Cue**: *When comparing $K$ candidate harnesses in a Propose–Probe–Compose loop while local RAG indexing is active...*
   - **Lesson**: Freeze the eligible knowledge snapshot (`harness_snapshot_lock`) prior to candidate probing and run each `harness-prober` in `Workspace: "branch"` so later candidates cannot read notes produced during earlier candidates' probes.
   - **Adopted Harness**: [`./harnesses/task-001-snapshot-isolation/harness/manifest.json`](./harnesses/task-001-snapshot-isolation/harness/manifest.json)

- **[task-002-gravity-well-swarm-hierarchy-context-dna](./harnesses/task-002-gravity-well-swarm-hierarchy-context-dna/EXPERIENCE.md)** (`2026-11-07T01:05:20.347Z`, `status: active`)
  - **Cue**: *When visualizing multi-tier subagent swarms, context window token DNA, or switching workspaces in Antigravity Auxiliary Pane sidecars, combine GetAllCascadeTrajectories + resolveActiveWorkspace with active-workspace.json state sync and tiered SVG Bezier DAG rendering.*
  - **Adopted Harness**: [`./harnesses/task-002-gravity-well-swarm-hierarchy-context-dna/harness/manifest.json`](./harnesses/task-002-gravity-well-swarm-hierarchy-context-dna/harness/manifest.json)

- **[task-003-interactive-hierarchy-live-pulse](./harnesses/task-003-interactive-hierarchy-live-pulse/EXPERIENCE.md)** (`2026-11-07T02:31:29.710Z`, `status: active`)
  - **Cue**: *When implementing interactive agent hierarchy DAG maps with real-time live telemetry in an Antigravity UI sidecar, combine transform3d(panX, panY) scale(zoomScale) with individual node offsets, a floating hover inspector card, 1s /api/live-pulse delta checks, and non-destructive in-place DOM patching so live updates never reset pan/zoom/drag state.*
  - **Adopted Harness**: [`./harnesses/task-003-interactive-hierarchy-live-pulse/harness/manifest.json`](./harnesses/task-003-interactive-hierarchy-live-pulse/harness/manifest.json)

- **[task-004-realtime-telemetry-and-hot-reload](./harnesses/task-004-realtime-telemetry-and-hot-reload/EXPERIENCE.md)** (`2026-11-07T03:03:31.034Z`, `status: active`)
  - **Cue**: *When Auxiliary Pane sidecar statistics appear frozen or fail to update after setup.mjs, ensure apiFetch injects X-Sidecar-Token from script src token fallback, format compact tokens with 3 decimals (>=5M) and seconds on multi-hour durations, advance all RUNNING nodes and context analytics via a 1s wall-clock ticker, and use a zero-downtime /api/reload + launcher retry loop.*
  - **Adopted Harness**: [`./harnesses/task-004-realtime-telemetry-and-hot-reload/harness/manifest.json`](./harnesses/task-004-realtime-telemetry-and-hot-reload/harness/manifest.json)
