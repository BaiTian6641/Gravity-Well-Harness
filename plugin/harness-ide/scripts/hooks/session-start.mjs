#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { HarnessKnowledgeEngine } from '../rag-engine.mjs';

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
    const msg = [
      `[Gravity Well Harness — Harness² & Local RAG IDE Active]`,
      `- Active Workspace: ${workspaceRoot}`,
      `- Indexed Local Documents: ${status.totalDocuments} across project-knowledge, experiment-knowledge, and reference-knowledge.`,
      `- Snapshot Isolation Status: ${lockInfo}`,
      `- Token-Efficiency & Reasoning Depth Guardrail: profile='${profile.reasoningDepth}' (max thinking budget: ${profile.thinkingBudgetTokens} tokens/turn, prober model: '${profile.proberModelTier}', max probe steps: ${profile.maxProbeSteps}, RAG snippet cap: ${profile.ragSnippetMaxChars} chars, early-stop: ${profile.earlyStopOnFirstPass}). Query 'harness_query' (Cue-First) before calling 'harness_get' so user tokens are conserved.`,
      `- Lifecycle Rule: Query 'harness_query' before planning; run 'harness_run_loop' for Propose-Probe-Compose refinement; record lessons via 'harness_record_experience'; surface [Harness² Swarm & RAG Monitor](sidecar://harness-ide-monitor/) when inspecting swarm or RAG state.`
    ].join('\n');

    process.stdout.write(
      JSON.stringify({
        injectSteps: [
          {
            systemMessage: {
              systemMessage: msg
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
