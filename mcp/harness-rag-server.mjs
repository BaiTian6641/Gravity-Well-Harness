#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessKnowledgeEngine } from '../src/rag-engine.mjs';
import {
  invokeUnifiedModel,
  searchWebMultiEngine,
  injectOrConveySwarmMessage,
  runSelfImprovementCoopCycle,
  getEnrichedModelCatalog,
  SEARCH_ENGINE_CATALOG,
} from '../src/model-hub.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function resolveActiveWorkspaceRoot(args = {}) {
  if (args?.workspace_root && fs.existsSync(args.workspace_root)) {
    return path.resolve(args.workspace_root);
  }
  const envRoot = process.env.HARNESS_WORKSPACE_ROOT || process.env.ANTIGRAVITY_WORKSPACE_ROOT;
  if (envRoot && fs.existsSync(envRoot)) {
    return path.resolve(envRoot);
  }
  // Check active-workspace.json written by SessionStart / PostToolUse hooks and UI sidecar
  try {
    const activePath = path.join(
      os.homedir(),
      '.gemini',
      'antigravity',
      'sidecar_data',
      'harness-ide-monitor',
      'active-workspace.json'
    );
    if (fs.existsSync(activePath)) {
      const data = JSON.parse(fs.readFileSync(activePath, 'utf8'));
      if (data?.workspaceRoot && fs.existsSync(data.workspaceRoot)) {
        return path.resolve(data.workspaceRoot);
      }
    }
  } catch {}
  // Check telemetry.json for most recently updated workspace
  try {
    const telPath = path.join(
      os.homedir(),
      '.gemini',
      'antigravity',
      'sidecar_data',
      'harness-ide-monitor',
      'telemetry.json'
    );
    if (fs.existsSync(telPath)) {
      const tel = JSON.parse(fs.readFileSync(telPath, 'utf8'));
      const sessions = Object.values(tel.sessions || {}).sort((a, b) =>
        String(b.lastUpdatedAt || '').localeCompare(String(a.lastUpdatedAt || ''))
      );
      for (const s of sessions) {
        if (s?.workspaceRoot && fs.existsSync(s.workspaceRoot)) {
          return path.resolve(s.workspaceRoot);
        }
      }
    }
  } catch {}
  if (fs.existsSync(path.join(process.cwd(), '.harness'))) {
    return process.cwd();
  }
  if (fs.existsSync(path.join(REPO_ROOT, '.harness'))) {
    return REPO_ROOT;
  }
  return process.cwd();
}

const TOOL_DEFINITIONS = [
  {
    name: 'harness_query',
    description:
      'Search local project knowledge, Harness2 experience libraries (INDEX.md & EXPERIENCE.md), and reference docs using BM25 lexical, dense vector, or hybrid RRF retrieval. Automatically enforces Snapshot Isolation during active Harness2 candidate probes.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (keywords, natural language question, or INDEX.md situation cue).'
        },
        mode: {
          type: 'string',
          enum: ['hybrid', 'lex', 'vec'],
          description: 'Retrieval mode: hybrid (BM25 + Vector RRF, default), lex (BM25), or vec (semantic vector).'
        },
        collection: {
          type: 'string',
          enum: ['all', 'project-knowledge', 'experiment-knowledge', 'reference-knowledge'],
          description: 'Filter by knowledge collection (default: all).'
        },
        domain: {
          type: 'string',
          description: 'Optional Harness2 domain filter (e.g., software-engineering, architecture, all).'
        },
        status: {
          type: 'string',
          enum: ['active', 'candidate', 'superseded', 'all'],
          description: 'Filter by provenance currency status (default: active).'
        },
        topK: {
          type: 'number',
          description: 'Maximum number of results to return (default: 8).'
        },
        snapshot_id: {
          type: 'string',
          description: 'Optional explicit Harness2 snapshot lock ID for candidate probe isolation.'
        },
        workspace_root: {
          type: 'string',
          description: 'Optional workspace root override.'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'harness_get',
    description:
      'Retrieve the full Markdown source and provenance metadata of a document or Harness2 EXPERIENCE.md by docid, relative path, or task_id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Document ID (e.g. ADR-001, EXP-SWE-001), task_id, or relative file path.'
        },
        snapshot_id: {
          type: 'string',
          description: 'Optional explicit Harness2 snapshot lock ID.'
        },
        workspace_root: {
          type: 'string',
          description: 'Optional workspace root override.'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'harness_multi_get',
    description:
      'Batch retrieve multiple source documents by comma-separated docids/paths or glob patterns (e.g. "*INDEX*").',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Comma-separated list of docids/paths or a glob pattern.'
        },
        snapshot_id: {
          type: 'string',
          description: 'Optional explicit Harness2 snapshot lock ID.'
        },
        workspace_root: {
          type: 'string',
          description: 'Optional workspace root override.'
        }
      },
      required: ['pattern']
    }
  },
  {
    name: 'harness_status',
    description:
      'Check local RAG index health, document counts across collections, QMD CLI availability, and active Harness2 Snapshot Isolation locks.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_root: {
          type: 'string',
          description: 'Optional workspace root override.'
        }
      }
    }
  },
  {
    name: 'harness_metadata',
    description:
      'Discover available frontmatter metadata keys (collection, domain, status, tags) and document value counts.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_root: {
          type: 'string',
          description: 'Optional workspace root override.'
        }
      }
    }
  },
  {
    name: 'harness_snapshot_lock',
    description:
      'Manage Harness2 Snapshot Isolation locks (create, status, release, list). Use "create" before spawning candidate harness probes so all K candidates read the exact same eligible knowledge snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'status', 'release', 'list'],
          description: 'Lock operation to perform.'
        },
        domain: {
          type: 'string',
          description: 'Domain being probed (used when action="create", default: software-engineering).'
        },
        k: {
          type: 'number',
          description: 'Number of candidate probes K (default: 2).'
        },
        mode: {
          type: 'string',
          enum: ['parallel', 'sequential'],
          description: 'Harness2 recursion mode (default: parallel).'
        },
        description: {
          type: 'string',
          description: 'Description of the Propose-Probe-Compose experiment.'
        },
        workspace_root: {
          type: 'string',
          description: 'Optional workspace root override.'
        }
      },
      required: ['action']
    }
  },
  {
    name: 'harness_record_experience',
    description:
      'Record a structured Harness2 EXPERIENCE.md lesson, save the adopted harness manifest, update INDEX.md cues, and refresh the local RAG index.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Unique identifier for the task/experiment (e.g., task-002-retry-backoff).'
        },
        domain: {
          type: 'string',
          description: 'Domain library name (e.g., software-engineering, android-frontend, ml-training).'
        },
        title: {
          type: 'string',
          description: 'Concise title of the experience lesson.'
        },
        cue: {
          type: 'string',
          description: 'Conditional cue for INDEX.md starting with "When..." describing when future tasks should adopt this lesson.'
        },
        problem: {
          type: 'string',
          description: 'What task or problem produced this lesson?'
        },
        observed_behavior: {
          type: 'string',
          description: 'What was empirically observed across baseline vs. candidate probes?'
        },
        supporting_evidence: {
          type: 'array',
          items: { type: 'string' },
          description: 'Paths, commits, test logs, or trajectory references supporting the conclusion.'
        },
        status: {
          type: 'string',
          enum: ['active', 'candidate', 'superseded'],
          description: 'Provenance status: use "candidate" during unverified probing, "active" after Compose adoption.'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Topic tags for retrieval.'
        },
        adopted_harness: {
          type: 'object',
          description: 'Optional JSON object describing the adopted harness components (rules, skills, subagents, hooks, etc.).'
        },
        workspace_root: {
          type: 'string',
          description: 'Optional workspace root override.'
        }
      },
      required: ['task_id', 'problem', 'observed_behavior']
    }
  },
  {
    name: 'harness_promote_lesson',
    description:
      'Promote a verified Harness2 EXPERIENCE.md lesson into curated project-knowledge (ADR-*.md) with bidirectional provenance links.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id_or_docid: {
          type: 'string',
          description: 'The task_id or docid of the EXPERIENCE.md lesson to promote.'
        },
        adr_id: {
          type: 'string',
          description: 'Target ADR identifier (e.g. ADR-002-subagent-timeout-policy).'
        },
        title: {
          type: 'string',
          description: 'Title for the promoted ADR document.'
        },
        summary: {
          type: 'string',
          description: 'Curated architectural guidance text.'
        },
        workspace_root: {
          type: 'string',
          description: 'Optional workspace root override.'
        }
      },
      required: ['task_id_or_docid']
    }
  },
  {
    name: 'harness_index_refresh',
    description:
      'Rebuild the local hybrid RAG index and run "qmd update" if the QMD CLI is installed.',
    inputSchema: {
      type: 'object',
      properties: {
        run_qmd_sync: {
          type: 'boolean',
          description: 'Also invoke "qmd update" if QMD CLI is installed (default: true).'
        },
        workspace_root: {
          type: 'string',
          description: 'Optional workspace root override.'
        }
      }
    }
  },
  {
    name: 'harness_run_loop',
    description:
      'Execute a complete, token-efficient Google Research Harness² Propose -> Probe -> Compose cycle with Snapshot Isolation, Invariant + Domain-Specific candidate proposals, bounded Reasoning Depth (eco/balanced/deep), and automatic EXPERIENCE.md + INDEX.md adoption.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Unique identifier for the task/experiment (e.g. task-005-token-efficiency).'
        },
        domain: {
          type: 'string',
          description: 'Domain library name (default: software-engineering).'
        },
        problem: {
          type: 'string',
          description: 'Problem statement or task bottleneck to optimize.'
        },
        k: {
          type: 'number',
          description: 'Number of candidate harnesses to probe (2 to 6, default: 2).'
        },
        mode: {
          type: 'string',
          enum: ['parallel', 'sequential'],
          description: 'Probe execution mode (default: parallel).'
        },
        reasoning_depth: {
          type: 'string',
          enum: ['eco', 'balanced', 'deep'],
          description: 'Reasoning depth & token budget preset: eco (~71% tokens saved), balanced (~53% tokens saved, default), or deep.'
        },
        thinking_budget_tokens: {
          type: 'number',
          description: 'Optional max thinking tokens per turn override (e.g. 1024, 2048, 8192).'
        },
        max_probe_steps: {
          type: 'number',
          description: 'Optional max steps per candidate probe override.'
        },
        prober_model_tier: {
          type: 'string',
          enum: ['flash_lite', 'flash', 'inherit', 'pro'],
          description: 'Optional model tier for candidate probers (default: flash for balanced, flash_lite for eco).'
        },
        early_stop: {
          type: 'boolean',
          description: 'Stop remaining sequential candidates once a candidate passes 100% of verification checks (default: true).'
        },
        record_to_library: {
          type: 'boolean',
          description: 'Record the composed winner into .harness/library/<domain>/ (default: true).'
        },
        workspace_root: {
          type: 'string',
          description: 'Optional workspace root override.'
        }
      },
      required: ['task_id', 'problem']
    }
  },
  {
    name: 'harness_model_invoke',
    description:
      'Invoke any model across DeepSeek Official (deepseek-reasoner, deepseek-chat, deepseek-v4-pro), OpenCode Go Coding Plan (kimi-k3.1-pro, kimi-k2.7-code, glm-5.3, glm-5.3-flash, minimax-m3.1-flash, qwen3-coder-plus), or Antigravity Native models with configurable reasoning_depth (eco/balanced/deep) and bidirectional peer subagent delegation.',
    inputSchema: {
      type: 'object',
      properties: {
        model_id: {
          type: 'string',
          description: 'Model ID (e.g. deepseek-reasoner, deepseek-chat, kimi-k2.7-code, glm-5.3, minimax-m3.1-flash, qwen3-coder-plus).'
        },
        prompt: {
          type: 'string',
          description: 'Task prompt or query for the target model.'
        },
        reasoning_depth: {
          type: 'string',
          enum: ['eco', 'balanced', 'deep'],
          description: 'Reasoning depth and thinking token cap (eco, balanced, deep).'
        },
        delegate_to_peer_model: {
          type: 'string',
          description: 'Optional peer model ID that the target model should call as a subagent (e.g. glm-5.3 or deepseek-chat).'
        },
        workspace_root: {
          type: 'string',
          description: 'Optional workspace root override.'
        }
      },
      required: ['prompt']
    }
  },
  {
    name: 'harness_web_search',
    description:
      'Search the web across Parallel AI Search (search.parallel.ai/mcp), Tavily AI Search, DuckDuckGo Instant Answer, Jina AI Search (s.jina.ai), Wikipedia Action API, and HackerNews Algolia with Reciprocal Rank Fusion (RRF).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query string.'
        },
        engine: {
          type: 'string',
          enum: ['multi-fusion', 'parallel', 'tavily', 'duckduckgo', 'jina', 'wikipedia', 'hn-algolia'],
          description: 'Search engine or multi-fusion (default: multi-fusion).'
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default: 6).'
        },
        workspace_root: {
          type: 'string',
          description: 'Optional workspace root override.'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'harness_message_inject',
    description:
      'Inject or convey a message (INJECT_DIRECTIVE, CONVEY_CONTEXT, PEER_CRITIQUE, SELF_IMPROVE_CUE) across agents and models in the active workspace swarm.',
    inputSchema: {
      type: 'object',
      properties: {
        from_agent: { type: 'string', description: 'Sender agent ID (default: main-orchestrator).' },
        to_agent: { type: 'string', description: 'Recipient agent ID or "all" (default: harness-proposer).' },
        from_model: { type: 'string', description: 'Sender model ID.' },
        to_model: { type: 'string', description: 'Recipient model ID (e.g. deepseek-reasoner, kimi-k2.7-code, glm-5.3).' },
        type: {
          type: 'string',
          enum: ['INJECT_DIRECTIVE', 'CONVEY_CONTEXT', 'PEER_CRITIQUE', 'SELF_IMPROVE_CUE'],
          description: 'Message injection / convey type.'
        },
        content: { type: 'string', description: 'Message content to inject and convey.' },
        reasoning_depth: {
          type: 'string',
          enum: ['eco', 'balanced', 'deep'],
          description: 'Reasoning depth for recipient execution.'
        },
        workspace_root: { type: 'string', description: 'Optional workspace root override.' }
      },
      required: ['content']
    }
  },
  {
    name: 'harness_self_improve',
    description:
      'Execute a full multi-model Self-Improvement & Cooperation cycle combining Google Research Harness² (Propose -> Probe -> Compose), Cross-Model Peer Critique (DeepSeek + OpenCode Go + Gemini), and runtime Message Bus broadcast.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task or capability to self-improve.' },
        domain: { type: 'string', description: 'Target domain library (default: software-engineering).' },
        reasoning_depth: {
          type: 'string',
          enum: ['eco', 'balanced', 'deep'],
          description: 'Reasoning depth preset (default: balanced).'
        },
        workspace_root: { type: 'string', description: 'Optional workspace root override.' }
      }
    }
  }
];

function getEngine(args = {}) {
  const root = resolveActiveWorkspaceRoot(args);
  return new HarnessKnowledgeEngine(root);
}

export async function handleToolCall(name, args = {}) {
  const root = resolveActiveWorkspaceRoot(args);
  const engine = new HarnessKnowledgeEngine(root);
  switch (name) {
    case 'harness_query':
    case 'qmd_query':
      return engine.query(args);
    case 'harness_get':
    case 'qmd_get':
      return engine.getDocument(args.id, { snapshot_id: args.snapshot_id });
    case 'harness_multi_get':
    case 'qmd_multi_get':
      return engine.multiGet(args.pattern, { snapshot_id: args.snapshot_id });
    case 'harness_status':
    case 'qmd_status':
      return {
        ...engine.getStatus(),
        models: getEnrichedModelCatalog(root),
        searchEngines: SEARCH_ENGINE_CATALOG,
      };
    case 'harness_metadata':
    case 'qmd_metadata':
      return engine.getMetadata();
    case 'harness_snapshot_lock': {
      const action = args.action || 'status';
      if (action === 'create') return engine.createSnapshotLock(args);
      if (action === 'release') return engine.releaseSnapshotLock();
      if (action === 'list') return { snapshots: engine.listSnapshots() };
      return { activeLock: engine.getActiveSnapshotLock() };
    }
    case 'harness_record_experience':
      return engine.recordExperience(args);
    case 'harness_promote_lesson':
      return engine.promoteExperienceToProjectKnowledge(args);
    case 'harness_index_refresh': {
      const idx = engine.buildIndex({ runQmdSync: args.run_qmd_sync !== false });
      return {
        refreshed: true,
        indexedAt: idx.indexedAt,
        totalDocuments: idx.totalDocuments,
        gitRevision: idx.gitRevision,
        qmdStatus: idx.qmdStatus
      };
    }
    case 'harness_run_loop':
      return engine.runHarness2Loop(args);
    case 'harness_model_invoke':
      return invokeUnifiedModel(root, {
        modelId: args.model_id || args.modelId,
        prompt: args.prompt,
        reasoningDepth: args.reasoning_depth || args.reasoningDepth,
        delegateToPeerModel: args.delegate_to_peer_model || args.delegateToPeerModel,
      });
    case 'harness_web_search':
      return searchWebMultiEngine(root, {
        query: args.query,
        engine: args.engine,
        limit: args.limit,
      });
    case 'harness_message_inject':
      return injectOrConveySwarmMessage(root, {
        fromAgent: args.from_agent || args.fromAgent,
        toAgent: args.to_agent || args.toAgent,
        fromModel: args.from_model || args.fromModel,
        toModel: args.to_model || args.toModel,
        type: args.type,
        content: args.content,
        reasoningDepth: args.reasoning_depth || args.reasoningDepth,
      });
    case 'harness_self_improve':
      return runSelfImprovementCoopCycle(root, engine, {
        ...args,
        task: args.task || args.problem,
        reasoningDepth: args.reasoning_depth || args.reasoningDepth,
      });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function processRpcMessage(msg, useContentLength = false) {
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;

  const sendResponse = (resultObj) => {
    if (id === undefined || id === null) return;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, result: resultObj });
    if (useContentLength) {
      process.stdout.write(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`);
    } else {
      process.stdout.write(payload + '\n');
    }
  };

  const sendError = (code, message) => {
    if (id === undefined || id === null) return;
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code, message }
    });
    if (useContentLength) {
      process.stdout.write(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`);
    } else {
      process.stdout.write(payload + '\n');
    }
  };

  try {
    if (method === 'initialize') {
      sendResponse({
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: {
          tools: {},
          resources: {}
        },
        serverInfo: {
          name: 'harness_ide_rag_mcp',
          version: '1.1.0'
        }
      });
    } else if (method === 'notifications/initialized' || method === 'initialized') {
      // No response required for notifications
    } else if (method === 'ping') {
      sendResponse({});
    } else if (method === 'tools/list') {
      sendResponse({ tools: TOOL_DEFINITIONS });
    } else if (method === 'resources/list') {
      const engine = getEngine();
      const index = engine.loadOrBuildIndex();
      sendResponse({
        resources: index.documents.map((d) => ({
          uri: `harness://${d.collection}/${d.docid}`,
          name: d.title,
          description: `[${d.collection}] ${d.path} (status: ${d.status})`,
          mimeType: 'text/markdown'
        }))
      });
    } else if (method === 'resources/read') {
      const uri = params?.uri || '';
      const docid = uri.split('/').pop();
      const engine = getEngine();
      const doc = engine.getDocument(docid);
      sendResponse({
        contents: [
          {
            uri,
            mimeType: 'text/markdown',
            text: doc.found ? doc.content : doc.error
          }
        ]
      });
    } else if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      const result = await handleToolCall(toolName, toolArgs);
      sendResponse({
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      });
    } else if (id !== undefined && id !== null) {
      sendResponse({});
    }
  } catch (err) {
    sendError(-32000, err?.message || String(err));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  let buffer = '';
  let useContentLength = false;

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buffer += chunk;

    while (true) {
      if (buffer.startsWith('Content-Length:')) {
        useContentLength = true;
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;
        const header = buffer.slice(0, headerEnd);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        const contentLen = match ? parseInt(match[1], 10) : 0;
        const bodyStart = headerEnd + 4;
        if (Buffer.byteLength(buffer.slice(bodyStart), 'utf8') < contentLen) break;
        const bodyBuf = Buffer.from(buffer.slice(bodyStart), 'utf8');
        const jsonStr = bodyBuf.subarray(0, contentLen).toString('utf8');
        buffer = bodyBuf.subarray(contentLen).toString('utf8');
        try {
          await processRpcMessage(JSON.parse(jsonStr), true);
        } catch {
          // Ignore malformed packet
        }
      } else {
        const newlineIdx = buffer.indexOf('\n');
        if (newlineIdx === -1) break;
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;
        try {
          await processRpcMessage(JSON.parse(line), useContentLength);
        } catch {
          // Ignore non-JSON lines
        }
      }
    }
  });
}
