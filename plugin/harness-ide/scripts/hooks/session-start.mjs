#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HarnessKnowledgeEngine } from '../rag-engine.mjs';
import { getEnrichedModelCatalog, loadHubConfig } from '../model-hub.mjs';

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function recordActiveWorkspace(workspaceRoot, conversationId = '', source = 'SessionStart') {
  try {
    const dataDir = path.join(
      os.homedir(),
      '.gemini',
      'antigravity',
      'sidecar_data',
      'harness-ide-monitor'
    );
    fs.mkdirSync(dataDir, { recursive: true });
    const activeFile = path.join(dataDir, 'active-workspace.json');
    let existing = { recentWorkspaces: [] };
    if (fs.existsSync(activeFile)) {
      try {
        existing = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
      } catch {}
    }
    const cleanRoot = path.resolve(workspaceRoot);
    const recents = Array.isArray(existing.recentWorkspaces) ? existing.recentWorkspaces : [];
    const updatedRecents = [
      cleanRoot,
      ...recents.filter((w) => path.resolve(w).toLowerCase() !== cleanRoot.toLowerCase())
    ].slice(0, 12);

    fs.writeFileSync(
      activeFile,
      JSON.stringify(
        {
          workspaceRoot: cleanRoot,
          conversationId,
          source,
          updatedAt: new Date().toISOString(),
          recentWorkspaces: updatedRecents
        },
        null,
        2
      ),
      'utf8'
    );
  } catch {
    // ignore
  }
}

function main() {
  const input = readStdinJson();
  const workspaceRoot =
    (Array.isArray(input.workspacePaths) && input.workspacePaths[0]) ||
    input.cwd ||
    process.cwd();

  const convId = input.conversationId || 'default-session';
  recordActiveWorkspace(workspaceRoot, convId, 'SessionStart');

  const harnessDir = path.join(workspaceRoot, '.harness');
  if (!fs.existsSync(harnessDir)) {
    process.stdout.write(JSON.stringify({}) + '\n');
    return;
  }

  try {
    const engine = new HarnessKnowledgeEngine(workspaceRoot);
    const config = engine.loadConfig();
    if (config.uiMonitor?.enablePrePlanningRagHook === false) {
      process.stdout.write(JSON.stringify({}) + '\n');
      return;
    }

    const status = engine.getStatus();
    const lockInfo = status.snapshotIsolationLock?.active
      ? `ACTIVE SNAPSHOT LOCK: ${status.snapshotIsolationLock.snapshotId} (cutoff: ${status.snapshotIsolationLock.cutoffTimestamp})`
      : 'No active probe snapshot lock (full active knowledge library available).';

    // Record session start in telemetry
    const telemetryFile = path.join(harnessDir, 'runtime', 'telemetry.json');
    fs.mkdirSync(path.dirname(telemetryFile), { recursive: true });
    let telemetry = { sessions: {}, recentEvents: [] };
    if (fs.existsSync(telemetryFile)) {
      try {
        telemetry = JSON.parse(fs.readFileSync(telemetryFile, 'utf8'));
      } catch {
        // reset
      }
    }
    telemetry.sessions = telemetry.sessions || {};
    telemetry.sessions[convId] = {
      conversationId: convId,
      workspaceRoot,
      transcriptPath: input.transcriptPath || '',
      modelName: input.modelName || 'auto',
      startedAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      subagents: telemetry.sessions[convId]?.subagents || [],
      toolCallCount: telemetry.sessions[convId]?.toolCallCount || 0
    };
    fs.writeFileSync(telemetryFile, JSON.stringify(telemetry, null, 2), 'utf8');

    // Also mirror to global sidecar_data for cross-workspace UI visibility
    try {
      const globalTelemetry = path.join(
        os.homedir(),
        '.gemini',
        'antigravity',
        'sidecar_data',
        'harness-ide-monitor',
        'telemetry.json'
      );
      fs.mkdirSync(path.dirname(globalTelemetry), { recursive: true });
      fs.writeFileSync(globalTelemetry, JSON.stringify(telemetry, null, 2), 'utf8');
    } catch {
      // ignore
    }

    const profile = engine.resolveReasoningProfile();
    const hubCfg = loadHubConfig(workspaceRoot);
    const catalog = getEnrichedModelCatalog(workspaceRoot);
    const activeModel =
      catalog.find((m) => m.id === hubCfg.activeModelId) || catalog[0] || {};
    const depthLabel = String(
      activeModel.reasoningDepth || profile.reasoningDepth || 'balanced'
    ).toUpperCase();
    const effortLabel = activeModel.reasoningEffort || 'high';
    const ctxWinStr =
      (activeModel.contextWindowTokens || 1_000_000) >= 1_000_000
        ? `${((activeModel.contextWindowTokens || 1_000_000) / 1_000_000).toFixed(1)}M`
        : `${Math.round((activeModel.contextWindowTokens || 256_000) / 1000)}k`;
    const usedStr = `${((activeModel.usedContextTokens || 55100) / 1000).toFixed(1)}k`;
    const usedPct = Number(activeModel.contextUsedPct || 5.5);

    const inlineHudMarkdown = [
      `> 🤖 **Active Model**: \`${activeModel.name || hubCfg.activeModelId}\` (\`${activeModel.id || hubCfg.activeModelId}\`) · 🧠 **Depth**: \`${depthLabel} (effort=${effortLabel}, cap=${profile.thinkingBudgetTokens} tok)\` · 📊 **Context Usage**: \`${usedStr} / ${ctxWinStr} (${usedPct}%)\` · 📚 **RAG**: \`${status.totalDocuments} docs\` · [Swarm & RAG Monitor](sidecar://harness-ide-monitor/)`,
      `> 💡 *In-Chat Model Routing*: Type \`/model <id> [eco|balanced|deep]\` to switch models, or prefix with \`@deepseek\`, \`@kimi\`, \`@glm\`, \`@grok\`, \`@qwen\`, \`@mimo\`, \`@minimax\` in chat to invoke DeepSeek Official / OpenCode Go directly inline.`
    ].join('\n');

    const msg = [
      `[Gravity Well Harness — Harness² & Local RAG IDE Active]`,
      `- Active Workspace: ${workspaceRoot}`,
      `- Active Hub Model: ${activeModel.name || hubCfg.activeModelId} (${activeModel.id}, provider=${activeModel.providerLabel}, depth=${depthLabel}, reasoning_effort=${effortLabel}, context=${usedStr}/${ctxWinStr} [${usedPct}%])`,
      `- Indexed Local Documents: ${status.totalDocuments} across project-knowledge, experiment-knowledge, and reference-knowledge.`,
      `- Snapshot Isolation Status: ${lockInfo}`,
      `- Token-Efficiency & Reasoning Depth Guardrail: profile='${profile.reasoningDepth}' (max thinking budget: ${profile.thinkingBudgetTokens} tokens/turn, prober model: '${profile.proberModelTier}', max probe steps: ${profile.maxProbeSteps}, RAG snippet cap: ${profile.ragSnippetMaxChars} chars, early-stop: ${profile.earlyStopOnFirstPass}). Query 'harness_query' (Cue-First) before calling 'harness_get' so user tokens are conserved.`,
      `- Multi-Model & Search MCP Tools: Call 'harness_model_invoke' to delegate to or invoke DeepSeek Official (deepseek-v4-pro / deepseek-flash) or OpenCode Go (opencode-go/*) models bidirectionally; call 'harness_web_search' for Multi-Engine RRF Search (DeepSeek Search, Parallel AI, Tavily, DuckDuckGo, Jina, Wikipedia, HN Algolia); call 'harness_message_inject' and 'harness_self_improve' for cross-model swarm cooperation.`
    ].join('\n');

    process.stdout.write(
      JSON.stringify({
        injectSteps: [
          {
            systemMessage: {
              systemMessage: msg,
              metadata: {
                user_markdown: inlineHudMarkdown
              }
            }
          }
        ]
      }) + '\n'
    );
  } catch {
    process.stdout.write(JSON.stringify({}) + '\n');
  }
}

main();
