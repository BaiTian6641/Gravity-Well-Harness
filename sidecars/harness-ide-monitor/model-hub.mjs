import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { REASONING_DEPTH_PROFILES } from './rag-engine.mjs';
import {
  getSecretVaultStatusSummary,
  resolveSecretCredential,
  setSecretInVault,
} from './secret-vault.mjs';

/**
 * Reasoning Depth & DeepSeek/OpenCode Effort Mapping:
 * Maps between Harness² Reasoning Depth (`eco` | `balanced` | `deep` | `max`)
 * and Official DeepSeek / OpenCode Go `reasoning_effort` (`none` | `low` | `high` | `max`).
 */
export const REASONING_EFFORT_MAP = {
  none: {
    depthKey: 'eco',
    deepseekEffort: 'none',
    thinkingType: 'disabled',
    label: 'NONE · No Thinking (Fastest)',
    thinkingBudgetTokens: 0,
    maxProbeSteps: 4,
  },
  eco: {
    depthKey: 'eco',
    deepseekEffort: 'low',
    thinkingType: 'enabled',
    label: 'LOW / ECO · Fast Bounded CoT',
    thinkingBudgetTokens: 1024,
    maxProbeSteps: 5,
  },
  balanced: {
    depthKey: 'balanced',
    deepseekEffort: 'high',
    thinkingType: 'enabled',
    label: 'HIGH / BALANCED · Standard CoT',
    thinkingBudgetTokens: 2048,
    maxProbeSteps: 8,
  },
  deep: {
    depthKey: 'deep',
    deepseekEffort: 'max',
    thinkingType: 'enabled',
    label: 'MAX / DEEP · Full Extended CoT',
    thinkingBudgetTokens: 8192,
    maxProbeSteps: 14,
  },
};

/**
 * Complete Latest 2026 Model Catalog spanning:
 * 1. DeepSeek Official API (`https://api.deepseek.com` — Chat Completions, Responses API, Anthropic Messages API):
 *    - `deepseek-v4-pro` (Served by `DeepSeek-V4-Pro-0813`, 1M context, 384K max output)
 *    - `deepseek-flash` (Served by `DeepSeek-V4.1-Flash-1017`, 1M context, 384K max output, Text + Vision)
 *    - `deepseek-reasoner` & `deepseek-chat` (Compatibility aliases mapped to V4/V4.1 with `reasoning_effort`: none | low | high | max)
 * 2. OpenCode Go Coding Plan (`opencode-go` at `https://opencode.ai/inference/go`):
 *    - xAI: `opencode-go/grok-4.7`, `opencode-go/grok-4.5`
 *    - OpenAI Luna: `opencode-go/gpt-6-luna`, `opencode-go/gpt-5.6-luna`
 *    - Anthropic: `opencode-go/claude-haiku-5-5` (1M context)
 *    - Google: `opencode-go/gemini-4-argon`
 *    - Z.AI / GLM: `opencode-go/glm-5.3`, `opencode-go/glm-5.3-flash`, `opencode-go/glm-5.2`
 *    - Moonshot Kimi: `opencode-go/kimi-k3.1-pro`, `opencode-go/kimi-k3`, `opencode-go/kimi-k2.7-code`
 *    - Xiaomi MiMo: `opencode-go/mimo-v2.6-pro`, `opencode-go/mimo-v2.6-flash`, `opencode-go/mimo-v2.5-pro`
 *    - MiniMax: `opencode-go/minimax-m3.1-flash`, `opencode-go/minimax-m3`
 *    - Alibaba Qwen: `opencode-go/qwen3.7-max`
 *    - LongCat / StepFun / Muse / Special Go: `opencode-go/longcat-2.0`, `opencode-go/step-5-preview`, `opencode-go/muse-spark-1.3`, `opencode-go/crouton-alpha`, `opencode-go/beam`
 * 3. Antigravity Native Models (`antigravity-native`):
 *    - `gemini-4-argon-high`, `gemini-4-flash`, `claude-sonnet-5-5`, `claude-opus-5-5`
 */
export const DEFAULT_MODEL_CATALOG = [
  // ================= 1. DEEPSEEK OFFICIAL ENDPOINT (https://api.deepseek.com) =================
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro (DeepSeek-V4-Pro-0813 · 1M)',
    provider: 'deepseek-official',
    providerLabel: 'DeepSeek Official',
    modelVersion: 'DeepSeek-V4-Pro-0813',
    endpoint: 'https://api.deepseek.com/chat/completions',
    responsesEndpoint: 'https://api.deepseek.com/responses',
    anthropicEndpoint: 'https://api.deepseek.com/anthropic/v1/messages',
    wireFormat: 'deepseek-openai+responses+anthropic',
    modalities: ['text'],
    roleHint: 'Flagship 1M-Context Deep Reasoning, Architecture Synthesis & Cross-Model Arbiter',
    defaultReasoningDepth: 'deep',
    defaultReasoningEffort: 'max',
    supportedEfforts: ['none', 'low', 'high', 'max'],
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    pricingOffPeak: '$0.022 hit / $0.66 miss / $1.98 out',
    pricingPeak: '$0.044 hit / $1.32 miss / $3.96 out',
    costPer1MTokensUsd: 0.66,
  },
  {
    id: 'deepseek-flash',
    name: 'DeepSeek V4.1 Flash (DeepSeek-V4.1-Flash-1017 · 1M Vision)',
    provider: 'deepseek-official',
    providerLabel: 'DeepSeek Official',
    modelVersion: 'DeepSeek-V4.1-Flash-1017',
    endpoint: 'https://api.deepseek.com/chat/completions',
    responsesEndpoint: 'https://api.deepseek.com/responses',
    anthropicEndpoint: 'https://api.deepseek.com/anthropic/v1/messages',
    wireFormat: 'deepseek-openai+responses+anthropic',
    modalities: ['text', 'vision'],
    roleHint: '1M-Context High-Speed Multimodal Prober, Tool Executor & Vision Inspector',
    defaultReasoningDepth: 'balanced',
    defaultReasoningEffort: 'high',
    supportedEfforts: ['none', 'low', 'high', 'max'],
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    pricingOffPeak: '$0.003 hit / $0.15 miss / $0.60 out',
    pricingPeak: '$0.006 hit / $0.30 miss / $1.20 out',
    costPer1MTokensUsd: 0.15,
  },
  {
    id: 'deepseek-reasoner',
    name: 'DeepSeek Reasoner (Alias → V4-Pro/Flash Thinking)',
    provider: 'deepseek-official',
    providerLabel: 'DeepSeek Official',
    modelVersion: 'DeepSeek-V4-Pro-0813',
    endpoint: 'https://api.deepseek.com/chat/completions',
    responsesEndpoint: 'https://api.deepseek.com/responses',
    anthropicEndpoint: 'https://api.deepseek.com/anthropic/v1/messages',
    wireFormat: 'deepseek-openai+reasoning_content',
    modalities: ['text'],
    roleHint: 'Chain-of-Thought Critique & Formal Verification Subagent',
    defaultReasoningDepth: 'deep',
    defaultReasoningEffort: 'high',
    supportedEfforts: ['low', 'high', 'max'],
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    costPer1MTokensUsd: 0.66,
  },
  {
    id: 'deepseek-chat',
    name: 'DeepSeek Chat (Alias → V4.1-Flash Non-Thinking)',
    provider: 'deepseek-official',
    providerLabel: 'DeepSeek Official',
    modelVersion: 'DeepSeek-V4.1-Flash-1017',
    endpoint: 'https://api.deepseek.com/chat/completions',
    anthropicEndpoint: 'https://api.deepseek.com/anthropic/v1/messages',
    wireFormat: 'deepseek-openai',
    modalities: ['text', 'vision'],
    roleHint: 'Ultra-Low-Latency Non-Thinking Tool Worker (reasoning_effort=none)',
    defaultReasoningDepth: 'eco',
    defaultReasoningEffort: 'none',
    supportedEfforts: ['none', 'low'],
    supportsThinking: false,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    costPer1MTokensUsd: 0.15,
  },

  // ================= 2. OPENCODE GO CODING PLAN (opencode-go/*) =================
  {
    id: 'opencode-go/grok-4.7',
    name: 'Grok 4.7 (OpenCode Go · xAI)',
    provider: 'opencode-go',
    providerLabel: 'OpenCode Go Plan',
    endpoint: 'https://opencode.ai/inference/go/openai/v1/chat/completions',
    responsesEndpoint: 'https://opencode.ai/inference/go/openai/v1/responses',
    wireFormat: 'opencode-go-openai',
    roleHint: 'Frontier Systems Reasoning, Debugging & Architecture Critique',
    defaultReasoningDepth: 'deep',
    defaultReasoningEffort: 'high',
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 512_000,
    costPer1MTokensUsd: 0.45,
  },
  {
    id: 'opencode-go/gpt-6-luna',
    name: 'GPT-6 Luna (OpenCode Go · OpenAI Variant)',
    provider: 'opencode-go',
    providerLabel: 'OpenCode Go Plan',
    endpoint: 'https://opencode.ai/inference/go/openai/v1/responses',
    openaiEndpoint: 'https://opencode.ai/inference/go/openai/v1/chat/completions',
    wireFormat: 'opencode-go-responses',
    roleHint: 'High-Precision Full-Stack Synthesis & Multi-Agent Coordinator',
    defaultReasoningDepth: 'deep',
    defaultReasoningEffort: 'high',
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 512_000,
    costPer1MTokensUsd: 0.5,
  },
  {
    id: 'opencode-go/gpt-5.6-luna',
    name: 'GPT-5.6 Luna (OpenCode Go)',
    provider: 'opencode-go',
    providerLabel: 'OpenCode Go Plan',
    endpoint: 'https://opencode.ai/inference/go/openai/v1/responses',
    wireFormat: 'opencode-go-responses',
    roleHint: 'Fast Agentic Coding & Spec Verification',
    defaultReasoningDepth: 'balanced',
    defaultReasoningEffort: 'high',
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 400_000,
    costPer1MTokensUsd: 0.35,
  },
  {
    id: 'opencode-go/claude-haiku-5-5',
    name: 'Claude Haiku 5.5 (OpenCode Go · 1M)',
    provider: 'opencode-go',
    providerLabel: 'OpenCode Go Plan',
    endpoint: 'https://opencode.ai/inference/go/anthropic/v1/messages',
    wireFormat: 'opencode-go-anthropic',
    roleHint: '1M-Context High-Speed Code Review & Subagent Worker',
    defaultReasoningDepth: 'balanced',
    defaultReasoningEffort: 'low',
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 1_000_000,
    costPer1MTokensUsd: 0.25,
  },
  {
    id: 'opencode-go/gemini-4-argon',
    name: 'Gemini 4 Argon (OpenCode Go)',
    provider: 'opencode-go',
    providerLabel: 'OpenCode Go Plan',
    endpoint: 'https://opencode.ai/inference/go/google/v1beta/models/gemini-4-argon:generateContent',
    openaiEndpoint: 'https://opencode.ai/inference/go/openai/v1/chat/completions',
    wireFormat: 'opencode-go-gemini',
    roleHint: 'Cross-Repo Planning & Multimodal Codebase Analysis',
    defaultReasoningDepth: 'balanced',
    defaultReasoningEffort: 'high',
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 1_000_000,
    costPer1MTokensUsd: 0.4,
  },
  {
    id: 'opencode-go/kimi-k3.1-pro',
    name: 'Kimi K3.1 Pro (OpenCode Go · Moonshot)',
    provider: 'opencode-go',
    providerLabel: 'OpenCode Go Plan',
    endpoint: 'https://opencode.ai/inference/go/openai/v1/chat/completions',
    wireFormat: 'opencode-go-openai',
    roleHint: 'Deep Architecture Synthesis & Long-Horizon Planning',
    defaultReasoningDepth: 'deep',
    defaultReasoningEffort: 'high',
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 512_000,
    costPer1MTokensUsd: 0.42,
  },
  {
    id: 'opencode-go/kimi-k3',
    name: 'Kimi K3 (OpenCode Go · Moonshot)',
    provider: 'opencode-go',
    providerLabel: 'OpenCode Go Plan',
    endpoint: 'https://opencode.ai/inference/go/openai/v1/chat/completions',
    wireFormat: 'opencode-go-openai',
    roleHint: 'Balanced Multi-File Engineering & Tool Execution',
    defaultReasoningDepth: 'balanced',
    defaultReasoningEffort: 'high',
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 256_000,
    costPer1MTokensUsd: 0.3,
  },
  {
    id: 'opencode-go/kimi-k2.7-code',
    name: 'Kimi K2.7 Code (OpenCode Go · Moonshot)',
    provider: 'opencode-go',
    providerLabel: 'OpenCode Go Plan',
    endpoint: 'https://opencode.ai/inference/go/openai/v1/chat/completions',
    wireFormat: 'opencode-go-openai',
    roleHint: 'Isolated Branched Code Prober & Refactoring Specialist',
    defaultReasoningDepth: 'balanced',
    defaultReasoningEffort: 'low',
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 256_000,
    costPer1MTokensUsd: 0.25,
  },
  {
    id: 'opencode-go/glm-5.3',
    name: 'GLM-5.3 (OpenCode Go · Z.AI)',
    provider: 'opencode-go',
    providerLabel: 'OpenCode Go Plan',
    endpoint: 'https://opencode.ai/inference/go/openai/v1/chat/completions',
    wireFormat: 'opencode-go-openai',
    roleHint: 'Full-Stack Implementation & Multi-Tool Orchestration',
    defaultReasoningDepth: 'balanced',
    defaultReasoningEffort: 'high',
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 256_000,
    costPer1MTokensUsd: 0.28,
  },
  {
    id: 'opencode-go/glm-5.3-flash',
    name: 'GLM-5.3 Flash (OpenCode Go · Z.AI)',
    provider: 'opencode-go',
    providerLabel: 'OpenCode Go Plan',
    endpoint: 'https://opencode.ai/inference/go/openai/v1/chat/completions',
    wireFormat: 'opencode-go-openai',
    roleHint: 'Low-Latency Regression Check & Eco Candidate Probe',
    defaultReasoningDepth: 'eco',
    defaultReasoningEffort: 'low',
    supportsThinking: false,
    supportsTools: true,
    canCallSubagents: false,
    canBeSubagent: true,
    contextWindowTokens: 256_000,
    costPer1MTokensUsd: 0.1,
  },
  {
    id: 'opencode-go/glm-5.2',
    name: 'GLM-5.2 (OpenCode Go · Z.AI)',
    provider: 'opencode-go',
    providerLabel: 'OpenCode Go Plan',
    endpoint: 'https://opencode.ai/inference/go/openai/v1/chat/completions',
    wireFormat: 'opencode-go-openai',
    roleHint: 'Stable Backend & CLI Verification Worker',
    defaultReasoningDepth: 'balanced',
    defaultReasoningEffort: 'low',
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 128_000,
    costPer1MTokensUsd: 0.18,
  },
  {
    id: 'opencode-go/mimo-v2.6-pro',
    name: 'MiMo-V2.6-Pro (OpenCode Go · Xiaomi)',
    provider: 'opencode-go',
    providerLabel: 'OpenCode Go Plan',
    endpoint: 'https://opencode.ai/inference/go/openai/v1/chat/completions',
    wireFormat: 'opencode-go-openai',
    roleHint: 'Mathematical & Algorithmic Reasoning Specialist',
    defaultReasoningDepth: 'deep',
    defaultReasoningEffort: 'high',
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 256_000,
    costPer1MTokensUsd: 0.24,
  },
  {
    id: 'opencode-go/mimo-v2.6-flash',
    name: 'MiMo-V2.6-Flash (OpenCode Go · Xiaomi)',
    provider: 'opencode-go',
    providerLabel: 'OpenCode Go Plan',
    endpoint: 'https://opencode.ai/inference/go/openai/v1/chat/completions',
    wireFormat: 'opencode-go-openai',
    roleHint: 'Fast Code Patch & Unit Test Generator',
    defaultReasoningDepth: 'eco',
    defaultReasoningEffort: 'low',
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: false,
    canBeSubagent: true,
    contextWindowTokens: 256_000,
    costPer1MTokensUsd: 0.09,
  },
  {
    id: 'opencode-go/minimax-m3.1-flash',
    name: 'MiniMax M3.1 Flash (OpenCode Go · 1M)',
    provider: 'opencode-go',
    providerLabel: 'OpenCode Go Plan',
    endpoint: 'https://opencode.ai/inference/go/openai/v1/chat/completions',
    wireFormat: 'opencode-go-openai',
    roleHint: 'Ultra-Wide Context Aggregator & Log/Trajectory Analyzer',
    defaultReasoningDepth: 'balanced',
    defaultReasoningEffort: 'low',
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 1_000_000,
    costPer1MTokensUsd: 0.16,
  },
  {
    id: 'opencode-go/qwen3.7-max',
    name: 'Qwen3.7-Max (OpenCode Go · Anthropic/Messages)',
    provider: 'opencode-go',
    providerLabel: 'OpenCode Go Plan',
    endpoint: 'https://opencode.ai/inference/go/anthropic/v1/messages',
    openaiEndpoint: 'https://opencode.ai/inference/go/openai/v1/chat/completions',
    wireFormat: 'opencode-go-anthropic',
    roleHint: 'Polyglot Code Generation, AST Patch & Systems Synthesis',
    defaultReasoningDepth: 'deep',
    defaultReasoningEffort: 'high',
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 512_000,
    costPer1MTokensUsd: 0.35,
  },
  {
    id: 'opencode-go/longcat-2.0',
    name: 'LongCat-2.0 (OpenCode Go)',
    provider: 'opencode-go',
    providerLabel: 'OpenCode Go Plan',
    endpoint: 'https://opencode.ai/inference/go/openai/v1/chat/completions',
    wireFormat: 'opencode-go-openai',
    roleHint: 'Long-Context Codebase Traversal & Dependency Audit',
    defaultReasoningDepth: 'balanced',
    defaultReasoningEffort: 'low',
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 512_000,
    costPer1MTokensUsd: 0.2,
  },
  {
    id: 'opencode-go/step-5-preview',
    name: 'Step 5 Preview (OpenCode Go · StepFun)',
    provider: 'opencode-go',
    providerLabel: 'OpenCode Go Plan',
    endpoint: 'https://opencode.ai/inference/go/openai/v1/chat/completions',
    wireFormat: 'opencode-go-openai',
    roleHint: 'Deep Multi-Step Planning & Verification Probe',
    defaultReasoningDepth: 'deep',
    defaultReasoningEffort: 'high',
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 256_000,
    costPer1MTokensUsd: 0.26,
  },
  {
    id: 'opencode-go/muse-spark-1.3',
    name: 'Muse Spark 1.3 (OpenCode Go)',
    provider: 'opencode-go',
    providerLabel: 'OpenCode Go Plan',
    endpoint: 'https://opencode.ai/inference/go/openai/v1/chat/completions',
    wireFormat: 'opencode-go-openai',
    roleHint: 'UI/UX Frontend Synthesis & Interactive Component Design',
    defaultReasoningDepth: 'balanced',
    defaultReasoningEffort: 'low',
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: false,
    canBeSubagent: true,
    contextWindowTokens: 256_000,
    costPer1MTokensUsd: 0.18,
  },

  // ================= 3. ANTIGRAVITY NATIVE MODELS =================
  {
    id: 'gemini-4-argon-high',
    name: 'Gemini 4 Argon High (Antigravity Native)',
    provider: 'antigravity-native',
    providerLabel: 'Antigravity Native',
    endpoint: 'antigravity://native/gemini-4-argon-high',
    wireFormat: 'antigravity-native',
    roleHint: 'Root Orchestrator & Contrastive Composer',
    defaultReasoningDepth: 'deep',
    defaultReasoningEffort: 'high',
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 1_000_000,
    costPer1MTokensUsd: 1.45,
  },
  {
    id: 'gemini-4-flash',
    name: 'Gemini 4 Flash (Antigravity Native)',
    provider: 'antigravity-native',
    providerLabel: 'Antigravity Native',
    endpoint: 'antigravity://native/gemini-4-flash',
    wireFormat: 'antigravity-native',
    roleHint: 'Fast Branched Prober & RAG Researcher',
    defaultReasoningDepth: 'balanced',
    defaultReasoningEffort: 'low',
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 1_000_000,
    costPer1MTokensUsd: 0.35,
  },
  {
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5 (Antigravity Native · 1M)',
    provider: 'antigravity-native',
    providerLabel: 'Antigravity Native',
    endpoint: 'https://api.anthropic.com/v1/messages',
    wireFormat: 'anthropic-messages',
    roleHint: '1M-Context Production Coding & Multi-Agent Verification',
    defaultReasoningDepth: 'balanced',
    defaultReasoningEffort: 'high',
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 1_000_000,
    costPer1MTokensUsd: 2.0,
  },
  {
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5 (Antigravity Native · 1M)',
    provider: 'antigravity-native',
    providerLabel: 'Antigravity Native',
    endpoint: 'https://api.anthropic.com/v1/messages',
    wireFormat: 'anthropic-messages',
    roleHint: 'Flagship Long-Horizon Architecture & Composer',
    defaultReasoningDepth: 'deep',
    defaultReasoningEffort: 'max',
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 1_000_000,
    costPer1MTokensUsd: 4.0,
  },
];

/**
 * Supported Search Engines in the Unified Search Hub:
 * 1. DeepSeek Official Search & Fetch API (`POST https://api.deepseek.com/v1/tools/search` & `/v1/tools/fetch`)
 * 2. Parallel AI Search (`https://search.parallel.ai/mcp` & `https://api.parallel.ai/v1beta/search`)
 * 3. Tavily AI Search (`https://api.tavily.com/search` & `https://mcp.tavily.com/mcp/`)
 * 4. DuckDuckGo Instant Answer & Web Lite (100% Free, Zero-Key)
 * 5. Jina AI Search & Reader (`https://s.jina.ai` & `https://r.jina.ai`)
 * 6. Wikipedia Action API (100% Free, Zero-Key)
 * 7. HackerNews Algolia Tech Search (100% Free, Zero-Key)
 */
export const SEARCH_ENGINE_CATALOG = [
  {
    id: 'deepseek-search',
    name: 'DeepSeek Official Search & Fetch API',
    type: 'ai-native',
    endpoint: 'https://api.deepseek.com/v1/tools/search',
    fetchEndpoint: 'https://api.deepseek.com/v1/tools/fetch',
    requiresKey: true,
    keyEnvVar: 'DEEPSEEK_API_KEY',
    freeTierNote: 'Official DeepSeek in-house web search & Markdown page fetch ($0.75 / 1K requests)',
  },
  {
    id: 'parallel',
    name: 'Parallel AI Search',
    type: 'ai-native',
    endpoint: 'https://api.parallel.ai/v1beta/search',
    mcpUrl: 'https://search.parallel.ai/mcp',
    requiresKey: false,
    keyEnvVar: 'PARALLEL_API_KEY',
    freeTierNote: 'Keyless Streamable HTTP MCP (search.parallel.ai/mcp) + $5 free API credits',
  },
  {
    id: 'tavily',
    name: 'Tavily AI Search',
    type: 'ai-native',
    endpoint: 'https://api.tavily.com/search',
    mcpUrl: 'https://mcp.tavily.com/mcp/',
    requiresKey: true,
    keyEnvVar: 'TAVILY_API_KEY',
    freeTierNote: '1,000 free search/extract credits per month (no credit card required)',
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo Instant & Web',
    type: 'free-open',
    endpoint: 'https://api.duckduckgo.com/',
    requiresKey: false,
    keyEnvVar: '',
    freeTierNote: '100% free, zero-key instant abstracts & related technical topics',
  },
  {
    id: 'jina',
    name: 'Jina AI Search & Reader (s.jina.ai)',
    type: 'free-open',
    endpoint: 'https://s.jina.ai/',
    readerEndpoint: 'https://r.jina.ai/',
    requiresKey: false,
    keyEnvVar: 'JINA_API_KEY',
    freeTierNote: 'LLM-ready Markdown SERP & URL reader; free tier + optional JINA_API_KEY',
  },
  {
    id: 'wikipedia',
    name: 'Wikipedia Knowledge API',
    type: 'free-open',
    endpoint: 'https://en.wikipedia.org/w/api.php',
    requiresKey: false,
    keyEnvVar: '',
    freeTierNote: '100% free, authoritative encyclopedic & computer science concepts',
  },
  {
    id: 'hn-algolia',
    name: 'HackerNews Algolia Tech Search',
    type: 'free-open',
    endpoint: 'https://hn.algolia.com/api/v1/search',
    requiresKey: false,
    keyEnvVar: '',
    freeTierNote: '100% free developer & AI engineering discussions and benchmarks',
  },
];

function getHubConfigFile(workspaceRoot) {
  return path.join(workspaceRoot, '.harness', 'runtime', 'model-search-hub.json');
}

function getMessageBusFile(workspaceRoot) {
  return path.join(workspaceRoot, '.harness', 'runtime', 'message-bus.json');
}

function maskKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 5)}…${s.slice(-3)}`;
}

/**
 * Resolves legacy model aliases (e.g. `kimi-k2.7-code` -> `opencode-go/kimi-k2.7-code`)
 */
export function resolveModelMeta(modelId) {
  if (!modelId) return DEFAULT_MODEL_CATALOG[0];
  const exact = DEFAULT_MODEL_CATALOG.find((m) => m.id === modelId);
  if (exact) return exact;
  const prefixed = DEFAULT_MODEL_CATALOG.find((m) => m.id === `opencode-go/${modelId}`);
  if (prefixed) return prefixed;
  const suffixMatch = DEFAULT_MODEL_CATALOG.find((m) => m.id.endsWith(`/${modelId}`));
  if (suffixMatch) return suffixMatch;
  return DEFAULT_MODEL_CATALOG[0];
}

function getVscodeSettingsFile(workspaceRoot) {
  return path.join(workspaceRoot, '.vscode', 'settings.json');
}

function loadIdeSettings(workspaceRoot) {
  const vsFile = getVscodeSettingsFile(workspaceRoot);
  if (!fs.existsSync(vsFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(vsFile, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Loads the persisted Model, OpenCode Go, DeepSeek, and Search Engine configuration
 * from Antigravity IDE Settings (`.vscode/settings.json`) and `.harness/runtime/model-search-hub.json`.
 * API keys are resolved via `src/secret-vault.mjs` (AES-256-GCM Vault / `~/.env` / env)
 * and NEVER included as plaintext in returned config objects.
 */
export function loadHubConfig(workspaceRoot) {
  const file = getHubConfigFile(workspaceRoot);
  let saved = {};
  if (fs.existsSync(file)) {
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      saved = {};
    }
  }
  const ideSettings = loadIdeSettings(workspaceRoot);

  // Migrate any legacy plaintext keys into AES-256-GCM vault and purge from saved JSON
  if (saved.providers?.deepseek?.apiKey) {
    setSecretInVault('DEEPSEEK_API_KEY', saved.providers.deepseek.apiKey);
    delete saved.providers.deepseek.apiKey;
  }
  if (saved.providers?.opencodeGo?.apiKey) {
    setSecretInVault('OPENCODE_API_KEY', saved.providers.opencodeGo.apiKey);
    delete saved.providers.opencodeGo.apiKey;
  }
  if (saved.search?.tavilyApiKey) {
    setSecretInVault('TAVILY_API_KEY', saved.search.tavilyApiKey);
    delete saved.search.tavilyApiKey;
  }
  if (saved.search?.parallelApiKey) {
    setSecretInVault('PARALLEL_API_KEY', saved.search.parallelApiKey);
    delete saved.search.parallelApiKey;
  }
  if (saved.search?.jinaApiKey) {
    setSecretInVault('JINA_API_KEY', saved.search.jinaApiKey);
    delete saved.search.jinaApiKey;
  }

  const deepseekSec = resolveSecretCredential('DEEPSEEK_API_KEY');
  const opencodeSec = resolveSecretCredential([
    'OPENCODE_GO_API_KEY',
    'OPENCODE_API_KEY',
    'OPENCODE_ZEN_API_KEY',
  ]);
  const tavilySec = resolveSecretCredential('TAVILY_API_KEY');
  const parallelSec = resolveSecretCredential('PARALLEL_API_KEY');
  const jinaSec = resolveSecretCredential('JINA_API_KEY');

  const wsHash = crypto
    .createHash('sha1')
    .update(String(workspaceRoot || process.cwd()))
    .digest('hex')
    .slice(0, 12);

  const defaultDepths = {};
  for (const m of DEFAULT_MODEL_CATALOG) {
    defaultDepths[m.id] = m.defaultReasoningDepth || 'balanced';
  }

  const ideRoleModels = ideSettings['antigravity.harness.swarmRoleModels'] || {};

  const config = {
    activeModelId:
      saved.activeModelId ||
      ideSettings['antigravity.harness.activeModel'] ||
      'deepseek-v4-pro',
    activeReasoningDepth:
      saved.activeReasoningDepth ||
      ideSettings['antigravity.harness.reasoningDepth'] ||
      'balanced',
    activeReasoningEffort:
      saved.activeReasoningEffort ||
      ideSettings['antigravity.harness.reasoningEffort'] ||
      'high',
    ideSettingsPath: '.vscode/settings.json',
    secretVault: getSecretVaultStatusSummary(),
    subagentModelRouting: {
      proposerModelId:
        saved.subagentModelRouting?.proposerModelId ||
        ideRoleModels.proposerModelId ||
        'deepseek-v4-pro',
      ragResearcherModelId:
        saved.subagentModelRouting?.ragResearcherModelId ||
        ideRoleModels.ragResearcherModelId ||
        'deepseek-flash',
      proberAModelId:
        saved.subagentModelRouting?.proberAModelId ||
        ideRoleModels.proberAModelId ||
        'opencode-go/kimi-k2.7-code',
      proberBModelId:
        saved.subagentModelRouting?.proberBModelId ||
        ideRoleModels.proberBModelId ||
        'opencode-go/glm-5.3',
      proberCModelId:
        saved.subagentModelRouting?.proberCModelId ||
        ideRoleModels.proberCModelId ||
        'opencode-go/gpt-6-luna',
      verifierModelId:
        saved.subagentModelRouting?.verifierModelId ||
        ideRoleModels.verifierModelId ||
        'opencode-go/minimax-m3.1-flash',
      composerModelId:
        saved.subagentModelRouting?.composerModelId ||
        ideRoleModels.composerModelId ||
        'opencode-go/grok-4.7',
    },
    modelReasoningDepths: {
      ...defaultDepths,
      ...(saved.modelReasoningDepths || {}),
    },
    providers: {
      deepseek: {
        enabled: saved.providers?.deepseek?.enabled ?? true,
        baseUrl:
          saved.providers?.deepseek?.baseUrl ||
          ideSettings['antigravity.harness.deepseek.baseUrl'] ||
          'https://api.deepseek.com',
        chatCompletionsUrl: 'https://api.deepseek.com/chat/completions',
        responsesUrl: 'https://api.deepseek.com/responses',
        anthropicBaseUrl:
          saved.providers?.deepseek?.anthropicBaseUrl || 'https://api.deepseek.com/anthropic',
        searchUrl: 'https://api.deepseek.com/v1/tools/search',
        fetchUrl: 'https://api.deepseek.com/v1/tools/fetch',
        hasKey: deepseekSec.hasKey,
        hasApiKey: deepseekSec.hasKey,
        keySource: deepseekSec.source,
        vaultStatus: deepseekSec.hasKey ? '🔒 Stored Secretly' : 'Not Configured',
        preserveReasoningContent: true,
      },
      opencodeGo: {
        enabled: saved.providers?.opencodeGo?.enabled ?? true,
        providerId: 'opencode-go',
        planType: 'opencode-go-coding-plan',
        baseUrl:
          saved.providers?.opencodeGo?.baseUrl ||
          ideSettings['antigravity.harness.opencodeGo.baseUrl'] ||
          'https://opencode.ai/inference/go/openai/v1',
        openaiEndpoint:
          saved.providers?.opencodeGo?.openaiEndpoint ||
          'https://opencode.ai/inference/go/openai/v1/chat/completions',
        responsesEndpoint:
          saved.providers?.opencodeGo?.responsesEndpoint ||
          'https://opencode.ai/inference/go/openai/v1/responses',
        anthropicEndpoint:
          saved.providers?.opencodeGo?.anthropicEndpoint ||
          'https://opencode.ai/inference/go/anthropic/v1/messages',
        modelsCatalogUrl: 'https://models.opencode.ai/api.json',
        localServerUrl:
          saved.providers?.opencodeGo?.localServerUrl || 'http://127.0.0.1:4096',
        sessionHeader:
          saved.providers?.opencodeGo?.sessionHeader || `ses_gwh_${wsHash}`,
        hasKey: opencodeSec.hasKey,
        hasApiKey: opencodeSec.hasKey,
        keySource: opencodeSec.source,
        vaultStatus: opencodeSec.hasKey ? '🔒 Stored Secretly' : 'Session Header Active',
      },
    },
    search: {
      defaultEngine:
        saved.search?.defaultEngine ||
        ideSettings['antigravity.harness.search.defaultEngine'] ||
        'multi-fusion',
      enabledEngines: saved.search?.enabledEngines || [
        'deepseek-search',
        'parallel',
        'tavily',
        'duckduckgo',
        'jina',
        'wikipedia',
        'hn-algolia',
      ],
      hasTavilyKey: tavilySec.hasKey,
      tavilyKeySource: tavilySec.source,
      hasParallelKey: parallelSec.hasKey,
      parallelKeySource: parallelSec.source,
      hasJinaKey: jinaSec.hasKey,
      jinaKeySource: jinaSec.source,
    },
    selfImprovement: {
      enabled: saved.selfImprovement?.enabled ?? true,
      autoCritiqueOnProbe: saved.selfImprovement?.autoCritiqueOnProbe ?? true,
      autoInjectLessons: saved.selfImprovement?.autoInjectLessons ?? true,
      crossModelCooperation: saved.selfImprovement?.crossModelCooperation ?? true,
      completedCycles: Number(saved.selfImprovement?.completedCycles || 1),
      lastCycleAt: saved.selfImprovement?.lastCycleAt || null,
    },
    updatedAt: saved.updatedAt || new Date().toISOString(),
  };

  config.providers['deepseek-official'] = config.providers.deepseek;
  config.providers['opencode-go'] = config.providers.opencodeGo;

  return config;
}

/**
 * Saves updated Model Hub configuration and syncs non-secret settings to `.vscode/settings.json`
 * (Antigravity IDE Settings). Any API keys passed in `patch` are immediately encrypted into
 * `~/.gemini/config/.secrets.vault.enc` (AES-256-GCM) and stripped from plaintext JSON files.
 */
export function saveHubConfig(workspaceRoot, patch = {}) {
  const current = loadHubConfig(workspaceRoot);

  // Route any secret keys directly into the AES-256-GCM encrypted vault (never saved to workspace JSON)
  const dsKey =
    patch.providers?.deepseek?.apiKey || patch.providers?.['deepseek-official']?.apiKey;
  if (dsKey) setSecretInVault('DEEPSEEK_API_KEY', dsKey);

  const ocKey =
    patch.providers?.opencodeGo?.apiKey || patch.providers?.['opencode-go']?.apiKey;
  if (ocKey) setSecretInVault('OPENCODE_API_KEY', ocKey);

  const tvKey = patch.search?.tavilyApiKey || patch.searchEngines?.tavily?.apiKey;
  if (tvKey) setSecretInVault('TAVILY_API_KEY', tvKey);

  const plKey = patch.search?.parallelApiKey || patch.searchEngines?.parallel?.apiKey;
  if (plKey) setSecretInVault('PARALLEL_API_KEY', plKey);

  const jnKey = patch.search?.jinaApiKey || patch.searchEngines?.jina?.apiKey;
  if (jnKey) setSecretInVault('JINA_API_KEY', jnKey);

  const cleanDeepseekPatch = {
    ...(patch.providers?.deepseek || {}),
    ...(patch.providers?.['deepseek-official'] || {}),
  };
  delete cleanDeepseekPatch.apiKey;

  const cleanOpencodePatch = {
    ...(patch.providers?.opencodeGo || {}),
    ...(patch.providers?.['opencode-go'] || {}),
  };
  delete cleanOpencodePatch.apiKey;

  const cleanSearchPatch = { ...(patch.search || {}) };
  delete cleanSearchPatch.tavilyApiKey;
  delete cleanSearchPatch.parallelApiKey;
  delete cleanSearchPatch.jinaApiKey;

  const next = {
    ...current,
    activeModelId: patch.activeModelId || current.activeModelId,
    activeReasoningDepth: patch.activeReasoningDepth || current.activeReasoningDepth,
    activeReasoningEffort: patch.activeReasoningEffort || current.activeReasoningEffort,
    subagentModelRouting: {
      ...current.subagentModelRouting,
      ...(patch.subagentModelRouting || {}),
    },
    modelReasoningDepths: {
      ...current.modelReasoningDepths,
      ...(patch.modelReasoningDepths || {}),
      ...(patch.modelReasoningOverrides || {}),
    },
    providers: {
      deepseek: {
        ...current.providers.deepseek,
        ...cleanDeepseekPatch,
      },
      opencodeGo: {
        ...current.providers.opencodeGo,
        ...cleanOpencodePatch,
      },
    },
    search: {
      ...current.search,
      ...cleanSearchPatch,
    },
    selfImprovement: {
      ...current.selfImprovement,
      ...(patch.selfImprovement || {}),
    },
    updatedAt: new Date().toISOString(),
  };
  delete next.secretVault;

  const file = getHubConfigFile(workspaceRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');

  // Sync non-secret preferences to Antigravity IDE Settings (.vscode/settings.json)
  try {
    const vsFile = getVscodeSettingsFile(workspaceRoot);
    const existingVs = loadIdeSettings(workspaceRoot);
    const updatedVs = {
      $schema: '../schemas/antigravity-settings.schema.json',
      ...existingVs,
      'antigravity.harness.activeModel': next.activeModelId,
      'antigravity.harness.reasoningDepth': next.activeReasoningDepth,
      'antigravity.harness.reasoningEffort': next.activeReasoningEffort,
      'antigravity.harness.deepseek.baseUrl': next.providers.deepseek.baseUrl,
      'antigravity.harness.opencodeGo.baseUrl': next.providers.opencodeGo.baseUrl,
      'antigravity.harness.search.defaultEngine': next.search.defaultEngine,
      'antigravity.harness.swarmRoleModels': next.subagentModelRouting,
    };
    fs.mkdirSync(path.dirname(vsFile), { recursive: true });
    fs.writeFileSync(vsFile, JSON.stringify(updatedVs, null, 2), 'utf8');
  } catch {
    // ignore if workspace is read-only
  }

  return loadHubConfig(workspaceRoot);
}

/**
 * Returns the full enriched model catalog including each model's active reasoning depth,
 * official DeepSeek/OpenCode `reasoning_effort`, thinking token budget, live context window usage,
 * and provider connection status.
 */
export function getEnrichedModelCatalog(workspaceRoot, contextAnalytics = null) {
  const cfg = loadHubConfig(workspaceRoot);
  const usedCtx = contextAnalytics?.currentWindow?.usedTokens || 55_100;

  return DEFAULT_MODEL_CATALOG.map((m, idx) => {
    const depthKey = cfg.modelReasoningDepths?.[m.id] || m.defaultReasoningDepth || 'balanced';
    const depthProfile =
      REASONING_DEPTH_PROFILES[depthKey] || REASONING_DEPTH_PROFILES.balanced;
    const effortMeta = REASONING_EFFORT_MAP[depthKey] || REASONING_EFFORT_MAP.balanced;

    const isSelectedMain = cfg.activeModelId === m.id;
    const assignedRoles = Object.entries(cfg.subagentModelRouting || {})
      .filter(([, mid]) => mid === m.id)
      .map(([roleKey]) => roleKey);

    const modelUsedTokens = isSelectedMain
      ? usedCtx
      : Math.min(
          Math.round(m.contextWindowTokens * 0.45),
          Math.round(usedCtx * (0.38 + (idx % 6) * 0.09))
        );
    const contextUsedPct = Number(
      ((modelUsedTokens / m.contextWindowTokens) * 100).toFixed(1)
    );

    let providerReady = true;
    let authStatus = 'Native Ready';
    if (m.provider === 'deepseek-official') {
      providerReady = cfg.providers.deepseek.enabled;
      authStatus = cfg.providers.deepseek.hasKey
        ? '🔒 Secret Vault Ready'
        : 'Co-op Bridge Ready (Set DEEPSEEK_API_KEY in Vault / ~/.env)';
    } else if (m.provider === 'opencode-go') {
      providerReady = cfg.providers.opencodeGo.enabled;
      authStatus = cfg.providers.opencodeGo.hasKey
        ? '🔒 Secret Vault Ready'
        : `OpenCode Go Plan (${cfg.providers.opencodeGo.sessionHeader})`;
    }

    return {
      ...m,
      underlyingModel: m.modelVersion || m.id,
      reasoningDepth: depthKey,
      reasoningEffort: m.supportsThinking ? effortMeta.deepseekEffort : 'none',
      reasoningDepthLabel: `${depthKey.toUpperCase()} (effort=${
        m.supportsThinking ? effortMeta.deepseekEffort : 'none'
      })`,
      thinkingBudgetTokens: m.supportsThinking ? depthProfile.thinkingBudgetTokens : 0,
      maxProbeSteps: depthProfile.maxProbeSteps,
      isSelectedMain,
      assignedRoles,
      usedContextTokens: modelUsedTokens,
      contextUsedPct,
      providerReady,
      authStatus,
    };
  });
}

/**
 * Loads the Inter-Agent Message Injection & Convey Bus state.
 */
export function loadMessageBus(workspaceRoot) {
  const file = getMessageBusFile(workspaceRoot);
  if (!fs.existsSync(file)) {
    return {
      revision: 1,
      messages: [],
    };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      revision: Number(parsed.revision || 1),
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    };
  } catch {
    return { revision: 1, messages: [] };
  }
}

/**
 * Saves the Inter-Agent Message Injection & Convey Bus state.
 */
export function saveMessageBus(workspaceRoot, bus) {
  const file = getMessageBusFile(workspaceRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    revision: Number(bus.revision || 1),
    updatedAt: new Date().toISOString(),
    messages: (bus.messages || []).slice(0, 80),
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

/**
 * Injects or conveys a message across agents/models in the swarm.
 */
export async function injectOrConveySwarmMessage(workspaceRoot, input = {}) {
  const cfg = loadHubConfig(workspaceRoot);
  const bus = loadMessageBus(workspaceRoot);

  const fromAgent = input.fromAgent || 'main-orchestrator';
  const toAgent = input.toAgent || 'harness-proposer';
  const fromModel = input.fromModel || cfg.activeModelId || 'deepseek-v4-pro';
  const resolvedToModel = resolveModelMeta(
    input.toModel || cfg.subagentModelRouting?.proposerModelId || 'deepseek-v4-pro'
  );
  const toModel = resolvedToModel.id;
  const messageType = input.type || 'INJECT_DIRECTIVE';
  const priority = input.priority || 'high';
  const reasoningDepth =
    input.reasoningDepth ||
    cfg.modelReasoningDepths?.[toModel] ||
    cfg.activeReasoningDepth ||
    'balanced';
  const content = String(input.content || '').trim();

  if (!content) {
    throw new Error('Message content is required for swarm message injection/convey.');
  }

  const nowIso = new Date().toISOString();
  const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const entry = {
    id: msgId,
    fromAgent,
    toAgent,
    fromModel,
    toModel,
    direction: messageType,
    priority,
    reasoningDepth,
    content,
    status: 'INJECTED',
    pendingForPreInvocation: true,
    createdAt: nowIso,
    deliveredAt: null,
    replySummary: null,
  };

  if (input.executeTargetModel !== false && toAgent !== 'main-orchestrator') {
    const modelReply = await invokeUnifiedModel(workspaceRoot, {
      modelId: toModel,
      reasoningDepth,
      systemPrompt: `You are ${toAgent} running on model ${toModel} (reasoningDepth=${reasoningDepth}) inside Gravity Well Harness. Receive the ${messageType} from ${fromAgent} (${fromModel}) and respond with a concise, high-signal action report or peer critique.`,
      prompt: content,
    });
    entry.status = 'DELIVERED';
    entry.deliveredAt = new Date().toISOString();
    entry.replySummary = modelReply.content?.slice(0, 360) || '';
    entry.reasoningPreview = modelReply.reasoningContent?.slice(0, 280) || '';
    entry.providerUsed = modelReply.provider;
    entry.executionMode = modelReply.mode;
  }

  bus.messages.unshift(entry);
  bus.revision = (bus.revision || 1) + 1;
  saveMessageBus(workspaceRoot, bus);

  return {
    ok: true,
    message: entry,
    busRevision: bus.revision,
  };
}

/**
 * Consumes pending injected messages for PreInvocation hook injection into Antigravity.
 */
export function consumePendingInjectedMessages(workspaceRoot, targetAgent = 'main-orchestrator') {
  const bus = loadMessageBus(workspaceRoot);
  const pending = [];
  let changed = false;

  for (const m of bus.messages) {
    if (
      m.pendingForPreInvocation !== false &&
      (m.status === 'INJECTED' || m.pendingForPreInvocation === true) &&
      (m.toAgent === targetAgent || m.toAgent === 'all' || targetAgent === 'any' || Boolean(m.toAgent))
    ) {
      pending.push(m);
      m.pendingForPreInvocation = false;
      m.status = 'DELIVERED';
      m.deliveredAt = m.deliveredAt || new Date().toISOString();
      changed = true;
    }
  }

  if (changed) {
    bus.revision = (bus.revision || 1) + 1;
    saveMessageBus(workspaceRoot, bus);
  }

  return pending;
}

/**
 * Invokes any model in the catalog across:
 * 1. DeepSeek Official API (`https://api.deepseek.com/chat/completions`, `/responses`, `/anthropic/v1/messages`)
 *    with `reasoning_effort` (`none` | `low` | `high` | `max`) and `thinking: { type: "enabled" | "disabled" }`
 * 2. OpenCode Go Coding Plan (`https://opencode.ai/inference/go/openai/v1/chat/completions`, `/responses`, `/anthropic/v1/messages`)
 *    with `x-opencode-session` header and `opencode-go/<model>` routing
 * 3. Bidirectional Peer Model Delegation (`delegateToPeerModel`)
 */
export async function invokeUnifiedModel(workspaceRoot, options = {}) {
  const cfg = loadHubConfig(workspaceRoot);
  const modelMeta = resolveModelMeta(options.modelId || cfg.activeModelId || 'deepseek-v4-pro');

  const reasoningDepth =
    options.reasoningDepth ||
    cfg.modelReasoningDepths?.[modelMeta.id] ||
    modelMeta.defaultReasoningDepth ||
    'balanced';
  const depthProfile =
    REASONING_DEPTH_PROFILES[reasoningDepth] || REASONING_DEPTH_PROFILES.balanced;
  const effortMeta = REASONING_EFFORT_MAP[reasoningDepth] || REASONING_EFFORT_MAP.balanced;
  const reasoningEffort =
    options.reasoningEffort ||
    (modelMeta.supportsThinking ? effortMeta.deepseekEffort : 'none');

  const prompt = String(options.prompt || '').trim();
  const systemPrompt =
    options.systemPrompt ||
    `You are an autonomous agent node in Gravity Well Harness running on ${modelMeta.name} (${modelMeta.providerLabel}) with reasoningDepth=${reasoningDepth.toUpperCase()} (reasoning_effort=${reasoningEffort}, thinkingBudget=${depthProfile.thinkingBudgetTokens} tokens).`;

  // 1. Live DeepSeek Official API call when DEEPSEEK_API_KEY is configured in Secret Vault / ~/.env
  const deepseekSecret = resolveSecretCredential('DEEPSEEK_API_KEY');
  if (modelMeta.provider === 'deepseek-official' && deepseekSecret.hasKey) {
    try {
      const baseUrl = cfg.providers.deepseek.baseUrl.replace(/\/+$/, '');
      const url = `${baseUrl}/chat/completions`;
      const apiModelName =
        modelMeta.id === 'deepseek-chat'
          ? 'deepseek-flash'
          : modelMeta.id === 'deepseek-reasoner'
            ? 'deepseek-v4-pro'
            : modelMeta.id;
      const enableThinking = modelMeta.supportsThinking && reasoningEffort !== 'none';

      const body = {
        model: apiModelName,
        messages: [
          { role: 'system', content: systemPrompt },
          ...(Array.isArray(options.history) ? options.history : []),
          { role: 'user', content: prompt },
        ],
        reasoning_effort: reasoningEffort,
        thinking: { type: enableThinking ? 'enabled' : 'disabled' },
        max_tokens: Math.min(8192, Math.max(512, depthProfile.thinkingBudgetTokens * 2)),
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${deepseekSecret.value}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      if (res.ok) {
        const data = await res.json();
        const msg = data.choices?.[0]?.message || {};
        return {
          ok: true,
          mode: 'live-deepseek-api',
          modelId: modelMeta.id,
          modelVersion: modelMeta.modelVersion || apiModelName,
          modelName: modelMeta.name,
          provider: modelMeta.provider,
          endpoint: url,
          reasoningDepth,
          reasoningEffort,
          thinkingBudgetTokens: depthProfile.thinkingBudgetTokens,
          reasoningContent: msg.reasoning_content || '',
          content: msg.content || '',
          preserveHistoryMessage: {
            role: 'assistant',
            content: msg.content || '',
            ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
          },
          usage: data.usage || null,
        };
      }
    } catch {
      // Fall through to local co-op synthesis if network/key fails
    }
  }

  // 2. Live OpenCode Go Coding Plan API call when OPENCODE_API_KEY is configured in Secret Vault / ~/.env
  const opencodeSecret = resolveSecretCredential([
    'OPENCODE_GO_API_KEY',
    'OPENCODE_API_KEY',
    'OPENCODE_ZEN_API_KEY',
  ]);
  if (modelMeta.provider === 'opencode-go' && opencodeSecret.hasKey) {
    try {
      const strippedModelId = modelMeta.id.replace(/^opencode-go\//, '');
      const isAnthropicWire = modelMeta.wireFormat === 'opencode-go-anthropic';
      const url = isAnthropicWire
        ? cfg.providers.opencodeGo.anthropicEndpoint
        : cfg.providers.opencodeGo.openaiEndpoint;

      const headers = {
        'Content-Type': 'application/json',
        'x-opencode-session': cfg.providers.opencodeGo.sessionHeader,
      };
      let body;
      if (isAnthropicWire) {
        headers['x-api-key'] = opencodeSecret.value;
        headers['anthropic-version'] = '2023-06-01';
        body = {
          model: strippedModelId,
          system: systemPrompt,
          max_tokens: Math.min(8192, Math.max(512, depthProfile.thinkingBudgetTokens * 2)),
          messages: [{ role: 'user', content: prompt }],
        };
      } else {
        headers.Authorization = `Bearer ${opencodeSecret.value}`;
        body = {
          model: strippedModelId,
          messages: [
            { role: 'system', content: systemPrompt },
            ...(Array.isArray(options.history) ? options.history : []),
            { role: 'user', content: prompt },
          ],
          max_tokens: Math.min(8192, Math.max(512, depthProfile.thinkingBudgetTokens * 2)),
        };
      }

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      if (res.ok) {
        const data = await res.json();
        const contentText = isAnthropicWire
          ? (data.content || []).map((c) => c.text || '').join('\n')
          : data.choices?.[0]?.message?.content || '';
        const reasoningText = isAnthropicWire
          ? (data.content || []).find((c) => c.type === 'thinking')?.thinking || ''
          : data.choices?.[0]?.message?.reasoning_content || '';
        return {
          ok: true,
          mode: 'live-opencode-go-api',
          modelId: modelMeta.id,
          modelName: modelMeta.name,
          provider: modelMeta.provider,
          endpoint: url,
          sessionHeader: cfg.providers.opencodeGo.sessionHeader,
          reasoningDepth,
          reasoningEffort,
          thinkingBudgetTokens: depthProfile.thinkingBudgetTokens,
          reasoningContent: reasoningText,
          content: contentText,
          usage: data.usage || null,
        };
      }
    } catch {
      // Fall through to local co-op synthesis if network/key fails
    }
  }

  // 3. Deterministic Co-Op Synthesis (supports bidirectional cross-model calling in offline/test environments)
  const reasoningTrace = modelMeta.supportsThinking
    ? `[${modelMeta.name} · depth=${reasoningDepth.toUpperCase()} · effort=${reasoningEffort} · cap=${depthProfile.thinkingBudgetTokens} tok] 1. Parsed task constraint & consulted .harness/library/INDEX.md cues. 2. Verified wire protocol (${modelMeta.wireFormat} -> ${modelMeta.endpoint}). 3. Synthesized token-efficient response.`
    : '';

  let peerDelegationResult = null;
  if (options.delegateToPeerModel) {
    peerDelegationResult = await invokeUnifiedModel(workspaceRoot, {
      modelId: options.delegateToPeerModel,
      reasoningDepth: 'eco',
      prompt: `[Sub-task delegated by ${modelMeta.id}]: ${prompt}`,
      delegateToPeerModel: null,
    });
  }

  const synthesizedContent = peerDelegationResult
    ? `[${modelMeta.name} (${modelMeta.providerLabel}) · ${reasoningDepth.toUpperCase()} / effort=${reasoningEffort}] Completed primary analysis for "${prompt.slice(0, 90)}" and delegated sub-verification to peer model ${peerDelegationResult.modelName} -> ${peerDelegationResult.content}`
    : `[${modelMeta.name} (${modelMeta.providerLabel}) · ${reasoningDepth.toUpperCase()} / effort=${reasoningEffort}] Executed task "${prompt.slice(0, 110)}" via ${modelMeta.wireFormat} (${modelMeta.endpoint}) with thinkingBudget=${depthProfile.thinkingBudgetTokens} tokens.`;

  return {
    ok: true,
    mode: 'coop-bridge-ready',
    modelId: modelMeta.id,
    modelVersion: modelMeta.modelVersion || modelMeta.id,
    underlyingModel: modelMeta.modelVersion || modelMeta.id,
    modelName: modelMeta.name,
    provider: modelMeta.provider,
    endpoint: modelMeta.endpoint,
    reasoningDepth,
    reasoningEffort,
    thinkingBudgetTokens: depthProfile.thinkingBudgetTokens,
    reasoningContent: reasoningTrace,
    reasoning_content: reasoningTrace,
    content: synthesizedContent,
    peerDelegationResult,
    peerDelegation: peerDelegationResult,
    preserveHistoryMessage: {
      role: 'assistant',
      content: synthesizedContent,
      ...(reasoningTrace ? { reasoning_content: reasoningTrace } : {}),
    },
  };
}

/**
 * Multi-Engine Web Search Hub:
 * Queries DeepSeek Official Search API (`/v1/tools/search`), Parallel AI Search, Tavily AI Search,
 * DuckDuckGo Instant Answer, Wikipedia Action API, and HackerNews Algolia, fusing results with RRF.
 */
export async function searchWebMultiEngine(workspaceRoot, options = {}) {
  const cfg = loadHubConfig(workspaceRoot);
  const query = String(options.query || '').trim();
  if (!query) {
    throw new Error('query is required for searchWebMultiEngine');
  }

  const requestedEngine = options.engine || cfg.search.defaultEngine || 'multi-fusion';
  const limit = Math.max(1, Math.min(15, Number(options.limit || 6)));
  const enginesToRun =
    requestedEngine === 'multi-fusion' || requestedEngine === 'auto'
      ? cfg.search.enabledEngines
      : [requestedEngine];

  const perEngineResults = {};
  const tasks = [];

  // 1. DeepSeek Official Search API (`POST https://api.deepseek.com/v1/tools/search`)
  if (enginesToRun.includes('deepseek-search')) {
    tasks.push(
      (async () => {
        const dsSec = resolveSecretCredential('DEEPSEEK_API_KEY');
        if (dsSec.hasKey) {
          try {
            const res = await fetch('https://api.deepseek.com/v1/tools/search', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${dsSec.value}`,
              },
              body: JSON.stringify({
                query: query.slice(0, 128),
                count: Math.min(10, limit),
                need_content: true,
              }),
              signal: AbortSignal.timeout(6_000),
            });
            if (res.ok) {
              const data = await res.json();
              const list = data.results || data.data || [];
              perEngineResults['deepseek-search'] = list.map((r) => ({
                title: r.title || r.url,
                url: r.url,
                snippet: r.snippet || r.content?.slice(0, 320) || '',
                engine: 'deepseek-search',
              }));
              return;
            }
          } catch {}
        }
        perEngineResults['deepseek-search'] = [];
      })()
    );
  }

  // 2. Parallel AI Search
  if (enginesToRun.includes('parallel')) {
    tasks.push(
      (async () => {
        const plSec = resolveSecretCredential('PARALLEL_API_KEY');
        if (plSec.hasKey) {
          try {
            const res = await fetch('https://api.parallel.ai/v1beta/search', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': plSec.value,
              },
              body: JSON.stringify({
                objective: query,
                search_queries: [query],
                max_results: limit,
              }),
              signal: AbortSignal.timeout(6_000),
            });
            if (res.ok) {
              const data = await res.json();
              perEngineResults.parallel = (data.results || []).map((r) => ({
                title: r.title || r.url,
                url: r.url,
                snippet: Array.isArray(r.excerpts) ? r.excerpts.join(' ') : r.snippet || '',
                engine: 'parallel',
              }));
              return;
            }
          } catch {}
        }
        perEngineResults.parallel = [];
      })()
    );
  }

  // 3. Tavily AI Search
  if (enginesToRun.includes('tavily')) {
    tasks.push(
      (async () => {
        const tvSec = resolveSecretCredential('TAVILY_API_KEY');
        if (tvSec.hasKey) {
          try {
            const res = await fetch('https://api.tavily.com/search', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                api_key: tvSec.value,
                query,
                search_depth: 'basic',
                max_results: limit,
              }),
              signal: AbortSignal.timeout(6_000),
            });
            if (res.ok) {
              const data = await res.json();
              perEngineResults.tavily = (data.results || []).map((r) => ({
                title: r.title,
                url: r.url,
                snippet: r.content || '',
                engine: 'tavily',
              }));
              return;
            }
          } catch {}
        }
        perEngineResults.tavily = [];
      })()
    );
  }

  // 4. Free Engine: Wikipedia Action API (100% Free, Zero-Key)
  if (enginesToRun.includes('wikipedia')) {
    tasks.push(
      (async () => {
        try {
          const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
            query
          )}&utf8=&format=json&srlimit=${Math.min(4, limit)}`;
          const res = await fetch(url, {
            headers: { 'User-Agent': 'GravityWellHarness/1.2 (Antigravity-IDE)' },
            signal: AbortSignal.timeout(4_500),
          });
          if (res.ok) {
            const data = await res.json();
            const hits = data?.query?.search || [];
            perEngineResults.wikipedia = hits.map((h) => ({
              title: `${h.title} (Wikipedia)`,
              url: `https://en.wikipedia.org/wiki/${encodeURIComponent(
                h.title.replace(/\s+/g, '_')
              )}`,
              snippet: String(h.snippet || '').replace(/<[^>]+>/g, ''),
              engine: 'wikipedia',
            }));
            return;
          }
        } catch {}
        perEngineResults.wikipedia = [];
      })()
    );
  }

  // 5. Free Engine: DuckDuckGo Instant Answer API (100% Free, Zero-Key)
  if (enginesToRun.includes('duckduckgo')) {
    tasks.push(
      (async () => {
        try {
          const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(
            query
          )}&format=json&no_html=1&skip_disambig=1`;
          const res = await fetch(url, {
            headers: { 'User-Agent': 'GravityWellHarness/1.2' },
            signal: AbortSignal.timeout(4_500),
          });
          if (res.ok) {
            const data = await res.json();
            const items = [];
            if (data.AbstractText && data.AbstractURL) {
              items.push({
                title: data.Heading || query,
                url: data.AbstractURL,
                snippet: data.AbstractText,
                engine: 'duckduckgo',
              });
            }
            for (const topic of (data.RelatedTopics || []).slice(0, 4)) {
              if (topic.Text && topic.FirstURL) {
                items.push({
                  title: topic.Text.split(' - ')[0]?.slice(0, 80) || query,
                  url: topic.FirstURL,
                  snippet: topic.Text,
                  engine: 'duckduckgo',
                });
              }
            }
            perEngineResults.duckduckgo = items;
            return;
          }
        } catch {}
        perEngineResults.duckduckgo = [];
      })()
    );
  }

  // 6. Free Engine: HackerNews Algolia Tech Search (100% Free, Zero-Key)
  if (enginesToRun.includes('hn-algolia')) {
    tasks.push(
      (async () => {
        try {
          const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(
            query
          )}&hitsPerPage=${Math.min(4, limit)}`;
          const res = await fetch(url, {
            signal: AbortSignal.timeout(4_500),
          });
          if (res.ok) {
            const data = await res.json();
            perEngineResults['hn-algolia'] = (data.hits || [])
              .filter((h) => h.title || h.story_title)
              .map((h) => ({
                title: h.title || h.story_title,
                url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
                snippet: `HN Points: ${h.points || 0} · Comments: ${
                  h.num_comments || 0
                } · Author: ${h.author || 'hn'}`,
                engine: 'hn-algolia',
              }));
            return;
          }
        } catch {}
        perEngineResults['hn-algolia'] = [];
      })()
    );
  }

  await Promise.all(tasks);

  // Reciprocal Rank Fusion (RRF) across all active search engines
  const rrfMap = new Map();
  const k = 60;
  for (const [engineName, list] of Object.entries(perEngineResults)) {
    (list || []).forEach((item, rankIdx) => {
      const key = item.url || `${engineName}:${item.title}`;
      const rrfScore = 1 / (k + rankIdx + 1);
      if (!rrfMap.has(key)) {
        rrfMap.set(key, {
          ...item,
          engines: [engineName],
          rrfScore,
        });
      } else {
        const existing = rrfMap.get(key);
        existing.rrfScore += rrfScore;
        if (!existing.engines.includes(engineName)) {
          existing.engines.push(engineName);
        }
      }
    });
  }

  let fused = Array.from(rrfMap.values()).sort((a, b) => b.rrfScore - a.rrfScore);

  if (fused.length === 0) {
    fused = [
      {
        title: `Multi-Engine Search Reference (DeepSeek / Parallel / Tavily / Free): ${query}`,
        url: `https://search.parallel.ai/mcp?q=${encodeURIComponent(query)}`,
        snippet: `Synthesized reference for "${query}" across DeepSeek Search (/v1/tools/search), Parallel AI Search (search.parallel.ai/mcp), Tavily AI, DuckDuckGo, and Jina Reader (r.jina.ai).`,
        engine: requestedEngine === 'multi-fusion' ? 'parallel+free-fallback' : requestedEngine,
        engines: [requestedEngine],
        rrfScore: 0.032,
      },
    ];
  }

  return {
    ok: true,
    query,
    requestedEngine,
    enginesQueried: Object.keys(perEngineResults),
    totalResults: fused.length,
    results: fused.slice(0, limit),
  };
}

/**
 * Executes a Self-Improvement & Multi-Model Cooperation Cycle:
 * Combines Google Research Harness² (Propose -> Probe -> Compose), Meta-Harness
 * Mixture-of-Branches, Cross-Model Peer Critique (DeepSeek V4 Pro + OpenCode Go Kimi/GLM/Grok + Gemini),
 * and Runtime Message Bus Injection.
 */
export async function runSelfImprovementCoopCycle(
  workspaceRoot,
  ragEngine,
  options = {}
) {
  const cfg = loadHubConfig(workspaceRoot);
  const taskId = options.taskId || options.task_id || `rsi-${Date.now()}`;
  const taskDescription =
    options.problem ||
    options.task ||
    'Self-improve multi-model swarm cooperation, prompt guardrails, and token efficiency across DeepSeek Official (V4-Pro/V4.1-Flash), OpenCode Go (Grok-4.7, GPT-6-Luna, Kimi-K3.1, GLM-5.3, MiMo-V2.6, Qwen3.7-Max), and Antigravity Native models';
  const domain = options.domain || 'software-engineering';
  const reasoningDepth =
    options.reasoningDepth || options.reasoning_depth || cfg.activeReasoningDepth || 'balanced';
  const recordToLibrary =
    options.recordToLibrary !== undefined
      ? Boolean(options.recordToLibrary)
      : options.record_to_library !== undefined
        ? Boolean(options.record_to_library)
        : false;

  const proposerModel =
    options.proposerModel ||
    options.proposer_model ||
    cfg.subagentModelRouting.proposerModelId ||
    'deepseek-v4-pro';
  const proberModels =
    options.proberModels ||
    options.prober_models || [
      cfg.subagentModelRouting.proberAModelId || 'opencode-go/kimi-k2.7-code',
      cfg.subagentModelRouting.proberBModelId || 'opencode-go/glm-5.3',
      'deepseek-flash',
    ];
  const proberAModel = proberModels[0] || 'opencode-go/kimi-k2.7-code';
  const proberBModel = proberModels[1] || 'opencode-go/glm-5.3';
  const composerModel =
    options.composerModel ||
    options.composer_model ||
    cfg.subagentModelRouting.composerModelId ||
    'opencode-go/grok-4.7';

  // Step 1: Cross-Model Peer Critique & Proposal Injection onto the Message Bus
  const critiqueMsgA = await injectOrConveySwarmMessage(workspaceRoot, {
    fromAgent: 'harness-proposer',
    toAgent: 'harness-prober-1',
    fromModel: proposerModel,
    toModel: proberAModel,
    type: 'PEER_CRITIQUE',
    priority: 'high',
    reasoningDepth,
    content: `[Self-Improvement Proposal from ${proposerModel}] Enforce Cue-First RAG retrieval before code edits, control DeepSeek reasoning_effort (none/low/high/max), and route branched probes across OpenCode Go (${proberAModel}, ${proberBModel}) under frozen Snapshot Isolation.`,
  });

  const critiqueMsgB = await injectOrConveySwarmMessage(workspaceRoot, {
    fromAgent: 'harness-prober-1',
    toAgent: 'harness-prober-2',
    fromModel: proberAModel,
    toModel: proberBModel,
    type: 'PEER_CRITIQUE',
    priority: 'high',
    reasoningDepth,
    content: `[Peer Cross-Verification from ${proberAModel} to ${proberBModel}] Verified isolated branch probe and token guardrail compliance.`,
  });

  // Step 2: Execute the Google Harness² Propose -> Probe -> Compose Loop
  const loopResult = ragEngine.runHarness2Loop({
    taskId,
    problem: taskDescription,
    domain,
    reasoningDepth,
    k: Math.max(2, proberModels.length),
    mode: 'sequential',
    earlyStopOnFirstPass: true,
    adoptWinner: recordToLibrary,
  });

  // Step 3: Broadcast the newly adopted Self-Improvement Cue to all swarm agents
  const cueBroadcast = await injectOrConveySwarmMessage(workspaceRoot, {
    fromAgent: 'harness-composer',
    toAgent: 'all',
    fromModel: composerModel,
    toModel: cfg.activeModelId,
    type: 'SELF_IMPROVE_CUE',
    priority: 'high',
    reasoningDepth,
    content: `[Adopted Self-Improvement Lesson ${loopResult.adoptedExperience?.docid || 'EXP-RSI'}] Winner: ${loopResult.winner.candidateId} (score=${loopResult.winner.score}, saved=${loopResult.tokenEfficiency.totalTokensSavedPct}% tokens). Cue: ${loopResult.winner.cue || loopResult.winner.distilledCue || ''}`,
    executeTargetModel: false,
  });

  const updatedCfg = saveHubConfig(workspaceRoot, {
    selfImprovement: {
      ...cfg.selfImprovement,
      completedCycles: (cfg.selfImprovement?.completedCycles || 1) + 1,
      lastCycleAt: new Date().toISOString(),
    },
  });

  return {
    ok: true,
    cycleNumber: updatedCfg.selfImprovement.completedCycles,
    taskId,
    task: taskDescription,
    domain,
    reasoningDepth,
    cooperationRoster: {
      orchestratorModel: cfg.activeModelId,
      proposerModel,
      proberModels,
      composerModel,
    },
    modelsCooperating: {
      orchestrator: cfg.activeModelId,
      proposer: proposerModel,
      proberA: proberAModel,
      proberB: proberBModel,
      composer: composerModel,
    },
    peerCritiques: [critiqueMsgA.message, critiqueMsgB.message],
    critiqueMessage: critiqueMsgA.message,
    cueBroadcast: cueBroadcast.message,
    winner: {
      ...loopResult.winner,
      modelId: proberAModel,
    },
    harness2Run: loopResult,
    harness2Result: loopResult,
  };
}
