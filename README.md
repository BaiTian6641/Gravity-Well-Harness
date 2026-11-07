# Gravity Well Harness (`gravity-well-harness` / `harness-ide`)

**Gravity Well Harness** (combining **Antigravity** + **Harness²**) transforms **Google Antigravity** (`Antigravity IDE` & `Antigravity 2.0`) into a self-improving **Recursive Agent Harnessing IDE** powered by:
- **[Google Research's Harness²](https://github.com/google-research/harness2)** (`Propose → Probe → Compose` + Per-Domain Experience Library)
- **[QMD (`tobi/qmd`)](https://github.com/tobi/qmd)** + Built-in Zero-Dependency **Local Hybrid RAG Engine** (BM25 + Dense Vector + RRF Reranking)
- **[Context7](https://context7.com/docs/resources/all-clients#google-antigravity)** & **Google Developer Knowledge** External Documentation MCPs
- **Dynamic Multi-Tier Subagent Swarm Hierarchy & Team Formation Map** (`Workspace: "branch"` isolation + curved SVG directional flow DAG)
- **Context Window & Token DNA Analytics Tool** (8-category Token DNA breakdown, Latency donut & timeline, Step-by-Step Context Trend chart, and expandable DNA Browser)
- **Smooth Workspace Auto-Follow & Switcher** (automatically adapts to the currently opened workspace in Antigravity IDE)

**Remote Repository**: [`git@github.com:BaiTian6641/Gravity-Well-Harness.git`](https://github.com/BaiTian6641/Gravity-Well-Harness)

---

## 🚀 One-Prompt Reproducible Installation

Any user can clone or open this repository in Google Antigravity and simply tell the agent:

> **"Hey, turn my Antigravity IDE into an effective harness IDE"**

Because this repository includes workspace-scoped rules ([`AGENTS.md`](./AGENTS.md)), plugin discovery ([`.agents/plugins.json`](./.agents/plugins.json)), and an automated onboarding skill ([`.agents/skills/turn-into-harness-ide/SKILL.md`](./.agents/skills/turn-into-harness-ide/SKILL.md)), Antigravity will automatically execute the installer, verify all tests, and activate the sidecar UI.

### Or Install Manually via Terminal (Windows / macOS / Linux)

```bash
git clone git@github.com:BaiTian6641/Gravity-Well-Harness.git
cd Gravity-Well-Harness
npm install --no-package-lock
node setup.mjs
npm test
```
*(Convenience wrappers [`install.ps1`](./install.ps1) and [`install.sh`](./install.sh) are also included.)*

---

## 🧩 Division of Responsibilities

| Component | Responsibility in **Gravity Well Harness** |
| :--- | :--- |
| **Google Antigravity** | Implement changes, investigate problems, consult local project/experiment knowledge, spawn isolated `harness-prober` subagent swarms (`Workspace: "branch"`), and enforce the retrieval lifecycle. |
| **Google Research Harness²** | Propose and probe candidate harness edits across the 8 editable harness dimensions (`system_prompts`, `rules`, `skills`, `subagents`, `hooks`, `tools`, `scripts`, `plugins`), compose winning refinements, and retain execution evidence (`INDEX.md`, `EXPERIENCE.md`, and `harness/`). |
| **Local Hybrid RAG (`QMD` + Built-in Engine)** | Index local Markdown files across the 3 knowledge collections (`project-knowledge`, `experiment-knowledge`, `reference-knowledge`), perform BM25 + dense vector + RRF reranked search 100% locally, and enforce **Snapshot Isolation** during candidate probes. |
| **Context7 & Google Dev Knowledge** | Fetch version-specific external library documentation (`mcp.context7.com`) and official Android, Firebase, and Google Cloud documentation (`developers.google.com/knowledge/mcp`). |
| **Auxiliary Pane UI (`harness-ide-monitor`)** | Native Antigravity sidecar UI (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`) for dynamic multi-tier Subagent Swarm hierarchy & team formations, Context Window & Token DNA analytics, Harness² Snapshot Lock Studio, Local RAG search, smooth workspace switching, and visual settings. |
| **Versioned Project Markdown (`.harness/`)** | Authoritative record of Architecture Decision Records (`ADR-*.md`), constraints (`CONSTRAINTS-*.md`), experiment logs (`EXP-LOG-*.md`), and Harness² experience libraries. |

---

## 🖥️ Auxiliary Pane UI Sidecar (`sidecar://harness-ide-monitor/`)

Once installed, open the sidecar panel in Antigravity with one click:
- `[Harness² Swarm & RAG Monitor](sidecar://harness-ide-monitor/)`

### Smooth Workspace Switching
- The top header includes an **Active Workspace Switcher** with **`⚡ Auto-Follow IDE`** enabled by default.
- Whenever you switch workspaces or conversations in Antigravity IDE, the page smoothly transitions to the currently opened workspace (`GetAllCascadeTrajectories` + `resolveActiveWorkspace` + `window.sidecar.onWorkspaceChange` + hook telemetry).
- If you open a brand-new project that does not yet have a `.harness/` directory, a 1-click **`✨ Initialize Gravity Well .harness/ Here`** banner lets you scaffold the 3 knowledge collections immediately.

### Five Interactive Tabs:
1. **1. Swarm Formation (`编队 — Dynamic Hierarchy & Team Formations`)**:
   - **Multi-Tier Hierarchical DAG Canvas**: Renders **Tier 0 (Root Main Orchestrator)** $\rightarrow$ **Tier 1 (Proposer / Stage Leads)** $\rightarrow$ **Tier 2 (Isolated Branched Prober Workers)** $\rightarrow$ **Tier 3 (Contrastive Composer & Verifiers)** connected by animated SVG cubic Bezier flow curves (`-- Running` dashed flow & solid completed links), zoom/pan controls (`-`, `100%`, `+`, `Fit`), and click-to-highlight lineage filtering.
   - **Embedded Node Telemetry**: Each node displays live status, role, total tokens, estimated cost, duration + step count, context window %, and an 8-segment **Context DNA bar**.
   - **Swarm Teams & Members (`编队成员`)**: Groups agents into Teams with search, status filters (`All`, `Running`, `Completed`), and sort options (`Hierarchy Tier`, `Token Usage`, `Step Count`).
   - **Delegated Tasks (`任务`) & Inter-Agent Communication Bus (`通讯记录`)**: Inspect exact subagent task prompts and directional Main Agent $\leftrightarrow$ Subagent messages.
2. **2. Context & Token DNA (`上下文 — Context Window Analytics`)**:
   - **Context Flow Overview (`上下文统计`)**: Visual pipeline connecting `I/O Operations (Input, Read, Write, Search)` + `Context Events (Injected, Compacted, Pruned)` $\rightarrow$ `Current Session Hub (Turns, Steps, Skills, Replies)` $\rightarrow$ `Tool Calls` + `Agent Network Token Split (Main Agent vs. Subagents)`.
   - **Token Statistics Donut (`Token 统计`)**: Cache Hit % and 8-category DNA breakdown (`System Prompt`, `Tool Definitions`, `User Messages`, `Injected RAG`, `Skill Injection`, `Assistant Messages`, `Tool Results`, `Output + Thinking`).
   - **Latency Breakdown Donut & Timeline Bar (`耗时统计`)**: Output speed (`tok/s`), 6-category latency breakdown (`Model Wait`, `Model Thinking`, `Model Reply`, `Tool Args`, `Tool Execution`, `Other Overhead`), and proportional execution timeline bar.
   - **Current Context Window (`当前上下文`), Step-by-Step Context Trend Chart (`上下文趋势`), & Expandable Context DNA Browser (`上下文浏览器`)**.
3. **3. Harness² Studio (`Propose → Probe → Compose`)**:
   - **Snapshot Isolation Lock Controller**: One-click **Freeze Snapshot for Probe** (`SNAP-*`) and **Release Lock** buttons so all $K$ candidate harnesses evaluate against the exact same historical knowledge cutoff.
   - **Experience Library Browser**: Inspect `INDEX.md` conditional cues and `EXPERIENCE.md` lessons, promote lessons to Project ADRs, or record new empirical lessons.
4. **4. Local RAG Explorer (`QMD + Hybrid BM25/Vector/RRF`)**:
   - Search across `project-knowledge`, `experiment-knowledge`, and `reference-knowledge` with 1-click benchmark query chips, inspect full Markdown & YAML provenance, create new Markdown notes, and trigger **Re-Index & Embed Now**.
5. **5. Visual Settings Manager**:
   - Switch between **QMD + Built-in Local Hybrid**, **Built-in Zero-Dep Hybrid**, **Basic Memory**, and **RAGFlow**.
   - Toggle **Context7** and **Google Developer Knowledge** MCPs, Harness² recursion mode, candidate count ($K$), strict Snapshot Isolation, and lifecycle hooks.

---

## 📖 Staged Engineering Documentation

- [Master Implementation Plan (`PLAN.md`)](./PLAN.md)
- [System Architecture Guide (`docs/ARCHITECTURE.md`)](./docs/ARCHITECTURE.md)
- [Stage 1: Architecture & Plan (`docs/stages/STAGE_1_ARCHITECTURE_AND_PLAN.md`)](./docs/stages/STAGE_1_ARCHITECTURE_AND_PLAN.md)
- [Stage 2: Local RAG & Knowledge Engine (`docs/stages/STAGE_2_LOCAL_RAG_AND_KNOWLEDGE_ENGINE.md`)](./docs/stages/STAGE_2_LOCAL_RAG_AND_KNOWLEDGE_ENGINE.md)
- [Stage 3: Harness² Plugin & Swarm (`docs/stages/STAGE_3_HARNESS2_PLUGIN_AND_SWARM.md`)](./docs/stages/STAGE_3_HARNESS2_PLUGIN_AND_SWARM.md)
- [Stage 4: UI Sidecar Monitor & Settings (`docs/stages/STAGE_4_UI_SIDECAR_MONITOR_AND_SETTINGS.md`)](./docs/stages/STAGE_4_UI_SIDECAR_MONITOR_AND_SETTINGS.md)
- [Stage 5: Reproducible Installer & Verification (`docs/stages/STAGE_5_REPRODUCIBLE_INSTALLER_AND_VERIFICATION.md`)](./docs/stages/STAGE_5_REPRODUCIBLE_INSTALLER_AND_VERIFICATION.md)
- [Stage 6: Gravity Well Harness Rebranding, Dynamic Swarm Hierarchy, Context DNA & Smooth Workspace Sync (`docs/stages/STAGE_6_GRAVITY_WELL_HARNESS_SWARM_HIERARCHY_AND_CONTEXT_DNA.md`)](./docs/stages/STAGE_6_GRAVITY_WELL_HARNESS_SWARM_HIERARCHY_AND_CONTEXT_DNA.md)
