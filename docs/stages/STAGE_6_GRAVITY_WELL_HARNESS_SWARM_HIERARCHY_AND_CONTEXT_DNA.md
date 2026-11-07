# Stage 6 — Gravity Well Harness Rebranding, Dynamic Multi-Tier Swarm Hierarchy, Context DNA & Smooth Workspace Switching

## 1. Stage Objectives
1. **Formal Branding & GitHub Remote**:
   - Establish **Gravity Well Harness** as the formal name across the project, plugin (`plugin/harness-ide/plugin.json`), UI sidecar (`sidecars/harness-ide-monitor/sidecar.json` & `hub-manifest.json`), and documentation while preserving technical IDs (`harness-ide` and `harness-ide-monitor`) for seamless compatibility.
   - Connect the repository to `git@github.com:BaiTian6641/Gravity-Well-Harness.git` and push all staged commits.
2. **Smooth Workspace Auto-Follow & Switching**:
   - Ensure both the UI Sidecar (`sidecars/harness-ide-monitor/server.mjs` + `ui/app.js`) and the Local RAG MCP Server (`mcp/harness-rag-server.mjs`) automatically detect and transition to the currently opened workspace in Antigravity IDE.
3. **Dynamic Multi-Tier Subagent Swarm Hierarchy & Team Formation Map (`Tab 1: Swarm Formation / 编队`)**:
   - Upgrade the subagent swarm view into an interactive hierarchical DAG/tree canvas with curved SVG directional flow edges, zoom/pan controls, per-node token/cost/duration/step telemetry, embedded 8-segment Context DNA bars, Team Member grids (`编队成员`), Delegated Task cards (`任务`), and an Inter-Agent Communication Bus (`通讯记录`).
4. **Context Window & Token DNA Analytics (`Tab 2: Context & Token DNA / 上下文`)**:
   - Build a dedicated Context & Token DNA analytics view featuring the Context Summary Flow Graph (`I/O` + `Context Events` $\rightarrow$ `Current Session` $\rightarrow$ `Tool Calls` + `Agent Network Split`), 8-category Token DNA Donut Chart, 6-category Latency Donut & Timeline Bar, Current Context Window Meter, 20-step Stacked Context Trend Chart, and expandable Context DNA Browser.

## 2. Implementation Summary
- **Backend (`sidecars/harness-ide-monitor/server.mjs`)**:
  - Implemented `resolveWorkspaceContext(reqPayload)` combining `resolveActiveWorkspace` and `extractTrajectoryWorkspace` from `antigravity-sidecar-kit/workspace`, `GetAllCascadeTrajectories` RPC, `active-workspace.json`, and `telemetry.json`.
  - Added `/api/workspace/switch` and `/api/workspace/init` endpoints.
  - Implemented `buildSwarmFormations()` producing 3 full multi-tier hierarchical formations (`live-harness2`, `compact-verification`, and `multi-stage-team`) with directed edges, team groupings, delegated tasks, and inter-agent messages.
  - Implemented `gatherContextAnalytics()` computing I/O counts, context events, 8-category Token DNA breakdown, 6-category latency breakdown, current context window usage, and step-by-step stacked DNA trends.
- **Frontend (`sidecars/harness-ide-monitor/ui/index.html`, `styles.css`, `app.js`)**:
  - Added header Workspace Switcher (`#workspace-switcher-select`) + `⚡ Auto-Follow IDE` toggle (`#btn-auto-follow-ws`) + smooth transition animation (`workspace-switching`) + 1-click `.harness/` initialization banner.
  - Built the interactive SVG + HTML Multi-Tier Hierarchy Map (`drawHierarchyEdges()`) with animated dashed running flows and click-to-highlight lineage filtering.
  - Built the Context & Token DNA tab with SVG donut charts, execution timeline bar, stacked step trend chart, and expandable DNA browser rows.
