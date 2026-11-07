#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { HarnessKnowledgeEngine } from '../rag-engine.mjs';
import { consumePendingInjectedMessages, loadHubConfig } from '../model-hub.mjs';

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function main() {
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
    const profile = engine.resolveReasoningProfile();
    const hubCfg = loadHubConfig(workspaceRoot);
    const pendingMessages = consumePendingInjectedMessages(workspaceRoot, 'main-orchestrator');

    const injectSteps = [];

    if (snapLock && snapLock.active) {
      const warning = `[Harness² Snapshot Isolation & Token Guardrail] Active Snapshot Lock '${snapLock.snapshotId}' (cutoff: ${snapLock.cutoffTimestamp}, domain: ${snapLock.domain}, K=${snapLock.k} ${snapLock.mode}) | Active Model: '${hubCfg.activeModelId}' | Reasoning Depth: '${profile.reasoningDepth}' (thinkingCap=${profile.thinkingBudgetTokens}, proberModel=${profile.proberModelTier}, maxSteps=${profile.maxProbeSteps}). All RAG queries are locked to this snapshot. Do NOT promote notes to 'status: active' until Compose finishes.`;
      injectSteps.push({ ephemeralMessage: warning });
    }

    for (const msg of pendingMessages) {
      injectSteps.push({
        ephemeralMessage: `[Swarm Message Injection · ${msg.direction}] From ${msg.fromAgent} (${msg.fromModel}) → ${msg.toAgent} (${msg.toModel}, depth=${msg.reasoningDepth}): ${msg.content}`,
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
