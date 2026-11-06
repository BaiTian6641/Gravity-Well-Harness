---
docid: REF-QMD-CONTEXT7
title: "Reference: QMD Local Hybrid Search & Context7 External Documentation MCP"
collection: reference-knowledge
domain: rag-and-mcp
status: active
repo: tobi/qmd
git_revision: main
created_at: "2026-11-07T02:56:15Z"
tags: [qmd, context7, mcp, rag, bm25, vector-search, reranking]
---

# Reference: QMD (`tobi/qmd`) & Context7 MCP Integration

## 1. QMD Local Hybrid Search (`tobi/qmd`)
QMD indexes local Markdown files and provides BM25 keyword search, local GGUF vector embeddings (`node-llama-cpp`), and Reciprocal Rank Fusion (RRF) with local reranking.

### Key CLI Commands
- `qmd collection add <path> --name <collection>`: Register a local Markdown directory as a named collection.
- `qmd update`: Rescan registered collection directories to sync added, modified, or deleted Markdown files.
- `qmd embed`: Generate local dense vector embeddings for indexed chunks.
- `qmd mcp`: Start the stdio MCP server (`qmd mcp --http --port 8181` for shared loopback HTTP mode).

### Key MCP Tools Exposed by QMD & `harness_ide_rag_mcp`
- `query` / `harness_query`: Search across collections using `lex` (BM25), `vec` (semantic vector), or `hybrid` (RRF fusion), with collection, domain, status, and `snapshot_id` filtering.
- `get` / `harness_get`: Fetch a complete Markdown document by relative path or `docid`, including parsed YAML frontmatter and provenance.
- `multi_get` / `harness_multi_get`: Batch retrieve multiple documents by glob pattern or comma-separated `docid` list.
- `status` / `harness_status`: Check index health, collection statistics, QMD binary presence, and active Snapshot Isolation locks.
- `metadata` / `harness_metadata`: Inspect available frontmatter metadata keys (`collection`, `domain`, `status`, `tags`, `git_revision`) and counts.

## 2. Context7 MCP (`@upstash/context7-mcp`)
Context7 provides version-specific external library documentation and code examples at query time.
- **Remote Streamable HTTP Endpoint**: `https://mcp.context7.com/mcp`
- **Complementary Role**: Use **QMD / `harness_ide_rag_mcp`** for project decisions (`project-knowledge`) and prior Harness² experiments (`experiment-knowledge`), and use **Context7** for external library APIs.
- **Google Developer Knowledge MCP**: `https://developers.google.com/knowledge/mcp` provides official Android, Firebase, and Google Cloud documentation.
