# `harness-ide` — Harness² & Local RAG Plugin for Google Antigravity

`harness-ide` bundles **Google Research's Harness²** (`Propose -> Probe -> Compose` recursive agent harnessing + per-domain Experience Library), **QMD Local Hybrid RAG** (`tobi/qmd` + built-in zero-dependency BM25/Vector/RRF engine), **Context7** external library documentation, and the **Harness² Swarm & RAG Monitor** UI sidecar into a single Antigravity plugin.

## Bundled Components
- **MCP Servers (`mcp_config.json`)**:
  - `harness_ide_rag_mcp`: Local hybrid search (`harness_query`, `harness_get`, `harness_multi_get`, `harness_status`, `harness_metadata`), Snapshot Isolation (`harness_snapshot_lock`), Experience Library recording (`harness_record_experience`, `harness_promote_lesson`), and index maintenance (`harness_index_refresh`).
  - `harness_ide_context7`: Up-to-date external library documentation via `https://mcp.context7.com/mcp`.
- **Lifecycle Hooks (`hooks.json`)**:
  - `SessionStart`: Injects active local RAG summary and Snapshot Isolation lock status.
  - `PreInvocation`: Guards candidate probes against cross-candidate knowledge leakage when a Snapshot Lock is active.
  - `PostToolUse`: Streams real-time Main Agent & Subagent Swarm telemetry to the UI monitor and auto-refreshes the local RAG index when `.harness/` Markdown files are modified.
- **Rules (`rules/AGENTS.md`)**: Enforces the 4-step retrieval lifecycle and 5-part provenance schema.
- **Subagents (`agents/`)**: `harness-proposer`, `harness-prober` (`Workspace: "branch"`), and `harness-composer`.
- **Skills (`skills/`)**: `harness2-loop`, `qmd-knowledge-lifecycle`, and `harness-swarm-monitor`.
