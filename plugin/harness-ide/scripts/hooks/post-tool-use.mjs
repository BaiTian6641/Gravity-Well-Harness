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

function recordActiveWorkspace(workspaceRoot, conversationId = '', source = 'PostToolUse') {
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
  recordActiveWorkspace(workspaceRoot, convId, 'PostToolUse');

  const harnessDir = path.join(workspaceRoot, '.harness');
  if (!fs.existsSync(harnessDir)) {
    process.stdout.write(JSON.stringify({}) + '\n');
    return;
  }

  try {
    const engine = new HarnessKnowledgeEngine(workspaceRoot);
    const config = engine.loadConfig();
    const toolName = input.toolCall?.name || 'unknown_tool';
    const toolArgs = input.toolCall?.args || {};
    const nowIso = new Date().toISOString();

    if (config.uiMonitor?.enablePostToolTelemetryHook !== false) {
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
      if (!telemetry.sessions[convId]) {
        telemetry.sessions[convId] = {
          conversationId: convId,
          workspaceRoot,
          transcriptPath: input.transcriptPath || '',
          modelName: input.modelName || 'auto',
          startedAt: nowIso,
          lastUpdatedAt: nowIso,
          subagents: [],
          toolCallCount: 0
        };
      }
      const sess = telemetry.sessions[convId];
      sess.lastUpdatedAt = nowIso;
      sess.toolCallCount = (sess.toolCallCount || 0) + 1;
      if (input.transcriptPath) {
        sess.transcriptPath = input.transcriptPath;
      }

      // Track subagent invocations in real time
      if (toolName === 'invoke_subagent') {
        sess.subagents = sess.subagents || [];
        sess.subagents.push({
          role: toolArgs.Role || toolArgs.TypeName || 'Subagent',
          typeName: toolArgs.TypeName || 'self',
          workspace: toolArgs.Workspace || 'inherit',
          model: toolArgs.Model || 'inherit',
          promptPreview: String(toolArgs.Prompt || '').slice(0, 220),
          invokedAt: nowIso,
          stepIdx: input.stepIdx || 0,
          status: input.error ? 'ERROR' : 'RUNNING'
        });
      }

      telemetry.recentEvents = telemetry.recentEvents || [];
      telemetry.recentEvents.unshift({
        timestamp: nowIso,
        conversationId: convId,
        stepIdx: input.stepIdx ?? 0,
        toolName,
        summary:
          toolArgs.toolSummary ||
          toolArgs.Role ||
          toolArgs.Path ||
          toolArgs.query ||
          toolArgs.CommandLine?.slice(0, 80) ||
          toolName,
        error: input.error || null
      });
      telemetry.recentEvents = telemetry.recentEvents.slice(0, 60);

      fs.writeFileSync(telemetryFile, JSON.stringify(telemetry, null, 2), 'utf8');

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
    }

    // Auto-refresh local RAG index when Markdown or config files in .harness/ are written or edited
    if (
      config.rag?.autoIndexOnChange !== false &&
      (toolName === 'write_file' || toolName === 'edit_file')
    ) {
      const targetPath = String(toolArgs.Path || '').replace(/\\/g, '/');
      if (targetPath.includes('.harness/') && (targetPath.endsWith('.md') || targetPath.endsWith('.json'))) {
        engine.buildIndex();
      }
    }
  } catch {
    // Non-fatal in hook
  }

  process.stdout.write(JSON.stringify({}) + '\n');
}

main();
