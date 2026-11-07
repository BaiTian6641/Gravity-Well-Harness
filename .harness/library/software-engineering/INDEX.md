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

- **[task-005-harness2-token-efficient-reasoning-depth](./harnesses/task-005-harness2-token-efficient-reasoning-depth/EXPERIENCE.md)** (`2026-11-07T03:24:00.721Z`, `status: active`)
  - **Cue**: *When tackling 'Validate Google Research Harness2 Propose-Probe-Compose loop with Adaptive Reasoning Depth' in 'software-engineering', use candidate-2-domain-rag-branched with balanced reasoning depth (thinkingCap=2048, model=flash, Workspace=branch) to achieve score=0.95 while saving 78.2% tokens.*
  - **Adopted Harness**: [`./harnesses/task-005-harness2-token-efficient-reasoning-depth/harness/manifest.json`](./harnesses/task-005-harness2-token-efficient-reasoning-depth/harness/manifest.json)

- **[task-007-multi-model-deepseek-opencode-go-search-and-rsi](./harnesses/task-007-multi-model-deepseek-opencode-go-search-and-rsi/EXPERIENCE.md)** (`2026-11-07T05:30:28.865Z`, `status: active`)
  - **Cue**: *When orchestrating multi-model swarms across DeepSeek Official (deepseek-v4-pro / deepseek-flash 1M), OpenCode Go Coding Plan (opencode-go/grok-4.7, gpt-6-luna, claude-haiku-5-5, gemini-4-argon, kimi-k3.1-pro, kimi-k2.7-code, glm-5.3, mimo-v2.6-pro, minimax-m3.1-flash, qwen3.7-max, longcat-2.0, step-5-preview), and Antigravity Native models, remove demo formations so only the Current Workspace Agent Swarm is active, surface an always-visible inline Model + Reasoning Depth + Context Usage bar in the Antigravity UI, fuse web searches across DeepSeek Search (/v1/tools/search) + Parallel AI + Tavily + Free engines via RRF, and convey cross-model peer critiques over the Swarm Message Bus.*
  - **Adopted Harness**: [`./harnesses/task-007-multi-model-deepseek-opencode-go-search-and-rsi/harness/manifest.json`](./harnesses/task-007-multi-model-deepseek-opencode-go-search-and-rsi/harness/manifest.json)

- **[task-008-ide-settings-and-aes256-secret-vault](./harnesses/task-008-ide-settings-and-aes256-secret-vault/EXPERIENCE.md)** (`2026-11-07T06:06:02.602Z`, `status: active`)
  - **Cue**: *When integrating model/harness configuration and API keys in Antigravity IDE, keep the Auxiliary Pane sidecar strictly as a 4-tab Monitor UI, place non-secret configuration in Antigravity IDE Settings (.vscode/settings.json + contributes.configuration), and encrypt API keys in ~/.gemini/config/.secrets.vault.enc (AES-256-GCM, mode 0600) or ~/.env so keys never leak to git, chat, or HTTP responses.*
  - **Adopted Harness**: [`./harnesses/task-008-ide-settings-and-aes256-secret-vault/harness/manifest.json`](./harnesses/task-008-ide-settings-and-aes256-secret-vault/harness/manifest.json)

- **[task-009-pure-monitor-and-chatbox-multi-model-subagents](./harnesses/task-009-pure-monitor-and-chatbox-multi-model-subagents/EXPERIENCE.md)** (`2026-11-07T06:45:46.795Z`, `status: active`)
  - **Cue**: *When integrating Gravity Well Harness into Antigravity IDE without reverse-engineering IDE internals, keep the Auxiliary Pane sidecar strictly as a read-only Debugging & Preview Monitor (Agent Swarm, Google Harness², Local RAG + Context DNA), sync the Main Agent model from official hook stdin (input.modelName + input.transcriptPath), and route spawned subagents to specialized assisting models (DeepSeek V4-Pro/Flash 1M, OpenCode Go opencode-go/*, or Antigravity tiers) via .vscode/settings.json.*
  - **Adopted Harness**: [`./harnesses/task-009-pure-monitor-and-chatbox-multi-model-subagents/harness/manifest.json`](./harnesses/task-009-pure-monitor-and-chatbox-multi-model-subagents/harness/manifest.json)

- **[task-stage14-grill-me-hardening](./harnesses/task-stage14-grill-me-hardening/EXPERIENCE.md)** (`2026-11-07T21:41:07.545Z`, `status: active`)
  - **Cue**: *When hardening an Antigravity IDE harness across multi-model swarms, RAG snapshots, and long-horizon Argon sessions, enforce content-addressed immutable snapshot blobs, CAS per-run locks, credential origin allowlists, recipient-isolated message bus locks, batched Subagents hook decoding, and durable task ledgers/checkpoints.*
  - **Adopted Harness**: [`./harnesses/task-stage14-grill-me-hardening/harness/manifest.json`](./harnesses/task-stage14-grill-me-hardening/harness/manifest.json)
