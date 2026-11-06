# Harness² + Local RAG IDE for Google Antigravity (`harness-ide`)

Turn **Google Antigravity** (`Antigravity IDE` & `Antigravity 2.0`) into a self-improving **Recursive Agent Harnessing IDE** powered by **[Google Research's Harness²](https://github.com/google-research/harness2)**, **[QMD (`tobi/qmd`)](https://github.com/tobi/qmd)** + a built-in zero-dependency **Local Hybrid RAG Engine**, **[Context7](https://context7.com/docs/resources/all-clients#google-antigravity)** external library documentation, **Branched Subagent Swarms**, and a native **Auxiliary Pane UI Sidecar (`harness-ide-monitor`)**.

---

## 🚀 One-Prompt Reproducible Installation

Any user can clone or drop this repository into Google Antigravity and simply tell the agent:

> **"Hey, turn my Antigravity IDE into an effective harness IDE"**

Because this repository includes workspace-scoped rules ([`AGENTS.md`](./AGENTS.md)), plugin discovery ([`.agents/plugins.json`](./.agents/plugins.json)), and an automated onboarding skill ([`.agents/skills/turn-into-harness-ide/SKILL.md`](./.agents/skills/turn-into-harness-ide/SKILL.md)), Antigravity will automatically execute the installer, verify all tests, and activate the sidecar UI.

### Or Install Manually via Terminal (Windows / macOS / Linux)

```bash
npm install --no-package-lock
node setup.mjs
npm test
```
*(Convenience wrappers [`install.ps1`](./install.ps1) and [`install.sh`](./install.sh) are also included.)*

---

## 🧩 Division of Responsibilities

| Component | Responsibility in `harness-ide` |
| :--- | :--- |
| **Google Antigravity** | Implement changes, investigate problems, consult local project/experiment knowledge, spawn isolated `harness-prober` subagent swarms (`Workspace: "branch"`), and enforce the retrieval lifecycle. |
| **Google Research Harness²** | Propose and probe candidate harness edits across the 8 editable harness dimensions (`system_prompts`, `rules`, `skills`, `subagents`, `hooks`, `tools`, `scripts`, `plugins`), compose winning refinements, and retain execution evidence (`INDEX.md`, `EXPERIENCE.md`, and `harness/`). |
| **Local Hybrid RAG (`QMD` + Built-in Engine)** | Index local Markdown files across the 3 knowledge collections (`project-knowledge`, `experiment-knowledge`, `reference-knowledge`), perform BM25 + dense vector + RRF reranked search 100% locally, and enforce **Snapshot Isolation** during candidate probes. |
| **Context7 & Google Dev Knowledge** | Fetch version-specific external library documentation (`mcp.context7.com`) and official Android, Firebase, and Google Cloud documentation (`developers.google.com/knowledge/mcp`). |
| **Auxiliary Pane UI (`harness-ide-monitor`)** | Native Antigravity sidecar UI (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`) for real-time Main Agent + Subagent Swarm monitoring, Harness² Snapshot Lock Studio, Local RAG search, and easy-to-understand visual settings. |
| **Versioned Project Markdown (`.harness/`)** | Authoritative record of Architecture Decision Records (`ADR-*.md`), constraints (`CONSTRAINTS-*.md`), experiment logs (`EXP-LOG-*.md`), and Harness² experience libraries. |

---

## 🖥️ Auxiliary Pane UI Sidecar (`harness-ide-monitor`)

Once installed, open the sidecar panel in Antigravity with one click:
- `[Harness² Swarm & RAG Monitor](sidecar://harness-ide-monitor/)`

### Four Interactive Tabs:
1. **1. Swarm Monitor (`Main Agent + Subagent Swarm`)**:
   - Real-time topology of the **Main Orchestrator Agent** and its **Subagent Swarm** (`harness-proposer`, `harness-prober #1..K [Workspace: branch]`, `harness-composer`, `research`, `self`).
   - Reads live trajectories via Antigravity Language Server Connect RPCs (`GetAllCascadeTrajectories`) and local `.system_generated/logs/transcript.jsonl` + `PostToolUse` hook telemetry.
2. **2. Harness² Studio (`Propose → Probe → Compose`)**:
   - **Snapshot Isolation Lock Controller**: One-click **Freeze Snapshot for Probe** (`SNAP-*`) and **Release Lock** buttons so all $K$ candidate harnesses evaluate against the exact same historical knowledge cutoff.
   - **Experience Library Browser**: Inspect `INDEX.md` conditional cues and `EXPERIENCE.md` lessons, promote lessons to Project ADRs, or record new empirical lessons.
3. **3. Local RAG Explorer (`QMD + Hybrid BM25/Vector/RRF`)**:
   - Search across `project-knowledge`, `experiment-knowledge`, and `reference-knowledge` with 1-click benchmark query chips, inspect full Markdown & YAML provenance, create new Markdown notes, and trigger **Re-Index & Embed Now**.
4. **4. Visual Settings Manager**:
   - Switch between **QMD + Built-in Local Hybrid**, **Built-in Zero-Dep Hybrid**, **Basic Memory**, and **RAGFlow**.
   - Toggle **Context7** (with optional API key) and **Google Developer Knowledge** MCPs.
   - Configure Harness² recursion mode (`Parallel` vs `Sequential`), candidate count ($K$), strict Snapshot Isolation, and lifecycle hooks.

---

## 📚 Knowledge Structure & 5-Part Provenance

All persistent knowledge is kept locally in versioned Markdown under [`.harness/`](./.harness):

```text
.harness/
├── config.json                                   # Local RAG, External Docs, Harness² & UI Settings
├── knowledge/
│   ├── project/                                  # ADR-001, CONSTRAINTS-001, architecture decisions
│   ├── experiments/                              # EXP-LOG-001, training & memory trial logs
│   └── reference/                                # REF-HARNESS2, REF-QMD-CONTEXT7, paper/API summaries
└── library/                                      # Per-domain Harness² Experience Library
    ├── INDEX.md                                  # Master cross-domain conditional cues
    └── software-engineering/
        ├── INDEX.md                              # Domain-specific conditional cues
        └── harnesses/
            └── task-001-snapshot-isolation/
                ├── EXPERIENCE.md                 # 5-part empirical provenance record
                └── harness/
                    └── manifest.json             # Complete adopted harness configuration
```

Every `EXPERIENCE.md` entry preserves five required provenance dimensions:
1. **What task or problem produced it?** (`task_id`, `problem`)
2. **Which repository and revision did it apply to?** (`repo`, `git_revision`, `domain`)
3. **What was actually observed?** (`observed_behavior` contrasting baseline vs. candidates)
4. **Which evidence supports the conclusion?** (`evidence_links`, `harness/manifest.json`)
5. **Is the conclusion still current?** (`status: active | candidate | superseded`)

---

## 🔬 Dual-Level Harness² Execution

1. **Level 1 — Native Antigravity Subagent Swarm ([`plugin/harness-ide/skills/harness2-loop/SKILL.md`](./plugin/harness-ide/skills/harness2-loop/SKILL.md))**:
   - Locks a frozen knowledge snapshot (`harness_snapshot_lock`), spawns $K$ `harness-prober` subagents with `Workspace: "branch"`, composes the winning harness via `harness-composer`, and records `EXPERIENCE.md` + `INDEX.md`.
2. **Level 2 — Python `AntigravityExecutor` Adapter ([`adapters/harness2_antigravity_executor.py`](./adapters/harness2_antigravity_executor.py))**:
   - Run standalone or integrate with upstream `google-research/harness2`:
     ```bash
     python adapters/harness2_antigravity_executor.py --self-test
     ```

---

## 📖 Staged Engineering Documentation

- [Master Implementation Plan (`PLAN.md`)](./PLAN.md)
- [System Architecture Guide (`docs/ARCHITECTURE.md`)](./docs/ARCHITECTURE.md)
- [Stage 1: Architecture & Plan (`docs/stages/STAGE_1_ARCHITECTURE_AND_PLAN.md`)](./docs/stages/STAGE_1_ARCHITECTURE_AND_PLAN.md)
- [Stage 2: Local RAG & Knowledge Engine (`docs/stages/STAGE_2_LOCAL_RAG_AND_KNOWLEDGE_ENGINE.md`)](./docs/stages/STAGE_2_LOCAL_RAG_AND_KNOWLEDGE_ENGINE.md)
- [Stage 3: Harness² Plugin & Swarm (`docs/stages/STAGE_3_HARNESS2_PLUGIN_AND_SWARM.md`)](./docs/stages/STAGE_3_HARNESS2_PLUGIN_AND_SWARM.md)
- [Stage 4: UI Sidecar Monitor & Settings (`docs/stages/STAGE_4_UI_SIDECAR_MONITOR_AND_SETTINGS.md`)](./docs/stages/STAGE_4_UI_SIDECAR_MONITOR_AND_SETTINGS.md)
- [Stage 5: Reproducible Installer & Verification (`docs/stages/STAGE_5_REPRODUCIBLE_INSTALLER_AND_VERIFICATION.md`)](./docs/stages/STAGE_5_REPRODUCIBLE_INSTALLER_AND_VERIFICATION.md)
