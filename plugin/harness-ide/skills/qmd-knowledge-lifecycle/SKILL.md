---
name: qmd-knowledge-lifecycle
description: "Manage the local RAG knowledge base (QMD + Built-in Local Hybrid Engine), search across the 3 collections (project-knowledge, experiment-knowledge, reference-knowledge), record provenance-backed lessons, and query Context7 for external library docs."
---

# QMD & Local RAG Knowledge Lifecycle (`qmd-knowledge-lifecycle`)

Use this skill whenever you need to search project history, check architectural decisions, inspect Harness² experience libraries (`INDEX.md` and `EXPERIENCE.md`), record new lessons with provenance, or refresh the local QMD / Hybrid RAG index.

---

## 1. Three Knowledge Collections & When to Query Each

| Collection | Directory | What It Stores | Primary Tool Call |
| :--- | :--- | :--- | :--- |
| **`project-knowledge`** | `.harness/knowledge/project/` | Requirements, Architecture Decision Records (`ADR-*.md`), setup guides, Android frontend & Linux backend constraints (`CONSTRAINTS-*.md`). | `harness_query(query="...", collection="project-knowledge")` |
| **`experiment-knowledge`** | `.harness/library/` & `.harness/knowledge/experiments/` | Harness² `INDEX.md` conditional cues, per-task `EXPERIENCE.md` lessons, adopted `harness/manifest.json` files, and training/experiment failure logs (`EXP-LOG-*.md`). | `harness_query(query="...", collection="experiment-knowledge")` |
| **`reference-knowledge`** | `.harness/knowledge/reference/` | Paper summaries, protocol specs, hardware notes, and curated API references. | `harness_query(query="...", collection="reference-knowledge")` (plus **Context7** for live external library docs) |

---

## 2. Standard 4-Step Retrieval Workflow

1. **Retrieve Before Planning**:
   - Before proposing an architectural change, run:
     `harness_query(query="<topic>", collection="project-knowledge", mode="hybrid")`
   - Before choosing an experimental or training strategy, run:
     `harness_query(query="<strategy or failure mode>", collection="experiment-knowledge", mode="hybrid")`
2. **Fetch Source & Verify Against Working Tree**:
   - Never rely solely on a short snippet. Call `harness_get(id="<docid or path>")` to read the full `ADR` or `EXPERIENCE.md` and inspect its `evidence_links` and `git_revision`.
   - Always check the current code and tests in the working tree to confirm whether the retrieved note still reflects the live implementation.
3. **Save Lessons with 5-Part Provenance**:
   - After completing significant work or an experiment, call `harness_record_experience` (for experiment/harness lessons) or write a new Markdown file in `.harness/knowledge/project/` with YAML frontmatter answering:
     1. What task or problem produced it (`task_id`, `problem`)?
     2. Which repository and revision did it apply to (`repo`, `git_revision`, `domain`)?
     3. What was actually observed (`observed_behavior`)?
     4. Which evidence supports the conclusion (`evidence_links`)?
     5. Is the conclusion still current (`status: "active" | "candidate" | "superseded"`)?
4. **Refresh the Index**:
   - Call `harness_index_refresh()` after adding or editing Markdown files (the `PostToolUse` hook also triggers this automatically for edits inside `.harness/`).

---

## 3. Optional QMD CLI Commands (`tobi/qmd`)

If the user has `qmd` installed globally (`npm install -g @tobilu/qmd`), `harness_ide_rag_mcp` automatically syncs with it. You can also manage QMD collections directly:
```bash
qmd collection add .harness/knowledge/project --name project-knowledge
qmd collection add .harness/library --name experiment-knowledge
qmd collection add .harness/knowledge/reference --name reference-knowledge
qmd update
qmd embed
```
If `qmd` is not installed, `harness_ide_rag_mcp`'s built-in zero-dependency Local Hybrid Engine (BM25 + 256-dim dense semantic vectors + Reciprocal Rank Fusion) handles all queries seamlessly offline.
