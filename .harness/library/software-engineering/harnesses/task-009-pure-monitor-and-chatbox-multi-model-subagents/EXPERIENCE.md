---
docid: EXP-SOFT-TASK-009-PURE-MO
title: "Pure Debugging & Preview Sidecar + Official Antigravity Chat Box Model Sync & Multi-Model Subagent Role Routing"
collection: experiment-knowledge
domain: software-engineering
task_id: task-009-pure-monitor-and-chatbox-multi-model-subagents
status: active
repo: Harness2-RAG-antigravity
git_revision: 380e7ef
created_at: "2026-11-07T06:45:46.795Z"
cue: "When integrating Gravity Well Harness into Antigravity IDE without reverse-engineering IDE internals, keep the Auxiliary Pane sidecar strictly as a read-only Debugging & Preview Monitor (Agent Swarm, Google Harness², Local RAG + Context DNA), sync the Main Agent model from official hook stdin (input.modelName + input.transcriptPath), and route spawned subagents to specialized assisting models (DeepSeek V4-Pro/Flash 1M, OpenCode Go opencode-go/*, or Antigravity tiers) via .vscode/settings.json."
tags: [harness2, experience]
evidence_links:
  - ".harness/library/software-engineering/harnesses/task-009-pure-monitor-and-chatbox-multi-model-subagents/harness/manifest.json"
  - "sidecars/harness-ide-monitor/ui/index.html"
  - "sidecars/harness-ide-monitor/ui/app.js"
  - "src/model-hub.mjs"
  - "plugin/harness-ide/scripts/hooks/session-start.mjs"
  - "plugin/harness-ide/scripts/hooks/pre-invocation.mjs"
  - "test/harness-ide.test.mjs"
---

# Pure Debugging & Preview Sidecar + Official Antigravity Chat Box Model Sync & Multi-Model Subagent Role Routing

## 1. What Task or Problem Produced This Lesson?
- **Task ID**: `task-009-pure-monitor-and-chatbox-multi-model-subagents`
- **Problem**: Having model selectors and mutation forms inside the Gravity Well Harness sidecar duplicated IDE controls, and relying on undocumented Language Server internals risked breaking across Antigravity IDE updates.

## 2. Which Repository and Revision Did It Apply To?
- **Repository**: `Harness2-RAG-antigravity`
- **Git Revision**: `380e7ef`
- **Domain**: `software-engineering`

## 3. What Was Actually Observed?
Removed all model selection dropdowns, message injection bars, and authoring forms from sidecars/harness-ide-monitor/ui/index.html and app.js so the sidecar is strictly a Pure Debugging & Preview Monitor across (1) Real Agent Network/Swarm, (2) Google Harness², and (3) Local RAG + Context DNA. Implemented syncChatBoxModelAndTranscript in src/model-hub.mjs to sync the official Antigravity chat box model (e.g. Gemini 4 Argon High) and real transcript.jsonl context usage, while mapping spawned subagent roles to assisting models via .vscode/settings.json and encrypting API keys in ~/.gemini/config/.secrets.vault.enc (AES-256-GCM). All 47 repo files pass AST/grammar checks and 8/8 automated tests pass.

## 4. Which Evidence Supports the Conclusion?
- `.harness/library/software-engineering/harnesses/task-009-pure-monitor-and-chatbox-multi-model-subagents/harness/manifest.json`
- `sidecars/harness-ide-monitor/ui/index.html`
- `sidecars/harness-ide-monitor/ui/app.js`
- `src/model-hub.mjs`
- `plugin/harness-ide/scripts/hooks/session-start.mjs`
- `plugin/harness-ide/scripts/hooks/pre-invocation.mjs`
- `test/harness-ide.test.mjs`

## 5. Is the Conclusion Still Current?
- **Status**: `active`
- **Recorded At**: `2026-11-07T06:45:46.795Z`
