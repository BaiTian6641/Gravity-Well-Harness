# Master Implementation Plan: Harness² + Local RAG Antigravity IDE (`harness-ide`)

> **Goal**: Turn Google Antigravity into an effective **Recursive Agent Harnessing IDE** by combining **Google Research’s Harness²** (`Propose -> Probe -> Compose` + per-domain Experience Library), **QMD Local Hybrid RAG** (with zero-dependency built-in fallback), **Context7** external documentation, **Subagent Swarm Orchestration**, and a native **Antigravity Auxiliary Pane UI Sidecar** (`harness-ide-monitor`) with an intuitive Settings Manager and one-prompt reproducibility.

---

## 1. Division of Responsibilities

| Component | Responsibility in `harness-ide` |
| :--- | :--- |
| **Antigravity Agent & Swarm** | Implement changes, investigate problems, consult local project/experiment knowledge, spawn isolated `prober` subagent swarms (`Workspace: "branch"`), and manage the retrieval lifecycle. |
| **Google Research Harness²** | Propose and probe candidate harness edits across the 8 modular harness dimensions (`system_prompts`, `rules`, `skills`, `subagents`, `hooks`, `tools`, `scripts`, `plugins`), compose winning refinements, and retain execution evidence (`INDEX.md`, `EXPERIENCE.md`, and `harness/`). |
| **Local RAG (`QMD` + Built-in Hybrid Engine)** | Index local Markdown files across the 3 knowledge collections (`project`, `experiment`, `reference`), provide BM25 lexical + dense vector + RRF reranked retrieval, and enforce **Snapshot Isolation** during candidate probes. |
| **Context7 & Google Dev Knowledge** | Retrieve up-to-date, version-specific external library documentation and official Android/Cloud/Firebase API references via MCP. |
| **Auxiliary Pane UI Sidecar (`harness-ide-monitor`)** | Render an interactive side-panel inside Antigravity IDE / Antigravity 2.0 for real-time Main Agent + Subagent Swarm monitoring, Harness² Probe Studio, Local RAG search/inspection, and easy-to-understand visual settings. |
| **Versioned Project Markdown (`.harness/`)** | Authoritative record of architecture decisions (ADRs), requirements, experiment summaries, and adopted Harness² experience libraries. |

---

## 2. Staged Execution Roadmap

### Stage 1: Repository Initialization, Research Synthesis & Master Architecture Plan
- Initialize Git repository (`git init`) and configure `.gitignore` to keep derived indices (`.harness/index/`, `.harness/runtime/`) out of version control while preserving authoritative Markdown evidence (`.harness/knowledge/`, `.harness/library/`).
- Document system architecture (`docs/ARCHITECTURE.md`) and Stage 1 milestone (`docs/stages/STAGE_1_ARCHITECTURE_AND_PLAN.md`).

### Stage 2: Local RAG & Harness² Knowledge Engine (`harness-rag-mcp` + QMD Integration)
- Create the three structured local knowledge collections under `.harness/`:
  1. `project-knowledge/`: Requirements, Architecture Decision Records (ADRs), setup instructions, frontend/backend constraints.
  2. `experiment-knowledge/` & `library/`: Harness² `INDEX.md`, per-task `EXPERIENCE.md` lessons, and complete adopted `harness/` snapshots.
  3. `reference-knowledge/`: Curated paper summaries, hardware/API notes, external technical references.
- Build the MCP Server (`mcp/harness-rag-server.mjs`) exposing:
  - `harness_query`: Hybrid search (`lex` BM25 + `vec` semantic + RRF reranking) with collection, domain, status, and `snapshot_id` filtering. Automatically bridges to `qmd` CLI when installed and provides a built-in zero-dependency local engine out-of-the-box.
  - `harness_get` / `harness_multi_get`: Fetch full source documents with provenance metadata and fuzzy path/ID matching.
  - `harness_status` / `harness_metadata`: Inspect index health, collection statistics, QMD status, and active snapshot locks.
  - `harness_snapshot_lock`: Create, inspect, or release a **Snapshot Isolation Lock** (`snapshot_id` + cutoff timestamp/commit) so all $K$ candidate probes in a Harness² comparison see identical historical knowledge.
  - `harness_record_experience`: Record a new Harness² `EXPERIENCE.md` entry with required provenance (Task, Repo/Revision, Observation, Supporting Evidence, Status), archive the adopted harness tree, update `INDEX.md` cues, and refresh the index.
  - `harness_promote_knowledge`: Promote a broadly useful `EXPERIENCE.md` lesson into curated `project-knowledge/` with bidirectional provenance links.
  - `harness_index_refresh`: Trigger `qmd update` + `qmd embed` and update the local index.

### Stage 3: Harness² Execution Adapter, Subagent Swarm & Antigravity Plugin Bundle
- Package the complete Antigravity plugin under `plugin/harness-ide/`:
  - `plugin.json`: Plugin manifest (`name: "harness-ide"`).
  - `mcp_config.json`: Wires `harness_ide_rag_mcp` and external doc helpers.
  - `hooks.json` + `scripts/hooks/`:
    - `SessionStart`: Injects active project constraints, top `INDEX.md` cues, active snapshot lock state, and the `sidecar://harness-ide-monitor/` pill link.
    - `PreInvocation`: Enforces snapshot isolation during active Harness² probes and reminds the agent of retrieval-before-planning rules.
    - `PostToolUse`: Streams real-time tool/subagent telemetry to `.harness/runtime/telemetry.json` and auto-refreshes the local RAG index when `.harness/` or `docs/` Markdown files are modified.
  - `rules/AGENTS.md`: Always-on retrieval lifecycle and Harness² provenance rules.
  - `agents/`: Custom subagent configurations (`harness-proposer.md`, `harness-prober.md`, `harness-composer.md`).
  - `skills/`:
    - `harness2-loop/SKILL.md`: Propose–Probe–Compose workflow using either Antigravity's native branched subagent swarm (`Workspace: "branch"`) or `google-research/harness2` CLI.
    - `qmd-knowledge-lifecycle/SKILL.md`: Local RAG & QMD collection management, provenance schema, and Context7 integration.
    - `harness-swarm-monitor/SKILL.md`: Operating and surfacing the Auxiliary Pane UI Monitor.
- Implement `adapters/harness2_antigravity_executor.py`: A Python executor adapter compatible with `google-research/harness2` that executes candidate harnesses through the Google Antigravity Python SDK (`google-antigravity`) or `agy` CLI alongside OpenCode and Codex.

### Stage 4: Antigravity UI Extension Sidecar (`harness-ide-monitor`)
- Build an Auxiliary Pane UI Sidecar (`sidecars/harness-ide-monitor/`) using `antigravity-sidecar-kit` and `sidecar_sdk` (with standalone loopback HTTP preview support):
  - **Swarm & Main Agent Monitor**: Live tree of the Main Agent and spawned Subagents (`Role`, `Workspace: inherit|branch|share`, `Status`, `Step Count`, `Active Tool`, `Token & Thinking Metrics`), reading live from Language Server Connect RPCs (`GetAllCascadeTrajectories`, `GetCascadeTrajectorySteps`) and `.harness/runtime/telemetry.json`.
  - **Harness² Propose–Probe–Compose Studio**: Visualizes candidate probes ($K$), behavioral contrast diffs, Snapshot Isolation lock control, and an interactive `INDEX.md` / `EXPERIENCE.md` browser.
  - **Local RAG & Knowledge Explorer**: Live search bar across `project`, `experiment`, and `reference` collections, document reader, quick-note creator, and one-click index refresh.
  - **Easy-to-Understand Settings UI**: Friendly visual switches and inputs for RAG backend selection (`QMD`, `Built-in Local Hybrid`, `Basic Memory`, `RAGFlow`), Context7 & Google Developer Knowledge toggles, Harness² $K$ & recursion mode, Snapshot Isolation strictness, and lifecycle hooks.

### Stage 5: One-Prompt Reproducible Installer, Automated Tests & Live Activation
- Create `setup.mjs` (plus `install.ps1` and `install.sh`) and `.agents/skills/turn-into-harness-ide/SKILL.md` + root `AGENTS.md` so any user can drop this repository into Antigravity and say:
  > *"Hey, turn my Antigravity IDE into an effective harness IDE"*
- Write and run end-to-end automated tests (`test/harness-ide.test.mjs`).
- Run `node setup.mjs` to install and activate both the plugin and UI sidecar in the local Antigravity environment.
