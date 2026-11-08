#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { HarnessKnowledgeEngine } from '../rag-engine.mjs';

const __filename = fileURLToPath(import.meta.url);

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

export function isPidAlive(pid) {
  const numPid = Number(pid);
  if (!Number.isInteger(numPid) || numPid <= 0) return false;
  try {
    process.kill(numPid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

export function withFileLock(lockPath, fn, timeoutMs = 4000) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const effectiveTimeoutMs = Math.max(20, Number(timeoutMs || 4000));
  const deadline = Date.now() + effectiveTimeoutMs;
  let fd = null;

  while (true) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      const lockMeta = JSON.stringify({
        pid: process.pid,
        acquiredAt: Date.now(),
      });
      fs.writeSync(fd, lockMeta, 0, 'utf8');
      break;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        let brokeStale = false;
        try {
          const raw = fs.readFileSync(lockPath, 'utf8').trim();
          let holderPid = 0;
          if (raw.startsWith('{')) {
            const parsed = JSON.parse(raw);
            holderPid = Number(parsed?.pid || 0);
          } else if (/^\d+$/.test(raw)) {
            holderPid = Number(raw);
          }
          if (holderPid > 0 && !isPidAlive(holderPid)) {
            fs.unlinkSync(lockPath);
            brokeStale = true;
          } else if (holderPid <= 0) {
            const stat = fs.statSync(lockPath);
            if (Date.now() - stat.mtimeMs > Math.max(effectiveTimeoutMs * 2, 10000)) {
              fs.unlinkSync(lockPath);
              brokeStale = true;
            }
          }
        } catch {}

        if (brokeStale) {
          continue;
        }
        if (Date.now() >= deadline) {
          break;
        }
        const waitUntil = Math.min(deadline, Date.now() + 10);
        while (Date.now() < waitUntil) {
          // spin
        }
        continue;
      }
      throw err;
    }
  }

  if (fd === null) {
    const lockErr = new Error(
      `Failed to acquire telemetry file lock within ${effectiveTimeoutMs}ms: ${lockPath}`
    );
    lockErr.code = 'TELEMETRY_LOCK_TIMEOUT';
    throw lockErr;
  }

  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
    try {
      fs.unlinkSync(lockPath);
    } catch {}
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

export function processPostToolUse(input = {}) {
  const workspaceRoot =
    (Array.isArray(input.workspacePaths) && input.workspacePaths[0]) ||
    input.cwd ||
    process.cwd();

  const convId =
    input.conversationId ||
    input.conversation_id ||
    input.sessionId ||
    input.session_id ||
    'default-session';
  recordActiveWorkspace(workspaceRoot, convId, 'PostToolUse');

  const harnessDir = path.join(workspaceRoot, '.harness');
  if (!fs.existsSync(harnessDir)) {
    return {};
  }

  const engine = new HarnessKnowledgeEngine(workspaceRoot);
  const config = engine.loadConfig();
  const toolName =
    input.toolCall?.name || input.tool_name || input.toolName || 'unknown_tool';
  const toolArgs = input.toolCall?.args || input.tool_args || input.toolArgs || {};
  const rawStepVal = input.stepIdx ?? input.step_index ?? input.stepIndex;
  const nowIso = new Date().toISOString();
  const hasToolError = Boolean(
    input.error ||
      input.toolError ||
      input.toolCall?.error ||
      input.result?.error ||
      String(input.status || '').toUpperCase() === 'ERROR' ||
      String(input.toolCall?.status || '').toUpperCase() === 'ERROR'
  );

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
      const explicitStep =
        rawStepVal !== undefined && rawStepVal !== null ? Number(rawStepVal) : null;
      const existingEventsList = Array.isArray(telemetry.recentEvents)
        ? telemetry.recentEvents
        : Array.isArray(telemetry.events)
          ? telemetry.events
          : [];
      const rawEventId = input.eventId || input.event_id || input.toolCall?.id || null;
      const eventDedupId = rawEventId
        ? `${convId}:ev-${rawEventId}`
        : explicitStep !== null
          ? `${convId}:step-${explicitStep}:${toolName}:${JSON.stringify(toolArgs).slice(0, 160)}`
          : null;
      telemetry.seenEventIds = Array.isArray(telemetry.seenEventIds) ? telemetry.seenEventIds : [];
      const isReplayedEvent =
        (eventDedupId !== null && telemetry.seenEventIds.includes(eventDedupId)) ||
        (explicitStep !== null &&
          existingEventsList.some(
            (ev) =>
              ev &&
              ev.conversationId === convId &&
              Number(ev.stepIdx) === explicitStep &&
              ev.toolName === toolName
          ));
      if (!isReplayedEvent) {
        sess.toolCallCount = (sess.toolCallCount || 0) + 1;
        if (eventDedupId !== null) {
          telemetry.seenEventIds.push(eventDedupId);
          if (telemetry.seenEventIds.length > 200) {
            telemetry.seenEventIds = telemetry.seenEventIds.slice(-200);
          }
        }
      }
      if (input.transcriptPath) {
        sess.transcriptPath = input.transcriptPath;
      }

      sess.subagents = Array.isArray(sess.subagents) ? sess.subagents : [];
      const currentStepIdx = Number(rawStepVal ?? sess.toolCallCount ?? 0);

      // Track subagent invocations (supporting official batched args.Subagents array),
      // recalls (send_message), and explicit terminations (manage_subagents).
      // NOTE (F11 / F08 / WP6):
      // - Never auto-complete RUNNING subagents based on step count or elapsed time
      // - Never merge/deduplicate subagents that share the same Role across different batch indices or steps
      // - Deduplicate replayed hook events before any counter or state mutation
      // - Never transition CANCELLED/STOPPED workers back to RUNNING on replayed or late send_message
      // - Never transition or add RUNNING subagents when hasToolError is true
      // - Mark killed subagents as CANCELLED (not COMPLETED)
      if (!isReplayedEvent && toolName === 'invoke_subagent') {
        if (!hasToolError) {
          const batch = decodeSubagentBatch(toolArgs);
          for (let idx = 0; idx < batch.length; idx++) {
            const spec = batch[idx] || {};
            const roleName = spec.Role || spec.role || spec.TypeName || spec.typeName || 'Subagent';
            const typeName = spec.TypeName || spec.typeName || 'self';
            const resolvedConvId =
              spec.conversationId ||
              (batch.length === 1
                ? input.toolCall?.result?.conversationId || input.result?.conversationId || null
                : null);
            const eventKey =
              explicitStep !== null
                ? `${convId}:step-${explicitStep}:batch-${idx}:${resolvedConvId || spec.id || roleName}:${typeName}`
                : resolvedConvId || spec.id
                  ? `${convId}:id-${resolvedConvId || spec.id}:batch-${idx}`
                  : null;
            const existingReplay =
              eventKey !== null
                ? sess.subagents.find((s) => s && s.eventKey === eventKey)
                : null;
            if (existingReplay) {
              existingReplay.lastActiveAt = nowIso;
              continue;
            }
            const baseId =
              spec.id ||
              resolvedConvId ||
              `sub-${input.conversationId || 'session'}-${input.stepIdx ?? Date.now()}-${idx}`;
            const uniqueId = sess.subagents.some((s) => s.id === baseId)
              ? `${baseId}-${sess.subagents.length}`
              : baseId;

            sess.subagents.push({
              id: uniqueId,
              eventKey,
              conversationId: resolvedConvId,
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
              status: 'RUNNING'
            });
          }
        }
      } else if (!isReplayedEvent && toolName === 'send_message') {
        if (!hasToolError) {
          const recipient = String(toolArgs.Recipient || toolArgs.recipient || '').trim();
          const target = sess.subagents.find(
            (s) =>
              (s.conversationId && s.conversationId === recipient) ||
              s.id === recipient ||
              s.role.toLowerCase() === recipient.toLowerCase()
          );
          if (target) {
            const isTerminalCancelled =
              target.status === 'CANCELLED' ||
              target.status === 'STOPPED' ||
              target.status === 'CANCEL_REQUESTED';
            const isStaleStep =
              explicitStep !== null &&
              typeof target.lastTerminalStepIdx === 'number' &&
              explicitStep <= target.lastTerminalStepIdx;
            if (!isTerminalCancelled && !isStaleStep) {
              target.status = 'RUNNING';
              target.recalled = true;
              target.recallCount = (target.recallCount || 0) + 1;
              target.recalledAt = nowIso;
              target.lastActiveAt = nowIso;
              target.lastActiveStepIdx = currentStepIdx;
              if (toolArgs.Message || toolArgs.message) {
                target.promptPreview = String(toolArgs.Message || toolArgs.message).slice(0, 220);
              }
            }
          }
        }
      } else if (!isReplayedEvent && toolName === 'manage_subagents') {
        if (!hasToolError) {
          const action = String(toolArgs.Action || toolArgs.action || '').toLowerCase();
          const ids = Array.isArray(toolArgs.ConversationIds)
            ? toolArgs.ConversationIds
            : Array.isArray(toolArgs.conversationIds)
              ? toolArgs.conversationIds
              : [];
          if (action === 'kill_all') {
            for (const s of sess.subagents) {
              s.status = 'CANCELLED';
              s.cancelledAt = nowIso;
              s.terminationReason = 'kill_all';
              s.lastTerminalStepIdx = currentStepIdx;
            }
          } else if (action === 'kill') {
            for (const s of sess.subagents) {
              if (ids.includes(s.conversationId) || ids.includes(s.id) || ids.includes(s.role)) {
                s.status = 'CANCELLED';
                s.cancelledAt = nowIso;
                s.terminationReason = 'kill';
                s.lastTerminalStepIdx = currentStepIdx;
              }
            }
          } else if (action === 'complete_all') {
            for (const s of sess.subagents) {
              s.status = 'COMPLETED';
              s.completedAt = nowIso;
              s.lastTerminalStepIdx = currentStepIdx;
            }
          } else if (action === 'complete') {
            for (const s of sess.subagents) {
              if (
                ids.length === 0 ||
                ids.includes(s.conversationId) ||
                ids.includes(s.id) ||
                ids.includes(s.role)
              ) {
                s.status = 'COMPLETED';
                s.completedAt = nowIso;
                s.lastTerminalStepIdx = currentStepIdx;
              }
            }
          }
        }
      }

      telemetry.subagents = Object.values(telemetry.sessions || {}).flatMap((s) =>
        Array.isArray(s?.subagents) ? s.subagents : []
      );
      telemetry.recentEvents = telemetry.recentEvents || [];
      if (!isReplayedEvent) {
        const firstSubRole =
          Array.isArray(toolArgs.Subagents) && toolArgs.Subagents[0]
            ? toolArgs.Subagents.map((s) => s.Role || s.TypeName || 'Subagent').join(', ')
            : toolArgs.Role;
        const errDetail =
          input.error || input.toolError || input.toolCall?.error || input.result?.error || null;
        telemetry.recentEvents.unshift({
          timestamp: nowIso,
          conversationId: convId,
          stepIdx: currentStepIdx,
          toolName,
          summary:
            toolArgs.toolSummary ||
            firstSubRole ||
            toolArgs.Path ||
            toolArgs.query ||
            toolArgs.CommandLine?.slice(0, 80) ||
            toolName,
          error: errDetail
        });
        telemetry.recentEvents = telemetry.recentEvents.slice(0, 60);
      }
      telemetry.events = telemetry.recentEvents;

      writeJsonAtomic(telemetryFile, telemetry);

      try {
        const globalTelemetryAgy = path.join(
          os.homedir(),
          '.gemini',
          'antigravity',
          'sidecar_data',
          'harness-ide-monitor',
          'telemetry.json'
        );
        writeJsonAtomic(globalTelemetryAgy, telemetry);
      } catch {
        // ignore
      }
    });
  }

  // Auto-refresh local RAG index when Markdown or config files in .harness/ are written or edited
  if (
    !hasToolError &&
    config.rag?.autoIndexOnChange !== false &&
    (toolName === 'write_file' || toolName === 'edit_file')
  ) {
    const targetPath = String(toolArgs.Path || '').replace(/\\/g, '/');
    if (targetPath.includes('.harness/') && (targetPath.endsWith('.md') || targetPath.endsWith('.json'))) {
      engine.buildIndex();
    }
  }

  return { ok: true, hasToolError, toolError: hasToolError };
}

function main() {
  const input = readStdinJson();
  try {
    processPostToolUse(input);
  } catch {
    // Non-fatal in hook CLI
  }
  process.stdout.write(JSON.stringify({}) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}
