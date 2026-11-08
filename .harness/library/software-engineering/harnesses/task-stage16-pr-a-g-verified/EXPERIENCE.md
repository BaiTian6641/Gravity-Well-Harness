---
docid: EXP-SOFT-TASK-STAGE16-PR--B3CFDA
title: "Stage 16 Verification Authority, Frozen Snapshot Query Blobs & Context Recovery Tokens (PRs A-G)"
collection: experiment-knowledge
domain: software-engineering
task_id: task-stage16-pr-a-g-verified
status: active
synthetic: false
receipt_id: RCPT-1794111597004-8F42F873
repo: Harness2-RAG-antigravity
git_revision: a9d2e21
created_at: "2026-11-08T04:19:57.083Z"
cue: "When verifying candidate harnesses or promoting lessons, bind 15-field HMAC receipts to lessonDigest and harnessDigest, isolate candidate workspaces, score snapshot queries from frozen blobs, and require recoveryToken on subagent recovery."
tags: [harness2, experience]
evidence_links:
  - ".harness/library/software-engineering/harnesses/task-stage16-pr-a-g-verified/harness/manifest.json"
  - "src/rag-engine.mjs"
  - "src/secret-vault.mjs"
  - "src/model-hub.mjs"
  - "src/context-resilience.mjs"
  - "mcp/harness-rag-server.mjs"
  - "plugin/harness-ide/scripts/mcp-entry.mjs"
  - "plugin/harness-ide/rules/gravity-well-default.md"
  - "sidecars/harness-ide-monitor/server.mjs"
  - "adapters/harness2_antigravity_executor.py"
  - "test/harness-ide.test.mjs"
  - ".harness/receipts/RCPT-1794111597004-8F42F873.json"
---

# Stage 16 Verification Authority, Frozen Snapshot Query Blobs & Context Recovery Tokens (PRs A-G)

## 1. What Task or Problem Produced This Lesson?
- **Task ID**: `task-stage16-pr-a-g-verified`
- **Problem**: Eliminate remaining verification authority bypasses, live-index leakage during snapshot queries, dangling symlink escapes, concurrent message-bus double invocations, unauthenticated recovery packet acks, and fabricated partial monitor telemetry.

## 2. Which Repository and Revision Did It Apply To?
- **Repository**: `Harness2-RAG-antigravity`
- **Git Revision**: `a9d2e21`
- **Domain**: `software-engineering`

## 3. What Was Actually Observed?
18/18 test suites pass; 15-field receipt signatures bind lessonDigest and harnessDigest; candidate workspaces are isolated per candidate; snapshot queries score directly from frozen blobs; dangling symlinks are rejected before existsSync; IN_FLIGHT message reservation prevents duplicate provider calls; recovery tokens and stale-revision checks guard subagent recovery.

## 4. Which Evidence Supports the Conclusion?
- `.harness/library/software-engineering/harnesses/task-stage16-pr-a-g-verified/harness/manifest.json`
- `src/rag-engine.mjs`
- `src/secret-vault.mjs`
- `src/model-hub.mjs`
- `src/context-resilience.mjs`
- `mcp/harness-rag-server.mjs`
- `plugin/harness-ide/scripts/mcp-entry.mjs`
- `plugin/harness-ide/rules/gravity-well-default.md`
- `sidecars/harness-ide-monitor/server.mjs`
- `adapters/harness2_antigravity_executor.py`
- `test/harness-ide.test.mjs`
- `.harness/receipts/RCPT-1794111597004-8F42F873.json`

## 5. Is the Conclusion Still Current?
- **Status**: `active`
- **Recorded At**: `2026-11-08T04:19:57.083Z`
