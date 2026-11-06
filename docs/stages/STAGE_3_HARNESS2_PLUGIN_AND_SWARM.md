# Stage 3: Harness² Execution Adapter, Subagent Swarm & Antigravity Plugin Bundle

**Timestamp**: 2026-11-07
**Stage Status**: Completed

---

## 1. Objectives of Stage 3
1. Package the complete Antigravity Plugin (`plugin/harness-ide/`) containing:
   - `plugin.json`: Plugin manifest with `name: "harness-ide"`, `displayName`, `logo: "assets/logo.svg"`, and `suggestedPrompts`.
   - `mcp_config.json`: Wires `harness_ide_rag_mcp` (self-contained local hybrid RAG + Harness² Experience Library MCP server) and `harness_ide_context7` (`https://mcp.context7.com/mcp`).
   - `hooks.json` & `scripts/hooks/`:
     - `SessionStart` (`session-start.mjs`): Injects active local RAG document counts, Snapshot Isolation status, and the `sidecar://harness-ide-monitor/` link.
     - `PreInvocation` (`pre-invocation.mjs`): Enforces Snapshot Isolation guardrails when a probe lock is active.
     - `PostToolUse` (`post-tool-use.mjs`): Streams live Main Agent + Subagent Swarm telemetry (`invoke_subagent`, tool calls, file edits) to `.harness/runtime/telemetry.json` and auto-refreshes the local RAG index whenever `.harness/` files change.
   - `rules/AGENTS.md`: Enforces the 4-step retrieval lifecycle, 5-part provenance schema, Snapshot Isolation during candidate probes, and sidecar pill link surfacing.
   - `agents/`: Custom subagent definitions (`harness-proposer.md`, `harness-prober.md` in `Workspace: "branch"`, and `harness-composer.md`).
   - `skills/`: `harness2-loop/SKILL.md`, `qmd-knowledge-lifecycle/SKILL.md`, and `harness-swarm-monitor/SKILL.md`.
2. Build the Python `AntigravityExecutor` adapter (`adapters/harness2_antigravity_executor.py`) supporting both `google-antigravity` Python SDK rollouts and credential-free deterministic verification probes (`--self-test`).

---

## 2. Verification of Stage 3
- Executed `python adapters/harness2_antigravity_executor.py --self-test` verifying that:
  - A Snapshot Isolation lock (`SNAP-*`) freezes the 9 eligible documents across `project-knowledge`, `experiment-knowledge`, and `reference-knowledge`.
  - Parallel candidate probing evaluates `candidate-1-baseline-shared` (`score: 0.75`) against `candidate-2-harness2-rag-branched` (`score: 1.0`, `Workspace: branch`), selects the winning candidate, and releases the snapshot lock cleanly.

---

## 3. Files Created in Stage 3
- `plugin/harness-ide/plugin.json`
- `plugin/harness-ide/mcp_config.json`
- `plugin/harness-ide/hooks.json`
- `plugin/harness-ide/assets/logo.svg`
- `plugin/harness-ide/README.md`
- `plugin/harness-ide/rules/AGENTS.md`
- `plugin/harness-ide/agents/harness-proposer.md`
- `plugin/harness-ide/agents/harness-prober.md`
- `plugin/harness-ide/agents/harness-composer.md`
- `plugin/harness-ide/skills/harness2-loop/SKILL.md`
- `plugin/harness-ide/skills/qmd-knowledge-lifecycle/SKILL.md`
- `plugin/harness-ide/skills/harness-swarm-monitor/SKILL.md`
- `plugin/harness-ide/scripts/rag-engine.mjs` & `plugin/harness-ide/scripts/mcp-entry.mjs`
- `plugin/harness-ide/scripts/hooks/session-start.mjs`, `pre-invocation.mjs`, `post-tool-use.mjs`
- `adapters/harness2_antigravity_executor.py`
- `docs/stages/STAGE_3_HARNESS2_PLUGIN_AND_SWARM.md`
