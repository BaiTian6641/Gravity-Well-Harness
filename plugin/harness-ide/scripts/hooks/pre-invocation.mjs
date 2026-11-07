#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { HarnessKnowledgeEngine } from '../rag-engine.mjs';
import {
  consumePendingInjectedMessages,
  getEnrichedModelCatalog,
  invokeUnifiedModel,
  loadHubConfig,
  resolveModelMeta,
  saveHubConfig
} from '../model-hub.mjs';

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const SHORTHAND_MODEL_PREFIXES = [
  { regex: /^@(deepseek-v4-pro|deepseek-reasoner|deepseek)\b\s*/i, modelId: 'deepseek-v4-pro' },
  { regex: /^@(deepseek-flash|deepseek-chat)\b\s*/i, modelId: 'deepseek-flash' },
  { regex: /^@(grok-4\.7|grok)\b\s*/i, modelId: 'opencode-go/grok-4.7' },
  { regex: /^@(gpt-6-luna|gpt-6|luna)\b\s*/i, modelId: 'opencode-go/gpt-6-luna' },
  { regex: /^@(kimi-k3\.1-pro|kimi-pro)\b\s*/i, modelId: 'opencode-go/kimi-k3.1-pro' },
  { regex: /^@(kimi-k2\.7-code|kimi-code|kimi)\b\s*/i, modelId: 'opencode-go/kimi-k2.7-code' },
  { regex: /^@(glm-5\.3|glm)\b\s*/i, modelId: 'opencode-go/glm-5.3' },
  { regex: /^@(mimo-v2\.6-pro|mimo)\b\s*/i, modelId: 'opencode-go/mimo-v2.6-pro' },
  { regex: /^@(minimax-m3\.1-flash|minimax)\b\s*/i, modelId: 'opencode-go/minimax-m3.1-flash' },
  { regex: /^@(qwen3\.7-max|qwen)\b\s*/i, modelId: 'opencode-go/qwen3.7-max' },
  { regex: /^@(longcat-2\.0|longcat)\b\s*/i, modelId: 'opencode-go/longcat-2.0' },
  { regex: /^@(step-5-preview|step)\b\s*/i, modelId: 'opencode-go/step-5-preview' }
];

async function main() {
  const input = readStdinJson();
  const workspaceRoot =
    (Array.isArray(input.workspacePaths) && input.workspacePaths[0]) || process.cwd();

  const harnessDir = path.join(workspaceRoot, '.harness');
  if (!fs.existsSync(harnessDir)) {
    process.stdout.write(JSON.stringify({}) + '\n');
    return;
  }

  try {
    const engine = new HarnessKnowledgeEngine(workspaceRoot);
    const snapLock = engine.getActiveSnapshotLock();
    let hubCfg = loadHubConfig(workspaceRoot);
    const userPrompt = String(input.lastUserInput || input.prompt || '').trim();
    const injectSteps = [];

    // 1. In-Chat Command: `/model <modelId> [eco|balanced|deep]` or `/models` directly inside Antigravity Chat
    const modelCmdMatch = userPrompt.match(/^\/models?(?:\s+(\S+))?(?:\s+(eco|balanced|deep))?\s*$/i);
    if (modelCmdMatch) {
      const requestedModelArg = modelCmdMatch[1];
      const requestedDepthArg = modelCmdMatch[2]?.toLowerCase();
      if (requestedModelArg && requestedModelArg.toLowerCase() !== 'list') {
        const resolved = resolveModelMeta(requestedModelArg);
        const nextDepth =
          requestedDepthArg ||
          hubCfg.modelReasoningDepths?.[resolved.id] ||
          resolved.defaultReasoningDepth ||
          'balanced';
        hubCfg = saveHubConfig(workspaceRoot, {
          activeModelId: resolved.id,
          activeReasoningDepth: nextDepth,
          modelReasoningDepths: { [resolved.id]: nextDepth }
        });
      }
      const catalog = getEnrichedModelCatalog(workspaceRoot);
      const tableRows = catalog
        .map(
          (m) =>
            `| ${m.id === hubCfg.activeModelId ? '⭐ **' + m.name + '**' : m.name} | \`${m.id}\` | ${m.providerLabel} | **${m.reasoningDepth.toUpperCase()}** (\`effort=${m.reasoningEffort}\`) | \`${Math.round((m.usedContextTokens || 55100) / 1000)}k / ${m.contextWindowTokens >= 1000000 ? (m.contextWindowTokens / 1000000).toFixed(1) + 'M' : Math.round(m.contextWindowTokens / 1000) + 'k'}\` (${m.contextUsedPct}%) |`
        )
        .join('\n');
      const tableMd = [
        `### 🤖 Antigravity Inline Model Roster & Live Context Usage`,
        `| Model Name | Model ID | Provider | Reasoning Depth · Effort | Context Usage |`,
        `| :--- | :--- | :--- | :--- | :--- |`,
        tableRows
      ].join('\n');
      injectSteps.push({
        systemMessage: {
          systemMessage: `[Antigravity Inline Model Switcher] Active model is now '${hubCfg.activeModelId}' (depth='${hubCfg.activeReasoningDepth}').`,
          metadata: {
            user_markdown: tableMd
          }
        }
      });
    }

    // 2. In-Chat Direct Model Routing (`@deepseek ...`, `@kimi ...`, `@glm ...`, `@grok ...`, `@qwen ...`)
    for (const entry of SHORTHAND_MODEL_PREFIXES) {
      if (entry.regex.test(userPrompt)) {
        const cleanTask = userPrompt.replace(entry.regex, '').trim() || userPrompt;
        const reply = await invokeUnifiedModel(workspaceRoot, {
          modelId: entry.modelId,
          reasoningDepth: hubCfg.activeReasoningDepth || 'balanced',
          prompt: cleanTask
        });
        const inlineReplyMd = [
          `> ⚡ **Direct Peer Model Execution (\`${reply.modelName}\` · \`${reply.reasoningDepth.toUpperCase()} / effort=${reply.reasoningEffort}\`)**`,
          reply.reasoningContent ? `> 🧠 *Reasoning Trace*: \`${reply.reasoningContent}\`` : '',
          `> 💬 **Output**: ${reply.content}`
        ]
          .filter(Boolean)
          .join('\n');
        injectSteps.push({
          systemMessage: {
            systemMessage: `[Peer Model '${reply.modelId}' Output for Current Turn]:\nReasoning: ${reply.reasoningContent}\nOutput: ${reply.content}`,
            metadata: {
              user_markdown: inlineReplyMd
            }
          }
        });
        break;
      }
    }

    // 3. Always-On Compact Inline Model + Reasoning Depth + Context Usage Status Pill in Antigravity IDE Chat
    const profile = engine.resolveReasoningProfile();
    const catalog = getEnrichedModelCatalog(workspaceRoot);
    const activeModel =
      catalog.find((m) => m.id === hubCfg.activeModelId) || catalog[0] || {};
    const depthUpper = String(
      activeModel.reasoningDepth || profile.reasoningDepth || 'balanced'
    ).toUpperCase();
    const effort = activeModel.reasoningEffort || 'high';
    const maxWin = activeModel.contextWindowTokens || 1_000_000;
    const maxWinStr =
      maxWin >= 1_000_000 ? `${(maxWin / 1_000_000).toFixed(1)}M` : `${Math.round(maxWin / 1000)}k`;
    const usedStr = `${((activeModel.usedContextTokens || 55100) / 1000).toFixed(1)}k`;
    const pct = Number(activeModel.contextUsedPct || 5.5);

    const statusBarMd = `🤖 **Model**: \`${activeModel.name || hubCfg.activeModelId}\` · 🧠 **Depth**: \`${depthUpper} (effort=${effort}, cap=${profile.thinkingBudgetTokens})\` · 📊 **Context**: \`${usedStr} / ${maxWinStr} (${pct}%)\` · 🔒 **Snapshot**: \`${snapLock?.active ? snapLock.snapshotId : 'Unlocked'}\` · [Swarm Monitor](sidecar://harness-ide-monitor/)`;

    injectSteps.push({
      systemMessage: {
        systemMessage: `[Active Harness Model & Context Status] Model='${activeModel.id}' (${activeModel.providerLabel}, depth=${depthUpper}, effort=${effort}, context=${usedStr}/${maxWinStr} [${pct}%]). You can call 'harness_model_invoke' or 'invoke_subagent' (deepseek-agent / opencode-go-agent) to delegate tasks across DeepSeek Official and OpenCode Go models.`,
        metadata: {
          user_markdown: statusBarMd
        }
      }
    });

    // 4. Snapshot Isolation Guardrail
    if (snapLock && snapLock.active) {
      const warning = `[Harness² Snapshot Isolation & Token Guardrail] Active Snapshot Lock '${snapLock.snapshotId}' (cutoff: ${snapLock.cutoffTimestamp}, domain: ${snapLock.domain}, K=${snapLock.k} ${snapLock.mode}) | Active Model: '${hubCfg.activeModelId}' | Reasoning Depth: '${profile.reasoningDepth}' (thinkingCap=${profile.thinkingBudgetTokens}, proberModel=${profile.proberModelTier}, maxSteps=${profile.maxProbeSteps}). All RAG queries are locked to this snapshot. Do NOT promote notes to 'status: active' until Compose finishes.`;
      injectSteps.push({ ephemeralMessage: warning });
    }

    // 5. Pending Swarm Message Bus Injections
    const pendingMessages = consumePendingInjectedMessages(workspaceRoot, 'main-orchestrator');
    for (const msg of pendingMessages) {
      injectSteps.push({
        ephemeralMessage: `[Swarm Message Injection · ${msg.direction}] From ${msg.fromAgent} (${msg.fromModel}) → ${msg.toAgent} (${msg.toModel}, depth=${msg.reasoningDepth}): ${msg.content}`
      });
    }

    if (injectSteps.length > 0) {
      process.stdout.write(JSON.stringify({ injectSteps }) + '\n');
      return;
    }

    process.stdout.write(JSON.stringify({}) + '\n');
  } catch {
    process.stdout.write(JSON.stringify({}) + '\n');
  }
}

main();
