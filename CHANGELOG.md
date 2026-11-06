# Changelog (`Harness2-RAG-antigravity`)

All architectural stages, implementation milestones, and verification results are documented chronologically by stage.

## [1.0.0] — 2026-11-07

### Stage 1 — Repository Initialization, Research Synthesis & Master Architecture Plan (`74bf28e`)
- Initialized Git repository and configured `.gitignore` to keep derived indices (`.harness/index/`) and runtime telemetry (`.harness/runtime/`) out of version control while preserving authoritative Markdown evidence (`.harness/knowledge/` and `.harness/library/`).
- Authored [`PLAN.md`](./PLAN.md), [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md), and [`docs/stages/STAGE_1_ARCHITECTURE_AND_PLAN.md`](./docs/stages/STAGE_1_ARCHITECTURE_AND_PLAN.md).

### Stage 2 — Local RAG & Harness² Knowledge Engine (`81ce601`)
- Created the 3 local knowledge collections under `.harness/`: `project-knowledge`, `experiment-knowledge` (`.harness/library/INDEX.md` & `EXPERIENCE.md`), and `reference-knowledge`.
- Implemented [`src/rag-engine.mjs`](./src/rag-engine.mjs) featuring BM25 lexical scoring, 256-dim dense semantic vectors with concept-cluster expansion, Reciprocal Rank Fusion (RRF), **Snapshot Isolation** (`createSnapshotLock` / `releaseSnapshotLock`), and `tobi/qmd` CLI synchronization.
- Implemented the Model Context Protocol server [`mcp/harness-rag-server.mjs`](./mcp/harness-rag-server.mjs) exposing 9 tools (`harness_query`, `harness_get`, `harness_multi_get`, `harness_status`, `harness_metadata`, `harness_snapshot_lock`, `harness_record_experience`, `harness_promote_lesson`, `harness_index_refresh`).

### Stage 3 — Harness² Execution Adapter, Subagent Swarm & Antigravity Plugin Bundle (`f8ec530`)
- Authored the [`plugin/harness-ide/`](./plugin/harness-ide) bundle including `plugin.json`, `mcp_config.json` (wiring `harness_ide_rag_mcp` and `harness_ide_context7`), `hooks.json` (`SessionStart`, `PreInvocation`, `PostToolUse`), `rules/AGENTS.md`, custom subagents (`harness-proposer`, `harness-prober`, `harness-composer`), and skills (`harness2-loop`, `qmd-knowledge-lifecycle`, `harness-swarm-monitor`).
- Implemented the Python [`AntigravityExecutor`](./adapters/harness2_antigravity_executor.py) adapter for `google-research/harness2`.

### Stage 4 — Antigravity Auxiliary Pane UI Extension Sidecar (`2801f17`)
- Built [`sidecars/harness-ide-monitor/`](./sidecars/harness-ide-monitor) using `antigravity-sidecar-kit` and `sidecar_sdk` (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`) with a 4-tab interface:
  1. **Swarm Monitor** (Main Agent + Subagent Swarm topology, live transcript & hook telemetry, active MCP servers).
  2. **Harness² Studio** (Snapshot Isolation lock controls, `INDEX.md` & `EXPERIENCE.md` browser, experience recorder, ADR promoter).
  3. **Local RAG Explorer** (Hybrid BM25 + Vector search, benchmark query presets, full document reader, quick Markdown note creator).
  4. **Visual Settings Manager** (Local RAG backend selector for QMD / Built-in / Basic Memory / RAGFlow, Context7 & Google Developer Knowledge toggles, Harness² $K$ & recursion mode, hook toggles).

### Stage 5 — One-Prompt Reproducible Installer, Automated Test Suite & Live Activation
- Built [`setup.mjs`](./setup.mjs), [`install.ps1`](./install.ps1), [`install.sh`](./install.sh), [`AGENTS.md`](./AGENTS.md), [`.agents/plugins.json`](./.agents/plugins.json), and [`.agents/skills/turn-into-harness-ide/SKILL.md`](./.agents/skills/turn-into-harness-ide/SKILL.md) for one-prompt reproducibility.
- Authored and verified the end-to-end test suite [`test/harness-ide.test.mjs`](./test/harness-ide.test.mjs) (`6/6` tests passing).
- Installed and activated `harness-ide` plugin and `harness-ide-monitor` sidecar (`SIDECAR_STATUS_RUNNING`) in the local Antigravity environment.
