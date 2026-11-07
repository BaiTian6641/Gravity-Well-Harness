---
docid: EXP-SOFT-TASK-STAGE14-GRI-FB0EC0
title: "Gravity Well Harness Hardening: F01-F15 Public API Repair, Immutable Snapshot Blobs, Credential Origin Guards & Argon Context Resilience"
collection: experiment-knowledge
domain: software-engineering
task_id: task-stage14-grill-me-hardening
status: active
synthetic: false
repo: Harness2-RAG-antigravity
git_revision: c619f9d
created_at: "2026-11-07T21:41:07.545Z"
cue: "When hardening an Antigravity IDE harness across multi-model swarms, RAG snapshots, and long-horizon Argon sessions, enforce content-addressed immutable snapshot blobs, CAS per-run locks, credential origin allowlists, recipient-isolated message bus locks, batched Subagents hook decoding, and durable task ledgers/checkpoints."
tags: [harness2, experience]
evidence_links:
  - ".harness/library/software-engineering/harnesses/task-stage14-grill-me-hardening/harness/manifest.json"
  - "src/context-resilience.mjs"
  - "src/rag-engine.mjs"
  - "src/secret-vault.mjs"
  - "src/model-hub.mjs"
  - "mcp/harness-rag-server.mjs"
  - "plugin/harness-ide/scripts/hooks/post-tool-use.mjs"
  - "sidecars/harness-ide-monitor/server.mjs"
  - "adapters/harness2_antigravity_executor.py"
  - "test/harness-ide.test.mjs"
---

# Gravity Well Harness Hardening: F01-F15 Public API Repair, Immutable Snapshot Blobs, Credential Origin Guards & Argon Context Resilience

## 1. What Task or Problem Produced This Lesson?
- **Task ID**: `task-stage14-grill-me-hardening`
- **Problem**: Resolve all 15 review findings (F01-F15) and implement Documents 01-04 (Public API Integration Repair, Gravity Well Default Operating Contract, and Gemini 4 Argon Context Resilience CTX-01..CTX-12).

## 2. Which Repository and Revision Did It Apply To?
- **Repository**: `Harness2-RAG-antigravity`
- **Git Revision**: `c619f9d`
- **Domain**: `software-engineering`

## 3. What Was Actually Observed?
All 13 automated test suites (covering F01-F15, REL-01..REL-12, and CTX-01..CTX-12) and 52-file AST/grammar checks pass with 0 errors and zero API key leakage.

## 4. Which Evidence Supports the Conclusion?
- `.harness/library/software-engineering/harnesses/task-stage14-grill-me-hardening/harness/manifest.json`
- `src/context-resilience.mjs`
- `src/rag-engine.mjs`
- `src/secret-vault.mjs`
- `src/model-hub.mjs`
- `mcp/harness-rag-server.mjs`
- `plugin/harness-ide/scripts/hooks/post-tool-use.mjs`
- `sidecars/harness-ide-monitor/server.mjs`
- `adapters/harness2_antigravity_executor.py`
- `test/harness-ide.test.mjs`

## 5. Is the Conclusion Still Current?
- **Status**: `active`
- **Recorded At**: `2026-11-07T21:41:07.545Z`
