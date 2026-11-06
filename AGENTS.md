# Workspace Rules & One-Prompt Onboarding (`Harness2-RAG-antigravity`)

## 1. One-Prompt Reproducible Installation
If the user says **"hey, turn my antigravity IDE into effective harness IDE"** (or asks to install, activate, or set up this repository):
1. Read and follow [`.agents/skills/turn-into-harness-ide/SKILL.md`](./.agents/skills/turn-into-harness-ide/SKILL.md).
2. Run `npm install --no-package-lock && node setup.mjs && npm test`.
3. Surface the clickable Auxiliary Pane pill link `[Harness² Swarm & RAG Monitor](sidecar://harness-ide-monitor/)` and plugin management link `[harness-ide](customization://harness-ide)` in your response.

## 2. Active Harness² & Local RAG Lifecycle in This Workspace
1. **Retrieve Before Planning**: Query `.harness/` via `harness_query` (or `node -e` with `./src/rag-engine.mjs`) across `project-knowledge`, `experiment-knowledge` (`.harness/library/INDEX.md` & `EXPERIENCE.md`), and `reference-knowledge`. Use **Context7** for external library documentation.
2. **Preserve Original Evidence & 5-Part Provenance**: Keep authoritative records in versioned Markdown under `.harness/`. Every `EXPERIENCE.md` lesson must record: (1) Task/Problem, (2) Repo & Git Revision, (3) Observed Behavior, (4) Supporting Evidence, and (5) Currency Status (`active | candidate | superseded`).
3. **Enforce Snapshot Isolation During Candidate Probes**: Before comparing $K$ candidate harnesses in a `Propose -> Probe -> Compose` loop, lock a frozen snapshot via `harness_snapshot_lock(action="create")` and spawn `harness-prober` subagents with `Workspace: "branch"` so later candidates cannot read notes written during earlier candidates' probes.
4. **Always Surface the Sidecar Link**: Whenever discussing subagent swarms, Harness² probes, RAG status, or IDE settings, include `[Harness² Swarm & RAG Monitor](sidecar://harness-ide-monitor/)`.
