---
docid: ADR-001
title: "ADR-001: Local Hybrid RAG (QMD) + Harness² Experience Library Architecture"
collection: project-knowledge
domain: architecture
status: active
repo: Harness2-RAG-antigravity
git_revision: HEAD
created_at: "2026-11-07T02:55:00Z"
tags: [architecture, rag, qmd, harness2, context7, memory]
evidence_links:
  - ".harness/library/software-engineering/harnesses/task-001-snapshot-isolation/EXPERIENCE.md"
  - "docs/ARCHITECTURE.md"
---

# ADR-001: Local Hybrid RAG (QMD) + Harness² Experience Library Architecture

## 1. Problem & Context
When Google Antigravity starts a new engineering or research task, stuffing the entire project history into the prompt wastes tokens and degrades reasoning focus. At the same time, Google Research's **Harness²** already maintains a structured, file-backed per-domain experience library (`INDEX.md`, `EXPERIENCE.md`, and adopted `harness/` directory trees). We needed a retrieval architecture that:
1. Keeps all project and experiment knowledge **100% local** in version-controlled Markdown files.
2. Preserves Harness²'s native directory organization and experimental provenance.
3. Enforces **Snapshot Isolation** during candidate harness comparisons (`Propose -> Probe -> Compose`).

## 2. Decision
We chose **QMD (`tobi/qmd`) paired with a Built-in Local Hybrid RAG Engine (`harness_ide_rag_mcp`)** as our primary local knowledge layer, complemented by **Context7** for external library documentation:

- **QMD + Local Hybrid Engine**: Indexes `.harness/knowledge/project/`, `.harness/library/` (plus `.harness/knowledge/experiments/`), and `.harness/knowledge/reference/`. Combines BM25 lexical matching, local dense vector similarity, and Reciprocal Rank Fusion (RRF) reranking.
- **Context7 MCP**: Queries version-specific third-party library and framework documentation without polluting the local project index.
- **Optional Profiles**:
  - **Basic Memory**: Can be toggled in Settings if an actively linked personal research notebook workflow is desired.
  - **RAGFlow**: Can be toggled in Settings when heavy PDF, scanned datasheet, or hardware manual ingestion becomes the dominant workload.

## 3. Evidence & Tradeoffs
- **Supporting Evidence**: Harness² stores its output as plain Markdown (`INDEX.md`, `EXPERIENCE.md`) and config files (`harness2/core/library.py`). Indexing these directly avoids duplicating state into an opaque cloud vector database.
- **Tradeoff Addressed**: Because raw QMD only provides search/fetch tools (`query`, `get`, `multi_get`, `status`, `metadata`), our Antigravity plugin (`harness-ide`) owns the **retrieval lifecycle** via rules, skills, and hooks:
  1. Search before planning.
  2. Fetch full source notes and inspect referenced code before acting.
  3. Lock eligible knowledge snapshots during Harness² candidate probes.
  4. Record structured `EXPERIENCE.md` provenance and refresh the index after completing meaningful work.
