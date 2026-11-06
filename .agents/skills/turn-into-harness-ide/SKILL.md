---
name: turn-into-harness-ide
description: "One-prompt automated installer and activator. Trigger this skill whenever the user says 'turn my antigravity IDE into effective harness IDE', 'install harness-ide', 'set up this repo', or asks to transform their Antigravity IDE into a Harness² + Local RAG IDE."
---

# Turn Antigravity Into an Effective Harness² + Local RAG IDE (`turn-into-harness-ide`)

Activate this skill whenever a user clones or opens this repository and says:
> *"Hey, turn my Antigravity IDE into an effective harness IDE"* (or any similar installation/setup request).

## Automated Setup Procedure (3 Steps)

1. **Install Dependencies & Run the One-Command Installer**:
   Execute in the repository root:
   ```bash
   npm install --no-package-lock
   node setup.mjs
   ```
   What `node setup.mjs` automatically performs:
   - Builds the local Hybrid RAG index (`.harness/index/local-rag-index.json`) over `.harness/knowledge/project`, `.harness/library`, and `.harness/knowledge/reference` (and syncs with `qmd` CLI if installed).
   - Installs the **`harness-ide` plugin** into `~/.gemini/config/plugins/harness-ide/` and enables it live via the Language Server `JetboxWriteState` RPC and `~/.gemini/config/config.json`.
   - Installs the **`harness-ide-monitor` Auxiliary Pane UI Sidecar** into `~/.gemini/config/sidecars/harness-ide-monitor/`, bundles `antigravity-sidecar-kit`, and activates it via the Language Server `ManageSidecar` RPC.

2. **Run the End-to-End Verification Suite**:
   ```bash
   npm test
   ```
   Confirm all automated tests pass (Local Hybrid RAG search, 4 benchmark queries, Snapshot Isolation locks, Experience Library recording, MCP tools, Lifecycle Hooks, Sidecar UI HTTP endpoints, and Python `AntigravityExecutor` adapter).

3. **Report Back with One-Click Links**:
   Always include both links in your final message to the user:
   - **Auxiliary Pane UI Monitor & Settings**: `[Harness² Swarm & RAG Monitor](sidecar://harness-ide-monitor/)`
   - **Plugin Management Page**: `[harness-ide](customization://harness-ide)`
   - Remind the user to restart Antigravity once if this is the first time the `harness-ide` plugin folder was created so startup discovery registers all global skills and hooks.
