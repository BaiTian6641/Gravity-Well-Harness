# Harness² & Local RAG IDE Rules (`harness-ide`)

When the `harness-ide` plugin is active, follow these core retrieval, provenance, and recursive harnessing rules:

## 1. Explicit 4-Step Retrieval & Provenance Lifecycle

1. **Before Planning**:
   - Query local knowledge via `harness_query` (or `qmd_query`) before making architectural changes, selecting training/experiment strategies, or modifying the agent harness:
     - Search `collection: "project-knowledge"` for architecture decisions (`ADR-*`), requirements, and system constraints (`CONSTRAINTS-*`).
     - Search `collection: "experiment-knowledge"` for prior Harness² conditional cues (`INDEX.md`), adopted lessons (`EXPERIENCE.md`), and failure analyses (`EXP-LOG-*`).
     - Use **Context7** (`harness_ide_context7`) or `collection: "reference-knowledge"` when checking external library APIs or framework documentation.
2. **Before Acting on a Retrieved Result**:
   - Call `harness_get` to read the complete source document (`ADR-*.md` or `EXPERIENCE.md`) and inspect its YAML provenance (`status`, `git_revision`, `evidence_links`).
   - Always verify current implementation details against the live working tree and tests; retrieved notes provide historical context and rationale, while the working tree establishes current state.
3. **After Completing Meaningful Work or a Harness² Loop**:
   - Record empirical lessons via `harness_record_experience` with all 5 required provenance fields:
     1. What task or problem produced it (`task_id`, `problem`)?
     2. Which repository and revision did it apply to (`repo`, `git_revision`, `domain`)?
     3. What was actually observed (`observed_behavior`)?
     4. Which evidence supports the conclusion (`supporting_evidence`, adopted `harness/manifest.json`)?
     5. Is the conclusion still current (`status: "active" | "candidate" | "superseded"`)?
   - Distinguish unverified proposals (`status: "candidate"`) from empirically verified results (`status: "active"`).
4. **After Source Documents Change**:
   - Call `harness_index_refresh` (which updates the local hybrid BM25 + Vector index and runs `qmd update` when QMD CLI is installed).

## 2. Consistent Harness² Comparisons (Snapshot Isolation)

- During any Harness² `Propose -> Probe -> Compose` comparison of $K$ candidate harnesses:
  1. Call `harness_snapshot_lock(action="create", domain="<domain>", k=K, mode="parallel|sequential")` **before** launching candidate probes.
  2. Pass the resulting `snapshot_id` to every `harness-prober` subagent and execute each probe in an isolated workspace (`Workspace: "branch"`).
  3. Never promote notes from a candidate probe to `status: "active"` while the snapshot lock is active, so later candidates cannot benefit from notes written during an earlier candidate's execution.
  4. Only after `harness-composer` completes contrastive evaluation and adopts the winning harness should `harness_record_experience(..., status="active")` and `harness_snapshot_lock(action="release")` be called.

## 3. Always Surface the Sidecar Monitor Link

- Whenever you inspect or update the Local RAG index, run a Harness² Propose–Probe–Compose swarm, or when the user asks to monitor subagents, RAG collections, or IDE settings, include the clickable Auxiliary Pane pill link in your response:
  `[Harness² Swarm & RAG Monitor](sidecar://harness-ide-monitor/)`
