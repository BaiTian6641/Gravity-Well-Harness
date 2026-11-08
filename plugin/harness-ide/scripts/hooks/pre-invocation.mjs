#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HarnessKnowledgeEngine } from '../rag-engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoModelHubPath = path.resolve(__dirname, '../../../../src/model-hub.mjs');
const pluginModelHubPath = path.resolve(__dirname, '../model-hub.mjs');
const repoResiliencePath = path.resolve(__dirname, '../../../../src/context-resilience.mjs');
const pluginResiliencePath = path.resolve(__dirname, '../context-resilience.mjs');
const {
  consumePendingInjectedMessages,
  getEnrichedModelCatalog,
  invokeUnifiedModel,
  loadHubConfig,
  resolveModelMeta,
  saveHubConfig,
  syncChatBoxModelAndTranscript,
} = await import(
  pathToFileURL(fs.existsSync(repoModelHubPath) ? repoModelHubPath : pluginModelHubPath).href
);
const { ContextResilienceManager } = await import(
  pathToFileURL(fs.existsSync(repoResiliencePath) ? repoResiliencePath : pluginResiliencePath).href
);

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
    const liveUsage =
      typeof syncChatBoxModelAndTranscript === 'function'
        ? syncChatBoxModelAndTranscript(workspaceRoot, {
            modelName: input.modelName,
            transcriptPath: input.transcriptPath,
            conversationId: input.conversationId,
          })
        : null;

    const engine = new HarnessKnowledgeEngine(workspaceRoot);
    const snapLock = engine.getActiveSnapshotLock();
    let hubCfg = loadHubConfig(workspaceRoot);
    const userPrompt = String(input.lastUserInput || input.prompt || '').trim();
    const injectSteps = [];

    // 1. In-Chat Command: `/usage`, `/models`, or `/model <modelId> [eco|balanced|deep]` directly inside Antigravity Chat
    const usageCmdMatch = userPrompt.match(/^\/(usage|models?)(?:\s+(\S+))?(?:\s+(eco|balanced|deep))?\s*$/i);
    if (usageCmdMatch) {
      const cmdVerb = usageCmdMatch[1]?.toLowerCase();
      const requestedModelArg = usageCmdMatch[2];
      const requestedDepthArg = usageCmdMatch[3]?.toLowerCase();
      if (
        cmdVerb !== 'usage' &&
        requestedModelArg &&
        requestedModelArg.toLowerCase() !== 'list'
      ) {
        const isAutoReset =
          requestedModelArg.toLowerCase() === 'auto' ||
          requestedModelArg.toLowerCase() === 'reset';
        const resolved = resolveModelMeta(
          isAutoReset ? hubCfg.chatBoxNativeModel || 'gemini-4-argon-high' : requestedModelArg
        );
        const nextDepth =
          requestedDepthArg ||
          hubCfg.modelReasoningDepths?.[resolved.id] ||
          resolved.defaultReasoningDepth ||
          'balanced';
        hubCfg = saveHubConfig(workspaceRoot, {
          activeModelId: resolved.id,
          activeReasoningDepth: nextDepth,
          userPinnedModelOverride: !isAutoReset,
          modelReasoningDepths: { [resolved.id]: nextDepth }
        });
      }
      const catalog = getEnrichedModelCatalog(workspaceRoot);
      const activeMeta =
        catalog.find((m) => m.id === hubCfg.activeModelId) || catalog[0] || {};
      const usedTok = activeMeta.usedContextTokens || liveUsage?.usedTokens || 55_100;
      const winTok = activeMeta.contextWindowTokens || 1_000_000;
      const pctUsed = Number(((usedTok / winTok) * 100).toFixed(1));
      const filledBlocks = Math.min(20, Math.max(1, Math.round((pctUsed / 100) * 20)));
      const progressBar = `${'█'.repeat(filledBlocks)}${'░'.repeat(20 - filledBlocks)}`;
      const routing = hubCfg.subagentModelRouting || {};

      const roleRows = [
        `| **Main Orchestrator (Chat Box)** | \`main-orchestrator\` | \`${hubCfg.chatBoxNativeModel || activeMeta.name}\` → \`${activeMeta.id}\` | **${String(activeMeta.reasoningDepth || 'balanced').toUpperCase()}** |`,
        `| **Harness² Proposer** | \`harness-proposer\` | \`${routing.proposerModelId || 'deepseek-v4-pro'}\` | **DEEP** |`,
        `| **RAG Researcher** | \`rag-researcher\` | \`${routing.ragResearcherModelId || 'deepseek-flash'}\` | **ECO / BALANCED** |`,
        `| **Branched Prober #1** | \`harness-prober-1\` | \`${routing.proberAModelId || 'opencode-go/kimi-k2.7-code'}\` | **BALANCED** |`,
        `| **Branched Prober #2** | \`harness-prober-2\` | \`${routing.proberBModelId || 'opencode-go/glm-5.3'}\` | **BALANCED** |`,
        `| **Branched Prober #3** | \`harness-prober-3\` | \`${routing.proberCModelId || 'opencode-go/gpt-6-luna'}\` | **BALANCED** |`,
        `| **Contrastive Composer** | \`harness-composer\` | \`${routing.composerModelId || 'opencode-go/grok-4.7'}\` | **DEEP** |`,
      ].join('\n');

      const tableRows = catalog
        .map(
          (m) =>
            `| ${m.id === hubCfg.activeModelId ? '⭐ **' + m.name + '**' : m.name} | \`${m.id}\` | ${m.providerLabel} | **${m.reasoningDepth.toUpperCase()}** (\`effort=${m.reasoningEffort}\`) | \`${Math.round((m.usedContextTokens || 55100) / 1000)}k / ${m.contextWindowTokens >= 1000000 ? (m.contextWindowTokens / 1000000).toFixed(1) + 'M' : Math.round(m.contextWindowTokens / 1000) + 'k'}\` (${m.contextUsedPct}%) | ${m.authStatus} |`
        )
        .join('\n');

      const transcriptDetailLine =
        liveUsage && liveUsage.steps > 0
          ? `> 📜 **Live Transcript (\`transcript.jsonl\`)**: \`${liveUsage.turns} turns\` · \`${liveUsage.steps} steps\` · User: \`${liveUsage.userTokens} tok\` · Assistant: \`${liveUsage.assistantTokens} tok\` · Thinking: \`${liveUsage.thinkingTokens} tok\` · Tool Results: \`${liveUsage.toolResultTokens} tok\``
          : `> 📜 **Context Telemetry**: \`${Math.round(usedTok / 1000)}k / ${winTok >= 1000000 ? (winTok / 1000000).toFixed(1) + 'M' : Math.round(winTok / 1000) + 'k'}\` (\`${pctUsed}%\`) · DeepSeek Vault: \`${hubCfg.providers?.deepseek?.vaultStatus || 'Ready'}\` · OpenCode Go: \`${hubCfg.providers?.opencodeGo?.vaultStatus || 'Ready'}\``;

      const tableMd = [
        `### 📊 Antigravity View Usage, Sub-Agent Multi-Model Routing & Model Roster`,
        `> **Context Window**: \`[${progressBar}] ${pctUsed}%\` (\`${Math.round(usedTok / 1000)}k / ${winTok >= 1000000 ? (winTok / 1000000).toFixed(1) + 'M' : Math.round(winTok / 1000) + 'k'} tokens\`) · **Chat Box Selection**: \`${hubCfg.chatBoxNativeModel || input.modelName || 'auto'}\``,
        transcriptDetailLine,
        ``,
        `#### 🐝 Sub-Agent Multi-Model Routing (\`.vscode/settings.json\` → \`antigravity.harness.swarmRoleModels\`)`,
        `| Swarm Role | Sub-Agent Type | Assigned Model | Default Depth |`,
        `| :--- | :--- | :--- | :--- |`,
        roleRows,
        ``,
        `#### 🤖 Available Models (Antigravity Built-in · DeepSeek Official 1M · OpenCode Go Plan)`,
        `| Model Name | Model ID | Provider | Reasoning Depth · Effort | Context Usage | Status |`,
        `| :--- | :--- | :--- | :--- | :--- | :--- |`,
        tableRows
      ].join('\n');
      injectSteps.push({
        systemMessage: {
          systemMessage: `[Antigravity Inline Model Switcher] Active model is now '${hubCfg.activeModelId}' (depth='${hubCfg.activeReasoningDepth}', chatBox='${hubCfg.chatBoxNativeModel || input.modelName || 'auto'}').`,
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
    const routing = hubCfg.subagentModelRouting || {};

    const statusBarMd = `🤖 **Model**: \`${activeModel.name || hubCfg.activeModelId}\` · 🧠 **Depth**: \`${depthUpper} (effort=${effort}, cap=${profile.thinkingBudgetTokens})\` · 📊 **Context**: \`${usedStr} / ${maxWinStr} (${pct}%)\` · 🐝 **Subagents**: \`${routing.proposerModelId || 'deepseek-v4-pro'}\` / \`${routing.proberAModelId || 'opencode-go/kimi-k2.7-code'}\` · 🔒 **Snapshot**: \`${snapLock?.active ? snapLock.snapshotId : 'Unlocked'}\` · [Swarm Monitor](sidecar://harness-ide-monitor/)`;

    injectSteps.push({
      systemMessage: {
        systemMessage: `[Active Harness Model & Context Status] Model='${activeModel.id}' (chatBox='${hubCfg.chatBoxNativeModel || input.modelName || 'auto'}', ${activeModel.providerLabel}, depth=${depthUpper}, effort=${effort}, context=${usedStr}/${maxWinStr} [${pct}%]). Sub-Agent Multi-Model Routing: Proposer='${routing.proposerModelId}', Probers=['${routing.proberAModelId}', '${routing.proberBModelId}', '${routing.proberCModelId}'], Composer='${routing.composerModelId}'. Call 'harness_model_invoke' or 'invoke_subagent' (deepseek-agent / opencode-go-agent / harness-proposer / harness-prober / harness-composer) to delegate tasks across models.`,
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

    // 6. Active Task Context Resilience & Compaction Recovery Packet (WP5)
    try {
      const resilience = new ContextResilienceManager(workspaceRoot);
      const taskPacket = resilience.buildActiveTasksHookPacket();
      if (taskPacket) {
        injectSteps.push({
          ephemeralMessage: taskPacket,
        });
      }
    } catch {}

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
