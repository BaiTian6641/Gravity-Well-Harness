# Stage 1: Repository Initialization, Research Synthesis & Master Architecture Plan

**Timestamp**: 2026-11-07
**Stage Status**: Completed

---

## 1. Objectives of Stage 1
1. Synthesize the architectural requirements for integrating **Google Research's Harness²**, **QMD (`tobi/qmd`)**, **Context7**, and **Antigravity UI Extensions (`sidecar_sdk` / `antigravity-sidecar-kit`)**.
2. Initialize the Git repository in `c:\Users\weyst\Documents\Harness2-RAG-antigravity` with a clean `.gitignore` that separates versioned Markdown evidence from derived local RAG indices and ephemeral runtime logs.
3. Establish the master roadmap (`PLAN.md`) and architectural blueprint (`docs/ARCHITECTURE.md`).

---

## 2. Key Findings from Technical Discovery

1. **Google Research Harness² (`google-research/harness2`)**:
   - Optimizes the 8 editable components of an agent's execution harness (`system_prompts`, `guardrails/rules`, `memory`, `tools`, `scripts`, `subagents`, `skills`, `plugins`) via a **Propose $\rightarrow$ Probe $\rightarrow$ Compose** contrastive loop without modifying model weights.
   - Stores adopted refinements in a per-domain library (`<root>/<run-tag>/<mode>/<domain>/harnesses/<task>/`) containing `INDEX.md` (browsable cues), `EXPERIENCE.md` (situation, behavioral contrast, supporting evidence), and `harness/` (complete adopted configuration).
   - Requires **Snapshot Isolation** during candidate probing so parallel or sequential candidates cannot leak notes to one another before composition.

2. **QMD (`tobi/qmd`) & Zero-Dependency Local Fallback**:
   - `qmd` provides local BM25 + GGUF vector embeddings + local LLM reranking and exposes an MCP server (`qmd mcp`) with `query`, `get`, `multi_get`, `status`, and `metadata`.
   - Because `qmd` only handles search/retrieval and does not manage the Harness² lifecycle (when to search, when to lock a snapshot, when to record an `EXPERIENCE.md` lesson, or when to run `qmd update && qmd embed`), our plugin provides `harness_ide_rag_mcp` to wrap `qmd` AND includes a built-in zero-dependency local hybrid search engine (BM25 + TF-IDF cosine vector + Reciprocal Rank Fusion) so the plugin works out-of-the-box on any machine even before `qmd` is installed.

3. **Antigravity UI Modification via Auxiliary Pane Sidecars**:
   - Antigravity supports native **UI Extension Sidecars** (`has_web_ui: true`, `entrypoint: "SIDECAR_UI_ENTRYPOINT_AUX_PANE"` in `sidecar.json`) using `sidecar_sdk` and `antigravity-sidecar-kit`.
   - Through Language Server Connect RPCs (`GetAllCascadeTrajectories`, `GetCascadeTrajectorySteps`, `GetMcpServerStates`, `GetSidecars`) combined with our plugin's `PostToolUse` hook telemetry, the sidecar UI can monitor the Main Agent and its entire Subagent Swarm in real time.

---

## 3. Files Created in Stage 1
- `.gitignore`: Excludes derived SQLite/vector indices, runtime telemetry, and `node_modules` / `.venv` while tracking `.harness/knowledge/` and `.harness/library/`.
- `PLAN.md`: Master 5-stage implementation plan.
- `docs/ARCHITECTURE.md`: Full architecture guide covering knowledge collections, provenance schema, snapshot isolation, dual-level Harness² execution, and the UI sidecar.
- `docs/stages/STAGE_1_ARCHITECTURE_AND_PLAN.md`: Stage 1 documentation log.
