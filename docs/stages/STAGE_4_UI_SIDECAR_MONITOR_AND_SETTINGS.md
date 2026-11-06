# Stage 4: Antigravity Auxiliary Pane UI Extension Sidecar (`harness-ide-monitor`)

**Timestamp**: 2026-11-07
**Stage Status**: Completed

---

## 1. Objectives of Stage 4
1. Build an interactive **Antigravity Auxiliary Pane UI Extension Sidecar** (`sidecars/harness-ide-monitor/`) using `antigravity-sidecar-kit` and `sidecar_sdk` (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`) with a standalone loopback HTTP server fallback.
2. Provide four integrated tabs inside the Antigravity side pane:
   - **Tab 1 — Swarm & Main Agent Monitor**: Visualizes the Main Agent (`Gemini 4 Argon`), live trajectory steps, spawned subagents from both Language Server Connect RPCs (`GetAllCascadeTrajectories`) and local `.system_generated/logs/transcript.jsonl` / `PostToolUse` hook telemetry, the 4 Harness² Swarm roles (`harness-proposer`, `harness-prober #1..2 [Workspace: branch]`, `harness-composer`), active MCP servers, and recent tool execution events.
   - **Tab 2 — Harness² Propose–Probe–Compose Studio**: Provides one-click **Snapshot Isolation Lock** creation/release (`SNAP-*`), browses the per-domain Experience Library (`INDEX.md` conditional cues and `EXPERIENCE.md` entries), promotes lessons to Project ADRs (`ADR-*.md`), and records new `EXPERIENCE.md` lessons with 5-part provenance.
   - **Tab 3 — Local RAG & Knowledge Explorer**: Displays collection health across `project-knowledge`, `experiment-knowledge`, and `reference-knowledge`, runs live Hybrid (`BM25 + Vector RRF`), Lexical (`BM25`), or Semantic (`Vector`) queries, includes 1-click benchmark query chips, renders full Markdown source & YAML provenance, and allows creating new Markdown notes directly in the UI.
   - **Tab 4 — Easy-to-Understand Visual Settings Manager**: Lets users configure their primary local RAG backend (`QMD + Built-in Hybrid`, `Built-in Local Hybrid`, `Basic Memory`, `RAGFlow`), toggle **Context7** and **Google Developer Knowledge** MCPs, configure Harness² recursion mode (`parallel` vs `sequential`, $K$ candidates, strict Snapshot Isolation), and toggle lifecycle hooks.

---

## 2. Verification of Stage 4
- Tested `createHarnessMonitorApp()` over loopback HTTP (`127.0.0.1`):
  - `GET /` $\rightarrow$ `200 OK` (serves theme-adaptive UI shell).
  - `POST /api/dashboard` $\rightarrow$ `200 OK` (`ok: true`, `docs: 9`, `roles: 4`, live transcript & hook telemetry).

---

## 3. Files Created in Stage 4
- `package.json`
- `sidecars/harness-ide-monitor/package.json`
- `sidecars/harness-ide-monitor/sidecar.json`
- `sidecars/harness-ide-monitor/hub-manifest.json`
- `sidecars/harness-ide-monitor/launch.mjs`
- `sidecars/harness-ide-monitor/server.mjs`
- `sidecars/harness-ide-monitor/rag-engine.mjs`
- `sidecars/harness-ide-monitor/ui/index.html`
- `sidecars/harness-ide-monitor/ui/styles.css`
- `sidecars/harness-ide-monitor/ui/app.js`
- `docs/stages/STAGE_4_UI_SIDECAR_MONITOR_AND_SETTINGS.md`
