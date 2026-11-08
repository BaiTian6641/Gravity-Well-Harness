#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let HarnessKnowledgeEngine;
try {
  ({ HarnessKnowledgeEngine } = await import('../src/rag-engine.mjs'));
} catch {
  ({ HarnessKnowledgeEngine } = await import('./rag-engine.mjs'));
}

let invokeUnifiedModel;
let searchWebMultiEngine;
let injectOrConveySwarmMessage;
let runSelfImprovementCoopCycle;
let getEnrichedModelCatalog;
let SEARCH_ENGINE_CATALOG;
try {
  ({
    invokeUnifiedModel,
    searchWebMultiEngine,
    injectOrConveySwarmMessage,
    runSelfImprovementCoopCycle,
    getEnrichedModelCatalog,
    SEARCH_ENGINE_CATALOG,
  } = await import('../src/model-hub.mjs'));
} catch {
  ({
    invokeUnifiedModel,
    searchWebMultiEngine,
    injectOrConveySwarmMessage,
    runSelfImprovementCoopCycle,
    getEnrichedModelCatalog,
    SEARCH_ENGINE_CATALOG,
  } = await import('./model-hub.mjs'));
}

let ContextResilienceManager;
try {
  ({ ContextResilienceManager } = await import('../src/context-resilience.mjs'));
} catch {
  ({ ContextResilienceManager } = await import('./context-resilience.mjs'));
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = fs.existsSync(path.join(path.resolve(__dirname, '..'), '.harness'))
  ? path.resolve(__dirname, '..')
  : fs.existsSync(path.join(path.resolve(__dirname, '..', '..', '..'), '.harness'))
    ? path.resolve(__dirname, '..', '..', '..')
    : path.resolve(__dirname, '..');

export const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
]);

function createRpcError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function enforceAllowedWorkspacesBoundary(realPath) {
  const rawAllowedList = [];
  if (process.env.HARNESS_ALLOWED_WORKSPACES) {
    rawAllowedList.push(
      ...String(process.env.HARNESS_ALLOWED_WORKSPACES)
        .split(/[,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }
  if (process.env.HARNESS_ALLOWED_WORKSPACE_ROOT) {
    rawAllowedList.push(
      ...String(process.env.HARNESS_ALLOWED_WORKSPACE_ROOT)
        .split(/[,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }
  if (rawAllowedList.length === 0) return;

  const allowedRealRoots = [];
  for (const rawAllowed of rawAllowedList) {
    try {
      if (fs.existsSync(rawAllowed)) {
        allowedRealRoots.push(fs.realpathSync(rawAllowed));
      } else {
        allowedRealRoots.push(path.resolve(rawAllowed));
      }
    } catch {
      allowedRealRoots.push(path.resolve(rawAllowed));
    }
  }

  const normTarget = process.platform === 'win32' ? realPath.toLowerCase() : realPath;
  const insideAny = allowedRealRoots.some((bound) => {
    const normBound = process.platform === 'win32' ? bound.toLowerCase() : bound;
    return normTarget === normBound || normTarget.startsWith(normBound + path.sep);
  });

  if (!insideAny) {
    throw createRpcError(
      -32602,
      `Workspace "${realPath}" is outside allowed workspace boundary (${allowedRealRoots.join(', ')})`
    );
  }
}

export function resolveWorkspace(args = {}) {
  const explicitRaw = args?.workspace_root ?? args?.workspaceRoot;
  if (explicitRaw !== undefined && explicitRaw !== null && String(explicitRaw).trim() !== '') {
    const rawStr = String(explicitRaw).trim();
    if (/(^|[\\/])\.\.([\\/]|$)/.test(rawStr)) {
      throw createRpcError(-32602, `Invalid workspace_root: path traversal denied (${rawStr})`);
    }
    if (!fs.existsSync(rawStr)) {
      throw createRpcError(-32602, `Invalid workspace_root: path does not exist (${rawStr})`);
    }
    let realPath;
    try {
      realPath = fs.realpathSync(rawStr);
    } catch (err) {
      throw createRpcError(-32602, `Invalid workspace_root: ${err?.message || rawStr}`);
    }
    let stat;
    try {
      stat = fs.statSync(realPath);
    } catch {
      throw createRpcError(-32602, `Invalid workspace_root: unable to stat (${realPath})`);
    }
    if (!stat.isDirectory()) {
      throw createRpcError(-32602, `Invalid workspace_root: path is not a directory (${realPath})`);
    }
    enforceAllowedWorkspacesBoundary(realPath);
    return realPath;
  }

  const envRoot = process.env.HARNESS_WORKSPACE_ROOT || process.env.ANTIGRAVITY_WORKSPACE_ROOT;
  if (envRoot && fs.existsSync(envRoot)) {
    try {
      const realEnv = fs.realpathSync(envRoot);
      if (fs.statSync(realEnv).isDirectory()) {
        enforceAllowedWorkspacesBoundary(realEnv);
        return realEnv;
      }
    } catch (err) {
      if (err?.code === -32602) throw err;
    }
  }

  if (fs.existsSync(path.join(process.cwd(), '.harness'))) {
    const realCwd = fs.realpathSync(process.cwd());
    enforceAllowedWorkspacesBoundary(realCwd);
    return realCwd;
  }
  if (fs.existsSync(path.join(REPO_ROOT, '.harness'))) {
    const realRepo = fs.realpathSync(REPO_ROOT);
    enforceAllowedWorkspacesBoundary(realRepo);
    return realRepo;
  }
  const fallbackCwd = fs.realpathSync(process.cwd());
  enforceAllowedWorkspacesBoundary(fallbackCwd);
  return fallbackCwd;
}

const resolveActiveWorkspaceRoot = resolveWorkspace;

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
      'Batch retrieve multiple source documents by array of docids (ids) or comma-separated docids/paths or glob patterns (pattern).',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Non-empty array of document IDs or relative paths.'
        },
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
      }
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
  },
  {
    name: 'harness_task_ledger',
    description:
      'Manage durable Argon Context Resilience requirement ledgers and exact cross-component contracts (get, upsert, register_contract, validate_contracts, resolve_conflict, record_progress).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'get',
            'upsert',
            'register_contract',
            'validate_contracts',
            'resolve_conflict',
            'record_progress'
          ],
          description: 'Task ledger or contract registry operation.'
        },
        task_id: {
          type: 'string',
          description: 'Task identifier (e.g., task-gw-01).'
        },
        objective: {
          type: 'string',
          description: 'Task objective (for upsert).'
        },
        user_correction: {
          type: 'string',
          description: 'Material user correction to preserve across compaction (for upsert).'
        },
        requirements: {
          type: 'array',
          items: { type: 'object' },
          description: 'Requirement entries to upsert.'
        },
        contract: {
          type: 'object',
          description: 'Contract specification for register_contract.'
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
    name: 'harness_checkpoint',
    description:
      'Write or load atomic resumable task checkpoints, restore subagent state after compaction, acknowledge recovery packets, or externalize large tool outputs (write, load, restore_subagent, acknowledge_recovery, store_bounded_log).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['write', 'load', 'restore_subagent', 'acknowledge_recovery', 'store_bounded_log'],
          description: 'Checkpoint operation.'
        },
        task_id: {
          type: 'string',
          description: 'Task identifier.'
        },
        worker_id: {
          type: 'string',
          description: 'Subagent worker ID (for restore_subagent or acknowledge_recovery).'
        },
        recovery_token: {
          type: 'string',
          description: 'Recovery token or checkpoint revision (for acknowledge_recovery).'
        },
        checkpoint_revision: {
          type: 'number',
          description: 'Checkpoint revision number (for acknowledge_recovery).'
        },
        tool_name: {
          type: 'string',
          description: 'Tool name (for store_bounded_log).'
        },
        raw_output: {
          type: 'string',
          description: 'Full tool output to externalize (for store_bounded_log).'
        },
        max_context_chars: {
          type: 'number',
          description: 'Maximum excerpt length kept in prompt context (default: 600).'
        },
        workspace_root: {
          type: 'string',
          description: 'Optional workspace root override.'
        }
      },
      required: ['action', 'task_id']
    }
  }
];

function getEngine(args = {}) {
  const root = resolveActiveWorkspaceRoot(args);
  return new HarnessKnowledgeEngine(root);
}

function requireNonEmptyString(val, fieldName, toolName) {
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw createRpcError(-32602, `Invalid params for ${toolName}: "${fieldName}" must be a non-empty string`);
  }
}

export async function handleToolCall(name, args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw createRpcError(-32602, `Invalid params for ${name}: arguments must be an object`);
  }

  const root = resolveActiveWorkspaceRoot(args);
  const engine = new HarnessKnowledgeEngine(root);

  switch (name) {
    case 'harness_query':
    case 'qmd_query': {
      requireNonEmptyString(args.query, 'query', name);
      return engine.query(args);
    }
    case 'harness_get':
    case 'qmd_get': {
      requireNonEmptyString(args.id, 'id', name);
      return engine.getDocument(args.id, {
        snapshot_id: args.snapshot_id ?? args.snapshotId,
        include_candidates: args.include_candidates ?? args.includeCandidates,
      });
    }
    case 'harness_multi_get':
    case 'qmd_multi_get': {
      let patternStr = '';
      if (args.ids !== undefined) {
        if (
          !Array.isArray(args.ids) ||
          args.ids.length === 0 ||
          !args.ids.every((item) => typeof item === 'string' && item.trim().length > 0)
        ) {
          throw createRpcError(
            -32602,
            `Invalid params for ${name}: "ids" must be a non-empty array of non-empty strings`
          );
        }
        patternStr = args.ids.join(', ');
      } else if (typeof args.pattern === 'string' && args.pattern.trim().length > 0) {
        patternStr = args.pattern;
      } else {
        throw createRpcError(
          -32602,
          `Invalid params for ${name}: requires "ids" (non-empty array) or "pattern" (non-empty string)`
        );
      }
      return engine.multiGet(patternStr, {
        snapshot_id: args.snapshot_id ?? args.snapshotId,
        include_candidates: args.include_candidates ?? args.includeCandidates,
      });
    }
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
      const action = args.action;
      if (typeof action !== 'string' || !['create', 'status', 'release', 'list'].includes(action)) {
        throw createRpcError(
          -32602,
          'Invalid params for harness_snapshot_lock: "action" must be create, status, release, or list'
        );
      }
      if (action === 'create') return engine.createSnapshotLock(args);
      if (action === 'release') {
        return engine.releaseSnapshotLock({
          snapshotId: args.snapshot_id ?? args.snapshotId,
          ownerRunId: args.owner_run_id ?? args.ownerRunId ?? args.owner_id ?? args.ownerId,
          force: args.force,
        });
      }
      if (action === 'list') return { snapshots: engine.listSnapshots() };
      return { activeLock: engine.getActiveSnapshotLock() };
    }
    case 'harness_record_experience': {
      const taskId = args.task_id ?? args.taskId;
      requireNonEmptyString(taskId, 'task_id', name);
      requireNonEmptyString(args.problem, 'problem', name);
      requireNonEmptyString(args.observed_behavior ?? args.observedBehavior, 'observed_behavior', name);
      return engine.recordExperience({
        ...args,
        task_id: taskId,
        observed_behavior: args.observed_behavior ?? args.observedBehavior,
        receiptId: args.receipt_id ?? args.receiptId,
        evaluationReceipt: args.evaluation_receipt ?? args.evaluationReceipt,
        status: args.status,
        synthetic: args.synthetic,
      });
    }
    case 'harness_promote_lesson': {
      const targetDocId = args.task_id_or_docid ?? args.experienceDocId ?? args.docid;
      requireNonEmptyString(targetDocId, 'task_id_or_docid', name);
      return engine.promoteExperienceToProjectKnowledge({
        ...args,
        task_id_or_docid: targetDocId,
        receiptId: args.receipt_id ?? args.receiptId,
        evaluationReceipt: args.evaluation_receipt ?? args.evaluationReceipt,
        status: args.status,
        synthetic: args.synthetic,
      });
    }
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
    case 'harness_run_loop': {
      const taskId = args.task_id || args.taskId;
      requireNonEmptyString(taskId, 'task_id', name);
      requireNonEmptyString(args.problem, 'problem', name);
      const explicitAllowSim = args.allow_simulation ?? args.allowSimulation;
      const strictExec = args.strict_execution ?? args.strictExecution;
      const allowSimulation =
        explicitAllowSim !== undefined
          ? Boolean(explicitAllowSim)
          : strictExec === true
            ? false
            : true;
      return await engine.runHarness2Loop({
        ...args,
        task_id: taskId,
        taskId,
        requiredArtifacts: args.required_artifacts ?? args.requiredArtifacts,
        allowSimulation,
        strictExecution: strictExec,
        passThreshold: args.pass_threshold ?? args.passThreshold,
      });
    }
    case 'harness_model_invoke': {
      requireNonEmptyString(args.prompt, 'prompt', name);
      return invokeUnifiedModel(root, {
        modelId: args.model_id || args.modelId,
        prompt: args.prompt,
        systemPrompt: args.system_prompt || args.systemPrompt,
        reasoningDepth: args.reasoning_depth || args.reasoningDepth,
        reasoningEffort: args.reasoning_effort || args.reasoningEffort,
        delegateToPeerModel: args.delegate_to_peer_model || args.delegateToPeerModel,
        strictExecution: args.strict_execution ?? args.strictExecution,
        allowSimulation: args.allow_simulation ?? args.allowSimulation,
        executionMode: args.execution_mode ?? args.executionMode,
        timeoutMs: args.timeout_ms ?? args.timeoutMs,
        endpoint: args.endpoint,
        baseUrl: args.base_url ?? args.baseUrl,
      });
    }
    case 'harness_web_search': {
      requireNonEmptyString(args.query, 'query', name);
      return searchWebMultiEngine(root, {
        query: args.query,
        engine: args.engine,
        limit: args.limit ?? args.maxResults ?? args.max_results,
        strictExecution: args.strict_execution ?? args.strictExecution,
        allowSimulation: args.allow_simulation ?? args.allowSimulation,
        executionMode: args.execution_mode ?? args.executionMode,
        endpoint: args.endpoint,
        deepseekSearchUrl: args.deepseek_search_url ?? args.deepseekSearchUrl,
        parallelSearchUrl: args.parallel_search_url ?? args.parallelSearchUrl,
        tavilySearchUrl: args.tavily_search_url ?? args.tavilySearchUrl,
        jinaSearchUrl: args.jina_search_url ?? args.jinaSearchUrl,
      });
    }
    case 'harness_message_inject': {
      requireNonEmptyString(args.content, 'content', name);
      return injectOrConveySwarmMessage(root, {
        id: args.id ?? args.message_id ?? args.messageId,
        fromAgent: args.from_agent || args.fromAgent,
        toAgent: args.to_agent || args.toAgent,
        fromModel: args.from_model || args.fromModel,
        toModel: args.to_model || args.toModel,
        type: args.type || args.messageType || args.message_type,
        priority: args.priority,
        content: args.content,
        reasoningDepth: args.reasoning_depth || args.reasoningDepth,
        strictExecution: args.strict_execution ?? args.strictExecution,
        allowSimulation: args.allow_simulation ?? args.allowSimulation,
        executionMode: args.execution_mode ?? args.executionMode,
        executeTargetModel: args.execute_target_model ?? args.executeTargetModel,
        runId: args.run_id ?? args.runId,
        candidateId: args.candidate_id ?? args.candidateId,
      });
    }
    case 'harness_self_improve':
      return runSelfImprovementCoopCycle(root, engine, {
        ...args,
        task: args.task || args.problem,
        reasoningDepth: args.reasoning_depth || args.reasoningDepth,
        strictExecution: args.strict_execution ?? args.strictExecution,
        allowSimulation: args.allow_simulation ?? args.allowSimulation,
        executionMode: args.execution_mode ?? args.executionMode,
      });
    case 'harness_task_ledger': {
      const action = args.action;
      const validActions = [
        'get',
        'upsert',
        'register_contract',
        'validate_contracts',
        'resolve_conflict',
        'record_progress'
      ];
      if (typeof action !== 'string' || !validActions.includes(action)) {
        throw createRpcError(
          -32602,
          `Invalid params for harness_task_ledger: "action" must be one of ${validActions.join(', ')}`
        );
      }
      const mgr = new ContextResilienceManager(root);
      if (action === 'resolve_conflict') {
        return mgr.resolveNoteVsSourceConflict({
          retrievedNote: args.retrieved_note || args.retrievedNote,
          sourceFile: args.source_file || args.sourceFile,
          approvedRequirement: args.approved_requirement || args.approvedRequirement,
        });
      }
      const taskId = args.task_id || args.taskId;
      requireNonEmptyString(taskId, 'task_id', name);
      if (action === 'get') {
        return mgr.loadRequirementLedger(taskId);
      }
      if (action === 'upsert') {
        return mgr.upsertRequirementLedger(taskId, {
          objective: args.objective,
          userCorrection: args.user_correction ?? args.userCorrection,
          requirements: args.requirements || [],
        });
      }
      if (action === 'register_contract') {
        const rawSpec = args.contract && typeof args.contract === 'object' ? args.contract : args;
        return mgr.registerContract(taskId, {
          ...rawSpec,
          contractId: rawSpec.contractId || rawSpec.contract_id,
          symbolName: rawSpec.symbolName || rawSpec.symbol_name,
          storageKey: rawSpec.storageKey || rawSpec.storage_key,
          unit: rawSpec.unit,
          consumerUnit: rawSpec.consumerUnit || rawSpec.consumer_unit,
          producerFile: rawSpec.producerFile || rawSpec.producer_file,
          consumerFile: rawSpec.consumerFile || rawSpec.consumer_file,
        });
      }
      if (action === 'validate_contracts') {
        return mgr.validateContracts(taskId);
      }
      if (action === 'record_progress') {
        return mgr.recordAttemptProgress(taskId, {
          madeProgress: Boolean(args.made_progress ?? args.madeProgress),
          maxStagnantAttempts: Number(args.max_stagnant_attempts ?? args.maxStagnantAttempts ?? 3),
        });
      }
      break;
    }
    case 'harness_checkpoint': {
      const action = args.action;
      const validActions = [
        'write',
        'load',
        'restore_subagent',
        'acknowledge_recovery',
        'store_bounded_log'
      ];
      if (typeof action !== 'string' || !validActions.includes(action)) {
        throw createRpcError(
          -32602,
          `Invalid params for harness_checkpoint: "action" must be one of ${validActions.join(', ')}`
        );
      }
      const taskId = args.task_id || args.taskId;
      requireNonEmptyString(taskId, 'task_id', name);
      const mgr = new ContextResilienceManager(root);
      if (action === 'write') {
        return mgr.writeCheckpoint(taskId, {
          activeWorkers: args.active_workers || args.activeWorkers || [],
          pendingMessages: args.pending_messages || args.pendingMessages || [],
          knownFailures: args.known_failures || args.knownFailures || [],
          nextAction: args.next_action || args.nextAction || '',
          contextMetrics: args.context_metrics || args.contextMetrics || null,
          simulateCrashBeforePointerSwap: Boolean(
            args.simulate_crash_before_pointer_swap ?? args.simulateCrashBeforePointerSwap
          ),
        });
      }
      if (action === 'load') {
        return mgr.loadLatestCheckpoint(taskId);
      }
      if (action === 'restore_subagent') {
        const workerId = args.worker_id || args.workerId;
        requireNonEmptyString(workerId, 'worker_id', name);
        return mgr.restoreSubagentFromCheckpoint(taskId, workerId, args);
      }
      if (action === 'acknowledge_recovery') {
        const workerId = args.worker_id || args.workerId;
        requireNonEmptyString(workerId, 'worker_id', name);
        if (typeof mgr.acknowledgeRecoveryPacket === 'function') {
          return mgr.acknowledgeRecoveryPacket(taskId, workerId, args);
        }
        return {
          ok: true,
          acknowledged: true,
          taskId,
          workerId,
          recoveryToken: args.recovery_token ?? args.recoveryToken ?? null,
        };
      }
      if (action === 'store_bounded_log') {
        const toolName = args.tool_name || args.toolName || 'tool';
        return mgr.storeBoundedToolOutput(
          taskId,
          toolName,
          args.raw_output ?? args.rawOutput ?? '',
          Number(args.max_context_chars ?? args.maxContextChars ?? 600)
        );
      }
      break;
    }
    default:
      throw createRpcError(-32601, `Unknown tool: ${name}`);
  }
}

export async function handleJsonRpcMessage(msg) {
  if (!msg || typeof msg !== 'object') {
    return {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request' }
    };
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  const makeResult = (resultObj) => {
    if (isNotification) return null;
    return { jsonrpc: '2.0', id, result: resultObj };
  };

  const makeError = (code, message) => {
    if (isNotification) return null;
    return {
      jsonrpc: '2.0',
      id,
      error: { code, message }
    };
  };

  try {
    if (method === 'initialize') {
      const requestedVersion = params?.protocolVersion ?? '2024-11-05';
      if (
        typeof requestedVersion !== 'string' ||
        !SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
      ) {
        return makeError(
          -32602,
          `Unsupported protocolVersion "${requestedVersion}". Supported versions: ${Array.from(
            SUPPORTED_PROTOCOL_VERSIONS
          ).join(', ')}`
        );
      }
      return makeResult({
        protocolVersion: requestedVersion,
        capabilities: {
          tools: {},
          resources: {}
        },
        serverInfo: {
          name: 'harness_ide_rag_mcp',
          version: '1.1.0'
        }
      });
    }

    if (method === 'notifications/initialized' || method === 'initialized') {
      return null;
    }

    if (method === 'ping') {
      return makeResult({});
    }

    if (method === 'tools/list') {
      return makeResult({ tools: TOOL_DEFINITIONS });
    }

    if (method === 'resources/list') {
      const engine = getEngine(params || {});
      const index = engine.loadOrBuildIndex();
      const activeLock = engine.getActiveSnapshotLock();
      const eligibleSet =
        activeLock && activeLock.active && Array.isArray(activeLock.eligibleDocIds)
          ? new Set(activeLock.eligibleDocIds)
          : null;
      const cutoffMs =
        activeLock && activeLock.active && activeLock.cutoffTimestamp
          ? Date.parse(activeLock.cutoffTimestamp)
          : 0;

      const visibleDocs = (index.documents || []).filter((d) => {
        if (!d || d.status !== 'active' || d.synthetic === true) return false;
        if (eligibleSet && !eligibleSet.has(d.docid)) return false;
        if (cutoffMs > 0 && d.created_at) {
          const docMs = Date.parse(d.created_at);
          if (docMs > cutoffMs) return false;
        }
        return true;
      });

      return makeResult({
        resources: visibleDocs.map((d) => ({
          uri: `harness://${d.collection}/${d.docid}`,
          name: d.title,
          description: `[${d.collection}] ${d.path} (status: ${d.status})`,
          mimeType: 'text/markdown'
        }))
      });
    }

    if (method === 'resources/read') {
      const uri = typeof params?.uri === 'string' ? params.uri.trim() : '';
      if (!uri) {
        return makeError(-32602, 'Invalid params for resources/read: "uri" is required');
      }
      const docid = uri.split('/').pop();
      const engine = getEngine(params || {});
      const activeLock = engine.getActiveSnapshotLock();
      const doc = engine.getDocument(docid, {
        snapshot_id:
          params?.snapshot_id || (activeLock?.active ? activeLock.snapshotId : undefined),
        include_candidates: false
      });

      if (!doc || !doc.found || (doc.status && doc.status !== 'active')) {
        return makeError(
          -32002,
          doc?.error || `Resource not found or excluded by active snapshot lock: ${uri}`
        );
      }

      return makeResult({
        contents: [
          {
            uri,
            mimeType: 'text/markdown',
            text: doc.content
          }
        ]
      });
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      if (typeof toolName !== 'string' || !toolName.trim()) {
        return makeError(-32602, 'Invalid params for tools/call: "name" must be a non-empty string');
      }
      const toolArgs = params?.arguments ?? {};
      const result = await handleToolCall(toolName, toolArgs);
      const isErr = Boolean(result && typeof result === 'object' && result.ok === false);
      return makeResult({
        ...(isErr ? { isError: true } : {}),
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      });
    }

    return makeError(-32601, `Method not found: ${method}`);
  } catch (err) {
    const code = typeof err?.code === 'number' ? err.code : -32000;
    return makeError(code, err?.message || String(err));
  }
}

async function processRpcMessage(msg, useContentLength = false) {
  const responseObj = await handleJsonRpcMessage(msg);
  if (!responseObj) return;
  const payload = JSON.stringify(responseObj);
  if (useContentLength) {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`);
  } else {
    process.stdout.write(payload + '\n');
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
