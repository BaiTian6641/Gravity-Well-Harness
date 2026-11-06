# Stage 2: Local RAG & Harness² Knowledge Engine (`harness-rag-mcp` + QMD Integration)

**Timestamp**: 2026-11-07
**Stage Status**: Completed

---

## 1. Objectives of Stage 2
1. Establish the local, versioned Markdown knowledge layout (`.harness/`) covering:
   - `project-knowledge` (`.harness/knowledge/project/`)
   - `experiment-knowledge` (`.harness/library/` & `.harness/knowledge/experiments/`)
   - `reference-knowledge` (`.harness/knowledge/reference/`)
2. Build the zero-dependency **Local Hybrid RAG + Harness² Library Engine** (`src/rag-engine.mjs`) combining BM25 lexical search, 256-dim dense semantic vectors with concept-cluster awareness, Reciprocal Rank Fusion (RRF), and optional `tobi/qmd` CLI synchronization.
3. Implement **Snapshot Isolation** (`createSnapshotLock`, `getActiveSnapshotLock`, `releaseSnapshotLock`) to guarantee that candidate harnesses during a Harness² `Propose -> Probe -> Compose` comparison read identical historical knowledge without cross-candidate contamination.
4. Expose the engine via a standards-compliant Model Context Protocol (MCP) server (`mcp/harness-rag-server.mjs`).

---

## 2. Verification of the 4 Benchmark Engineering & Research Queries

We verified `HarnessKnowledgeEngine` against the four benchmark queries specified in the design requirements:

| Query | Top Ranked Document (`docid`) | Collection |
| :--- | :--- | :--- |
| *"What evidence supported our previous choice of memory architecture?"* | `ADR-001` (`ADR-001: Local Hybrid RAG (QMD) + Harness² Experience Library Architecture`) | `project-knowledge` |
| *"Which approaches failed in earlier training experiments, and under what conditions?"* | `EXP-LOG-001` (`Experiment Log: Failed vs. Adopted Approaches in Agent Harness & Memory Trials`) | `experiment-knowledge` |
| *"What constraints did we establish for the Android frontend and Linux backend?"* | `CONSTRAINTS-001` (`System & Cross-Platform Constraints (IDE, Subagent Swarm, Frontend & Backend)`) | `project-knowledge` |
| *"Which earlier harness change helped with this type of task?"* | `LIB-INDEX-SWE` (`Harness² Experience Library Index — software-engineering`) | `experiment-knowledge` |

---

## 3. Files Created in Stage 2
- `.harness/config.json`: Local RAG, External Docs (Context7 / Google Developer Knowledge), Harness² Loop, and UI Monitor configuration.
- `.harness/knowledge/project/ADR-001-memory-and-rag-architecture.md`: Architectural decision record with provenance.
- `.harness/knowledge/project/CONSTRAINTS-001-system-constraints.md`: Cross-stack (Android frontend / Linux backend / Antigravity loopback) and Snapshot Isolation constraints.
- `.harness/knowledge/experiments/EXP-LOG-001-training-and-memory-trials.md`: Empirical failure analysis and adopted strategies.
- `.harness/knowledge/reference/REF-harness2-recursive-agent-harnessing.md`: Reference guide for `google-research/harness2`.
- `.harness/knowledge/reference/REF-qmd-and-context7-mcp.md`: Reference guide for `tobi/qmd` and `Context7` MCP.
- `.harness/library/INDEX.md` & `.harness/library/software-engineering/INDEX.md`: Harness² browsable conditional cue indices.
- `.harness/library/software-engineering/harnesses/task-001-snapshot-isolation/EXPERIENCE.md` & `harness/manifest.json`: Complete Harness² experience entry and adopted harness tree.
- `src/rag-engine.mjs`: Core Local Hybrid RAG, Snapshot Isolation, and Experience Library engine.
- `mcp/harness-rag-server.mjs`: Stdio MCP server exposing `harness_query`, `harness_get`, `harness_multi_get`, `harness_status`, `harness_metadata`, `harness_snapshot_lock`, `harness_record_experience`, `harness_promote_lesson`, and `harness_index_refresh`.
