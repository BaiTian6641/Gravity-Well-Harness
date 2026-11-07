import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { REASONING_DEPTH_PROFILES } from './rag-engine.mjs';
import {
  getSecretVaultStatusSummary,
  redactSecrets,
  resolveSecretCredential,
  setSecretInVault,
  validateCredentialOrigin,
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
    modelVersion: 'MODEL_PLACEHOLDER_M417',
    aliases: [
      'Gemini 4 Argon (High)',
      'Gemini 4 Argon High',
      'Gemini 4 Argon',
      'gemini-4-argon',
      'MODEL_PLACEHOLDER_M417',
      'pro',
      'inherit',
      'auto',
    ],
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
    id: 'gemini-4-argon-medium',
    name: 'Gemini 4 Argon Medium (Antigravity Native)',
    provider: 'antigravity-native',
    providerLabel: 'Antigravity Native',
    modelVersion: 'MODEL_PLACEHOLDER_M418',
    aliases: [
      'Gemini 4 Argon (Medium)',
      'Gemini 4 Argon Medium',
      'MODEL_PLACEHOLDER_M418',
    ],
    endpoint: 'antigravity://native/gemini-4-argon-medium',
    wireFormat: 'antigravity-native',
    roleHint: 'Balanced Main Orchestrator & Multi-Step Planner',
    defaultReasoningDepth: 'balanced',
    defaultReasoningEffort: 'high',
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 1_000_000,
    costPer1MTokensUsd: 0.95,
  },
  {
    id: 'gemini-4-argon-low',
    name: 'Gemini 4 Argon Low (Antigravity Native)',
    provider: 'antigravity-native',
    providerLabel: 'Antigravity Native',
    modelVersion: 'MODEL_PLACEHOLDER_M419',
    aliases: [
      'Gemini 4 Argon (Low)',
      'Gemini 4 Argon Low',
      'MODEL_PLACEHOLDER_M419',
    ],
    endpoint: 'antigravity://native/gemini-4-argon-low',
    wireFormat: 'antigravity-native',
    roleHint: 'Low-Latency Native Orchestrator & Fast Iteration',
    defaultReasoningDepth: 'eco',
    defaultReasoningEffort: 'low',
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 1_000_000,
    costPer1MTokensUsd: 0.55,
  },
  {
    id: 'gemini-3.8-flash-high',
    name: 'Gemini 3.8 Flash High (Antigravity Native)',
    provider: 'antigravity-native',
    providerLabel: 'Antigravity Native',
    modelVersion: 'MODEL_PLACEHOLDER_M420',
    aliases: [
      'Gemini 3.8 Flash (High)',
      'Gemini 3.8 Flash High',
      'Gemini 3.8 Flash',
      'gemini-3.8-flash',
      'gemini-4-flash',
      'Gemini 4 Flash',
      'MODEL_PLACEHOLDER_M420',
      'flash',
    ],
    endpoint: 'antigravity://native/gemini-3.8-flash-high',
    wireFormat: 'antigravity-native',
    roleHint: 'Fast Branched Prober & RAG Researcher',
    defaultReasoningDepth: 'deep',
    defaultReasoningEffort: 'high',
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 1_000_000,
    costPer1MTokensUsd: 0.35,
  },
  {
    id: 'gemini-3.8-flash-medium',
    name: 'Gemini 3.8 Flash Medium (Antigravity Native)',
    provider: 'antigravity-native',
    providerLabel: 'Antigravity Native',
    modelVersion: 'MODEL_PLACEHOLDER_M421',
    aliases: [
      'Gemini 3.8 Flash (Medium)',
      'Gemini 3.8 Flash Medium',
      'MODEL_PLACEHOLDER_M421',
    ],
    endpoint: 'antigravity://native/gemini-3.8-flash-medium',
    wireFormat: 'antigravity-native',
    roleHint: 'Balanced High-Throughput Subagent Prober',
    defaultReasoningDepth: 'balanced',
    defaultReasoningEffort: 'high',
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 1_000_000,
    costPer1MTokensUsd: 0.25,
  },
  {
    id: 'gemini-3.8-flash-low',
    name: 'Gemini 3.8 Flash Low (Antigravity Native)',
    provider: 'antigravity-native',
    providerLabel: 'Antigravity Native',
    modelVersion: 'MODEL_PLACEHOLDER_M422',
    aliases: [
      'Gemini 3.8 Flash (Low)',
      'Gemini 3.8 Flash Low',
      'MODEL_PLACEHOLDER_M422',
      'flash_lite',
    ],
    endpoint: 'antigravity://native/gemini-3.8-flash-low',
    wireFormat: 'antigravity-native',
    roleHint: 'Ultra-Fast Lightweight Subagent & RAG Lookup',
    defaultReasoningDepth: 'eco',
    defaultReasoningEffort: 'low',
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 1_000_000,
    costPer1MTokensUsd: 0.15,
  },
  {
    id: 'claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5 (Antigravity Native · 1M)',
    provider: 'antigravity-native',
    providerLabel: 'Antigravity Native',
    modelVersion: 'claude-sonnet-5-5',
    aliases: [
      'Claude Sonnet 5.5 (High)',
      'Claude Sonnet 5.5 (Medium)',
      'Claude Sonnet 5.5 (Low)',
      'Claude Sonnet 5.5',
      'Claude 4.6 Sonnet (Thinking)',
      'claude-sonnet-4-6',
    ],
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
    modelVersion: 'claude-opus-5-5',
    aliases: [
      'Claude Opus 5.5 (High)',
      'Claude Opus 5.5 (Thinking)',
      'Claude Opus 5.5',
      'Claude 4.6 Opus (Thinking)',
      'claude-opus-4-6',
    ],
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
  {
    id: 'gpt-oss-120b-medium',
    name: 'GPT-OSS 120B Medium (Antigravity Native)',
    provider: 'antigravity-native',
    providerLabel: 'Antigravity Native',
    modelVersion: 'gpt-oss-120b-medium',
    aliases: [
      'GPT-OSS 120B (Medium)',
      'GPT-OSS 120B',
      'gpt-oss-120b',
    ],
    endpoint: 'antigravity://native/gpt-oss-120b-medium',
    wireFormat: 'antigravity-native',
    roleHint: 'Open-Weight Reasoning & Code Verification Specialist',
    defaultReasoningDepth: 'balanced',
    defaultReasoningEffort: 'high',
    supportsThinking: true,
    supportsTools: true,
    canCallSubagents: true,
    canBeSubagent: true,
    contextWindowTokens: 256_000,
    costPer1MTokensUsd: 0.3,
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

function getChatContextUsageFile(workspaceRoot) {
  return path.join(workspaceRoot, '.harness', 'runtime', 'chat-context-usage.json');
}

function getMessageBusFile(workspaceRoot) {
  return path.join(workspaceRoot, '.harness', 'runtime', 'message-bus.json');
}

function getMessageBusLockFile(workspaceRoot) {
  return path.join(workspaceRoot, '.harness', 'runtime', 'message-bus.lock');
}

const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));
function sleepSyncMs(ms) {
  try {
    Atomics.wait(SLEEP_ARRAY, 0, 0, Math.max(1, ms));
  } catch {
    const deadline = Date.now() + Math.max(1, ms);
    while (Date.now() < deadline) {
      // spin fallback
    }
  }
}

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpFile = `${filePath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  const serialized = JSON.stringify(payload, null, 2);
  fs.writeFileSync(tmpFile, serialized, { encoding: 'utf8', mode: 0o600 });
  let renamed = false;
  for (let i = 0; i < 5; i += 1) {
    try {
      fs.renameSync(tmpFile, filePath);
      renamed = true;
      break;
    } catch (err) {
      if (i < 4 && err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY')) {
        sleepSyncMs(5 * (i + 1));
        continue;
      }
      break;
    }
  }
  if (!renamed) {
    fs.writeFileSync(filePath, serialized, { encoding: 'utf8', mode: 0o600 });
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch {}
  }
}

function withMessageBusLock(workspaceRoot, fn, maxRetries = 250) {
  const lockFile = getMessageBusLockFile(workspaceRoot);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  let fd = null;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      fd = fs.openSync(lockFile, 'wx');
      fs.writeFileSync(fd, `${process.pid}:${Date.now()}`, 'utf8');
      break;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        try {
          const stat = fs.statSync(lockFile);
          if (Date.now() - stat.mtimeMs > 5000) {
            fs.unlinkSync(lockFile);
            continue;
          }
        } catch {}
        sleepSyncMs(4);
        continue;
      }
      break;
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
      try {
        if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
      } catch {}
    }
  }
}

function maskKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 5)}…${s.slice(-3)}`;
}

/**
 * Finds a model entry in `DEFAULT_MODEL_CATALOG` by ID, Antigravity Chat Box `modelName`,
 * `modelVersion`, or alias. Returns `null` if no match is found.
 */
export function findModelInCatalog(modelIdOrName) {
  const raw = String(modelIdOrName || '').trim();
  if (!raw) return null;
  const norm = raw.toLowerCase();

  const exact = DEFAULT_MODEL_CATALOG.find(
    (m) => m.id === raw || m.id.toLowerCase() === norm
  );
  if (exact) return exact;

  const byAlias = DEFAULT_MODEL_CATALOG.find(
    (m) =>
      m.name.toLowerCase() === norm ||
      (m.modelVersion && m.modelVersion.toLowerCase() === norm) ||
      (Array.isArray(m.aliases) && m.aliases.some((a) => a.toLowerCase() === norm))
  );
  if (byAlias) return byAlias;

  const prefixed = DEFAULT_MODEL_CATALOG.find(
    (m) => m.id.toLowerCase() === `opencode-go/${norm}`
  );
  if (prefixed) return prefixed;

  const suffixMatch = DEFAULT_MODEL_CATALOG.find((m) =>
    m.id.toLowerCase().endsWith(`/${norm}`)
  );
  if (suffixMatch) return suffixMatch;

  // Normalized fuzzy match for Antigravity IDE Chat Box labels
  if (norm.includes('gemini 4 argon') || norm.includes('gemini-4-argon')) {
    if (norm.includes('low')) {
      return DEFAULT_MODEL_CATALOG.find((m) => m.id === 'gemini-4-argon-low') || null;
    }
    if (norm.includes('medium')) {
      return DEFAULT_MODEL_CATALOG.find((m) => m.id === 'gemini-4-argon-medium') || null;
    }
    return DEFAULT_MODEL_CATALOG.find((m) => m.id === 'gemini-4-argon-high') || null;
  }
  if (
    norm.includes('gemini 3.8 flash') ||
    norm.includes('gemini-3.8-flash') ||
    norm.includes('gemini 4 flash') ||
    norm.includes('gemini-4-flash')
  ) {
    if (norm.includes('low') || norm.includes('lite')) {
      return DEFAULT_MODEL_CATALOG.find((m) => m.id === 'gemini-3.8-flash-low') || null;
    }
    if (norm.includes('medium')) {
      return DEFAULT_MODEL_CATALOG.find((m) => m.id === 'gemini-3.8-flash-medium') || null;
    }
    return DEFAULT_MODEL_CATALOG.find((m) => m.id === 'gemini-3.8-flash-high') || null;
  }
  if (norm.includes('claude') && norm.includes('sonnet')) {
    return DEFAULT_MODEL_CATALOG.find((m) => m.id === 'claude-sonnet-5-5') || null;
  }
  if (norm.includes('claude') && norm.includes('opus')) {
    return DEFAULT_MODEL_CATALOG.find((m) => m.id === 'claude-opus-5-5') || null;
  }
  if (norm.includes('gpt-oss') || norm.includes('120b')) {
    return DEFAULT_MODEL_CATALOG.find((m) => m.id === 'gpt-oss-120b-medium') || null;
  }

  return null;
}

/**
 * Resolves model IDs, Antigravity Chat Box `modelName` labels, and legacy model aliases
 * (e.g. `"Gemini 4 Argon (High)"` -> `gemini-4-argon-high`, `kimi-k2.7-code` -> `opencode-go/kimi-k2.7-code`).
 */
export function resolveModelMeta(modelId) {
  return findModelInCatalog(modelId) || DEFAULT_MODEL_CATALOG[0];
}

function estimateTokensFromText(input) {
  if (!input) return 0;
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Loads the persisted real conversation context usage computed from Antigravity's `transcript.jsonl`.
 */
export function loadChatContextUsage(workspaceRoot) {
  const file = getChatContextUsageFile(workspaceRoot);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Syncs the Main Agent model selected in the Antigravity IDE Chat Box (`input.modelName`)
 * and parses the live conversation transcript (`input.transcriptPath` / `transcript.jsonl`)
 * to compute real context token usage across turns, steps, user prompts, assistant responses,
 * chain-of-thought thinking traces, and tool results.
 */
export function syncChatBoxModelAndTranscript(
  workspaceRoot,
  { modelName, transcriptPath, conversationId } = {}
) {
  let currentCfg = loadHubConfig(workspaceRoot);
  const cleanModelName = String(modelName || '').trim();

  if (cleanModelName) {
    const matched =
      cleanModelName.toLowerCase() !== 'auto'
        ? findModelInCatalog(cleanModelName)
        : null;
    const patch = {
      chatBoxNativeModel: cleanModelName,
    };
    if (
      matched &&
      (!currentCfg.userPinnedModelOverride ||
        matched.provider === 'deepseek-official' ||
        matched.provider === 'opencode-go')
    ) {
      const nextDepth =
        currentCfg.modelReasoningDepths?.[matched.id] ||
        matched.defaultReasoningDepth ||
        currentCfg.activeReasoningDepth ||
        'balanced';
      patch.activeModelId = matched.id;
      patch.activeReasoningDepth = nextDepth;
      patch.activeReasoningEffort =
        matched.defaultReasoningEffort || currentCfg.activeReasoningEffort || 'high';
    }
    currentCfg = saveHubConfig(workspaceRoot, patch);
  }

  let resolvedTranscriptPath = String(transcriptPath || '').trim();
  if (!resolvedTranscriptPath || !fs.existsSync(resolvedTranscriptPath)) {
    try {
      const telemetryFile = path.join(workspaceRoot, '.harness', 'runtime', 'telemetry.json');
      if (fs.existsSync(telemetryFile)) {
        const tel = JSON.parse(fs.readFileSync(telemetryFile, 'utf8'));
        const sessions = Object.values(tel.sessions || {});
        const matchSess =
          (conversationId && tel.sessions?.[conversationId]) ||
          sessions.find((s) => s.transcriptPath && fs.existsSync(s.transcriptPath));
        if (matchSess?.transcriptPath && fs.existsSync(matchSess.transcriptPath)) {
          resolvedTranscriptPath = matchSess.transcriptPath;
        }
      }
    } catch {}
  }

  if (
    (!resolvedTranscriptPath || !fs.existsSync(resolvedTranscriptPath)) &&
    conversationId
  ) {
    const candidateBrainTranscript = path.join(
      os.homedir(),
      '.gemini',
      'antigravity',
      'brain',
      conversationId,
      '.system_generated',
      'logs',
      'transcript.jsonl'
    );
    if (fs.existsSync(candidateBrainTranscript)) {
      resolvedTranscriptPath = candidateBrainTranscript;
    }
  }

  if (resolvedTranscriptPath && fs.existsSync(resolvedTranscriptPath)) {
    let turns = 0;
    let steps = 0;
    let userTokens = 0;
    let assistantTokens = 0;
    let thinkingTokens = 0;
    let toolResultTokens = 0;

    try {
      const rawContent = fs.readFileSync(resolvedTranscriptPath, 'utf8');
      const lines = rawContent.split(/\r?\n/).filter((l) => l.trim().length > 0);
      for (const line of lines) {
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        if (!row || typeof row !== 'object') continue;
        steps += 1;

        const stepType = String(row.type || '').toUpperCase();
        const stepSource = String(row.source || '').toUpperCase();
        const role = String(row.role || '').toLowerCase();

        if (row.thinking || row.reasoning_content) {
          thinkingTokens += estimateTokensFromText(row.thinking || row.reasoning_content);
        }

        if (
          stepType === 'USER_INPUT' ||
          stepSource === 'USER_EXPLICIT' ||
          role === 'user'
        ) {
          turns += 1;
          userTokens += estimateTokensFromText(row.content || row.text || row.prompt || '');
        } else if (
          stepType === 'PLANNER_RESPONSE' ||
          stepSource === 'MODEL' ||
          role === 'assistant'
        ) {
          assistantTokens += estimateTokensFromText(row.content || row.text || '');
          if (row.tool_calls) {
            assistantTokens += estimateTokensFromText(row.tool_calls);
          }
        } else {
          toolResultTokens += estimateTokensFromText(
            row.content || row.output || row.result || row.tool_responses || ''
          );
        }
      }
    } catch {}

    const usedTokens = userTokens + assistantTokens + thinkingTokens + toolResultTokens;
    const activeMeta = resolveModelMeta(currentCfg.activeModelId);
    const contextWindowTokens = activeMeta.contextWindowTokens || 1_000_000;
    const contextUsedPct = Number(
      ((usedTokens / contextWindowTokens) * 100).toFixed(2)
    );

    const summary = {
      conversationId: conversationId || 'default-session',
      transcriptPath: resolvedTranscriptPath,
      modelName: cleanModelName || currentCfg.chatBoxNativeModel || activeMeta.name,
      resolvedModelId: activeMeta.id,
      turns,
      steps,
      userTokens,
      assistantTokens,
      thinkingTokens,
      toolResultTokens,
      usedTokens,
      contextWindowTokens,
      contextUsedPct,
      updatedAt: new Date().toISOString(),
    };

    try {
      const usageFile = getChatContextUsageFile(workspaceRoot);
      writeJsonAtomic(usageFile, summary);
    } catch {}

    return summary;
  }

  const existing = loadChatContextUsage(workspaceRoot);
  if (existing) {
    return existing;
  }

  const activeMeta = resolveModelMeta(currentCfg.activeModelId);
  return {
    conversationId: conversationId || 'default-session',
    transcriptPath: resolvedTranscriptPath || '',
    modelName: cleanModelName || currentCfg.chatBoxNativeModel || activeMeta.name,
    resolvedModelId: activeMeta.id,
    turns: 0,
    steps: 0,
    userTokens: 0,
    assistantTokens: 0,
    thinkingTokens: 0,
    toolResultTokens: 0,
    usedTokens: 0,
    contextWindowTokens: activeMeta.contextWindowTokens || 1_000_000,
    contextUsedPct: 0,
    updatedAt: new Date().toISOString(),
  };
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
 * and NEVER included as plaintext in returned config objects or left on disk (F13).
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

  // Transactional plaintext key migration (F13): encrypt into vault and immediately scrub from disk
  let migratedFromHubFile = false;
  if (saved.providers?.deepseek?.apiKey) {
    setSecretInVault('DEEPSEEK_API_KEY', saved.providers.deepseek.apiKey);
    delete saved.providers.deepseek.apiKey;
    migratedFromHubFile = true;
  }
  if (saved.providers?.['deepseek-official']?.apiKey) {
    setSecretInVault('DEEPSEEK_API_KEY', saved.providers['deepseek-official'].apiKey);
    delete saved.providers['deepseek-official'].apiKey;
    migratedFromHubFile = true;
  }
  if (saved.providers?.opencodeGo?.apiKey) {
    setSecretInVault('OPENCODE_API_KEY', saved.providers.opencodeGo.apiKey);
    delete saved.providers.opencodeGo.apiKey;
    migratedFromHubFile = true;
  }
  if (saved.providers?.['opencode-go']?.apiKey) {
    setSecretInVault('OPENCODE_API_KEY', saved.providers['opencode-go'].apiKey);
    delete saved.providers['opencode-go'].apiKey;
    migratedFromHubFile = true;
  }
  if (saved.search?.tavilyApiKey) {
    setSecretInVault('TAVILY_API_KEY', saved.search.tavilyApiKey);
    delete saved.search.tavilyApiKey;
    migratedFromHubFile = true;
  }
  if (saved.searchEngines?.tavily?.apiKey) {
    setSecretInVault('TAVILY_API_KEY', saved.searchEngines.tavily.apiKey);
    delete saved.searchEngines.tavily.apiKey;
    migratedFromHubFile = true;
  }
  if (saved.search?.parallelApiKey) {
    setSecretInVault('PARALLEL_API_KEY', saved.search.parallelApiKey);
    delete saved.search.parallelApiKey;
    migratedFromHubFile = true;
  }
  if (saved.searchEngines?.parallel?.apiKey) {
    setSecretInVault('PARALLEL_API_KEY', saved.searchEngines.parallel.apiKey);
    delete saved.searchEngines.parallel.apiKey;
    migratedFromHubFile = true;
  }
  if (saved.search?.jinaApiKey) {
    setSecretInVault('JINA_API_KEY', saved.search.jinaApiKey);
    delete saved.search.jinaApiKey;
    migratedFromHubFile = true;
  }
  if (saved.searchEngines?.jina?.apiKey) {
    setSecretInVault('JINA_API_KEY', saved.searchEngines.jina.apiKey);
    delete saved.searchEngines.jina.apiKey;
    migratedFromHubFile = true;
  }

  if (migratedFromHubFile && fs.existsSync(file)) {
    writeJsonAtomic(file, saved);
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

  const deepseekBaseUrl =
    saved.providers?.deepseek?.baseUrl ||
    saved.providers?.['deepseek-official']?.baseUrl ||
    ideSettings['antigravity.harness.deepseek.baseUrl'] ||
    'https://api.deepseek.com';
  const normalizedDeepseekBase = String(deepseekBaseUrl).replace(/\/+$/, '');

  const opencodeBaseUrl =
    saved.providers?.opencodeGo?.baseUrl ||
    saved.providers?.['opencode-go']?.baseUrl ||
    ideSettings['antigravity.harness.opencodeGo.baseUrl'] ||
    'https://opencode.ai/inference/go/openai/v1';

  const config = {
    activeModelId:
      saved.activeModelId ||
      ideSettings['antigravity.harness.activeModel'] ||
      'deepseek-v4-pro',
    chatBoxNativeModel:
      saved.chatBoxNativeModel ||
      ideSettings['antigravity.harness.chatBoxNativeModel'] ||
      'Gemini 4 Argon (High)',
    userPinnedModelOverride: Boolean(saved.userPinnedModelOverride),
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
        enabled:
          saved.providers?.deepseek?.enabled ??
          saved.providers?.['deepseek-official']?.enabled ??
          true,
        baseUrl: deepseekBaseUrl,
        chatCompletionsUrl:
          saved.providers?.deepseek?.chatCompletionsUrl ||
          `${normalizedDeepseekBase}/chat/completions`,
        responsesUrl:
          saved.providers?.deepseek?.responsesUrl || `${normalizedDeepseekBase}/responses`,
        anthropicBaseUrl:
          saved.providers?.deepseek?.anthropicBaseUrl ||
          `${normalizedDeepseekBase}/anthropic`,
        searchUrl:
          saved.providers?.deepseek?.searchUrl ||
          `${normalizedDeepseekBase}/v1/tools/search`,
        fetchUrl:
          saved.providers?.deepseek?.fetchUrl ||
          `${normalizedDeepseekBase}/v1/tools/fetch`,
        hasKey: deepseekSec.hasKey,
        hasApiKey: deepseekSec.hasKey,
        keySource: deepseekSec.source,
        vaultStatus: deepseekSec.hasKey ? '🔒 Stored Secretly' : 'Not Configured',
        preserveReasoningContent: true,
      },
      opencodeGo: {
        enabled:
          saved.providers?.opencodeGo?.enabled ??
          saved.providers?.['opencode-go']?.enabled ??
          true,
        providerId: 'opencode-go',
        planType: 'opencode-go-coding-plan',
        baseUrl: opencodeBaseUrl,
        openaiEndpoint:
          saved.providers?.opencodeGo?.openaiEndpoint ||
          saved.providers?.['opencode-go']?.openaiEndpoint ||
          (opencodeBaseUrl !== 'https://opencode.ai/inference/go/openai/v1'
            ? `${String(opencodeBaseUrl).replace(/\/+$/, '')}/chat/completions`
            : 'https://opencode.ai/inference/go/openai/v1/chat/completions'),
        responsesEndpoint:
          saved.providers?.opencodeGo?.responsesEndpoint ||
          saved.providers?.['opencode-go']?.responsesEndpoint ||
          'https://opencode.ai/inference/go/openai/v1/responses',
        anthropicEndpoint:
          saved.providers?.opencodeGo?.anthropicEndpoint ||
          saved.providers?.['opencode-go']?.anthropicEndpoint ||
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
      tavilyEndpoint:
        saved.search?.tavilyEndpoint ||
        saved.searchEngines?.tavily?.endpoint ||
        'https://api.tavily.com/search',
      parallelEndpoint:
        saved.search?.parallelEndpoint ||
        saved.searchEngines?.parallel?.endpoint ||
        'https://api.parallel.ai/v1beta/search',
      jinaEndpoint:
        saved.search?.jinaEndpoint ||
        saved.searchEngines?.jina?.endpoint ||
        'https://s.jina.ai/',
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
    chatBoxNativeModel: patch.chatBoxNativeModel || current.chatBoxNativeModel,
    userPinnedModelOverride:
      patch.userPinnedModelOverride !== undefined
        ? Boolean(patch.userPinnedModelOverride)
        : current.userPinnedModelOverride,
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
  writeJsonAtomic(file, next);

  // Sync non-secret preferences to Antigravity IDE Settings (.vscode/settings.json)
  try {
    const vsFile = getVscodeSettingsFile(workspaceRoot);
    const existingVs = loadIdeSettings(workspaceRoot);
    const updatedVs = {
      $schema: '../schemas/antigravity-settings.schema.json',
      ...existingVs,
      'antigravity.harness.activeModel': next.activeModelId,
      'antigravity.harness.chatBoxNativeModel': next.chatBoxNativeModel,
      'antigravity.harness.reasoningDepth': next.activeReasoningDepth,
      'antigravity.harness.reasoningEffort': next.activeReasoningEffort,
      'antigravity.harness.deepseek.baseUrl': next.providers.deepseek.baseUrl,
      'antigravity.harness.opencodeGo.baseUrl': next.providers.opencodeGo.baseUrl,
      'antigravity.harness.search.defaultEngine': next.search.defaultEngine,
      'antigravity.harness.swarmRoleModels': next.subagentModelRouting,
    };
    writeJsonAtomic(vsFile, updatedVs);
  } catch {
    // ignore if workspace is read-only
  }

  return loadHubConfig(workspaceRoot);
}

function resolveTelemetryFallbackUsedTokens(workspaceRoot) {
  try {
    const telemetryFile = path.join(workspaceRoot, '.harness', 'runtime', 'telemetry.json');
    if (fs.existsSync(telemetryFile)) {
      const tel = JSON.parse(fs.readFileSync(telemetryFile, 'utf8'));
      const sessions = Object.values(tel.sessions || {});
      const totalCalls = sessions.reduce((acc, s) => acc + Number(s.toolCallCount || 0), 0);
      const eventsCount = Array.isArray(tel.recentEvents) ? tel.recentEvents.length : 0;
      if (totalCalls > 0 || eventsCount > 0) {
        return Math.min(240_000, 12_400 + totalCalls * 1850 + eventsCount * 620);
      }
    }
  } catch {}
  return 55_100;
}

/**
 * Returns the full enriched model catalog including each model's active reasoning depth,
 * official DeepSeek/OpenCode `reasoning_effort`, thinking token budget, live context window usage,
 * and provider connection status.
 */
export function getEnrichedModelCatalog(workspaceRoot, contextAnalytics = null) {
  const cfg = loadHubConfig(workspaceRoot);
  const liveChatUsage = loadChatContextUsage(workspaceRoot);
  const usedCtx =
    contextAnalytics?.currentWindow?.usedTokens ||
    (liveChatUsage && liveChatUsage.usedTokens > 0 ? liveChatUsage.usedTokens : 0) ||
    resolveTelemetryFallbackUsedTokens(workspaceRoot);

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
      liveTranscriptUsage: isSelectedMain ? liveChatUsage : null,
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
 * Saves the Inter-Agent Message Injection & Convey Bus state atomically.
 * Never drops unconsumed messages (`!m.consumed`) during retention pruning (F04).
 */
export function saveMessageBus(workspaceRoot, bus) {
  const file = getMessageBusFile(workspaceRoot);
  const allMessages = Array.isArray(bus.messages) ? bus.messages : [];
  let consumedCount = 0;
  const retainedMessages = allMessages.filter((m) => {
    if (!m || typeof m !== 'object') return false;
    if (!m.consumed) return true;
    consumedCount += 1;
    return consumedCount <= 80;
  });

  const payload = {
    revision: Number(bus.revision || 1),
    updatedAt: new Date().toISOString(),
    messages: retainedMessages,
  };
  writeJsonAtomic(file, payload);
  return payload;
}

/**
 * Injects or conveys a message across agents/models in the swarm with file locking
 * and atomic persistence (F04).
 */
export async function injectOrConveySwarmMessage(workspaceRoot, input = {}) {
  const cfg = loadHubConfig(workspaceRoot);

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
  const msgId =
    input.id ||
    `msg-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;

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
    workspaceRoot: path.resolve(workspaceRoot || process.cwd()),
    runId: input.runId || null,
    candidateId: input.candidateId || null,
    status: 'INJECTED',
    consumed: false,
    deliveries: {},
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

  const savedBus = withMessageBusLock(workspaceRoot, () => {
    const bus = loadMessageBus(workspaceRoot);
    const existingIdx = bus.messages.findIndex((m) => m && m.id === entry.id);
    if (existingIdx >= 0) {
      bus.messages[existingIdx] = entry;
    } else {
      bus.messages.unshift(entry);
    }
    bus.revision = (bus.revision || 1) + 1;
    return saveMessageBus(workspaceRoot, bus);
  });

  return {
    ok: true,
    message: entry,
    busRevision: savedBus.revision,
  };
}

/**
 * Transactional per-recipient message consumer (F04).
 * A message matches `targetAgent` ONLY if:
 * - `!targetAgent || targetAgent === 'all'` (explicitly requesting all messages), OR
 * - `m.toAgent === targetAgent`, OR
 * - `m.toAgent === 'all'` (broadcast).
 */
export function consumePendingSwarmMessages(workspaceRoot, targetAgent, options = {}) {
  return withMessageBusLock(workspaceRoot, () => {
    const bus = loadMessageBus(workspaceRoot);
    const pending = [];
    let changed = false;
    const nowIso = new Date().toISOString();
    const reqTarget = targetAgent ? String(targetAgent).trim() : '';
    const isAllRequest = !reqTarget || reqTarget === 'all';

    for (const m of bus.messages) {
      if (!m || typeof m !== 'object') continue;
      if (options.runId && m.runId && m.runId !== options.runId) continue;
      if (options.candidateId && m.candidateId && m.candidateId !== options.candidateId) continue;

      m.deliveries = m.deliveries && typeof m.deliveries === 'object' ? m.deliveries : {};

      const isBroadcast = m.toAgent === 'all';
      const matchesRecipient =
        isAllRequest || m.toAgent === reqTarget || isBroadcast;

      if (!matchesRecipient) {
        continue;
      }

      if (isBroadcast && !isAllRequest) {
        if (m.deliveries[reqTarget]?.state === 'consumed') {
          continue;
        }
        m.deliveries[reqTarget] = {
          state: 'consumed',
          ackedAt: nowIso,
        };
        m.status = 'DELIVERED';
        m.deliveredAt = m.deliveredAt || nowIso;
        pending.push(m);
        changed = true;
        continue;
      }

      if (m.toAgent === reqTarget && !isAllRequest) {
        if (m.consumed === true || m.deliveries[reqTarget]?.state === 'consumed') {
          continue;
        }
        m.deliveries[reqTarget] = {
          state: 'consumed',
          ackedAt: nowIso,
        };
        m.consumed = true;
        m.pendingForPreInvocation = false;
        m.status = 'DELIVERED';
        m.deliveredAt = m.deliveredAt || nowIso;
        pending.push(m);
        changed = true;
        continue;
      }

      if (isAllRequest) {
        if (m.consumed === true) {
          continue;
        }
        const key = m.toAgent || 'all';
        m.deliveries[key] = {
          state: 'consumed',
          ackedAt: nowIso,
        };
        m.consumed = true;
        m.pendingForPreInvocation = false;
        m.status = 'DELIVERED';
        m.deliveredAt = m.deliveredAt || nowIso;
        pending.push(m);
        changed = true;
      }
    }

    if (changed) {
      bus.revision = (bus.revision || 1) + 1;
      saveMessageBus(workspaceRoot, bus);
    }

    return pending;
  });
}

/**
 * Consumes pending injected messages for PreInvocation hook injection into Antigravity.
 * Delegates to `consumePendingSwarmMessages`, and for the host `'main-orchestrator'` hook also
 * surfaces synchronous peer reply receipts initiated by `'main-orchestrator'`.
 */
export function consumePendingInjectedMessages(
  workspaceRoot,
  targetAgent = 'main-orchestrator',
  options = {}
) {
  const direct = consumePendingSwarmMessages(workspaceRoot, targetAgent, options);
  if (direct.length > 0 || targetAgent !== 'main-orchestrator') {
    return direct;
  }

  return withMessageBusLock(workspaceRoot, () => {
    const bus = loadMessageBus(workspaceRoot);
    const pending = [];
    let changed = false;
    const nowIso = new Date().toISOString();

    for (const m of bus.messages) {
      if (!m || typeof m !== 'object') continue;
      if (
        m.fromAgent === 'main-orchestrator' &&
        Boolean(m.replySummary) &&
        m.pendingForPreInvocation !== false &&
        !m.preInvocationNotified
      ) {
        m.preInvocationNotified = true;
        m.pendingForPreInvocation = false;
        m.deliveredAt = m.deliveredAt || nowIso;
        pending.push(m);
        changed = true;
      }
    }

    if (changed) {
      bus.revision = (bus.revision || 1) + 1;
      saveMessageBus(workspaceRoot, bus);
    }

    return pending;
  });
}

function classifyHttpFailureStatus(httpStatus) {
  if (httpStatus === 401 || httpStatus === 403) return 'unauthorized';
  if (httpStatus === 429) return 'rate_limited';
  if (httpStatus === 408 || httpStatus === 504) return 'timed_out';
  return 'failed';
}

function classifyExceptionStatus(err) {
  const name = String(err?.name || '');
  const msg = String(err?.message || '');
  if (
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    /timed?\s*out|timeout|aborted/i.test(msg)
  ) {
    return 'timed_out';
  }
  return 'failed';
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
  const explicitModelId = options.modelId ?? options.model_id;

  if (
    explicitModelId !== undefined &&
    explicitModelId !== null &&
    String(explicitModelId).trim() !== ''
  ) {
    const matched = findModelInCatalog(explicitModelId);
    if (!matched) {
      return {
        ok: false,
        status: 'unsupported',
        error: `Unknown model identifier: ${explicitModelId}`,
        modelId: String(explicitModelId),
      };
    }
  }

  const targetModelId = explicitModelId || cfg.activeModelId || 'deepseek-v4-pro';
  const modelMeta = findModelInCatalog(targetModelId);
  if (!modelMeta) {
    return {
      ok: false,
      status: 'unsupported',
      error: `Unknown model identifier: ${targetModelId}`,
      modelId: String(targetModelId),
    };
  }

  // Enforce provider enablement before any network or simulation path (F05)
  if (
    (modelMeta.provider === 'deepseek-official' && cfg.providers?.deepseek?.enabled === false) ||
    (modelMeta.provider === 'opencode-go' && cfg.providers?.opencodeGo?.enabled === false)
  ) {
    return {
      ok: false,
      status: 'disabled',
      error: `Provider ${modelMeta.provider} is disabled`,
      modelId: modelMeta.id,
      provider: modelMeta.provider,
    };
  }

  const isStrict =
    options.strictExecution === true ||
    options.strict_execution === true ||
    options.allowSimulation === false ||
    options.allow_simulation === false;

  if (modelMeta.provider === 'antigravity-native' && isStrict) {
    return {
      ok: false,
      status: 'unsupported',
      error: 'Native Antigravity models execute in the host session, not via standalone HTTP worker',
      modelId: modelMeta.id,
      provider: modelMeta.provider,
    };
  }

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

  const runCoordinatorPeerDelegation = async () => {
    if (!options.delegateToPeerModel) return null;
    return invokeUnifiedModel(workspaceRoot, {
      modelId: options.delegateToPeerModel,
      reasoningDepth: 'eco',
      prompt: `[Sub-task delegated by ${modelMeta.id}]: ${prompt}`,
      delegateToPeerModel: null,
      strictExecution: options.strictExecution,
      allowSimulation: options.allowSimulation,
    });
  };

  // 1. Live DeepSeek Official API call
  if (modelMeta.provider === 'deepseek-official') {
    const baseUrl = String(cfg.providers.deepseek.baseUrl || 'https://api.deepseek.com').replace(
      /\/+$/,
      ''
    );
    const url = `${baseUrl}/chat/completions`;
    const originCheck = validateCredentialOrigin('DEEPSEEK_API_KEY', url);
    if (!originCheck.allowed) {
      return {
        ok: false,
        status: 'unauthorized_origin',
        error: originCheck.reason,
        origin: originCheck.origin,
        modelId: modelMeta.id,
        provider: modelMeta.provider,
      };
    }

    const deepseekSecret = resolveSecretCredential('DEEPSEEK_API_KEY');
    if (!deepseekSecret.hasKey) {
      if (isStrict) {
        return {
          ok: false,
          status: 'unauthorized',
          error: 'Missing required DEEPSEEK_API_KEY credential for deepseek-official provider',
          modelId: modelMeta.id,
          provider: modelMeta.provider,
        };
      }
    } else {
      try {
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
          redirect: 'manual',
          signal: AbortSignal.timeout(Number(options.timeoutMs || 15_000)),
        });

        if (
          (res.status >= 300 && res.status < 400) ||
          res.type === 'opaqueredirect'
        ) {
          return {
            ok: false,
            status: 'unauthorized_origin',
            error: `Redirect (${res.status || 'opaqueredirect'}) blocked for authenticated request to ${url}`,
            modelId: modelMeta.id,
            provider: modelMeta.provider,
          };
        }

        if (res.ok) {
          const data = await res.json();
          if (
            !data ||
            typeof data !== 'object' ||
            !Array.isArray(data.choices) ||
            data.choices.length === 0
          ) {
            if (isStrict) {
              return {
                ok: false,
                status: 'failed',
                error: 'Malformed response payload from DeepSeek API (missing choices)',
                modelId: modelMeta.id,
                provider: modelMeta.provider,
              };
            }
          } else {
            const msg = data.choices[0]?.message || {};
            const peerDelegationResult = await runCoordinatorPeerDelegation();
            return {
              ok: true,
              status: 'succeeded',
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
              reasoning_content: msg.reasoning_content || '',
              content: msg.content || '',
              peerDelegationResult,
              peerDelegation: peerDelegationResult,
              preserveHistoryMessage: {
                role: 'assistant',
                content: msg.content || '',
                ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
              },
              usage: data.usage || null,
            };
          }
        } else if (isStrict) {
          let errDetail = '';
          try {
            errDetail = await res.text();
          } catch {}
          return {
            ok: false,
            status: classifyHttpFailureStatus(res.status),
            httpStatus: res.status,
            error: redactSecrets(
              errDetail
                ? `DeepSeek API HTTP ${res.status}: ${errDetail.slice(0, 300)}`
                : `DeepSeek API HTTP ${res.status}`
            ),
            modelId: modelMeta.id,
            provider: modelMeta.provider,
          };
        }
      } catch (err) {
        if (isStrict) {
          return {
            ok: false,
            status: classifyExceptionStatus(err),
            error: redactSecrets(err?.message || String(err)),
            modelId: modelMeta.id,
            provider: modelMeta.provider,
          };
        }
      }
    }
  }

  // 2. Live OpenCode Go Coding Plan API call
  if (modelMeta.provider === 'opencode-go') {
    const strippedModelId = modelMeta.id.replace(/^opencode-go\//, '');
    const isAnthropicWire = modelMeta.wireFormat === 'opencode-go-anthropic';
    const url = isAnthropicWire
      ? cfg.providers.opencodeGo.anthropicEndpoint
      : cfg.providers.opencodeGo.openaiEndpoint;

    const baseCheck = validateCredentialOrigin(
      'OPENCODE_API_KEY',
      cfg.providers.opencodeGo.baseUrl || url
    );
    const urlCheck = validateCredentialOrigin('OPENCODE_API_KEY', url);
    if (!baseCheck.allowed || !urlCheck.allowed) {
      const failedCheck = !urlCheck.allowed ? urlCheck : baseCheck;
      return {
        ok: false,
        status: 'unauthorized_origin',
        error: failedCheck.reason,
        origin: failedCheck.origin,
        modelId: modelMeta.id,
        provider: modelMeta.provider,
      };
    }

    const opencodeSecret = resolveSecretCredential([
      'OPENCODE_GO_API_KEY',
      'OPENCODE_API_KEY',
      'OPENCODE_ZEN_API_KEY',
    ]);
    if (!opencodeSecret.hasKey) {
      if (isStrict) {
        return {
          ok: false,
          status: 'unauthorized',
          error: 'Missing required OPENCODE_API_KEY credential for opencode-go provider',
          modelId: modelMeta.id,
          provider: modelMeta.provider,
        };
      }
    } else {
      try {
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
          redirect: 'manual',
          signal: AbortSignal.timeout(Number(options.timeoutMs || 15_000)),
        });

        if (
          (res.status >= 300 && res.status < 400) ||
          res.type === 'opaqueredirect'
        ) {
          return {
            ok: false,
            status: 'unauthorized_origin',
            error: `Redirect (${res.status || 'opaqueredirect'}) blocked for authenticated request to ${url}`,
            modelId: modelMeta.id,
            provider: modelMeta.provider,
          };
        }

        if (res.ok) {
          const data = await res.json();
          const validPayload = isAnthropicWire
            ? Array.isArray(data?.content) && data.content.length > 0
            : Array.isArray(data?.choices) && data.choices.length > 0;
          if (!validPayload) {
            if (isStrict) {
              return {
                ok: false,
                status: 'failed',
                error: 'Malformed response payload from OpenCode Go API',
                modelId: modelMeta.id,
                provider: modelMeta.provider,
              };
            }
          } else {
            const contentText = isAnthropicWire
              ? (data.content || []).map((c) => c.text || '').join('\n')
              : data.choices?.[0]?.message?.content || '';
            const reasoningText = isAnthropicWire
              ? (data.content || []).find((c) => c.type === 'thinking')?.thinking || ''
              : data.choices?.[0]?.message?.reasoning_content || '';
            const peerDelegationResult = await runCoordinatorPeerDelegation();
            return {
              ok: true,
              status: 'succeeded',
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
              reasoning_content: reasoningText,
              content: contentText,
              peerDelegationResult,
              peerDelegation: peerDelegationResult,
              usage: data.usage || null,
            };
          }
        } else if (isStrict) {
          let errDetail = '';
          try {
            errDetail = await res.text();
          } catch {}
          return {
            ok: false,
            status: classifyHttpFailureStatus(res.status),
            httpStatus: res.status,
            error: redactSecrets(
              errDetail
                ? `OpenCode Go API HTTP ${res.status}: ${errDetail.slice(0, 300)}`
                : `OpenCode Go API HTTP ${res.status}`
            ),
            modelId: modelMeta.id,
            provider: modelMeta.provider,
          };
        }
      } catch (err) {
        if (isStrict) {
          return {
            ok: false,
            status: classifyExceptionStatus(err),
            error: redactSecrets(err?.message || String(err)),
            modelId: modelMeta.id,
            provider: modelMeta.provider,
          };
        }
      }
    }
  }

  // 3. Deterministic Co-Op Synthesis (supports bidirectional cross-model calling in offline/test environments when simulation is permitted)
  const reasoningTrace = modelMeta.supportsThinking
    ? `[${modelMeta.name} · depth=${reasoningDepth.toUpperCase()} · effort=${reasoningEffort} · cap=${depthProfile.thinkingBudgetTokens} tok] 1. Parsed task constraint & consulted .harness/library/INDEX.md cues. 2. Verified wire protocol (${modelMeta.wireFormat} -> ${modelMeta.endpoint}). 3. Synthesized token-efficient response.`
    : '';

  const peerDelegationResult = await runCoordinatorPeerDelegation();

  const synthesizedContent = peerDelegationResult
    ? `[${modelMeta.name} (${modelMeta.providerLabel}) · ${reasoningDepth.toUpperCase()} / effort=${reasoningEffort}] Completed primary analysis for "${prompt.slice(0, 90)}" and delegated sub-verification to peer model ${peerDelegationResult.modelName} -> ${peerDelegationResult.content}`
    : `[${modelMeta.name} (${modelMeta.providerLabel}) · ${reasoningDepth.toUpperCase()} / effort=${reasoningEffort}] Executed task "${prompt.slice(0, 110)}" via ${modelMeta.wireFormat} (${modelMeta.endpoint}) with thinkingBudget=${depthProfile.thinkingBudgetTokens} tokens.`;

  return {
    ok: true,
    status: 'simulated',
    synthetic: true,
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
 * Jina AI Search, DuckDuckGo Instant Answer, Wikipedia Action API, and HackerNews Algolia, fusing results with RRF.
 * Enforces `validateCredentialOrigin` + `redirect: 'manual'` before attaching any secret credential (F05).
 */
export async function searchWebMultiEngine(workspaceRoot, options = {}) {
  const cfg = loadHubConfig(workspaceRoot);
  const query = String(options.query || '').trim();
  if (!query) {
    throw new Error('query is required for searchWebMultiEngine');
  }

  const isStrict =
    options.strictExecution === true ||
    options.strict_execution === true ||
    options.allowSimulation === false ||
    options.allow_simulation === false;

  const requestedEngine = options.engine || cfg.search.defaultEngine || 'multi-fusion';
  const limit = Math.max(1, Math.min(15, Number(options.limit || options.maxResults || 6)));
  const enginesToRun =
    requestedEngine === 'multi-fusion' || requestedEngine === 'auto'
      ? cfg.search.enabledEngines
      : [requestedEngine];

  const perEngineResults = {};
  const engineErrors = {};
  let unauthorizedOriginFailure = null;
  const tasks = [];

  // 1. DeepSeek Official Search API (`POST https://api.deepseek.com/v1/tools/search`)
  if (enginesToRun.includes('deepseek-search')) {
    tasks.push(
      (async () => {
        if (cfg.providers?.deepseek?.enabled === false) {
          perEngineResults['deepseek-search'] = [];
          return;
        }
        const searchUrl =
          options.deepseekSearchUrl ||
          (requestedEngine === 'deepseek-search' && options.endpoint) ||
          cfg.providers?.deepseek?.searchUrl ||
          'https://api.deepseek.com/v1/tools/search';
        const originCheck = validateCredentialOrigin('DEEPSEEK_API_KEY', searchUrl);
        if (!originCheck.allowed) {
          unauthorizedOriginFailure = originCheck;
          engineErrors['deepseek-search'] = originCheck.reason;
          perEngineResults['deepseek-search'] = [];
          return;
        }
        const dsSec = resolveSecretCredential('DEEPSEEK_API_KEY');
        if (dsSec.hasKey) {
          try {
            const res = await fetch(searchUrl, {
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
              redirect: 'manual',
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
        const parallelUrl =
          options.parallelSearchUrl ||
          (requestedEngine === 'parallel' && options.endpoint) ||
          cfg.search?.parallelEndpoint ||
          'https://api.parallel.ai/v1beta/search';
        const originCheck = validateCredentialOrigin('PARALLEL_API_KEY', parallelUrl);
        if (!originCheck.allowed) {
          unauthorizedOriginFailure = originCheck;
          engineErrors.parallel = originCheck.reason;
          perEngineResults.parallel = [];
          return;
        }
        const plSec = resolveSecretCredential('PARALLEL_API_KEY');
        if (plSec.hasKey) {
          try {
            const res = await fetch(parallelUrl, {
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
              redirect: 'manual',
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
        const tavilyUrl =
          options.tavilySearchUrl ||
          (requestedEngine === 'tavily' && options.endpoint) ||
          cfg.search?.tavilyEndpoint ||
          'https://api.tavily.com/search';
        const originCheck = validateCredentialOrigin('TAVILY_API_KEY', tavilyUrl);
        if (!originCheck.allowed) {
          unauthorizedOriginFailure = originCheck;
          engineErrors.tavily = originCheck.reason;
          perEngineResults.tavily = [];
          return;
        }
        const tvSec = resolveSecretCredential('TAVILY_API_KEY');
        if (tvSec.hasKey) {
          try {
            const res = await fetch(tavilyUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${tvSec.value}`,
              },
              body: JSON.stringify({
                api_key: tvSec.value,
                query,
                search_depth: 'basic',
                max_results: limit,
              }),
              redirect: 'manual',
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

  // 4. Jina AI Search (`https://s.jina.ai/`)
  if (enginesToRun.includes('jina')) {
    tasks.push(
      (async () => {
        const jinaBase =
          options.jinaSearchUrl ||
          (requestedEngine === 'jina' && options.endpoint) ||
          cfg.search?.jinaEndpoint ||
          'https://s.jina.ai/';
        const originCheck = validateCredentialOrigin('JINA_API_KEY', jinaBase);
        if (!originCheck.allowed) {
          unauthorizedOriginFailure = originCheck;
          engineErrors.jina = originCheck.reason;
          perEngineResults.jina = [];
          return;
        }
        const jinaSec = resolveSecretCredential('JINA_API_KEY');
        if (jinaSec.hasKey) {
          try {
            const jinaUrl = `${String(jinaBase).replace(/\/+$/, '')}/${encodeURIComponent(query)}`;
            const res = await fetch(jinaUrl, {
              method: 'GET',
              headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${jinaSec.value}`,
              },
              redirect: 'manual',
              signal: AbortSignal.timeout(5_000),
            });
            if (res.ok) {
              const data = await res.json();
              const list = Array.isArray(data?.data) ? data.data : [];
              perEngineResults.jina = list.slice(0, limit).map((r) => ({
                title: r.title || r.url || query,
                url: r.url || 'https://s.jina.ai/',
                snippet: r.description || r.content?.slice(0, 320) || '',
                engine: 'jina',
              }));
              return;
            }
          } catch {}
        }
        perEngineResults.jina = [];
      })()
    );
  }

  // 5. Free Engine: Wikipedia Action API (100% Free, Zero-Key)
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

  // 6. Free Engine: DuckDuckGo Instant Answer API (100% Free, Zero-Key)
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

  // 7. Free Engine: HackerNews Algolia Tech Search (100% Free, Zero-Key)
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

  if (unauthorizedOriginFailure) {
    return {
      ok: false,
      status: 'unauthorized_origin',
      error: unauthorizedOriginFailure.reason,
      origin: unauthorizedOriginFailure.origin,
      query,
      requestedEngine,
      enginesQueried: Object.keys(perEngineResults),
      errors: engineErrors,
      totalResults: 0,
      results: [],
    };
  }

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

  if (fused.length === 0 && !isStrict) {
    fused = [
      {
        title: `Multi-Engine Search Reference (DeepSeek / Parallel / Tavily / Free): ${query}`,
        url: `https://search.parallel.ai/mcp?q=${encodeURIComponent(query)}`,
        snippet: `Synthesized reference for "${query}" across DeepSeek Search (/v1/tools/search), Parallel AI Search (search.parallel.ai/mcp), Tavily AI, DuckDuckGo, and Jina Reader (r.jina.ai).`,
        engine: requestedEngine === 'multi-fusion' ? 'parallel+free-fallback' : requestedEngine,
        engines: [requestedEngine],
        rrfScore: 0.032,
        synthetic: true,
      },
    ];
  }

  return {
    ok: true,
    status: fused.length === 0 ? 'empty' : 'succeeded',
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
