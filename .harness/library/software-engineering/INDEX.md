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
