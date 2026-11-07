---
docid: EXP-SOFT-TASK-007-MULTI-M
title: "EXPERIENCE: Official DeepSeek V4-Pro/Flash (1M) + OpenCode Go Coding Plan + Multi-Engine Search Hub + Inline Context Usage & Self-Improving Swarm"
collection: experiment-knowledge
domain: software-engineering
task_id: task-007-multi-model-deepseek-opencode-go-search-and-rsi
status: active
repo: Harness2-RAG-antigravity
git_revision: 04028ca
created_at: "2026-11-07T05:30:28.865Z"
cue: "When orchestrating multi-model swarms across DeepSeek Official (deepseek-v4-pro / deepseek-flash 1M), OpenCode Go Coding Plan (opencode-go/grok-4.7, gpt-6-luna, claude-haiku-5-5, gemini-4-argon, kimi-k3.1-pro, kimi-k2.7-code, glm-5.3, mimo-v2.6-pro, minimax-m3.1-flash, qwen3.7-max, longcat-2.0, step-5-preview), and Antigravity Native models, remove demo formations so only the Current Workspace Agent Swarm is active, surface an always-visible inline Model + Reasoning Depth + Context Usage bar in the Antigravity UI, fuse web searches across DeepSeek Search (/v1/tools/search) + Parallel AI + Tavily + Free engines via RRF, and convey cross-model peer critiques over the Swarm Message Bus."
tags: [harness2, experience]
evidence_links:
  - ".harness/library/software-engineering/harnesses/task-007-multi-model-deepseek-opencode-go-search-and-rsi/harness/manifest.json"
  - "src/model-hub.mjs"
  - "mcp/harness-rag-server.mjs"
  - "sidecars/harness-ide-monitor/server.mjs"
  - "sidecars/harness-ide-monitor/ui/index.html"
  - "sidecars/harness-ide-monitor/ui/app.js"
  - "test/harness-ide.test.mjs"
---

# EXPERIENCE: Official DeepSeek V4-Pro/Flash (1M) + OpenCode Go Coding Plan + Multi-Engine Search Hub + Inline Context Usage & Self-Improving Swarm

## 1. What Task or Problem Produced This Lesson?
- **Task ID**: `task-007-multi-model-deepseek-opencode-go-search-and-rsi`
- **Problem**: Users needed (1) only the Current Workspace Agent Swarm (removing the 2 static demo formations), (2) latest 2026 DeepSeek Official API support (deepseek-v4-pro / DeepSeek-V4-Pro-0813 1M ctx, deepseek-flash / DeepSeek-V4.1-Flash-1017 1M Vision, /chat/completions, /responses, /anthropic, /v1/tools/search, reasoning_effort: none|low|high|max) with bidirectional subagent calling, (3) OpenCode Go Coding Plan support (opencode-go/* at https://opencode.ai/inference/go with x-opencode-session header), (4) Multi-Engine Web Search (DeepSeek Search, Parallel AI, Tavily, DuckDuckGo, Jina, Wikipedia, HN Algolia), (5) an always-visible model list with model name, reasoning depth, and inline context usage bar in the Antigravity UI, and (6) a solid self-improving multi-model cooperation harness with message injection and convey.

## 2. Which Repository and Revision Did It Apply To?
- **Repository**: `Harness2-RAG-antigravity`
- **Git Revision**: `04028ca`
- **Domain**: `software-engineering`

## 3. What Was Actually Observed?
Removing compact-verification and multi-stage-team left only live-harness2 (Current Workspace Agent Swarm). Implementing src/model-hub.mjs registered 22 models across DeepSeek Official, OpenCode Go Coding Plan, and Antigravity Native with explicit reasoningDepth (ECO/BALANCED/DEEP) mapped to reasoning_effort (none/low/high/max), live context window usage in the top inline strip (#inline-model-context-strip), bidirectional delegateToPeerModel subagent handoffs, 7-engine RRF web search, PreInvocation message bus injection, and recursive self-improvement cycles (8/8 integration tests passing).

## 4. Which Evidence Supports the Conclusion?
- `.harness/library/software-engineering/harnesses/task-007-multi-model-deepseek-opencode-go-search-and-rsi/harness/manifest.json`
- `src/model-hub.mjs`
- `mcp/harness-rag-server.mjs`
- `sidecars/harness-ide-monitor/server.mjs`
- `sidecars/harness-ide-monitor/ui/index.html`
- `sidecars/harness-ide-monitor/ui/app.js`
- `test/harness-ide.test.mjs`

## 5. Is the Conclusion Still Current?
- **Status**: `active`
- **Recorded At**: `2026-11-07T05:30:28.865Z`
