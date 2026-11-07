# Changelog (`Gravity Well Harness`)

All architectural stages, implementation milestones, and verification results are documented chronologically by stage.

## [1.1.0] — 2026-11-07

### Stage 6 — Gravity Well Harness Formal Branding, Dynamic Multi-Tier Swarm Hierarchy, Context DNA Analytics & Smooth Workspace Switching
- **Formal Rebranding & Remote Git Integration**:
  - Formally named the project **Gravity Well Harness** (`gravity-well-harness`, combining Antigravity + Harness²) and connected the local repository to `git@github.com:BaiTian6641/Gravity-Well-Harness.git`.
  - Preserved internal plugin/sidecar IDs (`harness-ide` and `harness-ide-monitor`) so existing `sidecar://harness-ide-monitor/` and `customization://harness-ide` links remain 100% compatible.
- **Smooth Workspace Auto-Follow & Switching (`server.mjs`, `ui/app.js`, `mcp-entry.mjs`, hooks)**:
  - Integrated `resolveActiveWorkspace` and `extractTrajectoryWorkspace` from `antigravity-sidecar-kit/workspace` alongside `window.sidecar.onWorkspaceChange`, URL query parameters, and hook-synced `active-workspace.json`.
  - Added header **Workspace Switcher** with **`⚡ Auto-Follow IDE`** mode, smooth visual page transitions on workspace change, and a 1-click **`.harness/` Initializer** (`/api/workspace/init`) for newly opened workspaces.
  - Upgraded `mcp/harness-rag-server.mjs` and `plugin/harness-ide/scripts/mcp-entry.mjs` so MCP calls without an explicit `workspace_root` automatically target the currently active workspace.
- **Dynamic Multi-Tier Subagent Swarm Hierarchy & Team Formation Map (`Tab 1: Swarm Formation / 编队`)**:
  - Built an interactive zoomable/pannable hierarchical DAG canvas rendering **Tier 0 (Root Main Orchestrator)** $\rightarrow$ **Tier 1 (Proposer / Stage Leads)** $\rightarrow$ **Tier 2 (Branched Prober Workers)** $\rightarrow$ **Tier 3 (Contrastive Composer & Verifiers)** with animated cubic Bezier SVG flow paths, per-node token/cost/step/duration metrics, and embedded 8-segment Context DNA bars.
  - Added 3 switchable Swarm Formations (`Gravity Well Harness² Swarm`, `4-Agent Verification Diamond`, `13-Agent Multi-Stage Pipeline Swarm`), grouped **Swarm Teams & Members (`编队成员`)**, **Delegated Tasks (`任务`)**, and **Inter-Agent Communication Bus (`通讯记录`)**.
- **Context Window & Token DNA Analytics (`Tab 2: Context & Token DNA / 上下文`)**:
  - Built the **Context Flow Overview** (`I/O Operations` + `Context Events` $\rightarrow$ `Current Session Hub` $\rightarrow$ `Tool Calls` + `Agent Network Token Split`), **8-Category Token DNA Donut Chart**, **6-Category Latency Donut & Timeline Bar**, **Current Context Window Meter**, **20-Step Stacked Context DNA Trend Chart**, and expandable **Context DNA Browser Accordion**.

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
- Built [`sidecars/harness-ide-monitor/`](./sidecars/harness-ide-monitor) using `antigravity-sidecar-kit` and `sidecar_sdk` (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`).

### Stage 5 — One-Prompt Reproducible Installer, Automated Test Suite & Live Activation (`69ddb77`)
- Built [`setup.mjs`](./setup.mjs), [`install.ps1`](./install.ps1), [`install.sh`](./install.sh), [`AGENTS.md`](./AGENTS.md), [`.agents/plugins.json`](./.agents/plugins.json), and [`.agents/skills/turn-into-harness-ide/SKILL.md`](./.agents/skills/turn-into-harness-ide/SKILL.md) for one-prompt reproducibility.
- Authored and verified the end-to-end test suite [`test/harness-ide.test.mjs`](./test/harness-ide.test.mjs).
