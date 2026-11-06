---
name: harness-swarm-monitor
description: "Open, operate, and configure the Harness² Swarm & RAG Monitor Auxiliary Pane UI Sidecar (sidecar://harness-ide-monitor/) to visualize the Main Agent + Subagent Swarm, Harness² candidate probes, Local RAG collections, and IDE settings."
---

# Harness² Swarm & RAG Monitor Sidecar (`harness-swarm-monitor`)

The **Harness² Swarm & RAG Monitor** (`harness-ide-monitor`) is an interactive Auxiliary Pane UI Extension (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`) rendered directly inside the Antigravity side panel.

## 1. Surfacing the One-Click Sidecar Pill

Whenever you:
- Spawn or monitor subagents in a swarm (`invoke_subagent`),
- Run a Harness² `Propose -> Probe -> Compose` loop or manage Snapshot Isolation locks,
- Query, record, or refresh Local RAG knowledge via `harness_ide_rag_mcp`, or
- Help the user configure RAG backends, Context7, or Harness² settings,

**ALWAYS** include this exact clickable pill link in your chat response:

```markdown
[Harness² Swarm & RAG Monitor](sidecar://harness-ide-monitor/)
```

---

## 2. What the User Can Do in the Auxiliary Pane UI

1. **Swarm & Agent Monitor Tab**:
   - View the live hierarchy of the **Main Agent** and all spawned **Subagents** (`harness-proposer`, `harness-prober #1..K`, `harness-composer`, `research`, `self`).
   - Inspect each subagent's live status (`RUNNING`, `DONE`, `IDLE`, `ERROR`), workspace isolation mode (`inherit`, `branch`, `share`), step count, active tool calls, and token/thinking usage fetched via Language Server RPCs (`GetAllCascadeTrajectories`) and hook telemetry.
2. **Harness² Studio Tab**:
   - Inspect active and historical `Propose -> Probe -> Compose` runs.
   - Create or release **Snapshot Isolation Locks** (`SNAP-*`) with one click.
   - Browse the per-domain Experience Library (`INDEX.md` conditional cues and full `EXPERIENCE.md` lessons) and record or promote lessons interactively.
3. **Local RAG & Knowledge Explorer Tab**:
   - Run live Hybrid (`BM25 + Vector RRF`), Lexical (`BM25`), or Semantic (`Vector`) searches across `project-knowledge`, `experiment-knowledge`, and `reference-knowledge`.
   - Read full Markdown documents with provenance badges (`status: active | candidate | superseded`, `git_revision`, `evidence_links`).
   - Create new project ADRs or experiment notes and click **Refresh Index & Embeddings** to rebuild the local index immediately.
4. **Settings Manager Tab**:
   - Switch the primary RAG backend (`QMD + Built-in Hybrid`, `Built-in Local Hybrid Only`, `Basic Memory`, `RAGFlow`).
   - Toggle **Context7** (with optional API key) and **Google Developer Knowledge** MCP servers.
   - Configure Harness² defaults ($K$ candidates, `parallel` vs `sequential` mode, strict Snapshot Isolation, execution substrate).
   - Toggle lifecycle hooks (`SessionStart` RAG context injection, `PostToolUse` swarm telemetry).
