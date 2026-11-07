---
docid: REF-MULTI-MODEL-RSI
title: "Reference: Self-Improving Multi-Model Agent Harness, DeepSeek Official (V4-Pro/V4.1-Flash), OpenCode Go & Multi-Engine Search"
collection: reference-knowledge
domain: architecture
status: active
git_revision: HEAD
created_at: 2026-11-07T05:12:00Z
tags: [deepseek, deepseek-v4-pro, deepseek-flash, opencode-go, parallel-search, tavily, self-improvement, harness2, meta-harness, message-injection]
---

# Self-Improving Multi-Model Agent Harness Architecture

$$\text{Agent} = \text{Base Model (Weights)} + \text{Self-Improving Harness}$$

## 1. DeepSeek Official API (`https://api-docs.deepseek.com/`)
- **Production Model Lineup & 1M Context Window**:
  - **`deepseek-v4-pro`** (Served by `DeepSeek-V4-Pro-0813`): **1M tokens** context length, up to **384K** max output tokens. Off-Peak: \$0.022/1M (Cache Hit), \$0.66/1M (Cache Miss), \$1.98/1M (Output); Peak: \$0.044/1M (Hit), \$1.32/1M (Miss), \$3.96/1M (Output).
  - **`deepseek-flash`** (Served by `DeepSeek-V4.1-Flash-1017`): **1M tokens** context length, up to **384K** max output tokens, **Text + Vision** multimodal input (JPEG, PNG, GIF, WebP). Off-Peak: \$0.003/1M (Cache Hit), \$0.15/1M (Cache Miss), \$0.60/1M (Output); Peak: \$0.006/1M (Hit), \$0.30/1M (Miss), \$1.20/1M (Output).
  - **Aliases**: `deepseek-reasoner` and `deepseek-chat`.
- **3 Official Generation Endpoints**:
  1. **Chat Completions API**: `https://api.deepseek.com/chat/completions`
  2. **Responses API**: `https://api.deepseek.com/responses` (OpenAI Responses API format for agentic workflows)
  3. **Anthropic (Messages) API**: `https://api.deepseek.com/anthropic` (`/v1/messages`; maps `claude-opus*` → `deepseek-v4-pro` and `claude-sonnet*`/`claude-haiku*` → `deepseek-flash`).
- **DeepSeek Native Web Search & Fetch API**:
  - **Search Endpoint**: `POST https://api.deepseek.com/v1/tools/search` (`{ query, count, ori_question, need_content: true }`)
  - **Fetch Endpoint**: `POST https://api.deepseek.com/v1/tools/fetch` (retrieves URL and converts page to Markdown; \$0.75 / 1,000 requests).
- **Thinking Mode & `reasoning_effort` Control**:
  - Supported effort levels: `none` (disables thinking), `low` (minimal/fast CoT), `high` (default standard CoT), and `max` (ultra/extended CoT).
  - Toggle via `extra_body: { thinking: { type: "enabled" | "disabled" } }` or `reasoning: { effort: "none" | "low" | "high" | "max" }`. Always pass `reasoning_content` back in multi-turn tool-calling histories.

## 2. OpenCode Go Coding Plan Integration (`opencode-go`)
- **Base URL & Wire-Protocol Translation Endpoints**:
  - OpenAI Chat Completions: `https://opencode.ai/inference/go/openai/v1/chat/completions`
  - OpenAI Responses API: `https://opencode.ai/inference/go/openai/v1/responses`
  - Anthropic Messages API: `https://opencode.ai/inference/go/anthropic/v1/messages` (used for `qwen3.7-max` & `claude-haiku-5-5`)
  - Google Gemini API: `https://opencode.ai/inference/go/google/v1beta/models/<model>:generateContent`
  - Live Model Catalog Discovery: `https://models.opencode.ai/api.json` & `GET /v1/models`
- **Authentication & Session Continuity**:
  - Runtime Provider ID: `opencode-go` (`OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY`)
  - Required session routing header: `x-opencode-session: ses_<workspace_hash>`
- **Full OpenCode Go Model Lineup (`opencode-go/<model>`)**:
  - **xAI**: `opencode-go/grok-4.7`, `opencode-go/grok-4.5`
  - **OpenAI Luna Series**: `opencode-go/gpt-6-luna`, `opencode-go/gpt-5.6-luna`
  - **Anthropic**: `opencode-go/claude-haiku-5-5` (1M context)
  - **Google**: `opencode-go/gemini-4-argon` (1M context)
  - **Moonshot AI (Kimi)**: `opencode-go/kimi-k3.1-pro`, `opencode-go/kimi-k3`, `opencode-go/kimi-k2.7-code`
  - **Z.AI (GLM)**: `opencode-go/glm-5.3`, `opencode-go/glm-5.3-flash`, `opencode-go/glm-5.2`
  - **Xiaomi MiMo**: `opencode-go/mimo-v2.6-pro`, `opencode-go/mimo-v2.6-flash`, `opencode-go/mimo-v2.5-pro`
  - **MiniMax**: `opencode-go/minimax-m3.1-flash`, `opencode-go/minimax-m3`
  - **Alibaba Qwen**: `opencode-go/qwen3.7-max`
  - **LongCat / StepFun / Muse**: `opencode-go/longcat-2.0`, `opencode-go/step-5-preview`, `opencode-go/muse-spark-1.3`

## 3. Unified Multi-Engine Web Search Hub
- **DeepSeek Official Search & Fetch** (`https://api.deepseek.com/v1/tools/search` & `/v1/tools/fetch`)
- **Parallel AI Search** (`https://search.parallel.ai/mcp` keyless MCP & `https://api.parallel.ai/v1beta/search`)
- **Tavily AI Search** (`https://api.tavily.com/search` & `https://mcp.tavily.com/mcp/`)
- **Free Zero-Key Search Engines**: DuckDuckGo Instant Answer API, Jina AI Search & Reader (`s.jina.ai` / `r.jina.ai`), Wikipedia Action API, and HackerNews Algolia Tech Search, fused via Reciprocal Rank Fusion (RRF).

## 4. Recursive Self-Improvement (RSI) & Multi-Model Swarm Cooperation
1. **Task-Level Recursion (`Propose -> Probe -> Compose`)**: Drafts two-front candidate harnesses (Invariant Guardrail Front + Domain-Specific RAG Front) and evaluates behavioral contrasts in isolated branched workspaces (`Workspace: "branch"`) under frozen RAG Snapshot Isolation.
2. **Mixture of Self-Improving Branches (Meta-Harness)**: Routes parallel candidate probes across heterogeneous model families (`deepseek-v4-pro`, `deepseek-flash`, `opencode-go/grok-4.7`, `opencode-go/gpt-6-luna`, `opencode-go/kimi-k2.7-code`, `opencode-go/glm-5.3`, `opencode-go/qwen3.7-max`).
3. **Runtime Message Injection & Convey Bus (`.harness/runtime/message-bus.json`)**: Injects `INJECT_DIRECTIVE`, `CONVEY_CONTEXT`, `PEER_CRITIQUE`, and `SELF_IMPROVE_CUE` messages directly into the active agent's `PreInvocation` stream (`injectSteps`) and across subagent nodes.
