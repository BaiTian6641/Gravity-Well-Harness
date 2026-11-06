import fs, { realpathSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgyCssHandler,
  createAssetHandler,
  createShellClientHandler,
  createShellCssHandler,
  FallbackResponse,
  registerUiRoutes,
} from 'antigravity-sidecar-kit/server';
import { exitWithLanguageServer } from 'antigravity-sidecar-kit/lifecycle';
import { createLsRpcCache, persistSidecarRuntime } from 'antigravity-sidecar-kit/rpc';
import { resolveHostTheme } from 'antigravity-sidecar-kit/theme';
import { normalizeWorkspacePath } from 'antigravity-sidecar-kit/workspace';
import { HarnessKnowledgeEngine } from './rag-engine.mjs';

const __dirname = realpathSync(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const UI_DIR = join(__dirname, 'ui');
const SIDECAR_ID = 'harness-ide-monitor';

// Dynamically resolve sidecar_sdk or provide a clean loopback HTTP fallback for standalone/test runs
let SidecarAppClass = null;
let ResponseClass = FallbackResponse;
try {
  const sdk = await import('sidecar_sdk');
  SidecarAppClass = sdk.SidecarApp;
  ResponseClass = sdk.Response || FallbackResponse;
} catch {
  class StandaloneSidecarApp {
    constructor() {
      this.pages = new Map();
      this.apis = new Map();
      this.server = null;
      this.port = 0;
    }
    page(route, handler) {
      this.pages.set(route, handler);
    }
    api(route, handler) {
      this.apis.set(route, handler);
    }
    async run(portOverride) {
      const targetPort = Number(
        portOverride ?? process.env.ANTIGRAVITY_SIDECAR_WEB_PORT ?? process.env.PORT ?? 0
      );
      this.server = http.createServer(async (req, res) => {
        try {
          const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
          const pathname = urlObj.pathname;

          if (this.apis.has(pathname)) {
            let rawBody = '';
            for await (const chunk of req) {
              rawBody += chunk.toString();
            }
            let parsedBody = {};
            if (rawBody.trim()) {
              try {
                parsedBody = JSON.parse(rawBody);
              } catch {
                parsedBody = {};
              }
            }
            const handler = this.apis.get(pathname);
            const out = await handler({
              req,
              body: parsedBody,
              query: Object.fromEntries(urlObj.searchParams.entries()),
              ...parsedBody,
            });
            if (out instanceof ResponseClass || (out && typeof out === 'object' && 'body' in out && 'status' in out)) {
              res.writeHead(out.status || 200, {
                'Content-Type': out.contentType || 'application/json; charset=utf-8',
                ...(out.headers || {}),
              });
              res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify(out));
            }
            return;
          }

          const pageHandler = this.pages.get(pathname) || (pathname === '' ? this.pages.get('/') : null);
          if (pageHandler) {
            const out = await pageHandler({
              req,
              url: req.url,
              headers: req.headers,
              query: Object.fromEntries(urlObj.searchParams.entries()),
            });
            res.writeHead(out?.status || 200, {
              'Content-Type': out?.contentType || 'text/html; charset=utf-8',
              ...(out?.headers || {}),
            });
            res.end(out?.body ?? String(out ?? ''));
            return;
          }

          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: `Not Found: ${pathname}` }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
        }
      });

      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(targetPort, '127.0.0.1', () => {
          this.port = this.server.address()?.port || targetPort;
          resolve();
        });
      });
      return this;
    }
    async close() {
      if (!this.server) return;
      await new Promise((resolve) => this.server.close(() => resolve()));
    }
  }
  SidecarAppClass = StandaloneSidecarApp;
}

const lsCache = createLsRpcCache({
  ttlMs: {
    GetAllCascadeTrajectories: 2000,
    GetMcpServerStates: 4000,
    GetSidecars: 4000,
  },
  defaultTtlMs: 1000,
});

function resolveTargetWorkspace(reqPayload = {}) {
  if (reqPayload?.workspaceRoot && fs.existsSync(reqPayload.workspaceRoot)) {
    return path.resolve(reqPayload.workspaceRoot);
  }
  if (process.env.HARNESS_WORKSPACE_ROOT && fs.existsSync(process.env.HARNESS_WORKSPACE_ROOT)) {
    return path.resolve(process.env.HARNESS_WORKSPACE_ROOT);
  }
  if (fs.existsSync(path.join(REPO_ROOT, '.harness'))) {
    return REPO_ROOT;
  }
  // Check global telemetry for most recently active workspace with .harness
  try {
    const globalTelPath = path.join(
      os.homedir(),
      '.gemini',
      'antigravity',
      'sidecar_data',
      SIDECAR_ID,
      'telemetry.json'
    );
    if (fs.existsSync(globalTelPath)) {
      const tel = JSON.parse(fs.readFileSync(globalTelPath, 'utf8'));
      const sessions = Object.values(tel.sessions || {});
      for (const s of sessions) {
        if (s.workspaceRoot && fs.existsSync(path.join(s.workspaceRoot, '.harness'))) {
          return path.resolve(s.workspaceRoot);
        }
      }
    }
  } catch {
    // ignore
  }
  return process.cwd();
}

function scanRecentBrainTranscripts() {
  const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
  const discoveredConversations = [];
  if (!fs.existsSync(brainDir)) return discoveredConversations;

  try {
    const entries = fs
      .readdirSync(brainDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const transcriptFile = path.join(
          brainDir,
          e.name,
          '.system_generated',
          'logs',
          'transcript.jsonl'
        );
        let mtimeMs = 0;
        if (fs.existsSync(transcriptFile)) {
          try {
            mtimeMs = fs.statSync(transcriptFile).mtimeMs;
          } catch {}
        }
        return { convId: e.name, transcriptFile, mtimeMs };
      })
      .filter((item) => item.mtimeMs > 0)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 5);

    for (const item of entries) {
      const rawLines = fs
        .readFileSync(item.transcriptFile, 'utf8')
        .split('\n')
        .filter(Boolean);
      const subagents = [];
      const recentTools = [];
      let totalSteps = rawLines.length;
      let lastUserPrompt = '';

      for (const line of rawLines.slice(-120)) {
        try {
          const step = JSON.parse(line);
          if (step.type === 'USER_INPUT' && step.content) {
            lastUserPrompt = String(step.content).replace(/<[^>]+>/g, '').trim().slice(0, 180);
          }
          if (Array.isArray(step.tool_calls)) {
            for (const tc of step.tool_calls) {
              const tName = tc.name || tc.tool_name || 'tool';
              const tArgs = tc.arguments || tc.args || {};
              recentTools.unshift({
                stepIndex: step.step_index ?? 0,
                toolName: tName,
                summary:
                  tArgs.toolSummary ||
                  tArgs.Role ||
                  tArgs.query ||
                  tArgs.Path ||
                  tArgs.CommandLine?.slice(0, 60) ||
                  tName,
                createdAt: step.created_at || new Date(item.mtimeMs).toISOString(),
              });
              if (tName === 'invoke_subagent') {
                subagents.push({
                  role: tArgs.Role || tArgs.TypeName || 'Subagent',
                  typeName: tArgs.TypeName || 'self',
                  workspace: tArgs.Workspace || 'inherit',
                  model: tArgs.Model || 'inherit',
                  promptPreview: String(tArgs.Prompt || '').slice(0, 220),
                  invokedAt: step.created_at || new Date(item.mtimeMs).toISOString(),
                  stepIdx: step.step_index ?? 0,
                  status: step.status || 'DONE',
                });
              }
            }
          }
        } catch {
          // skip line
        }
      }

      discoveredConversations.push({
        conversationId: item.convId,
        lastActiveIso: new Date(item.mtimeMs).toISOString(),
        totalSteps,
        lastUserPrompt,
        subagents,
        recentTools: recentTools.slice(0, 25),
      });
    }
  } catch {
    // ignore scan errors
  }

  return discoveredConversations;
}

async function gatherSwarmState(workspaceRoot) {
  let lsConnected = false;
  let lsTrajectories = [];
  let mcpServers = [];

  try {
    const trajRes = await lsCache.call('GetAllCascadeTrajectories', {});
    if (trajRes && Array.isArray(trajRes.trajectorySummaries)) {
      lsConnected = true;
      lsTrajectories = trajRes.trajectorySummaries.slice(0, 8).map((t) => ({
        cascadeId: t.cascadeId || t.conversationId || '',
        summary: t.summary || 'Active Conversation',
        stepCount: t.stepCount || 0,
        status: t.status || 'IDLE',
        workspaceUri: t.workspaceUris?.[0] ? normalizeWorkspacePath(t.workspaceUris[0]) : workspaceRoot,
      }));
    }
  } catch {
    // Language server RPC optional in standalone mode
  }

  try {
    const mcpRes = await lsCache.call('GetMcpServerStates', {});
    if (mcpRes && Array.isArray(mcpRes.states)) {
      mcpServers = mcpRes.states.map((s) => ({
        name: s.serverName || s.name || 'mcp',
        status: s.status || 'CONNECTED',
        toolCount: Array.isArray(s.tools) ? s.tools.length : 0,
      }));
    }
  } catch {
    // Fallback
  }

  // Read hook telemetry
  let hookTelemetry = { sessions: {}, recentEvents: [] };
  const localTelPath = path.join(workspaceRoot, '.harness', 'runtime', 'telemetry.json');
  if (fs.existsSync(localTelPath)) {
    try {
      hookTelemetry = JSON.parse(fs.readFileSync(localTelPath, 'utf8'));
    } catch {}
  }

  const brainConversations = scanRecentBrainTranscripts();
  const activeBrain = brainConversations[0] || null;

  // Combine subagents from brain transcripts, hook telemetry, and configured Harness2 Swarm templates
  const liveSubagents = [];
  if (activeBrain && Array.isArray(activeBrain.subagents)) {
    liveSubagents.push(...activeBrain.subagents);
  }
  for (const sess of Object.values(hookTelemetry.sessions || {})) {
    if (Array.isArray(sess.subagents)) {
      for (const sub of sess.subagents) {
        if (!liveSubagents.some((x) => x.role === sub.role && x.stepIdx === sub.stepIdx)) {
          liveSubagents.push(sub);
        }
      }
    }
  }

  const configuredSwarmRoles = [
    {
      id: 'harness-proposer',
      role: 'Harness² Proposer',
      typeName: 'harness-proposer',
      workspace: 'inherit',
      status: liveSubagents.some((s) => s.typeName === 'harness-proposer') ? 'ACTIVE' : 'STANDBY',
      description: 'Analyzes task & baseline trace, queries INDEX.md & EXPERIENCE.md, and drafts K contrastive candidate harness edits.',
    },
    {
      id: 'harness-prober-branch-1',
      role: 'Harness² Prober #1 (Candidate A)',
      typeName: 'harness-prober',
      workspace: 'branch',
      status: liveSubagents.some((s) => s.typeName === 'harness-prober') ? 'ACTIVE' : 'STANDBY',
      description: 'Executes Candidate #1 inside an isolated branched workspace strictly locked to frozen snapshot_id.',
    },
    {
      id: 'harness-prober-branch-2',
      role: 'Harness² Prober #2 (Candidate B)',
      typeName: 'harness-prober',
      workspace: 'branch',
      status: liveSubagents.some((s) => s.typeName === 'harness-prober') ? 'ACTIVE' : 'STANDBY',
      description: 'Executes Candidate #2 inside an isolated branched workspace strictly locked to frozen snapshot_id.',
    },
    {
      id: 'harness-composer',
      role: 'Harness² Composer & Reflector',
      typeName: 'harness-composer',
      workspace: 'inherit',
      status: liveSubagents.some((s) => s.typeName === 'harness-composer') ? 'ACTIVE' : 'STANDBY',
      description: 'Evaluates behavioral contrasts across K probe trajectories, adopts winning harness, and records EXPERIENCE.md + INDEX.md.',
    },
  ];

  const recentEvents =
    hookTelemetry.recentEvents?.length > 0
      ? hookTelemetry.recentEvents
      : activeBrain?.recentTools || [];

  return {
    lsConnected,
    activeConversationId:
      activeBrain?.conversationId ||
      process.env.ANTIGRAVITY_CONVERSATION_ID ||
      lsTrajectories[0]?.cascadeId ||
      'live-session',
    mainAgent: {
      role: 'Main Orchestrator Agent (Antigravity)',
      model: 'Gemini 4 Argon (High)',
      status: 'ACTIVE',
      totalSteps: activeBrain?.totalSteps || lsTrajectories[0]?.stepCount || 0,
      lastUserPrompt: activeBrain?.lastUserPrompt || 'Building Harness² + Local RAG IDE Plugin & Swarm UI',
      workspaceRoot,
    },
    liveSubagents,
    configuredSwarmRoles,
    recentEvents: recentEvents.slice(0, 25),
    lsTrajectories,
    mcpServers:
      mcpServers.length > 0
        ? mcpServers
        : [
            { name: 'harness_ide_rag_mcp', status: 'READY (Local Stdio)', toolCount: 9 },
            { name: 'harness_ide_context7', status: 'CONFIGURED (Remote HTTP)', toolCount: 2 },
          ],
  };
}

function syncMcpConfigFromSettings(workspaceRoot, settings) {
  const mcpServers = {
    harness_ide_rag_mcp: {
      command: 'node',
      args: ['scripts/mcp-entry.mjs'],
    },
  };

  if (settings?.externalDocs?.context7?.enabled !== false) {
    const c7 = {
      url: settings?.externalDocs?.context7?.serverUrl || 'https://mcp.context7.com/mcp',
    };
    if (settings?.externalDocs?.context7?.apiKey) {
      c7.headers = { Authorization: `Bearer ${settings.externalDocs.context7.apiKey}` };
    }
    mcpServers.harness_ide_context7 = c7;
  }

  if (settings?.externalDocs?.googleDeveloperKnowledge?.enabled) {
    mcpServers.harness_ide_google_dev_knowledge = {
      url:
        settings?.externalDocs?.googleDeveloperKnowledge?.serverUrl ||
        'https://developers.google.com/knowledge/mcp',
    };
  }

  if (settings?.rag?.optionalBackends?.basicMemory?.enabled) {
    mcpServers.harness_ide_basic_memory = {
      command: settings.rag.optionalBackends.basicMemory.command || 'uvx',
      args: settings.rag.optionalBackends.basicMemory.args || ['basic-memory', 'mcp'],
    };
  }

  const targets = [
    path.join(workspaceRoot, 'plugin', 'harness-ide', 'mcp_config.json'),
    path.join(os.homedir(), '.gemini', 'config', 'plugins', 'harness-ide', 'mcp_config.json'),
  ];

  for (const t of targets) {
    if (fs.existsSync(path.dirname(t))) {
      try {
        fs.writeFileSync(t, JSON.stringify({ mcpServers }, null, 2) + '\n', 'utf8');
      } catch {
        // ignore
      }
    }
  }
}

export function createHarnessMonitorApp() {
  const serveAsset = (relPath, contentType) =>
    createAssetHandler(UI_DIR, relPath, contentType, { ResponseClass });

  const app = new SidecarAppClass();
  app.page('/', serveAsset('index.html', 'text/html; charset=utf-8'));
  app.page('/index.html', serveAsset('index.html', 'text/html; charset=utf-8'));
  app.page('/ui.html', serveAsset('index.html', 'text/html; charset=utf-8'));
  app.page('/compiled_tailwind.css', createAgyCssHandler({ ResponseClass }));
  app.page('/shell.css', createShellCssHandler({ ResponseClass }));
  app.page('/shell.js', createShellClientHandler({ ResponseClass }));
  registerUiRoutes(app, { modules: ['core', 'controls', 'surfaces'], ResponseClass });
  app.page('/styles.css', serveAsset('styles.css', 'text/css; charset=utf-8'));
  app.page('/app.js', serveAsset('app.js', 'text/javascript; charset=utf-8'));

  app.api(
    '/api/status',
    async (reqData = {}) => {
      const workspaceRoot = resolveTargetWorkspace(reqData);
      const engine = new HarnessKnowledgeEngine(workspaceRoot);
      return {
        ok: true,
        sidecarId: SIDECAR_ID,
        workspaceRoot,
        ragStatus: engine.getStatus(),
        theme: resolveHostTheme(),
        timestamp: new Date().toISOString(),
      };
    },
    'POST'
  );

  app.api(
    '/api/dashboard',
    async (reqData = {}) => {
      const workspaceRoot = resolveTargetWorkspace(reqData);
      const engine = new HarnessKnowledgeEngine(workspaceRoot);
      const index = engine.loadOrBuildIndex();
      const status = engine.getStatus();
      const settings = engine.loadConfig();
      const swarm = await gatherSwarmState(workspaceRoot);
      const snapshots = engine.listSnapshots();

      const experiences = index.documents.filter(
        (d) => d.collection === 'experiment-knowledge'
      );

      return {
        ok: true,
        timestamp: new Date().toISOString(),
        workspaceRoot,
        theme: resolveHostTheme(),
        swarm,
        rag: {
          status,
          documents: index.documents.map((d) => ({
            docid: d.docid,
            title: d.title,
            path: d.path,
            collection: d.collection,
            domain: d.domain,
            task_id: d.task_id,
            status: d.status,
            git_revision: d.git_revision,
            created_at: d.created_at,
            cue: d.cue,
            tags: d.tags,
            evidence_links: d.evidence_links,
            excerpt: d.excerpt,
          })),
        },
        harness2: {
          activeSnapshotLock: status.snapshotIsolationLock,
          snapshots,
          experiences,
          editableComponents: settings.harness2?.editableComponents || [
            'system_prompts',
            'rules',
            'skills',
            'subagents',
            'hooks',
            'tools',
            'scripts',
            'plugins',
          ],
        },
        settings,
      };
    },
    'POST'
  );

  app.api(
    '/api/rag/query',
    async (reqData = {}) => {
      const payload = reqData?.body || reqData || {};
      const workspaceRoot = resolveTargetWorkspace(payload);
      const engine = new HarnessKnowledgeEngine(workspaceRoot);
      const res = engine.query({
        query: payload.query || '',
        mode: payload.mode || 'hybrid',
        collection: payload.collection || 'all',
        domain: payload.domain || 'all',
        status: payload.status || 'active',
        topK: Number(payload.topK || 8),
        snapshot_id: payload.snapshot_id || null,
        include_candidates: Boolean(payload.include_candidates),
      });
      return { ok: true, ...res };
    },
    'POST'
  );

  app.api(
    '/api/rag/doc',
    async (reqData = {}) => {
      const payload = reqData?.body || reqData || {};
      const workspaceRoot = resolveTargetWorkspace(payload);
      const engine = new HarnessKnowledgeEngine(workspaceRoot);

      if (payload.action === 'save') {
        const col = payload.collection || 'project-knowledge';
        const colSpec = engine.loadConfig().rag?.collections?.[col] || {
          path: '.harness/knowledge/project',
        };
        const targetDir = path.resolve(workspaceRoot, colSpec.path);
        fs.mkdirSync(targetDir, { recursive: true });
        const safeName = String(payload.filename || `NOTE-${Date.now()}.md`)
          .replace(/[^a-zA-Z0-9._-]/g, '-')
          .replace(/(?<!\.md)$/, '.md');
        const fullPath = path.join(targetDir, safeName);
        const nowIso = new Date().toISOString();
        const docid = payload.docid || path.basename(safeName, '.md').toUpperCase();
        const tags = Array.isArray(payload.tags)
          ? payload.tags
          : String(payload.tags || 'note, project')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);

        const mdContent = payload.rawMarkdown
          ? payload.rawMarkdown
          : [
              '---',
              `docid: ${docid}`,
              `title: "${String(payload.title || safeName).replace(/"/g, '\\"')}"`,
              `collection: ${col}`,
              `domain: ${payload.domain || 'general'}`,
              `status: ${payload.status || 'active'}`,
              'repo: Harness2-RAG-antigravity',
              `git_revision: ${engine.getGitRevision()}`,
              `created_at: "${nowIso}"`,
              `tags: [${tags.join(', ')}]`,
              '---',
              '',
              `# ${payload.title || safeName}`,
              '',
              payload.content || '',
              '',
            ].join('\n');

        fs.writeFileSync(fullPath, mdContent, 'utf8');
        const idx = engine.buildIndex();
        return {
          ok: true,
          saved: true,
          docid,
          path: path.relative(workspaceRoot, fullPath).replace(/\\/g, '/'),
          totalDocuments: idx.totalDocuments,
        };
      }

      const doc = engine.getDocument(payload.id || 'ADR-001', {
        snapshot_id: payload.snapshot_id || null,
        include_candidates: true,
      });
      return { ok: doc.found, ...doc };
    },
    'POST'
  );

  app.api(
    '/api/rag/refresh',
    async (reqData = {}) => {
      const payload = reqData?.body || reqData || {};
      const workspaceRoot = resolveTargetWorkspace(payload);
      const engine = new HarnessKnowledgeEngine(workspaceRoot);
      const idx = engine.buildIndex({ runQmdSync: true });
      return {
        ok: true,
        indexedAt: idx.indexedAt,
        totalDocuments: idx.totalDocuments,
        gitRevision: idx.gitRevision,
        qmdStatus: idx.qmdStatus,
      };
    },
    'POST'
  );

  app.api(
    '/api/harness2/snapshot',
    async (reqData = {}) => {
      const payload = reqData?.body || reqData || {};
      const workspaceRoot = resolveTargetWorkspace(payload);
      const engine = new HarnessKnowledgeEngine(workspaceRoot);
      const action = payload.action || 'status';

      if (action === 'create') {
        const lock = engine.createSnapshotLock({
          domain: payload.domain || 'software-engineering',
          k: Number(payload.k || 2),
          mode: payload.mode || 'parallel',
          description: payload.description || 'Manual UI Snapshot Isolation Lock',
        });
        return { ok: true, lock };
      }
      if (action === 'release') {
        const res = engine.releaseSnapshotLock();
        return { ok: true, ...res };
      }
      return {
        ok: true,
        activeLock: engine.getActiveSnapshotLock(),
        snapshots: engine.listSnapshots(),
      };
    },
    'POST'
  );

  app.api(
    '/api/harness2/experience',
    async (reqData = {}) => {
      const payload = reqData?.body || reqData || {};
      const workspaceRoot = resolveTargetWorkspace(payload);
      const engine = new HarnessKnowledgeEngine(workspaceRoot);
      const action = payload.action || 'record';

      if (action === 'promote') {
        const res = engine.promoteExperienceToProjectKnowledge({
          task_id_or_docid: payload.task_id_or_docid,
          adr_id: payload.adr_id,
          title: payload.title,
          summary: payload.summary,
        });
        return { ok: true, ...res };
      }

      const res = engine.recordExperience({
        task_id: payload.task_id || `task-${Date.now()}`,
        domain: payload.domain || 'software-engineering',
        title: payload.title,
        cue: payload.cue,
        problem: payload.problem,
        observed_behavior: payload.observed_behavior,
        supporting_evidence: payload.supporting_evidence || [],
        status: payload.status || 'active',
        tags: payload.tags || ['harness2', 'experience'],
        adopted_harness: payload.adopted_harness || null,
      });
      return { ok: true, ...res };
    },
    'POST'
  );

  app.api(
    '/api/settings/save',
    async (reqData = {}) => {
      const payload = reqData?.body || reqData || {};
      const workspaceRoot = resolveTargetWorkspace(payload);
      const engine = new HarnessKnowledgeEngine(workspaceRoot);
      const updated = engine.saveConfig(payload.settings || payload, true);
      syncMcpConfigFromSettings(workspaceRoot, updated);
      return {
        ok: true,
        settings: updated,
        savedAt: new Date().toISOString(),
      };
    },
    'POST'
  );

  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createHarnessMonitorApp();
  await app.run();
  try {
    persistSidecarRuntime(SIDECAR_ID);
  } catch {}
  exitWithLanguageServer({ app });
}
