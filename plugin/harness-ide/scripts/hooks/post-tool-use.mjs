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

function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function withFileLock(lockPath, fn, maxRetries = 60) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let fd = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      break;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > 5000) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {}
        // Brief synchronous wait before retry
        const waitUntil = Date.now() + 10;
        while (Date.now() < waitUntil) {
          // spin
        }
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
        fs.unlinkSync(lockPath);
      } catch {}
    }
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

    writeJsonAtomic(activeFile, {
      workspaceRoot: cleanRoot,
      conversationId,
      source,
      updatedAt: new Date().toISOString(),
      recentWorkspaces: updatedRecents
    });
  } catch {
    // ignore
  }
}

export function decodeSubagentBatch(toolArgs = {}) {
  if (Array.isArray(toolArgs.Subagents)) {
    return toolArgs.Subagents;
  }
  if (Array.isArray(toolArgs.subagents)) {
    return toolArgs.subagents;
  }
  return [toolArgs];
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
      const runtimeDir = path.join(harnessDir, 'runtime');
      const telemetryFile = path.join(runtimeDir, 'telemetry.json');
      const lockFile = path.join(runtimeDir, 'telemetry.lock');

      withFileLock(lockFile, () => {
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

        sess.subagents = Array.isArray(sess.subagents) ? sess.subagents : [];
        const currentStepIdx = Number(input.stepIdx ?? sess.toolCallCount ?? 0);

        // Track subagent invocations (supporting official batched args.Subagents array),
        // recalls (send_message), and explicit terminations (manage_subagents).
        // NOTE (F11 / F08): Never auto-complete RUNNING subagents based on step count or elapsed time,
        // and never merge/deduplicate subagents that share the same Role.
        if (toolName === 'invoke_subagent') {
          const batch = decodeSubagentBatch(toolArgs);
          for (let idx = 0; idx < batch.length; idx++) {
            const spec = batch[idx] || {};
            const roleName = spec.Role || spec.role || spec.TypeName || spec.typeName || 'Subagent';
            const typeName = spec.TypeName || spec.typeName || 'self';
            const baseId =
              spec.id ||
              spec.conversationId ||
              `sub-${input.conversationId || 'session'}-${input.stepIdx ?? Date.now()}-${idx}`;
            const uniqueId = sess.subagents.some((s) => s.id === baseId)
              ? `${baseId}-${sess.subagents.length}`
              : baseId;

            sess.subagents.push({
              id: uniqueId,
              conversationId: spec.conversationId || null,
              role: roleName,
              typeName,
              workspace: spec.Workspace || spec.workspace || 'inherit',
              model: spec.Model || spec.model || 'inherit',
              promptPreview: String(spec.Prompt || spec.prompt || '').slice(0, 220),
              invokedAt: nowIso,
              lastActiveAt: nowIso,
              stepIdx: currentStepIdx,
              lastActiveStepIdx: currentStepIdx,
              batchIndex: idx,
              recalled: false,
              recallCount: 0,
              status: input.error ? 'ERROR' : 'RUNNING'
            });
          }
        } else if (toolName === 'send_message') {
          const recipient = String(toolArgs.Recipient || '').trim();
          const target = sess.subagents.find(
            (s) =>
              (s.conversationId && s.conversationId === recipient) ||
              s.id === recipient ||
              s.role.toLowerCase() === recipient.toLowerCase()
          );
          if (target) {
            target.status = input.error ? 'ERROR' : 'RUNNING';
            target.recalled = true;
            target.recallCount = (target.recallCount || 0) + 1;
            target.recalledAt = nowIso;
            target.lastActiveAt = nowIso;
            target.lastActiveStepIdx = currentStepIdx;
            if (toolArgs.Message) {
              target.promptPreview = String(toolArgs.Message).slice(0, 220);
            }
          }
        } else if (toolName === 'manage_subagents') {
          const action = String(toolArgs.Action || '').toLowerCase();
          if (action === 'kill_all') {
            for (const s of sess.subagents) {
              s.status = 'COMPLETED';
              s.completedAt = nowIso;
            }
          } else if (action === 'kill') {
            const ids = Array.isArray(toolArgs.ConversationIds) ? toolArgs.ConversationIds : [];
            for (const s of sess.subagents) {
              if (ids.includes(s.conversationId) || ids.includes(s.id)) {
                s.status = 'COMPLETED';
                s.completedAt = nowIso;
              }
            }
          }
        }

        telemetry.recentEvents = telemetry.recentEvents || [];
        const firstSubRole =
          Array.isArray(toolArgs.Subagents) && toolArgs.Subagents[0]
            ? toolArgs.Subagents.map((s) => s.Role || s.TypeName || 'Subagent').join(', ')
            : toolArgs.Role;
        telemetry.recentEvents.unshift({
          timestamp: nowIso,
          conversationId: convId,
          stepIdx: input.stepIdx ?? 0,
          toolName,
          summary:
            toolArgs.toolSummary ||
            firstSubRole ||
            toolArgs.Path ||
            toolArgs.query ||
            toolArgs.CommandLine?.slice(0, 80) ||
            toolName,
          error: input.error || null
        });
        telemetry.recentEvents = telemetry.recentEvents.slice(0, 60);

        writeJsonAtomic(telemetryFile, telemetry);

        try {
          const globalTelemetry = path.join(
            os.homedir(),
            '.gemini',
            'antigravity',
            'sidecar_data',
            'harness-ide-monitor',
            'telemetry.json'
          );
          writeJsonAtomic(globalTelemetry, telemetry);
        } catch {
          // ignore
        }
      });
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
