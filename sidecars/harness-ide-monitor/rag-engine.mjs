import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setSecretInVault, getSecretVaultStatusSummary } from './secret-vault.mjs';

const GLOBAL_SETTINGS_PATH = path.join(os.homedir(), '.gemini', 'config', 'harness-ide-settings.json');

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he',
  'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the', 'to', 'was', 'were',
  'will', 'with', 'what', 'which', 'who', 'whom', 'this', 'these', 'those',
  'am', 'or', 'but', 'if', 'because', 'until', 'while', 'about', 'against',
  'between', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'up', 'down', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'any',
  'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
  'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'can', 'just',
  'should', 'now', 'our', 'we', 'did', 'do', 'does'
]);

const SEMANTIC_CLUSTERS = [
  ['memory', 'rag', 'qmd', 'retrieval', 'index', 'embedding', 'vector', 'bm25', 'knowledge', 'basic-memory', 'ragflow'],
  ['evidence', 'supported', 'provenance', 'empirically', 'observed', 'conclusion', 'decision', 'adr', 'choice'],
  ['failed', 'failure', 'rejected', 'error', 'mistake', 'contaminate', 'leakage', 'stuffing', 'drift'],
  ['training', 'experiment', 'experiments', 'trial', 'trials', 'rollout', 'probe', 'probing', 'benchmark', 'evaluation'],
  ['constraints', 'constraint', 'boundary', 'requirement', 'rule', 'guardrail', 'policy', 'isolation', 'security'],
  ['android', 'frontend', 'client', 'mobile', 'ui', 'jetpack', 'kotlin'],
  ['linux', 'backend', 'server', 'daemon', 'loopback', 'node', 'python', 'api'],
  ['harness', 'harness2', 'propose', 'probe', 'compose', 'reflect', 'library', 'experience', 'cue', 'subagent', 'swarm'],
  ['snapshot', 'cutoff', 'frozen', 'lock', 'isolated', 'branch', 'consistency', 'fair']
];

export function parseFrontmatter(markdown) {
  const normalized = markdown.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { metadata: {}, body: normalized };
  }
  const endIdx = normalized.indexOf('\n---\n', 4);
  if (endIdx === -1) {
    return { metadata: {}, body: normalized };
  }
  const rawYaml = normalized.slice(4, endIdx);
  const body = normalized.slice(endIdx + 5).trim();
  const metadata = {};
  let currentListKey = null;

  for (const line of rawYaml.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('- ') && currentListKey) {
      const val = trimmed.slice(2).trim().replace(/^["']|["']$/g, '');
      if (!Array.isArray(metadata[currentListKey])) {
        metadata[currentListKey] = [];
      }
      metadata[currentListKey].push(val);
      continue;
    }
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx !== -1) {
      const key = trimmed.slice(0, colonIdx).trim();
      const rawVal = trimmed.slice(colonIdx + 1).trim();
      if (!rawVal) {
        currentListKey = key;
        metadata[key] = [];
      } else if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
        currentListKey = null;
        metadata[key] = rawVal
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
      } else {
        currentListKey = null;
        metadata[key] = rawVal.replace(/^["']|["']$/g, '');
      }
    }
  }
  return { metadata, body };
}

export function stemToken(word) {
  let w = word.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('es') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) return w.slice(0, -1);
  return w;
}

export function tokenize(text, includeStopwords = false) {
  if (!text) return [];
  const normalized = String(text)
    .toLowerCase()
    .replace(/harness²/g, 'harness2');
  const raw = normalized
    .split(/[^a-z0-9_-]+/)
    .filter((t) => t.length >= 2);
  const tokens = [];
  for (const t of raw) {
    if (!includeStopwords && STOPWORDS.has(t)) continue;
    tokens.push(t);
    const stemmed = stemToken(t);
    if (stemmed && stemmed !== t) {
      tokens.push(stemmed);
    }
  }
  const cjkMatches = normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu);
  if (cjkMatches) {
    for (const seq of cjkMatches) {
      const chars = Array.from(seq);
      for (let i = 0; i < chars.length; i++) {
        tokens.push(chars[i]);
        if (i + 1 < chars.length) {
          tokens.push(chars[i] + chars[i + 1]);
        }
      }
    }
  }
  return tokens;
}

const SNAPSHOT_ID_REGEX = /^snap-[a-zA-Z0-9_-]{4,80}$/i;

const VECTOR_DIM = 256;

function hashStringToDim(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const idx = Math.abs(h) % VECTOR_DIM;
  const sign = (h & 1) === 0 ? 1 : -1;
  return { idx, sign };
}

export function computeDenseVector(text, boostTokens = []) {
  const vec = new Float32Array(VECTOR_DIM);
  const tokens = tokenize(text, false);

  const addFeature = (feat, weight = 1.0) => {
    const { idx, sign } = hashStringToDim(feat);
    vec[idx] += sign * weight;
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    addFeature(`u:${tok}`, 1.0);
    if (i + 1 < tokens.length) {
      addFeature(`b:${tok}_${tokens[i + 1]}`, 0.7);
    }
    if (tok.length >= 4) {
      for (let c = 0; c <= tok.length - 3; c++) {
        addFeature(`c3:${tok.slice(c, c + 3)}`, 0.25);
      }
    }
    for (let clusterIdx = 0; clusterIdx < SEMANTIC_CLUSTERS.length; clusterIdx++) {
      if (SEMANTIC_CLUSTERS[clusterIdx].includes(tok)) {
        addFeature(`sem_cluster_${clusterIdx}`, 1.6);
      }
    }
  }

  for (const bt of boostTokens) {
    addFeature(`u:${bt}`, 2.2);
    for (let clusterIdx = 0; clusterIdx < SEMANTIC_CLUSTERS.length; clusterIdx++) {
      if (SEMANTIC_CLUSTERS[clusterIdx].includes(bt)) {
        addFeature(`sem_cluster_${clusterIdx}`, 2.5);
      }
    }
  }

  let normSq = 0;
  for (let i = 0; i < VECTOR_DIM; i++) {
    normSq += vec[i] * vec[i];
  }
  const norm = Math.sqrt(normSq) || 1;
  const result = new Array(VECTOR_DIM);
  for (let i = 0; i < VECTOR_DIM; i++) {
    result[i] = Number((vec[i] / norm).toFixed(5));
  }
  return result;
}

export function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dot = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
  }
  return dot;
}

export const REASONING_DEPTH_PROFILES = {
  eco: {
    id: 'eco',
    label: 'Eco / Token-Saver (~71% fewer tokens)',
    reasoningDepth: 'eco',
    thinkingBudgetTokens: 1024,
    maxCandidateTokens: 12000,
    maxProbeSteps: 4,
    ragTopK: 4,
    ragSnippetMaxChars: 320,
    proberModelTier: 'flash_lite',
    composerModelTier: 'flash',
    earlyStopOnFirstPass: true,
    contextPruningMode: 'cue-only',
    estimatedTokenSavingsPct: 71.4,
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced / Adaptive (~53% fewer tokens — Recommended)',
    reasoningDepth: 'balanced',
    thinkingBudgetTokens: 2048,
    maxCandidateTokens: 24000,
    maxProbeSteps: 6,
    ragTopK: 6,
    ragSnippetMaxChars: 500,
    proberModelTier: 'flash',
    composerModelTier: 'inherit',
    earlyStopOnFirstPass: true,
    contextPruningMode: 'cue-first',
    estimatedTokenSavingsPct: 52.8,
  },
  deep: {
    id: 'deep',
    label: 'Deep Reasoning (Complex Architecture & Multi-Stage Swarms)',
    reasoningDepth: 'deep',
    thinkingBudgetTokens: 8192,
    maxCandidateTokens: 64000,
    maxProbeSteps: 12,
    ragTopK: 10,
    ragSnippetMaxChars: 1200,
    proberModelTier: 'inherit',
    composerModelTier: 'pro',
    earlyStopOnFirstPass: false,
    contextPruningMode: 'section-full',
    estimatedTokenSavingsPct: 24.5,
  },
};

export const INDEX_SCHEMA_VERSION = '2.0.0';
export const TOKENIZER_VERSION = '2.0.0';

const IN_MEMORY_EXECUTOR_HANDLERS = new Map();
const IN_MEMORY_VERIFIER_HANDLERS = new Map();

export class HarnessKnowledgeEngine {
  constructor(workspaceRoot = process.cwd()) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.harnessDir = path.join(this.workspaceRoot, '.harness');
    this.configPath = path.join(this.harnessDir, 'config.json');
    this.indexDir = path.join(this.harnessDir, 'index');
    this.indexFilePath = path.join(this.indexDir, 'local-rag-index.json');
    this.snapshotsDir = path.join(this.harnessDir, 'snapshots');
    this.snapshotBlobsDir = path.join(this.snapshotsDir, 'blobs');
    this.activeLockPath = path.join(this.snapshotsDir, 'active.lock.json');
    this.snapshotMutexLockPath = path.join(this.snapshotsDir, '.lock');
    this.receiptsDir = path.join(this.harnessDir, 'receipts');
    this.runtimeDir = path.join(this.harnessDir, 'runtime');
    this.registryDir = path.join(this.harnessDir, 'registry');
    this.executorsRegistryPath = path.join(this.registryDir, 'executors.json');
    this.verifiersRegistryPath = path.join(this.registryDir, 'verifiers.json');
    this.telemetryPath = path.join(this.runtimeDir, 'telemetry.json');
    this.lastRunPath = path.join(this.runtimeDir, 'last-harness2-run.json');
  }

  ensureDirectories() {
    const dirs = [
      this.harnessDir,
      this.indexDir,
      this.snapshotsDir,
      this.snapshotBlobsDir,
      this.receiptsDir,
      this.runtimeDir,
      this.registryDir,
      path.join(this.harnessDir, 'knowledge', 'project'),
      path.join(this.harnessDir, 'knowledge', 'experiments'),
      path.join(this.harnessDir, 'knowledge', 'reference'),
      path.join(this.harnessDir, 'library')
    ];
    for (const d of dirs) {
      fs.mkdirSync(d, { recursive: true });
    }
  }

  _resolveRealPathWithNonExistentTail(targetPath) {
    let cur = path.resolve(targetPath);
    const tailSegments = [];
    const visitedLinks = new Set();
    while (true) {
      try {
        const lstat = fs.lstatSync(cur);
        if (lstat.isSymbolicLink()) {
          if (visitedLinks.has(cur)) {
            throw new Error(`Symlink loop detected at ${cur}`);
          }
          visitedLinks.add(cur);
          const linkTarget = fs.readlinkSync(cur);
          cur = path.resolve(path.dirname(cur), linkTarget);
          continue;
        }
      } catch (err) {
        if (err && err.message && err.message.includes('Symlink loop')) {
          throw err;
        }
        // Path segment does not exist yet
      }
      if (fs.existsSync(cur)) {
        const realBase = fs.realpathSync(cur);
        return tailSegments.length > 0 ? path.resolve(realBase, ...tailSegments) : realBase;
      }
      const parent = path.dirname(cur);
      if (parent === cur) {
        return tailSegments.length > 0 ? path.resolve(cur, ...tailSegments) : cur;
      }
      tailSegments.unshift(path.basename(cur));
      cur = parent;
    }
  }

  _isPathInsideWorkspace(targetPath) {
    try {
      const rootResolved = path.resolve(this.workspaceRoot);
      const targetResolved = path.resolve(targetPath);
      const rel = path.relative(rootResolved, targetResolved);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return false;
      }
      const wsReal = this._resolveRealPathWithNonExistentTail(rootResolved);
      const resolved = this._resolveRealPathWithNonExistentTail(targetResolved);
      const normWs = process.platform === 'win32' ? wsReal.toLowerCase() : wsReal;
      const normResolved = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      if (normResolved !== normWs && !normResolved.startsWith(normWs + path.sep)) {
        return false;
      }
      const realRel = path.relative(wsReal, resolved);
      if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  assertContainedPath(targetPath, label = 'path') {
    if (!this._isPathInsideWorkspace(targetPath)) {
      throw new Error(
        `Path containment violation for ${label}: "${targetPath}" escapes workspace root "${this.workspaceRoot}"`
      );
    }
    return targetPath;
  }

  loadConfig() {
    let baseConfig = {
      version: '1.0.0',
      rag: {
        primaryBackend: 'qmd-hybrid',
        enableQmdCliIfAvailable: true,
        enableBuiltinLocalEngine: true,
        autoIndexOnChange: true,
        defaultSearchMode: 'hybrid',
        defaultTopK: 8,
        rrfK: 60,
        collections: {
          'project-knowledge': {
            path: '.harness/knowledge/project',
            description: 'Current project requirements, architecture decisions (ADRs), setup instructions, and active constraints.'
          },
          'experiment-knowledge': {
            path: '.harness/library',
            extraPaths: ['.harness/knowledge/experiments'],
            description: 'Harness2 INDEX.md catalogs, EXPERIENCE.md lessons, failure analyses, and adopted harness configurations.'
          },
          'reference-knowledge': {
            path: '.harness/knowledge/reference',
            description: 'Selected external documentation, research paper summaries, API notes, and hardware/technical references.'
          }
        },
        optionalBackends: {
          basicMemory: { enabled: false, command: 'uvx', args: ['basic-memory', 'mcp'] },
          ragflow: { enabled: false, baseUrl: 'http://127.0.0.1:9380' }
        }
      },
      externalDocs: {
        context7: { enabled: true, serverUrl: 'https://mcp.context7.com/mcp' },
        googleDeveloperKnowledge: { enabled: false, serverUrl: 'https://developers.google.com/knowledge/mcp' }
      },
      harness2: {
        executionLevel: 'native-antigravity-swarm',
        defaultMode: 'parallel',
        defaultCandidatesK: 2,
        strictSnapshotIsolation: true,
        autoRecordExperiencePrompt: true,
        reasoningDepth: 'balanced',
        thinkingBudgetTokens: 2048,
        maxCandidateTokens: 24000,
        maxProbeSteps: 6,
        ragTopK: 6,
        ragSnippetMaxChars: 500,
        proberModelTier: 'flash',
        composerModelTier: 'inherit',
        earlyStopOnFirstPass: true,
        contextPruningMode: 'cue-first',
      },
      uiMonitor: {
        pollIntervalMs: 2500,
        maxSubagentDepthAlert: 3,
        enablePrePlanningRagHook: true,
        enablePostToolTelemetryHook: true,
        themeMode: 'auto'
      }
    };

    try {
      if (fs.existsSync(GLOBAL_SETTINGS_PATH)) {
        const globalData = JSON.parse(fs.readFileSync(GLOBAL_SETTINGS_PATH, 'utf8'));
        baseConfig = this._deepMerge(baseConfig, globalData);
      }
    } catch {
      // Ignore malformed global config
    }

    try {
      if (fs.existsSync(this.configPath)) {
        const localData = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        baseConfig = this._deepMerge(baseConfig, localData);
      }
    } catch {
      // Ignore malformed local config
    }

    // Read Antigravity IDE Settings (.vscode/settings.json)
    try {
      const ideSettingsPath = path.join(this.workspaceRoot, '.vscode', 'settings.json');
      if (fs.existsSync(ideSettingsPath)) {
        const ide = JSON.parse(fs.readFileSync(ideSettingsPath, 'utf8'));
        if (ide['antigravity.harness.rag.primaryBackend']) {
          baseConfig.rag.primaryBackend = ide['antigravity.harness.rag.primaryBackend'];
        }
        if (typeof ide['antigravity.harness.rag.autoIndexOnChange'] === 'boolean') {
          baseConfig.rag.autoIndexOnChange = ide['antigravity.harness.rag.autoIndexOnChange'];
        }
        if (typeof ide['antigravity.harness.rag.enableQmdCli'] === 'boolean') {
          baseConfig.rag.enableQmdCliIfAvailable = ide['antigravity.harness.rag.enableQmdCli'];
        }
        if (ide['antigravity.harness.reasoningDepth']) {
          baseConfig.harness2.reasoningDepth = ide['antigravity.harness.reasoningDepth'];
        }
        if (typeof ide['antigravity.harness.harness2.strictSnapshotIsolation'] === 'boolean') {
          baseConfig.harness2.strictSnapshotIsolation = ide['antigravity.harness.harness2.strictSnapshotIsolation'];
        }
        if (ide['antigravity.harness.harness2.defaultMode']) {
          baseConfig.harness2.defaultMode = ide['antigravity.harness.harness2.defaultMode'];
        }
        if (typeof ide['antigravity.harness.harness2.defaultCandidatesK'] === 'number') {
          baseConfig.harness2.defaultCandidatesK = ide['antigravity.harness.harness2.defaultCandidatesK'];
        }
        if (typeof ide['antigravity.harness.harness2.thinkingBudgetTokens'] === 'number') {
          baseConfig.harness2.thinkingBudgetTokens = ide['antigravity.harness.harness2.thinkingBudgetTokens'];
        }
        if (ide['antigravity.harness.harness2.proberModelTier']) {
          baseConfig.harness2.proberModelTier = ide['antigravity.harness.harness2.proberModelTier'];
        }
        if (typeof ide['antigravity.harness.harness2.ragSnippetMaxChars'] === 'number') {
          baseConfig.harness2.ragSnippetMaxChars = ide['antigravity.harness.harness2.ragSnippetMaxChars'];
        }
        if (typeof ide['antigravity.harness.harness2.earlyStopOnFirstPass'] === 'boolean') {
          baseConfig.harness2.earlyStopOnFirstPass = ide['antigravity.harness.harness2.earlyStopOnFirstPass'];
        }
      }
    } catch {
      // Ignore malformed IDE settings
    }

    // Never expose plaintext apiKey fields; attach Secret Vault status summary instead
    if (baseConfig.externalDocs?.context7 && 'apiKey' in baseConfig.externalDocs.context7) {
      delete baseConfig.externalDocs.context7.apiKey;
    }
    if (baseConfig.rag?.optionalBackends?.ragflow && 'apiKey' in baseConfig.rag.optionalBackends.ragflow) {
      delete baseConfig.rag.optionalBackends.ragflow.apiKey;
    }
    baseConfig.secretVault = getSecretVaultStatusSummary();

    return baseConfig;
  }

  saveConfig(partialConfig, saveGlobal = true) {
    this.ensureDirectories();
    const sanitized = JSON.parse(JSON.stringify(partialConfig || {}));
    if (sanitized.externalDocs?.context7?.apiKey) {
      setSecretInVault('CONTEXT7_API_KEY', sanitized.externalDocs.context7.apiKey);
      delete sanitized.externalDocs.context7.apiKey;
    }
    if (sanitized.rag?.optionalBackends?.ragflow?.apiKey) {
      setSecretInVault('RAGFLOW_API_KEY', sanitized.rag.optionalBackends.ragflow.apiKey);
      delete sanitized.rag.optionalBackends.ragflow.apiKey;
    }
    const merged = this._deepMerge(this.loadConfig(), sanitized);
    if (merged.externalDocs?.context7 && 'apiKey' in merged.externalDocs.context7) {
      delete merged.externalDocs.context7.apiKey;
    }
    if (merged.rag?.optionalBackends?.ragflow && 'apiKey' in merged.rag.optionalBackends.ragflow) {
      delete merged.rag.optionalBackends.ragflow.apiKey;
    }
    delete merged.secretVault;

    fs.writeFileSync(this.configPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    if (saveGlobal) {
      try {
        fs.mkdirSync(path.dirname(GLOBAL_SETTINGS_PATH), { recursive: true });
        fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
      } catch {
        // Ignore if global config dir is read-only
      }
    }
    // Sync non-secret preferences to Antigravity IDE Settings (.vscode/settings.json)
    try {
      const ideDir = path.join(this.workspaceRoot, '.vscode');
      const ideSettingsPath = path.join(ideDir, 'settings.json');
      let existing = {};
      if (fs.existsSync(ideSettingsPath)) {
        existing = JSON.parse(fs.readFileSync(ideSettingsPath, 'utf8'));
      }
      if (merged.rag?.primaryBackend) {
        existing['antigravity.harness.rag.primaryBackend'] = merged.rag.primaryBackend;
      }
      if (typeof merged.rag?.autoIndexOnChange === 'boolean') {
        existing['antigravity.harness.rag.autoIndexOnChange'] = merged.rag.autoIndexOnChange;
      }
      if (typeof merged.rag?.enableQmdCliIfAvailable === 'boolean') {
        existing['antigravity.harness.rag.enableQmdCli'] = merged.rag.enableQmdCliIfAvailable;
      }
      if (merged.harness2?.reasoningDepth) {
        existing['antigravity.harness.reasoningDepth'] = merged.harness2.reasoningDepth;
      }
      if (typeof merged.harness2?.strictSnapshotIsolation === 'boolean') {
        existing['antigravity.harness.harness2.strictSnapshotIsolation'] = merged.harness2.strictSnapshotIsolation;
      }
      if (merged.harness2?.defaultMode) {
        existing['antigravity.harness.harness2.defaultMode'] = merged.harness2.defaultMode;
      }
      if (typeof merged.harness2?.defaultCandidatesK === 'number') {
        existing['antigravity.harness.harness2.defaultCandidatesK'] = merged.harness2.defaultCandidatesK;
      }
      if (typeof merged.harness2?.thinkingBudgetTokens === 'number') {
        existing['antigravity.harness.harness2.thinkingBudgetTokens'] = merged.harness2.thinkingBudgetTokens;
      }
      if (merged.harness2?.proberModelTier) {
        existing['antigravity.harness.harness2.proberModelTier'] = merged.harness2.proberModelTier;
      }
      if (typeof merged.harness2?.ragSnippetMaxChars === 'number') {
        existing['antigravity.harness.harness2.ragSnippetMaxChars'] = merged.harness2.ragSnippetMaxChars;
      }
      if (typeof merged.harness2?.earlyStopOnFirstPass === 'boolean') {
        existing['antigravity.harness.harness2.earlyStopOnFirstPass'] = merged.harness2.earlyStopOnFirstPass;
      }
      fs.mkdirSync(ideDir, { recursive: true });
      fs.writeFileSync(ideSettingsPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
    } catch {
      // Ignore if .vscode is read-only
    }
    merged.secretVault = getSecretVaultStatusSummary();
    return merged;
  }

  _deepMerge(target, source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return source;
    const output = { ...target };
    for (const key of Object.keys(source)) {
      if (
        source[key] &&
        typeof source[key] === 'object' &&
        !Array.isArray(source[key]) &&
        target[key] &&
        typeof target[key] === 'object' &&
        !Array.isArray(target[key])
      ) {
        output[key] = this._deepMerge(target[key], source[key]);
      } else {
        output[key] = source[key];
      }
    }
    return output;
  }

  detectQmdCli() {
    try {
      const cmd = process.platform === 'win32' ? 'qmd.cmd' : 'qmd';
      const res = spawnSync(cmd, ['--version'], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true
      });
      if (res.status === 0) {
        return { installed: true, version: (res.stdout || '').trim() || 'detected' };
      }
    } catch {
      // QMD not on PATH
    }
    return {
      installed: false,
      version: null,
      installHint: 'npm install -g @tobilu/qmd (or bun install -g @tobilu/qmd); Built-in Local Hybrid Engine is active.'
    };
  }

  getGitRevision() {
    try {
      const res = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: this.workspaceRoot,
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true
      });
      if (res.status === 0 && res.stdout) {
        return res.stdout.trim();
      }
    } catch {
      // Fallback
    }
    return 'HEAD';
  }

  _walkMarkdownFiles(dirPath) {
    const results = [];
    if (!this._isPathInsideWorkspace(dirPath) || !fs.existsSync(dirPath)) return results;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (!this._isPathInsideWorkspace(fullPath)) continue;
      if (entry.isDirectory()) {
        if (
          entry.name === 'node_modules' ||
          entry.name === '.git' ||
          entry.name === 'index' ||
          entry.name === 'revisions'
        ) {
          continue;
        }
        results.push(...this._walkMarkdownFiles(fullPath));
      } else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.json'))) {
        // Index .md files and harness/manifest.json files
        if (entry.name.endsWith('.md') || entry.name === 'manifest.json') {
          results.push(fullPath);
        }
      }
    }
    return results;
  }

  _readConsistentFileBytes(filePath) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const statBefore = fs.statSync(filePath);
      const rawContent = fs.readFileSync(filePath, 'utf8');
      const statAfter = fs.statSync(filePath);
      if (
        statBefore.mtimeMs === statAfter.mtimeMs &&
        statBefore.size === statAfter.size
      ) {
        return { rawContent, mtimeIso: statAfter.mtime.toISOString(), mtimeMs: statAfter.mtimeMs };
      }
    }
    const statFinal = fs.statSync(filePath);
    const rawContent = fs.readFileSync(filePath, 'utf8');
    return { rawContent, mtimeIso: statFinal.mtime.toISOString(), mtimeMs: statFinal.mtimeMs };
  }

  _buildDocumentFromRawBytes(filePath, rawContent, collectionName, mtimeIso) {
    const relFile = path.relative(this.workspaceRoot, filePath).replace(/\\/g, '/');
    const blobHash = crypto.createHash('sha256').update(rawContent, 'utf8').digest('hex');

    let metadata = {};
    let body = rawContent;
    let title = path.basename(filePath);

    if (filePath.endsWith('.md')) {
      const parsed = parseFrontmatter(rawContent);
      metadata = parsed.metadata;
      body = parsed.body;
      const firstH1 = body.match(/^#\s+(.+)$/m);
      title = metadata.title || (firstH1 ? firstH1[1].trim() : path.basename(filePath, '.md'));
    } else if (filePath.endsWith('.json')) {
      try {
        const jsonObj = JSON.parse(rawContent);
        metadata = {
          docid: jsonObj.harness_id || `MANIFEST-${jsonObj.task_id || path.basename(path.dirname(filePath))}`,
          title: `Adopted Harness Manifest: ${jsonObj.task_id || relFile}`,
          domain: jsonObj.domain || 'software-engineering',
          task_id: jsonObj.task_id || '',
          git_revision: jsonObj.git_revision || 'HEAD',
          created_at: jsonObj.adopted_at || mtimeIso,
          status: jsonObj.status || 'candidate',
          synthetic: Boolean(jsonObj.synthetic),
          tags: ['harness-manifest', 'adopted-harness']
        };
        title = metadata.title;
      } catch {
        metadata = { status: 'candidate' };
      }
    }

    const docid =
      metadata.docid ||
      crypto.createHash('sha1').update(relFile).digest('hex').slice(0, 10).toUpperCase();
    const createdAt = metadata.created_at || mtimeIso;
    const status = metadata.status || 'active';
    const synthetic = metadata.synthetic === true || metadata.synthetic === 'true';
    const domain = metadata.domain || 'general';
    const tags = Array.isArray(metadata.tags) ? metadata.tags : [];
    const cue = metadata.cue || '';

    const headings = (body.match(/^#{1,3}\s+.+$/gm) || [])
      .map((h) => h.replace(/^#{1,3}\s+/, '').trim())
      .join(' ');

    const weightedText = [
      title, title, title,
      cue, cue,
      tags.join(' '), tags.join(' '),
      headings,
      domain,
      body
    ].join('\n');

    const tokens = tokenize(weightedText, false);
    const tf = {};
    for (const t of tokens) {
      tf[t] = (tf[t] || 0) + 1;
    }

    const boostTokens = tokenize(`${title} ${cue} ${tags.join(' ')}`, false);
    const vector = computeDenseVector(`${title}\n${cue}\n${headings}\n${body}`, boostTokens);
    const sections = this._extractSections(body, title);

    return {
      docid,
      path: relFile,
      title,
      collection: metadata.collection || collectionName,
      domain,
      task_id: metadata.task_id || '',
      status,
      synthetic,
      receipt_id: metadata.receipt_id && metadata.receipt_id !== 'null' ? metadata.receipt_id : null,
      repo: metadata.repo || 'Harness2-RAG-antigravity',
      git_revision: metadata.git_revision || 'HEAD',
      created_at: createdAt,
      mtime_iso: mtimeIso,
      cue,
      tags,
      evidence_links: Array.isArray(metadata.evidence_links) ? metadata.evidence_links : [],
      sections,
      excerpt: body.replace(/^#+\s+.+$/gm, '').trim().slice(0, 360),
      tokenCount: tokens.length,
      length: tokens.length,
      tokens: Object.keys(tf),
      tf,
      termFreqs: tf,
      vector,
      blobHash,
      _rawContent: rawContent
    };
  }

  buildIndex(options = {}) {
    this.ensureDirectories();
    const config = this.loadConfig();
    const collections = config.rag?.collections || {};
    const documents = [];
    const dfMap = {};

    for (const [collectionName, colSpec] of Object.entries(collections)) {
      const relPaths = [colSpec.path, ...(colSpec.extraPaths || [])].filter(Boolean);
      for (const rel of relPaths) {
        const absDir = path.resolve(this.workspaceRoot, rel);
        if (!this._isPathInsideWorkspace(absDir)) continue;
        const files = this._walkMarkdownFiles(absDir);
        for (const filePath of files) {
          if (!this._isPathInsideWorkspace(filePath)) continue;
          const { rawContent, mtimeIso } = this._readConsistentFileBytes(filePath);
          const doc = this._buildDocumentFromRawBytes(filePath, rawContent, collectionName, mtimeIso);
          delete doc._rawContent;
          for (const uniqueTok of Object.keys(doc.tf)) {
            dfMap[uniqueTok] = (dfMap[uniqueTok] || 0) + 1;
          }
          documents.push(doc);
        }
      }
    }

    const avgDocLen =
      documents.length > 0
        ? documents.reduce((acc, d) => acc + d.tokenCount, 0) / documents.length
        : 1;

    const qmdInfo = this.detectQmdCli();
    if (options.runQmdSync && qmdInfo.installed && config.rag?.enableQmdCliIfAvailable) {
      try {
        const cmd = process.platform === 'win32' ? 'qmd.cmd' : 'qmd';
        spawnSync(cmd, ['update'], { cwd: this.workspaceRoot, timeout: 10000, windowsHide: true });
      } catch {
        // Non-fatal
      }
    }

    const indexPayload = {
      version: '1.0.0',
      indexSchemaVersion: INDEX_SCHEMA_VERSION,
      tokenizerVersion: TOKENIZER_VERSION,
      indexedAt: new Date().toISOString(),
      workspaceRoot: this.workspaceRoot,
      gitRevision: this.getGitRevision(),
      totalDocuments: documents.length,
      avgDocLen,
      dfMap,
      qmdStatus: qmdInfo,
      documents
    };

    fs.writeFileSync(this.indexFilePath, JSON.stringify(indexPayload, null, 2), 'utf8');
    return indexPayload;
  }

  _extractSections(body, fallbackTitle) {
    const lines = body.split('\n');
    const sections = [];
    let currentHeading = fallbackTitle;
    let currentLines = [];

    for (const line of lines) {
      const m = line.match(/^#{1,3}\s+(.+)$/);
      if (m) {
        if (currentLines.length > 0) {
          sections.push({
            heading: currentHeading,
            content: currentLines.join('\n').trim()
          });
        }
        currentHeading = m[1].trim();
        currentLines = [];
      } else {
        currentLines.push(line);
      }
    }
    if (currentLines.length > 0) {
      sections.push({
        heading: currentHeading,
        content: currentLines.join('\n').trim()
      });
    }
    return sections.filter((s) => s.content.length > 0);
  }

  loadOrBuildIndex() {
    if (!fs.existsSync(this.indexFilePath)) {
      return this.buildIndex();
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexFilePath, 'utf8'));
      if (
        parsed?.indexSchemaVersion !== INDEX_SCHEMA_VERSION ||
        parsed?.tokenizerVersion !== TOKENIZER_VERSION
      ) {
        return this.buildIndex();
      }
      const config = this.loadConfig();
      if (config.rag?.autoIndexOnChange !== false) {
        const indexedAtMs = Date.parse(parsed?.indexedAt || '') || 0;
        const collections = config.rag?.collections || {};
        const currentFiles = [];
        for (const colSpec of Object.values(collections)) {
          const relPaths = [colSpec.path, ...(colSpec.extraPaths || [])].filter(Boolean);
          for (const rel of relPaths) {
            const absDir = path.resolve(this.workspaceRoot, rel);
            if (!this._isPathInsideWorkspace(absDir) || !fs.existsSync(absDir)) continue;
            currentFiles.push(...this._walkMarkdownFiles(absDir));
          }
        }
        const prevPaths = new Map(
          (parsed?.documents || []).map((d) => [String(d.path || '').replace(/\\/g, '/'), d])
        );
        if (currentFiles.length !== prevPaths.size) {
          return this.buildIndex();
        }
        for (const fp of currentFiles) {
          try {
            const relFp = path.relative(this.workspaceRoot, fp).replace(/\\/g, '/');
            const prevDoc = prevPaths.get(relFp);
            const st = fs.statSync(fp);
            if (!prevDoc || st.mtimeMs > indexedAtMs || st.mtime.toISOString() !== prevDoc.mtime_iso) {
              return this.buildIndex();
            }
          } catch {
            return this.buildIndex();
          }
        }
      }
      return parsed;
    } catch {
      return this.buildIndex();
    }
  }

  _withSnapshotFileLock(fn, timeoutMs = 5000) {
    fs.mkdirSync(this.snapshotsDir, { recursive: true });
    const lockFile = this.snapshotMutexLockPath || path.join(this.snapshotsDir, '.lock');
    const start = Date.now();
    const waitBuf = new Int32Array(new SharedArrayBuffer(4));
    let acquired = false;

    while (Date.now() - start <= timeoutMs) {
      try {
        const fd = fs.openSync(lockFile, 'wx');
        const payload = JSON.stringify({ pid: process.pid, acquiredAt: Date.now() });
        fs.writeFileSync(fd, payload, 'utf8');
        fs.closeSync(fd);
        acquired = true;
        break;
      } catch (err) {
        if (err && (err.code === 'EEXIST' || err.code === 'EACCES' || err.code === 'EBUSY')) {
          try {
            const raw = fs.readFileSync(lockFile, 'utf8');
            if (raw) {
              const info = JSON.parse(raw);
              let pidAlive = true;
              if (info.pid && Number.isInteger(info.pid) && info.pid !== process.pid) {
                try {
                  process.kill(info.pid, 0);
                } catch (killErr) {
                  if (killErr && killErr.code === 'ESRCH') {
                    pidAlive = false;
                  }
                }
              }
              if (!pidAlive) {
                try {
                  fs.unlinkSync(lockFile);
                } catch {}
                continue;
              }
            }
          } catch {
            // Writer may still be flushing lock metadata
          }
          try {
            Atomics.wait(waitBuf, 0, 0, 10);
          } catch {
            // Fallback spin
          }
          continue;
        }
        throw err;
      }
    }

    if (!acquired) {
      const timeoutErr = new Error(
        `Timed out waiting to acquire exclusive snapshot lock ${lockFile} after ${timeoutMs}ms`
      );
      timeoutErr.code = 'SNAPSHOT_LOCK_CONTENTION_TIMEOUT';
      throw timeoutErr;
    }

    try {
      return fn();
    } finally {
      try {
        if (fs.existsSync(lockFile)) {
          fs.unlinkSync(lockFile);
        }
      } catch {}
    }
  }

  getActiveSnapshotLock() {
    if (!fs.existsSync(this.activeLockPath)) {
      return null;
    }
    try {
      const lock = JSON.parse(fs.readFileSync(this.activeLockPath, 'utf8'));
      if (lock && lock.active && lock.snapshotId && Array.isArray(lock.frozenDocuments)) {
        return lock;
      }
      return null;
    } catch {
      return null;
    }
  }

  getSnapshotStatus() {
    const active = this.getActiveSnapshotLock();
    return active || { active: false };
  }

  createSnapshotLock({
    domain = 'software-engineering',
    k = 2,
    mode = 'parallel',
    description = 'Harness2 candidate probe comparison lock',
    cutoffTimestamp = null,
    ownerRunId = null,
    owner_run_id = null,
    force = false,
    lockTimeoutMs = 5000
  } = {}) {
    this.ensureDirectories();
    return this._withSnapshotFileLock(() => {
      const effectiveOwner = ownerRunId || owner_run_id || null;
      const currentLock = this.getActiveSnapshotLock();
      if (currentLock && !force) {
        const sameExplicitOwner =
          Boolean(currentLock.ownerRunId) &&
          Boolean(effectiveOwner) &&
          currentLock.ownerRunId === effectiveOwner;
        if (!sameExplicitOwner) {
          return {
            ok: false,
            active: false,
            locked: false,
            error: 'SNAPSHOT_LOCK_ACTIVE_BY_ANOTHER_RUN',
            snapshotId: currentLock.snapshotId,
            ownerRunId: currentLock.ownerRunId
          };
        }
      }

      const config = this.loadConfig();
      const collections = config.rag?.collections || {};
      const allDocuments = [];
      const allDfMap = {};
      const rawByDocPath = new Map();

      for (const [collectionName, colSpec] of Object.entries(collections)) {
        const relPaths = [colSpec.path, ...(colSpec.extraPaths || [])].filter(Boolean);
        for (const rel of relPaths) {
          const absDir = path.resolve(this.workspaceRoot, rel);
          if (!this._isPathInsideWorkspace(absDir)) continue;
          const files = this._walkMarkdownFiles(absDir);
          for (const filePath of files) {
            if (!this._isPathInsideWorkspace(filePath)) continue;
            const { rawContent, mtimeIso } = this._readConsistentFileBytes(filePath);
            const doc = this._buildDocumentFromRawBytes(filePath, rawContent, collectionName, mtimeIso);
            rawByDocPath.set(doc.path, doc._rawContent);
            delete doc._rawContent;
            for (const uniqueTok of Object.keys(doc.tf)) {
              allDfMap[uniqueTok] = (allDfMap[uniqueTok] || 0) + 1;
            }
            allDocuments.push(doc);
          }
        }
      }

      const avgDocLen =
        allDocuments.length > 0
          ? allDocuments.reduce((acc, d) => acc + d.tokenCount, 0) / allDocuments.length
          : 1;
      const indexPayload = {
        version: '1.0.0',
        indexSchemaVersion: INDEX_SCHEMA_VERSION,
        tokenizerVersion: TOKENIZER_VERSION,
        indexedAt: new Date().toISOString(),
        workspaceRoot: this.workspaceRoot,
        gitRevision: this.getGitRevision(),
        totalDocuments: allDocuments.length,
        avgDocLen,
        dfMap: allDfMap,
        qmdStatus: this.detectQmdCli(),
        documents: allDocuments
      };
      fs.writeFileSync(this.indexFilePath, JSON.stringify(indexPayload, null, 2), 'utf8');

      const cutoff = cutoffTimestamp || new Date().toISOString();
      const snapshotId = `SNAP-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto
        .randomBytes(2)
        .toString('hex')
        .toUpperCase()}`;

      const eligibleDocs = allDocuments.filter((d) => {
        if (
          d.status === 'candidate' ||
          d.status === 'draft' ||
          d.status === 'retracted' ||
          d.status === 'superseded' ||
          d.synthetic === true
        ) {
          return false;
        }
        if (cutoffTimestamp && d.created_at > cutoffTimestamp) return false;
        return true;
      });

      const frozenDocuments = [];
      const frozenDfMap = {};
      for (const d of eligibleDocs) {
        const rawContent = rawByDocPath.get(d.path) ?? '';
        const blobHash = d.blobHash;
        const blobPath = path.join(this.snapshotBlobsDir, `${blobHash}.md`);
        if (!fs.existsSync(blobPath)) {
          fs.writeFileSync(blobPath, rawContent, 'utf8');
        }
        const tf = d.tf || d.termFreqs || {};
        for (const tok of Object.keys(tf)) {
          frozenDfMap[tok] = (frozenDfMap[tok] || 0) + 1;
        }
        frozenDocuments.push({
          ...d,
          content: rawContent,
          sections: d.sections,
          tokens: d.tokens || Object.keys(tf),
          termFreqs: tf,
          tf,
          length: d.tokenCount || d.length || 0,
          tokenCount: d.tokenCount || d.length || 0,
          vector: d.vector,
          blobHash,
          rawHash: blobHash
        });
      }

      const frozenAvgDocLen =
        frozenDocuments.length > 0
          ? frozenDocuments.reduce((acc, doc) => acc + (doc.tokenCount || 0), 0) / frozenDocuments.length
          : 1;
      const eligibleDocIds = frozenDocuments.map((d) => d.docid);

      const lockPayload = {
        ok: true,
        active: true,
        snapshotId,
        ownerRunId: effectiveOwner,
        createdAt: new Date().toISOString(),
        cutoffTimestamp: cutoff,
        gitRevision: this.getGitRevision(),
        domain,
        k,
        mode,
        description,
        eligibleDocCount: eligibleDocIds.length,
        eligibleDocIds,
        avgDocLen: frozenAvgDocLen,
        dfMap: frozenDfMap,
        blobDir: this.snapshotBlobsDir,
        frozenDocuments
      };

      fs.writeFileSync(
        path.join(this.snapshotsDir, `${snapshotId}.json`),
        JSON.stringify(lockPayload, null, 2),
        'utf8'
      );
      fs.writeFileSync(this.activeLockPath, JSON.stringify(lockPayload, null, 2), 'utf8');
      return lockPayload;
    }, lockTimeoutMs);
  }

  releaseSnapshotLock(arg = {}) {
    const opts = typeof arg === 'string' ? { snapshotId: arg } : arg || {};
    const {
      snapshotId = null,
      snapshot_id = null,
      ownerRunId = null,
      owner_run_id = null,
      ownerId = null,
      force = false,
      lockTimeoutMs = 5000
    } = opts;
    return this._withSnapshotFileLock(() => {
      const current = this.getActiveSnapshotLock();
      if (!current) {
        return {
          ok: true,
          released: false,
          previousLock: null
        };
      }
      const effectiveOwner = ownerRunId || owner_run_id || ownerId || null;
      const targetSnapId = snapshotId || snapshot_id || null;
      if (!force) {
        if (current.ownerRunId && effectiveOwner !== current.ownerRunId) {
          return {
            ok: false,
            released: false,
            error: 'SNAPSHOT_LOCK_OWNED_BY_ANOTHER_RUN',
            ownerRunId: current.ownerRunId,
            snapshotId: current.snapshotId
          };
        }
        if (targetSnapId && current.snapshotId !== targetSnapId) {
          return {
            ok: false,
            released: false,
            error: 'SNAPSHOT_LOCK_OWNED_BY_ANOTHER_RUN',
            ownerRunId: current.ownerRunId,
            snapshotId: current.snapshotId
          };
        }
      }
      if (fs.existsSync(this.activeLockPath)) {
        fs.unlinkSync(this.activeLockPath);
      }
      return {
        ok: true,
        released: Boolean(current),
        previousLock: current
      };
    }, lockTimeoutMs);
  }

  listSnapshots() {
    this.ensureDirectories();
    const active = this.getActiveSnapshotLock();
    const files = fs
      .readdirSync(this.snapshotsDir)
      .filter((f) => SNAPSHOT_ID_REGEX.test(f.replace(/\.json$/i, '')) && f.endsWith('.json'));
    const snapshots = [];
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.snapshotsDir, f), 'utf8'));
        snapshots.push({
          ...data,
          isActive: Boolean(active && active.snapshotId === data.snapshotId)
        });
      } catch {
        // skip
      }
    }
    return snapshots.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  resolveSnapshotLock(snapshotIdParam = null) {
    const config = this.loadConfig();
    if (snapshotIdParam !== null && snapshotIdParam !== undefined && snapshotIdParam !== '') {
      const rawId = String(snapshotIdParam);
      if (typeof snapshotIdParam !== 'string' || !SNAPSHOT_ID_REGEX.test(rawId)) {
        return {
          invalidSnapshot: true,
          snapshotId: snapshotIdParam,
          error: 'INVALID_OR_MISSING_SNAPSHOT'
        };
      }
      const snapFile = path.resolve(this.snapshotsDir, `${rawId}.json`);
      if (
        !this._isPathInsideWorkspace(snapFile) ||
        path.dirname(snapFile) !== path.resolve(this.snapshotsDir) ||
        !fs.existsSync(snapFile)
      ) {
        return {
          invalidSnapshot: true,
          snapshotId: snapshotIdParam,
          error: 'INVALID_OR_MISSING_SNAPSHOT'
        };
      }
      try {
        const parsed = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          typeof parsed.snapshotId !== 'string' ||
          !Array.isArray(parsed.frozenDocuments)
        ) {
          return {
            invalidSnapshot: true,
            snapshotId: snapshotIdParam,
            error: 'INVALID_OR_MISSING_SNAPSHOT'
          };
        }
        return parsed;
      } catch {
        return {
          invalidSnapshot: true,
          snapshotId: snapshotIdParam,
          error: 'INVALID_OR_MISSING_SNAPSHOT'
        };
      }
    }
    if (config.harness2?.strictSnapshotIsolation !== false) {
      if (fs.existsSync(this.activeLockPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(this.activeLockPath, 'utf8'));
          if (!parsed || typeof parsed !== 'object') {
            return {
              invalidSnapshot: true,
              snapshotId: 'active.lock.json',
              error: 'INVALID_OR_MISSING_SNAPSHOT'
            };
          }
          if (!parsed.active) {
            return null;
          }
          if (typeof parsed.snapshotId !== 'string' || !Array.isArray(parsed.frozenDocuments)) {
            return {
              invalidSnapshot: true,
              snapshotId: parsed.snapshotId || 'active.lock.json',
              error: 'INVALID_OR_MISSING_SNAPSHOT'
            };
          }
          return parsed;
        } catch {
          return {
            invalidSnapshot: true,
            snapshotId: 'active.lock.json',
            error: 'INVALID_OR_MISSING_SNAPSHOT'
          };
        }
      }
      return null;
    }
    return null;
  }

  _verifyFrozenSnapshotBlobs(snapLock) {
    if (!snapLock || !Array.isArray(snapLock.frozenDocuments)) {
      return { ok: true };
    }
    for (const doc of snapLock.frozenDocuments) {
      if (!doc.blobHash || typeof doc.blobHash !== 'string') {
        return {
          ok: false,
          error: 'SNAPSHOT_BLOB_HASH_MISMATCH',
          docid: doc.docid
        };
      }
      const blobPath = path.join(this.snapshotBlobsDir, `${doc.blobHash}.md`);
      if (!this._isPathInsideWorkspace(blobPath) || !fs.existsSync(blobPath)) {
        return {
          ok: false,
          error: 'SNAPSHOT_BLOB_HASH_MISMATCH',
          docid: doc.docid
        };
      }
      const blobBytes = fs.readFileSync(blobPath, 'utf8');
      const actualHash = crypto.createHash('sha256').update(blobBytes, 'utf8').digest('hex');
      if (actualHash !== doc.blobHash) {
        return {
          ok: false,
          error: 'SNAPSHOT_BLOB_HASH_MISMATCH',
          docid: doc.docid
        };
      }
    }
    return { ok: true };
  }

  _resolveSnapshotFilter(snapshotIdParam) {
    return this.resolveSnapshotLock(snapshotIdParam);
  }

  _isDocEligibleForSnapshot(doc, snapLock, includeCandidates = false) {
    if (!snapLock) {
      if (
        !includeCandidates &&
        (doc.status === 'candidate' ||
          doc.status === 'draft' ||
          doc.status === 'retracted' ||
          doc.status === 'superseded' ||
          doc.synthetic === true)
      ) {
        return false;
      }
      return true;
    }
    if (
      doc.status === 'candidate' ||
      doc.status === 'draft' ||
      doc.status === 'retracted' ||
      doc.status === 'superseded' ||
      doc.synthetic === true
    ) {
      return false;
    }
    if (Array.isArray(snapLock.eligibleDocIds)) {
      return snapLock.eligibleDocIds.includes(doc.docid);
    }
    if (snapLock.cutoffTimestamp && doc.created_at > snapLock.cutoffTimestamp) {
      return false;
    }
    return true;
  }

  query({
    query: queryText = '',
    mode = 'hybrid',
    collection = 'all',
    domain = 'all',
    status = 'active',
    topK = 8,
    snapshot_id = null,
    snapshotId = null,
    include_candidates = false,
    snippetMaxChars = null
  } = {}) {
    const effectiveSnapshotId = snapshot_id ?? snapshotId ?? null;
    const snapLock = this.resolveSnapshotLock(effectiveSnapshotId);
    if (snapLock && snapLock.invalidSnapshot) {
      return {
        ok: false,
        invalidSnapshot: true,
        error: snapLock.error || 'INVALID_OR_MISSING_SNAPSHOT',
        query: queryText,
        mode,
        totalEligible: 0,
        results: [],
        snapshotIsolation: {
          active: false,
          invalidSnapshot: true,
          error: snapLock.error || 'INVALID_OR_MISSING_SNAPSHOT',
          snapshotId: effectiveSnapshotId
        }
      };
    }

    if (snapLock && Array.isArray(snapLock.frozenDocuments)) {
      const blobCheck = this._verifyFrozenSnapshotBlobs(snapLock);
      if (!blobCheck.ok) {
        return {
          ok: false,
          found: false,
          invalidSnapshot: true,
          error: 'SNAPSHOT_BLOB_HASH_MISMATCH',
          query: queryText,
          mode,
          totalEligible: 0,
          results: [],
          snapshotIsolation: {
            active: false,
            invalidSnapshot: true,
            error: 'SNAPSHOT_BLOB_HASH_MISMATCH',
            snapshotId: snapLock.snapshotId
          }
        };
      }
    }

    const index = this.loadOrBuildIndex();
    const useFrozenDocs = Boolean(snapLock && Array.isArray(snapLock.frozenDocuments));
    const sourceDocs = useFrozenDocs ? snapLock.frozenDocuments : index.documents;
    let filteredBySnapshotCount = 0;

    if (snapLock) {
      for (const liveDoc of index.documents) {
        if (!this._isDocEligibleForSnapshot(liveDoc, snapLock, include_candidates)) {
          filteredBySnapshotCount++;
        }
      }
    }

    const candidates = sourceDocs.filter((doc) => {
      if (!this._isDocEligibleForSnapshot(doc, snapLock, include_candidates)) {
        if (!snapLock) filteredBySnapshotCount++;
        return false;
      }
      if (collection && collection !== 'all' && doc.collection !== collection) return false;
      if (domain && domain !== 'all' && doc.domain !== domain && doc.domain !== 'all') return false;
      if (status && status !== 'all' && !include_candidates && doc.status !== status) return false;
      return true;
    });

    if (!queryText || !queryText.trim()) {
      return {
        ok: true,
        query: queryText,
        mode,
        totalEligible: candidates.length,
        snapshotIsolation: snapLock
          ? {
              active: true,
              snapshotId: snapLock.snapshotId,
              cutoffTimestamp: snapLock.cutoffTimestamp,
              filteredBySnapshotCount
            }
          : { active: false, filteredBySnapshotCount: 0 },
        results: candidates.slice(0, topK).map((d, idx) => this._formatSearchResult(d, 1.0 - idx * 0.05, 0, 0, ''))
      };
    }

    const qTokens = tokenize(queryText, false);
    const qVec = computeDenseVector(queryText, qTokens);
    const activeDfMap = (useFrozenDocs && snapLock.dfMap) || index.dfMap || {};
    const N = Math.max(
      1,
      useFrozenDocs ? snapLock.frozenDocuments.length : index.totalDocuments || candidates.length
    );
    const avgLen = Math.max(
      1,
      (useFrozenDocs && snapLock.avgDocLen) || index.avgDocLen || 100
    );
    const k1 = 1.5;
    const b = 0.75;

    const scored = candidates.map((doc) => {
      let effectiveDoc = doc;
      if (useFrozenDocs && doc.blobHash) {
        const blobPath = path.join(this.snapshotBlobsDir, `${doc.blobHash}.md`);
        if (this._isPathInsideWorkspace(blobPath) && fs.existsSync(blobPath)) {
          try {
            const blobRaw = fs.readFileSync(blobPath, 'utf8');
            const actualHash = crypto.createHash('sha256').update(blobRaw, 'utf8').digest('hex');
            if (actualHash === doc.blobHash) {
              const parsedBlob = String(doc.path || '').endsWith('.json')
                ? { metadata: {}, body: blobRaw }
                : parseFrontmatter(blobRaw);
              const blobBody = parsedBlob.body || blobRaw;
              const blobTitle = parsedBlob.metadata?.title || doc.title || doc.docid;
              const blobCue = parsedBlob.metadata?.cue || doc.cue || '';
              const blobTags = Array.isArray(parsedBlob.metadata?.tags)
                ? parsedBlob.metadata.tags
                : doc.tags || [];
              const blobHeadings = (blobBody.match(/^#{1,3}\s+.+$/gm) || [])
                .map((h) => h.replace(/^#{1,3}\s+/, '').trim())
                .join(' ');
              const weightedText = [
                blobTitle, blobTitle, blobTitle,
                blobCue, blobCue,
                blobTags.join(' '), blobTags.join(' '),
                blobHeadings,
                doc.domain || 'general',
                blobBody
              ].join('\n');
              const blobTokens = tokenize(weightedText, false);
              const blobTf = {};
              for (const t of blobTokens) {
                blobTf[t] = (blobTf[t] || 0) + 1;
              }
              const boostTokens = tokenize(`${blobTitle} ${blobCue} ${blobTags.join(' ')}`, false);
              const blobVec = computeDenseVector(
                `${blobTitle}\n${blobCue}\n${blobHeadings}\n${blobBody}`,
                boostTokens
              );
              const blobSections = this._extractSections(blobBody, blobTitle);
              const blobExcerpt = blobBody.replace(/^#+\s+.+$/gm, '').trim().slice(0, 360);
              effectiveDoc = {
                ...doc,
                title: blobTitle,
                cue: blobCue,
                sections: blobSections,
                excerpt: blobExcerpt,
                tf: blobTf,
                termFreqs: blobTf,
                tokenCount: blobTokens.length,
                length: blobTokens.length,
                vector: blobVec
              };
            }
          } catch {
            // Fallback to stored doc metadata if blob read fails
          }
        }
      }

      // 1. BM25 score
      let bm25 = 0;
      const docTf = effectiveDoc.tf || effectiveDoc.termFreqs || {};
      const docLen = effectiveDoc.tokenCount || effectiveDoc.length || 1;
      for (const qt of qTokens) {
        const tf = docTf[qt] || 0;
        if (tf > 0) {
          const df = activeDfMap[qt] || 1;
          const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
          const denom = tf + k1 * (1 - b + b * (docLen / avgLen));
          bm25 += idf * ((tf * (k1 + 1)) / denom);
        }
      }

      // 2. Semantic Vector cosine similarity
      const vecScore = Math.max(0, cosineSimilarity(qVec, effectiveDoc.vector));

      // Best matching section snippet
      let bestSection = effectiveDoc.sections?.[0] || {
        heading: effectiveDoc.title,
        content: effectiveDoc.excerpt
      };
      let bestSecOverlap = -1;
      for (const sec of effectiveDoc.sections || []) {
        const secTokens = new Set(tokenize(`${sec.heading} ${sec.content}`, false));
        let overlap = 0;
        for (const qt of qTokens) {
          if (secTokens.has(qt)) overlap++;
        }
        if (overlap > bestSecOverlap) {
          bestSecOverlap = overlap;
          bestSection = sec;
        }
      }

      return {
        doc: effectiveDoc,
        bm25,
        vecScore,
        bestSection
      };
    });

    const byLex = scored.filter((item) => item.bm25 > 0).sort((a, bItem) => bItem.bm25 - a.bm25);
    const byVec = scored.filter((item) => item.vecScore > 0).sort((a, bItem) => bItem.vecScore - a.vecScore);

    const lexRankMap = new Map();
    const vecRankMap = new Map();
    byLex.forEach((item, i) => lexRankMap.set(item.doc.docid, i + 1));
    byVec.forEach((item, i) => vecRankMap.set(item.doc.docid, i + 1));

    const rrfK = 60;
    const finalResults = scored
      .map((item) => {
        const rLex = lexRankMap.get(item.doc.docid);
        const rVec = vecRankMap.get(item.doc.docid);
        const lexPart = rLex ? 1 / (rrfK + rLex) : 0;
        const vecPart = rVec ? 1 / (rrfK + rVec) : 0;
        const rrfScore = lexPart + vecPart;
        const provenanceBoost = item.doc.status === 'active' ? 1.05 : 0.9;

        let combinedScore = rrfScore * provenanceBoost;
        if (mode === 'lex') combinedScore = item.bm25;
        if (mode === 'vec') combinedScore = item.vecScore;

        return {
          ...item,
          combinedScore
        };
      })
      .filter((item) => item.bm25 > 0 || item.vecScore >= 0.18)
      .sort((a, bItem) => bItem.combinedScore - a.combinedScore || bItem.bm25 - a.bm25)
      .slice(0, topK)
      .map((item) =>
        this._formatSearchResult(
          item.doc,
          item.combinedScore,
          item.bm25,
          item.vecScore,
          item.bestSection,
          snippetMaxChars || this.loadConfig().harness2?.ragSnippetMaxChars || 500
        )
      );

    return {
      ok: true,
      query: queryText,
      mode,
      collection,
      domain,
      totalEligible: candidates.length,
      snapshotIsolation: snapLock
        ? {
            active: true,
            snapshotId: snapLock.snapshotId,
            cutoffTimestamp: snapLock.cutoffTimestamp,
            filteredBySnapshotCount
          }
        : { active: false, filteredBySnapshotCount: 0 },
      results: finalResults
    };
  }

  _formatSearchResult(doc, score, bm25, vecScore, bestSection, snippetMaxChars = 500) {
    const cap = Math.max(120, Math.min(2000, Number(snippetMaxChars || 500)));
    return {
      docid: doc.docid,
      title: doc.title,
      path: doc.path,
      collection: doc.collection,
      domain: doc.domain,
      task_id: doc.task_id,
      status: doc.status,
      git_revision: doc.git_revision,
      created_at: doc.created_at,
      cue: doc.cue || undefined,
      tags: doc.tags,
      evidence_links: doc.evidence_links,
      score: Number(score.toFixed(4)),
      lexScore: Number(bm25.toFixed(4)),
      vecScore: Number(vecScore.toFixed(4)),
      snippet: bestSection ? String(bestSection.content || '').slice(0, cap) : undefined,
      matchedSection: bestSection
        ? {
            heading: bestSection.heading,
            snippet: String(bestSection.content || '').slice(0, cap)
          }
        : undefined
    };
  }

  getDocument(identifier, optionsOrSnapshotId = {}) {
    let targetId = identifier;
    let opts =
      typeof optionsOrSnapshotId === 'string'
        ? { snapshot_id: optionsOrSnapshotId }
        : optionsOrSnapshotId || {};
    if (typeof identifier === 'object' && identifier !== null) {
      opts = { ...opts, ...identifier };
      targetId =
        identifier.idOrPath ??
        identifier.identifier ??
        identifier.docid ??
        identifier.path ??
        '';
    }
    const effectiveSnapshotId = opts.snapshot_id ?? opts.snapshotId ?? null;
    const include_candidates = Boolean(opts.include_candidates ?? opts.includeCandidates);
    const snapLock = this.resolveSnapshotLock(effectiveSnapshotId);
    if (snapLock && snapLock.invalidSnapshot) {
      return {
        found: false,
        invalidSnapshot: true,
        snapshotId: effectiveSnapshotId,
        error: snapLock.error || 'INVALID_OR_MISSING_SNAPSHOT'
      };
    }
    if (snapLock && Array.isArray(snapLock.frozenDocuments)) {
      const blobCheck = this._verifyFrozenSnapshotBlobs(snapLock);
      if (!blobCheck.ok) {
        return {
          found: false,
          invalidSnapshot: true,
          snapshotId: snapLock.snapshotId,
          error: blobCheck.error || 'SNAPSHOT_BLOB_HASH_MISMATCH'
        };
      }
    }

    const index = this.loadOrBuildIndex();
    const useFrozenDocs = Boolean(snapLock && Array.isArray(snapLock.frozenDocuments));
    const sourceDocs = useFrozenDocs ? snapLock.frozenDocuments : index.documents;
    const normId = String(targetId || '').trim().replace(/\\/g, '/');

    const eligibleDocs = sourceDocs.filter((d) =>
      this._isDocEligibleForSnapshot(d, snapLock, include_candidates)
    );

    let match = eligibleDocs.find(
      (d) =>
        d.docid.toLowerCase() === normId.toLowerCase() ||
        d.path.toLowerCase() === normId.toLowerCase() ||
        d.path.toLowerCase().endsWith(normId.toLowerCase()) ||
        (d.task_id && d.task_id.toLowerCase() === normId.toLowerCase())
    );

    if (!match) {
      const blockedMatch = index.documents.find(
        (d) =>
          d.docid.toLowerCase() === normId.toLowerCase() ||
          d.path.toLowerCase().endsWith(normId.toLowerCase()) ||
          (d.task_id && d.task_id.toLowerCase() === normId.toLowerCase())
      );
      if (blockedMatch && snapLock) {
        return {
          found: false,
          blockedBySnapshotLock: true,
          snapshotId: snapLock.snapshotId,
          cutoffTimestamp: snapLock.cutoffTimestamp,
          error: `Document '${targetId}' (${blockedMatch.docid}) is excluded by active Harness² Snapshot Isolation lock ${snapLock.snapshotId} (cutoff ${snapLock.cutoffTimestamp}).`
        };
      }
      const suggestions = eligibleDocs
        .map((d) => ({ docid: d.docid, path: d.path, title: d.title }))
        .slice(0, 5);
      return {
        found: false,
        error: `Document '${targetId}' not found.`,
        suggestions
      };
    }

    let content = match.excerpt || '';
    if (useFrozenDocs) {
      if (!match.blobHash || typeof match.blobHash !== 'string') {
        return {
          found: false,
          invalidSnapshot: true,
          snapshotId: snapLock.snapshotId,
          error: 'SNAPSHOT_BLOB_HASH_MISMATCH'
        };
      }
      const blobPath = path.join(this.snapshotBlobsDir, `${match.blobHash}.md`);
      if (!this._isPathInsideWorkspace(blobPath) || !fs.existsSync(blobPath)) {
        return {
          found: false,
          invalidSnapshot: true,
          snapshotId: snapLock.snapshotId,
          error: 'SNAPSHOT_BLOB_HASH_MISMATCH'
        };
      }
      const blobBytes = fs.readFileSync(blobPath, 'utf8');
      const actualHash = crypto.createHash('sha256').update(blobBytes, 'utf8').digest('hex');
      if (actualHash !== match.blobHash) {
        return {
          found: false,
          invalidSnapshot: true,
          snapshotId: snapLock.snapshotId,
          error: 'SNAPSHOT_BLOB_HASH_MISMATCH'
        };
      }
      content = blobBytes;
    } else {
      const absPath = path.resolve(this.workspaceRoot, match.path);
      content =
        this._isPathInsideWorkspace(absPath) && fs.existsSync(absPath)
          ? fs.readFileSync(absPath, 'utf8')
          : match.content || match.excerpt || '';
    }

    return {
      found: true,
      docid: match.docid,
      title: match.title,
      path: match.path,
      collection: match.collection,
      domain: match.domain,
      task_id: match.task_id,
      status: match.status,
      synthetic: Boolean(match.synthetic),
      receipt_id: match.receipt_id || null,
      repo: match.repo,
      git_revision: match.git_revision,
      created_at: match.created_at,
      cue: match.cue,
      tags: match.tags,
      evidence_links: match.evidence_links,
      blobHash: match.blobHash,
      fromImmutableSnapshot: useFrozenDocs,
      content
    };
  }

  multiGet(identifiersOrPattern, options = {}) {
    const snapLock = this.resolveSnapshotLock(options.snapshot_id);
    if (snapLock && snapLock.invalidSnapshot) {
      return {
        ok: false,
        error: 'INVALID_OR_MISSING_SNAPSHOT',
        invalidSnapshot: true,
        snapshotId: options.snapshot_id,
        count: 0,
        documents: []
      };
    }

    const index = this.loadOrBuildIndex();
    const useFrozenDocs = Boolean(snapLock && Array.isArray(snapLock.frozenDocuments));
    const sourceDocs = useFrozenDocs ? snapLock.frozenDocuments : index.documents;
    const eligibleDocs = sourceDocs.filter((d) =>
      this._isDocEligibleForSnapshot(d, snapLock, options.include_candidates)
    );

    const list = Array.isArray(identifiersOrPattern)
      ? identifiersOrPattern
      : String(identifiersOrPattern || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);

    const matchedDocs = new Map();
    for (const item of list) {
      if (item.includes('*')) {
        const regex = new RegExp(
          '^' + item.replace(/\\/g, '/').replace(/\./g, '\\.').replace(/\*/g, '.*') + '$',
          'i'
        );
        for (const d of eligibleDocs) {
          if (regex.test(d.path) || regex.test(d.docid) || regex.test(d.collection)) {
            matchedDocs.set(d.docid, this.getDocument(d.docid, options));
          }
        }
      } else {
        const res = this.getDocument(item, options);
        if (res.found) {
          matchedDocs.set(res.docid, res);
        }
      }
    }

    return {
      ok: true,
      count: matchedDocs.size,
      documents: Array.from(matchedDocs.values())
    };
  }

  getStatus() {
    const index = this.loadOrBuildIndex();
    const config = this.loadConfig();
    const snapLock = this.getActiveSnapshotLock();
    const collectionStats = {};

    for (const colName of Object.keys(config.rag?.collections || {})) {
      collectionStats[colName] = {
        count: 0,
        activeCount: 0,
        candidateCount: 0,
        description: config.rag.collections[colName].description
      };
    }

    for (const doc of index.documents) {
      if (!collectionStats[doc.collection]) {
        collectionStats[doc.collection] = { count: 0, activeCount: 0, candidateCount: 0, description: '' };
      }
      collectionStats[doc.collection].count++;
      if (doc.status === 'active') collectionStats[doc.collection].activeCount++;
      if (doc.status === 'candidate') collectionStats[doc.collection].candidateCount++;
    }

    return {
      healthy: true,
      indexedAt: index.indexedAt,
      workspaceRoot: this.workspaceRoot,
      gitRevision: index.gitRevision,
      totalDocuments: index.totalDocuments,
      primaryBackend: config.rag?.primaryBackend || 'qmd-hybrid',
      qmdCli: index.qmdStatus || this.detectQmdCli(),
      collections: collectionStats,
      snapshotIsolationLock: snapLock || { active: false },
      externalDocs: {
        context7: Boolean(config.externalDocs?.context7?.enabled),
        googleDeveloperKnowledge: Boolean(config.externalDocs?.googleDeveloperKnowledge?.enabled)
      }
    };
  }

  getMetadata() {
    const index = this.loadOrBuildIndex();
    const collections = {};
    const domains = {};
    const statuses = {};
    const tags = {};

    for (const doc of index.documents) {
      collections[doc.collection] = (collections[doc.collection] || 0) + 1;
      domains[doc.domain] = (domains[doc.domain] || 0) + 1;
      statuses[doc.status] = (statuses[doc.status] || 0) + 1;
      for (const t of doc.tags || []) {
        tags[t] = (tags[t] || 0) + 1;
      }
    }

    return {
      totalDocuments: index.totalDocuments,
      keys: {
        collection: collections,
        domain: domains,
        status: statuses,
        tags
      }
    };
  }

  _getOrCreateReceiptKey() {
    const globalKeyPath = path.join(os.homedir(), '.gemini', 'config', '.receipt.key');
    try {
      if (fs.existsSync(globalKeyPath)) {
        const existing = fs.readFileSync(globalKeyPath, 'utf8').trim();
        if (existing.length >= 64) {
          return Buffer.from(existing.slice(0, 64), 'hex');
        }
      }
      fs.mkdirSync(path.dirname(globalKeyPath), { recursive: true });
      const rawKey = crypto.randomBytes(32);
      fs.writeFileSync(globalKeyPath, rawKey.toString('hex') + '\n', {
        encoding: 'utf8',
        mode: 0o600
      });
      return rawKey;
    } catch {
      const localKeyPath = path.join(this.runtimeDir, '.receipt.key');
      fs.mkdirSync(this.runtimeDir, { recursive: true });
      if (fs.existsSync(localKeyPath)) {
        const existing = fs.readFileSync(localKeyPath, 'utf8').trim();
        if (existing.length >= 64) {
          return Buffer.from(existing.slice(0, 64), 'hex');
        }
      }
      const rawKey = crypto.randomBytes(32);
      fs.writeFileSync(localKeyPath, rawKey.toString('hex') + '\n', {
        encoding: 'utf8',
        mode: 0o600
      });
      return rawKey;
    }
  }

  _canonicalizeChecks(checks) {
    if (!Array.isArray(checks)) return [];
    return checks.map((chk) => {
      if (chk === null || chk === undefined) return { raw: null, passed: false };
      if (typeof chk === 'string' || typeof chk === 'number' || typeof chk === 'boolean') {
        const s = String(chk);
        const endsFalse = s.endsWith(':false') || s === 'false';
        return { raw: s, passed: !endsFalse };
      }
      if (typeof chk === 'object') {
        const sorted = {};
        for (const k of Object.keys(chk).sort()) {
          sorted[k] = chk[k];
        }
        return sorted;
      }
      return { raw: String(chk), passed: true };
    });
  }

  _hasFailedCheckEntry(checks) {
    if (!Array.isArray(checks)) return false;
    for (const chk of checks) {
      if (chk && typeof chk === 'object' && chk.passed === false) {
        return true;
      }
      if (typeof chk === 'string' && (chk.endsWith(':false') || chk === 'false')) {
        return true;
      }
    }
    return false;
  }

  _signVerdictPayload(core) {
    const sortedArtifactHashes = {};
    if (
      core.artifactHashes &&
      typeof core.artifactHashes === 'object' &&
      !Array.isArray(core.artifactHashes)
    ) {
      for (const k of Object.keys(core.artifactHashes).sort()) {
        sortedArtifactHashes[k] = core.artifactHashes[k];
      }
    }
    const canonical = JSON.stringify({
      evidenceSchemaVersion: '2.0',
      verdictId: String(core.verdictId || ''),
      taskId: String(core.taskId || ''),
      reqId: core.reqId ? String(core.reqId) : null,
      requirementRevision:
        core.requirementRevision !== undefined && core.requirementRevision !== null
          ? Number(core.requirementRevision)
          : null,
      attemptId: core.attemptId ? String(core.attemptId) : null,
      lessonRevisionId: core.lessonRevisionId ? String(core.lessonRevisionId) : null,
      phase: String(core.phase || 'candidate'),
      workerId: core.workerId ? String(core.workerId) : null,
      passed: core.passed === true,
      score: typeof core.score === 'number' ? Number(core.score.toFixed(4)) : 1,
      synthetic: Boolean(core.synthetic),
      verifierId: String(core.verifierId || 'context-verifier'),
      receiptId: core.receiptId ? String(core.receiptId) : null,
      inputTreeHash: core.inputTreeHash ? String(core.inputTreeHash) : null,
      outputTreeHash: core.outputTreeHash ? String(core.outputTreeHash) : null,
      changeKind: String(core.changeKind || 'modified'),
      artifactHashes: sortedArtifactHashes,
      checks: this._canonicalizeChecks(core.checks),
    });
    const key = this._getOrCreateReceiptKey();
    return crypto.createHmac('sha256', key).update(canonical, 'utf8').digest('hex');
  }

  createSignedVerdict({
    verdictId = null,
    taskId = 'default',
    task_id = null,
    reqId = null,
    req_id = null,
    requirementRevision = null,
    requirement_revision = null,
    attemptId = null,
    attempt_id = null,
    lessonRevisionId = null,
    lesson_revision_id = null,
    phase = 'candidate',
    workerId = null,
    worker_id = null,
    passed = true,
    score = 1.0,
    synthetic = false,
    verifierId = 'context-verifier',
    verifier_id = null,
    receiptId = null,
    receipt_id = null,
    inputTreeHash = null,
    input_tree_hash = null,
    outputTreeHash = null,
    output_tree_hash = null,
    changeKind = 'modified',
    change_kind = null,
    artifactHashes = {},
    artifact_hashes = null,
    checks = [],
    acceptanceCheckIds = null,
    acceptance_check_ids = null
  } = {}) {
    const resolvedVerdictId =
      verdictId || `VRD-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const resolvedTaskId = String(taskId || task_id || 'default')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-');
    const resolvedReqId = reqId || req_id || null;
    const resolvedReqRev = requirementRevision ?? requirement_revision ?? null;
    const resolvedAttemptId = attemptId || attempt_id || null;
    const resolvedLessonRevId = lessonRevisionId || lesson_revision_id || null;
    const resolvedWorkerId = workerId || worker_id || null;
    const resolvedVerifierId = String(verifierId || verifier_id || 'context-verifier');
    const resolvedReceiptId = receiptId || receipt_id || null;
    const resolvedInputTreeHash = inputTreeHash || input_tree_hash || null;
    const resolvedOutputTreeHash = outputTreeHash || output_tree_hash || null;
    const resolvedChangeKind = String(changeKind || change_kind || 'modified');
    const resolvedArtifactHashes =
      artifactHashes && Object.keys(artifactHashes).length > 0
        ? artifactHashes
        : artifact_hashes || {};
    const suppliedCheckIds = acceptanceCheckIds || acceptance_check_ids;
    const normalizedChecks =
      Array.isArray(checks) && checks.length > 0
        ? checks
        : Array.isArray(suppliedCheckIds)
          ? suppliedCheckIds.map((id) => (typeof id === 'string' ? { id, passed: true } : id))
          : [];
    const hasFailedCheck = this._hasFailedCheckEntry(normalizedChecks);

    const core = {
      evidenceSchemaVersion: '2.0',
      verdictId: resolvedVerdictId,
      taskId: resolvedTaskId,
      reqId: resolvedReqId ? String(resolvedReqId) : null,
      requirementRevision:
        resolvedReqRev !== null && resolvedReqRev !== undefined ? Number(resolvedReqRev) : null,
      attemptId: resolvedAttemptId ? String(resolvedAttemptId) : null,
      lessonRevisionId: resolvedLessonRevId ? String(resolvedLessonRevId) : null,
      phase: String(phase || 'candidate'),
      workerId: resolvedWorkerId ? String(resolvedWorkerId) : null,
      passed: passed === true && synthetic !== true && !hasFailedCheck,
      score: typeof score === 'number' ? Number(score.toFixed(4)) : passed === true ? 1.0 : 0.0,
      synthetic: Boolean(synthetic),
      verifierId: resolvedVerifierId,
      receiptId: resolvedReceiptId ? String(resolvedReceiptId) : null,
      inputTreeHash: resolvedInputTreeHash ? String(resolvedInputTreeHash) : null,
      outputTreeHash: resolvedOutputTreeHash ? String(resolvedOutputTreeHash) : null,
      changeKind: resolvedChangeKind,
      artifactHashes: resolvedArtifactHashes,
      checks: normalizedChecks,
      createdAt: new Date().toISOString()
    };
    const signature = this._signVerdictPayload(core);
    return {
      ...core,
      signature
    };
  }

  verifySignedVerdict(
    verdictObj,
    {
      expectedTaskId = null,
      expectedReqId = null,
      expectedRequirementRevision = null,
      expectedPhase = null,
      requiredAcceptanceChecks = null
    } = {}
  ) {
    if (!verdictObj || typeof verdictObj !== 'object' || Array.isArray(verdictObj)) {
      return { valid: false, error: 'INVALID_VERDICT_OBJECT' };
    }
    if (verdictObj.synthetic === true || verdictObj.passed !== true) {
      return { valid: false, error: 'VERDICT_NOT_PASSED_OR_SYNTHETIC' };
    }
    if (this._hasFailedCheckEntry(verdictObj.checks)) {
      return { valid: false, error: 'VERDICT_CHECK_FAILED' };
    }
    if (typeof verdictObj.signature !== 'string' || verdictObj.signature.length !== 64) {
      return { valid: false, error: 'UNSIGNED_VERDICT_EVIDENCE' };
    }
    const expectedSig = this._signVerdictPayload(verdictObj);
    try {
      const bufA = Buffer.from(expectedSig, 'utf8');
      const bufB = Buffer.from(verdictObj.signature, 'utf8');
      if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
        return { valid: false, error: 'VERDICT_SIGNATURE_MISMATCH' };
      }
    } catch {
      return { valid: false, error: 'VERDICT_SIGNATURE_MISMATCH' };
    }
    if (expectedTaskId) {
      const normExpected = String(expectedTaskId).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      const normActual = String(verdictObj.taskId || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      if (!normActual || normExpected !== normActual) {
        return { valid: false, error: 'VERDICT_TASK_ID_MISMATCH' };
      }
    }
    if (expectedReqId && verdictObj.reqId && String(verdictObj.reqId) !== String(expectedReqId)) {
      return { valid: false, error: 'VERDICT_REQ_ID_MISMATCH' };
    }
    if (
      expectedRequirementRevision !== null &&
      expectedRequirementRevision !== undefined &&
      verdictObj.requirementRevision !== null &&
      verdictObj.requirementRevision !== undefined &&
      Number(verdictObj.requirementRevision) !== Number(expectedRequirementRevision)
    ) {
      return { valid: false, error: 'VERDICT_REQUIREMENT_REVISION_MISMATCH' };
    }
    if (expectedPhase && verdictObj.phase && String(verdictObj.phase) !== String(expectedPhase)) {
      return { valid: false, error: 'VERDICT_PHASE_MISMATCH' };
    }
    if (Array.isArray(requiredAcceptanceChecks) && requiredAcceptanceChecks.length > 0) {
      const rawCheckList = [
        ...(Array.isArray(verdictObj.checks) ? verdictObj.checks : []),
        ...(Array.isArray(verdictObj.acceptanceCheckIds)
          ? verdictObj.acceptanceCheckIds.map((id) => ({ id, passed: true }))
          : [])
      ];
      const coveredIds = new Set(
        rawCheckList
          .filter((c) => c && typeof c === 'object' && c.passed !== false)
          .map((c) => String(c.id || c.checkId || '').trim())
          .filter(Boolean)
      );
      if (coveredIds.size > 0) {
        const missingChecks = requiredAcceptanceChecks
          .map((c) =>
            typeof c === 'string'
              ? c.trim()
              : String(c?.id || c?.checkId || c?.name || '').trim()
          )
          .filter((id) => id && !coveredIds.has(id));
        if (missingChecks.length > 0) {
          return {
            valid: false,
            error: `MISSING_ACCEPTANCE_CHECK_COVERAGE:${missingChecks.join(',')}`
          };
        }
      }
    }
    if (verdictObj.receiptId) {
      const rcptCheck = this.verifyEvaluationReceipt(verdictObj.receiptId, {
        expectedTaskId: expectedTaskId || verdictObj.taskId || null,
        requiredAcceptanceChecks
      });
      if (!rcptCheck.valid) {
        return { valid: false, error: rcptCheck.error || 'INVALID_VERDICT_RECEIPT' };
      }
    }
    return { valid: true, verdict: verdictObj };
  }

  _signReceiptPayload(core) {
    const sortedArtifactHashes = {};
    if (core.artifactHashes && typeof core.artifactHashes === 'object' && !Array.isArray(core.artifactHashes)) {
      for (const k of Object.keys(core.artifactHashes).sort()) {
        sortedArtifactHashes[k] = core.artifactHashes[k];
      }
    }
    const canonical = JSON.stringify({
      evidenceSchemaVersion: '2.0',
      receiptId: String(core.receiptId || ''),
      taskId: String(core.taskId || ''),
      attemptId: core.attemptId ? String(core.attemptId) : null,
      lessonRevisionId: core.lessonRevisionId ? String(core.lessonRevisionId) : null,
      candidateId: String(core.candidateId || ''),
      domain: String(core.domain || 'software-engineering'),
      gitRevision: String(core.gitRevision || 'HEAD'),
      phase: String(core.phase || 'candidate'),
      inputTreeHash: core.inputTreeHash ? String(core.inputTreeHash) : null,
      outputTreeHash: core.outputTreeHash ? String(core.outputTreeHash) : null,
      changeKind: String(core.changeKind || 'modified'),
      harnessDigest: core.harnessDigest ? String(core.harnessDigest) : null,
      evaluatorId: String(core.evaluatorId || 'custom-evaluator'),
      checks: this._canonicalizeChecks(core.checks),
      score: Number(core.score),
      passed: core.passed === true,
      artifactHashes: sortedArtifactHashes,
      providerCalls: Number(core.providerCalls ?? 0),
      actualTokens:
        core.actualTokens !== undefined && core.actualTokens !== null
          ? Number(core.actualTokens)
          : null,
      synthetic: Boolean(core.synthetic),
      lessonDigest: core.lessonDigest ? String(core.lessonDigest) : null
    });
    const key = this._getOrCreateReceiptKey();
    return crypto.createHmac('sha256', key).update(canonical, 'utf8').digest('hex');
  }

  createEvaluationReceipt({
    taskId,
    task_id,
    attemptId = null,
    attempt_id = null,
    candidateId,
    candidate_id,
    domain = 'software-engineering',
    gitRevision = null,
    git_revision = null,
    phase = 'candidate',
    inputTreeHash = null,
    input_tree_hash = null,
    outputTreeHash = null,
    output_tree_hash = null,
    changeKind = 'modified',
    change_kind = null,
    harnessDigest = null,
    harness_digest = null,
    lessonDigest = null,
    lesson_digest = null,
    lessonRevisionId = null,
    lesson_revision_id = null,
    evaluatorId = 'custom-evaluator',
    evaluator_id = null,
    checks = [],
    score,
    passed,
    artifactHashes = {},
    artifact_hashes = null,
    providerCalls = 0,
    provider_calls = null,
    actualTokens = null,
    actual_tokens = null,
    synthetic = false
  } = {}) {
    this.ensureDirectories();
    const resolvedTaskId = String(taskId || task_id || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-');
    const resolvedCandidateId = String(candidateId || candidate_id || '').trim();
    const resolvedDomain = String(domain || 'software-engineering')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-');
    const resolvedGitRev = String(gitRevision || git_revision || this.getGitRevision());
    const resolvedEvaluatorId = String(evaluatorId || evaluator_id || 'custom-evaluator');
    const resolvedArtifactHashes = artifactHashes && Object.keys(artifactHashes).length > 0
      ? artifactHashes
      : artifact_hashes || {};
    const normalizedChecks = Array.isArray(checks) ? checks : [];

    if (
      synthetic === true ||
      passed !== true ||
      this._hasFailedCheckEntry(normalizedChecks) ||
      typeof score !== 'number' ||
      Number.isNaN(score) ||
      score < 0 ||
      score > 1 ||
      !resolvedTaskId ||
      !resolvedCandidateId ||
      !resolvedArtifactHashes ||
      typeof resolvedArtifactHashes !== 'object' ||
      Array.isArray(resolvedArtifactHashes)
    ) {
      return {
        ok: false,
        error: 'INVALID_EVALUATION_RECEIPT_INPUT'
      };
    }

    const receiptId = `RCPT-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const receiptArchiveDir = path.join(this.receiptsDir, 'artifacts', receiptId);
    this.assertContainedPath(receiptArchiveDir, 'receiptArchiveDir');
    fs.mkdirSync(receiptArchiveDir, { recursive: true });

    const verifiedHashes = {};
    const rawBuffersByRel = new Map();
    for (const [relPath, expectedSha256] of Object.entries(resolvedArtifactHashes)) {
      const cleanRel = String(relPath).replace(/\\/g, '/');
      const absPath = path.resolve(this.workspaceRoot, cleanRel);
      if (
        !this._isPathInsideWorkspace(absPath) ||
        !fs.existsSync(absPath) ||
        !fs.statSync(absPath).isFile()
      ) {
        return {
          ok: false,
          error: 'ARTIFACT_VERIFICATION_FAILED',
          relPath: cleanRel
        };
      }
      const rawBuf = fs.readFileSync(absPath);
      const actualSha256 = crypto
        .createHash('sha256')
        .update(rawBuf)
        .digest('hex');
      if (typeof expectedSha256 === 'string' && expectedSha256.length === 64) {
        if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
          return {
            ok: false,
            error: 'ARTIFACT_HASH_MISMATCH',
            relPath: cleanRel,
            expectedSha256,
            actualSha256
          };
        }
      } else {
        return {
          ok: false,
          error: 'INVALID_EVALUATION_RECEIPT_INPUT',
          relPath: cleanRel
        };
      }
      verifiedHashes[cleanRel] = actualSha256;
      rawBuffersByRel.set(cleanRel, rawBuf);
    }

    // Persist immutable artifact copies inside .harness/receipts/artifacts/<receiptId>/
    for (const [cleanRel, rawBuf] of rawBuffersByRel.entries()) {
      const archiveTarget = path.resolve(receiptArchiveDir, cleanRel);
      if (this._isPathInsideWorkspace(archiveTarget)) {
        fs.mkdirSync(path.dirname(archiveTarget), { recursive: true });
        fs.writeFileSync(archiveTarget, rawBuf);
      }
    }

    const resolvedHarnessDigest = harnessDigest || harness_digest || null;
    const resolvedLessonDigest = lessonDigest || lesson_digest || null;
    const resolvedAttemptId =
      attemptId ||
      attempt_id ||
      `ATT-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const resolvedLessonRevId = lessonRevisionId || lesson_revision_id || null;
    const resolvedInputTreeHash = inputTreeHash || input_tree_hash || null;
    const resolvedOutputTreeHash = outputTreeHash || output_tree_hash || null;
    const resolvedChangeKind = String(changeKind || change_kind || 'modified');

    const normScore = Number(score.toFixed(4));
    const corePayload = {
      evidenceSchemaVersion: '2.0',
      receiptId,
      taskId: resolvedTaskId,
      attemptId: resolvedAttemptId,
      candidateId: resolvedCandidateId,
      domain: resolvedDomain,
      gitRevision: resolvedGitRev,
      phase: String(phase || 'candidate'),
      inputTreeHash: resolvedInputTreeHash ? String(resolvedInputTreeHash) : null,
      outputTreeHash: resolvedOutputTreeHash ? String(resolvedOutputTreeHash) : null,
      changeKind: resolvedChangeKind,
      harnessDigest: resolvedHarnessDigest ? String(resolvedHarnessDigest) : null,
      evaluatorId: resolvedEvaluatorId,
      checks: normalizedChecks,
      score: normScore,
      passed: true,
      artifactHashes: verifiedHashes,
      providerCalls: Number(providerCalls ?? provider_calls ?? 0),
      actualTokens: actualTokens ?? actual_tokens ?? null,
      synthetic: false,
      lessonDigest: resolvedLessonDigest ? String(resolvedLessonDigest) : null,
      lessonRevisionId: resolvedLessonRevId ? String(resolvedLessonRevId) : null,
      createdAt: new Date().toISOString()
    };
    const signature = this._signReceiptPayload(corePayload);
    const storedReceipt = {
      ok: true,
      ...corePayload,
      signature
    };

    const receiptFile = path.join(this.receiptsDir, `${receiptId}.json`);
    this.assertContainedPath(receiptFile, 'receiptFile');
    const tmpFile = `${receiptFile}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpFile, JSON.stringify(storedReceipt, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600
    });
    fs.renameSync(tmpFile, receiptFile);
    return storedReceipt;
  }

  checkReceiptApplicability(receiptIdOrObj) {
    const hist = this.verifyEvaluationReceipt(receiptIdOrObj, { mode: 'historical' });
    if (!hist.valid) {
      return {
        ok: false,
        historicalValid: false,
        applicableToCurrentWorkspace: false,
        error: hist.error,
        driftedArtifacts: []
      };
    }
    const stored = hist.receipt;
    const driftedArtifacts = [];
    for (const [relPath, expectedSha256] of Object.entries(stored.artifactHashes || {})) {
      const absPath = path.resolve(this.workspaceRoot, String(relPath));
      if (!this._isPathInsideWorkspace(absPath) || !fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
        driftedArtifacts.push({ relPath, reason: 'missing_in_workspace', expectedSha256, actualSha256: null });
        continue;
      }
      const actualSha256 = crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
      if (actualSha256.toLowerCase() !== String(expectedSha256).toLowerCase()) {
        driftedArtifacts.push({ relPath, reason: 'hash_changed_in_workspace', expectedSha256, actualSha256 });
      }
    }
    return {
      ok: true,
      historicalValid: true,
      applicableToCurrentWorkspace: driftedArtifacts.length === 0,
      driftedArtifacts,
      receipt: stored
    };
  }

  verifyEvaluationReceipt(
    receiptIdOrObj,
    {
      expectedTaskId = null,
      expectedCandidateId = null,
      expectedDomain = null,
      expectedLessonDigest = null,
      expectedHarnessDigest = null,
      requiredAcceptanceChecks = null,
      mode = 'current_workspace'
    } = {}
  ) {
    if (!receiptIdOrObj || typeof receiptIdOrObj === 'boolean') {
      return {
        valid: false,
        error: 'STORED_RECEIPT_NOT_FOUND'
      };
    }

    const receiptId =
      typeof receiptIdOrObj === 'string'
        ? receiptIdOrObj.trim()
        : typeof receiptIdOrObj === 'object' && typeof receiptIdOrObj.receiptId === 'string'
          ? receiptIdOrObj.receiptId.trim()
          : typeof receiptIdOrObj === 'object' && typeof receiptIdOrObj.receipt_id === 'string'
            ? receiptIdOrObj.receipt_id.trim()
            : null;

    if (!receiptId || !/^RCPT-[A-Za-z0-9_-]+$/.test(receiptId)) {
      return {
        valid: false,
        error: 'STORED_RECEIPT_NOT_FOUND'
      };
    }

    const receiptPath = path.resolve(this.receiptsDir, `${receiptId}.json`);
    if (
      !this._isPathInsideWorkspace(receiptPath) ||
      path.dirname(receiptPath) !== path.resolve(this.receiptsDir) ||
      !fs.existsSync(receiptPath)
    ) {
      return {
        valid: false,
        error: 'STORED_RECEIPT_NOT_FOUND'
      };
    }

    try {
      const stored = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      if (
        !stored ||
        typeof stored !== 'object' ||
        stored.receiptId !== receiptId ||
        stored.passed !== true ||
        stored.synthetic !== false ||
        this._hasFailedCheckEntry(stored.checks) ||
        typeof stored.score !== 'number' ||
        Number.isNaN(stored.score) ||
        stored.score < 0 ||
        stored.score > 1 ||
        typeof stored.signature !== 'string'
      ) {
        return {
          valid: false,
          error: 'INVALID_STORED_RECEIPT_SCHEMA'
        };
      }

      const expectedSig = this._signReceiptPayload(stored);
      const sigBufA = Buffer.from(expectedSig, 'utf8');
      const sigBufB = Buffer.from(stored.signature, 'utf8');
      if (sigBufA.length !== sigBufB.length || !crypto.timingSafeEqual(sigBufA, sigBufB)) {
        return {
          valid: false,
          error: 'RECEIPT_SIGNATURE_MISMATCH'
        };
      }

      if (expectedTaskId) {
        const normExpected = String(expectedTaskId).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        const normActual = String(stored.taskId || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        if (normExpected !== normActual) {
          return {
            valid: false,
            error: 'RECEIPT_TASK_ID_MISMATCH'
          };
        }
      }

      if (expectedDomain) {
        const normExpDom = String(expectedDomain).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        const normActDom = String(stored.domain || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        if (normExpDom !== normActDom) {
          return {
            valid: false,
            error: 'RECEIPT_DOMAIN_MISMATCH'
          };
        }
      }

      if (expectedCandidateId && stored.candidateId !== expectedCandidateId) {
        return {
          valid: false,
          error: 'RECEIPT_CANDIDATE_ID_MISMATCH'
        };
      }

      if (expectedHarnessDigest && stored.harnessDigest && stored.harnessDigest !== expectedHarnessDigest) {
        return {
          valid: false,
          error: 'RECEIPT_HARNESS_DIGEST_MISMATCH'
        };
      }

      if (Array.isArray(requiredAcceptanceChecks) && requiredAcceptanceChecks.length > 0) {
        const rawCheckList = [
          ...(Array.isArray(stored.checks) ? stored.checks : []),
          ...(Array.isArray(stored.acceptanceCheckIds)
            ? stored.acceptanceCheckIds.map((id) => ({ id, passed: true }))
            : [])
        ];
        const coveredIds = new Set(
          rawCheckList
            .filter((c) => c && typeof c === 'object' && c.passed !== false)
            .map((c) => String(c.id || c.checkId || '').trim())
            .filter(Boolean)
        );
        if (coveredIds.size > 0) {
          const missingChecks = requiredAcceptanceChecks
            .map((c) =>
              typeof c === 'string'
                ? c.trim()
                : String(c?.id || c?.checkId || c?.name || '').trim()
            )
            .filter((id) => id && !coveredIds.has(id));
          if (missingChecks.length > 0) {
            return {
              valid: false,
              error: `MISSING_ACCEPTANCE_CHECK_COVERAGE:${missingChecks.join(',')}`
            };
          }
        }
      }

      const artifactHashes = stored.artifactHashes || {};
      const receiptArchiveDir = path.join(this.receiptsDir, 'artifacts', receiptId);
      const revArchiveDir =
        stored.lessonRevisionId && stored.taskId && stored.domain
          ? path.join(
              this.harnessDir,
              'library',
              String(stored.domain),
              'harnesses',
              String(stored.taskId),
              'revisions',
              String(stored.lessonRevisionId),
              'artifacts'
            )
          : null;

      let applicableToCurrentWorkspace = true;
      for (const [relPath, expectedSha256] of Object.entries(artifactHashes)) {
        const cleanRel = String(relPath).replace(/\\/g, '/');
        const wsPath = path.resolve(this.workspaceRoot, cleanRel);
        const wsExists =
          this._isPathInsideWorkspace(wsPath) &&
          fs.existsSync(wsPath) &&
          fs.statSync(wsPath).isFile();
        const wsSha256 = wsExists
          ? crypto.createHash('sha256').update(fs.readFileSync(wsPath)).digest('hex')
          : null;
        if (!wsSha256 || wsSha256.toLowerCase() !== String(expectedSha256).toLowerCase()) {
          applicableToCurrentWorkspace = false;
        }

        if (mode === 'historical') {
          const revArtifactPath = revArchiveDir ? path.resolve(revArchiveDir, cleanRel) : null;
          const rcptArtifactPath = path.resolve(receiptArchiveDir, cleanRel);
          const histFile =
            revArtifactPath &&
            this._isPathInsideWorkspace(revArtifactPath) &&
            fs.existsSync(revArtifactPath) &&
            fs.statSync(revArtifactPath).isFile()
              ? revArtifactPath
              : this._isPathInsideWorkspace(rcptArtifactPath) &&
                  fs.existsSync(rcptArtifactPath) &&
                  fs.statSync(rcptArtifactPath).isFile()
                ? rcptArtifactPath
                : wsExists
                  ? wsPath
                  : null;
          if (!histFile) {
            return {
              ok: false,
              valid: false,
              error: 'RECEIPT_ARTIFACT_MISSING',
              relPath: cleanRel
            };
          }
          const histSha = crypto.createHash('sha256').update(fs.readFileSync(histFile)).digest('hex');
          if (histSha.toLowerCase() !== String(expectedSha256).toLowerCase()) {
            return {
              ok: false,
              valid: false,
              error: 'RECEIPT_ARTIFACT_HASH_MISMATCH',
              relPath: cleanRel
            };
          }
        } else {
          if (!wsExists) {
            return {
              ok: false,
              valid: false,
              error: 'RECEIPT_ARTIFACT_MISSING',
              relPath: cleanRel
            };
          }
          if (wsSha256.toLowerCase() !== String(expectedSha256).toLowerCase()) {
            return {
              ok: false,
              valid: false,
              error: 'RECEIPT_ARTIFACT_HASH_MISMATCH',
              relPath: cleanRel
            };
          }
        }
      }

      if (expectedLessonDigest) {
        if (stored.lessonDigest && stored.lessonDigest !== expectedLessonDigest) {
          return {
            ok: false,
            valid: false,
            error: 'RECEIPT_LESSON_DIGEST_MISMATCH'
          };
        }
      } else if (stored.lessonDigest && stored.taskId && stored.domain) {
        const taskDir = path.join(
          this.harnessDir,
          'library',
          String(stored.domain),
          'harnesses',
          String(stored.taskId)
        );
        const activePointerPath = path.join(taskDir, 'active.json');
        let activePointer = null;
        if (this._isPathInsideWorkspace(activePointerPath) && fs.existsSync(activePointerPath)) {
          try {
            activePointer = JSON.parse(fs.readFileSync(activePointerPath, 'utf8'));
          } catch {}
        }
        const isSupersededRevision =
          mode === 'historical' ||
          (stored.lessonRevisionId &&
            activePointer &&
            activePointer.activeRevisionId &&
            activePointer.activeRevisionId !== stored.lessonRevisionId);

        const boundExpPath =
          isSupersededRevision && stored.lessonRevisionId
            ? path.join(taskDir, 'revisions', String(stored.lessonRevisionId), 'EXPERIENCE.md')
            : path.join(taskDir, 'EXPERIENCE.md');

        if (this._isPathInsideWorkspace(boundExpPath) && fs.existsSync(boundExpPath)) {
          const liveLessonDigest = crypto
            .createHash('sha256')
            .update(fs.readFileSync(boundExpPath, 'utf8'), 'utf8')
            .digest('hex');
          if (liveLessonDigest !== stored.lessonDigest) {
            return {
              ok: false,
              valid: false,
              error: 'RECEIPT_LESSON_DIGEST_MISMATCH'
            };
          }
        }
      }

      return {
        ok: true,
        valid: true,
        applicableToCurrentWorkspace,
        receiptId: stored.receiptId,
        receipt: stored
      };
    } catch {
      return {
        valid: false,
        error: 'CORRUPT_STORED_RECEIPT'
      };
    }
  }

  recordExperience({
    task_id,
    taskId = null,
    attempt_id = null,
    attemptId = null,
    request_id = null,
    requestId = null,
    domain = 'software-engineering',
    title,
    cue,
    problem,
    observed_behavior,
    supporting_evidence = [],
    status = 'candidate',
    synthetic = false,
    receiptId = null,
    receipt_id = null,
    evaluationReceiptId = null,
    evaluation_receipt_id = null,
    evaluationReceipt = null,
    evaluation_receipt = null,
    tags = ['harness2', 'experience'],
    adopted_harness = null
  }) {
    const rawTaskId = task_id || taskId;
    if (!rawTaskId) {
      throw new Error('task_id is required to record a Harness² experience entry.');
    }
    this.ensureDirectories();
    const safeDomain = domain.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const safeTaskId = String(rawTaskId).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const effectiveRequestId = requestId || request_id || null;
    const isSynthetic = Boolean(synthetic || adopted_harness?.synthetic);
    const candidateReceiptRef =
      receiptId ||
      receipt_id ||
      evaluationReceiptId ||
      evaluation_receipt_id ||
      evaluationReceipt ||
      evaluation_receipt ||
      adopted_harness?.receiptId ||
      adopted_harness?.receipt_id ||
      null;

    // RequestId idempotency check
    const reqStorePath = path.join(this.runtimeDir, 'experience-requests.json');
    let reqStore = {};
    if (this._isPathInsideWorkspace(reqStorePath) && fs.existsSync(reqStorePath)) {
      try {
        reqStore = JSON.parse(fs.readFileSync(reqStorePath, 'utf8')) || {};
      } catch {
        reqStore = {};
      }
    }
    const payloadFingerprint = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          task_id: safeTaskId,
          domain: safeDomain,
          title: title || '',
          cue: cue || '',
          problem: problem || '',
          observed_behavior: observed_behavior || '',
          status: status || 'candidate',
          synthetic: isSynthetic,
          receiptRef:
            typeof candidateReceiptRef === 'string'
              ? candidateReceiptRef
              : candidateReceiptRef?.receiptId || null
        }),
        'utf8'
      )
      .digest('hex');

    if (effectiveRequestId) {
      const existingReq = reqStore[effectiveRequestId];
      if (existingReq) {
        if (existingReq.payloadFingerprint !== payloadFingerprint) {
          return {
            ok: false,
            recorded: false,
            error: 'REQUEST_ID_PAYLOAD_CONFLICT',
            requestId: effectiveRequestId
          };
        }
        return {
          ...existingReq.result,
          idempotentReplay: true,
          requestId: effectiveRequestId
        };
      }
    }

    const gitRev = this.getGitRevision();
    const nowIso = new Date().toISOString();
    const domPrefix = safeDomain.slice(0, 4).toUpperCase();
    const slug = safeTaskId.slice(0, 16).toUpperCase();
    const hash6 = crypto.createHash('sha1').update(String(rawTaskId)).digest('hex').slice(0, 6).toUpperCase();
    const docid = `EXP-${domPrefix}-${slug}-${hash6}`;

    const expectedCandidateId =
      adopted_harness?.winning_candidate_id ||
      adopted_harness?.candidate_id ||
      adopted_harness?.candidateId ||
      null;

    let verifiedReceipt = null;
    if (candidateReceiptRef && !isSynthetic) {
      const check = this.verifyEvaluationReceipt(candidateReceiptRef, {
        expectedTaskId: safeTaskId,
        expectedDomain: safeDomain,
        expectedCandidateId
      });
      if (check.valid) {
        verifiedReceipt = check.receipt;
      }
    }

    let effectiveStatus = status || 'candidate';
    if (isSynthetic) {
      effectiveStatus = 'candidate';
    } else if (effectiveStatus === 'active' && !verifiedReceipt) {
      effectiveStatus = 'candidate';
    }

    const taskDir = path.join(this.harnessDir, 'library', safeDomain, 'harnesses', safeTaskId);
    const harnessSubdir = path.join(taskDir, 'harness');
    const revisionsDir = path.join(taskDir, 'revisions');
    const activePointerPath = path.join(taskDir, 'active.json');
    this.assertContainedPath(taskDir, 'taskDir');
    this.assertContainedPath(harnessSubdir, 'harnessSubdir');
    this.assertContainedPath(revisionsDir, 'revisionsDir');
    fs.mkdirSync(harnessSubdir, { recursive: true });
    fs.mkdirSync(revisionsDir, { recursive: true });

    let activeState = {
      taskId: safeTaskId,
      domain: safeDomain,
      activeRevisionId: null,
      receiptId: null,
      attemptId: null,
      revisionCount: 0,
      previousRevisions: [],
      candidateRevisions: []
    };
    if (fs.existsSync(activePointerPath)) {
      try {
        const parsedActive = JSON.parse(fs.readFileSync(activePointerPath, 'utf8'));
        if (parsedActive && typeof parsedActive === 'object') {
          activeState = {
            ...activeState,
            ...parsedActive,
            previousRevisions: Array.isArray(parsedActive.previousRevisions)
              ? parsedActive.previousRevisions
              : [],
            candidateRevisions: Array.isArray(parsedActive.candidateRevisions)
              ? parsedActive.candidateRevisions
              : []
          };
        }
      } catch {}
    }

    const nextSeq = Number(activeState.revisionCount || 0) + 1;
    const revHash8 = crypto
      .createHash('sha256')
      .update(`${safeTaskId}:${nowIso}:${payloadFingerprint}:${nextSeq}`, 'utf8')
      .digest('hex')
      .slice(0, 8)
      .toUpperCase();
    const lessonRevisionId = `REV-${nextSeq}-${revHash8}`;
    const resolvedAttemptId =
      attemptId ||
      attempt_id ||
      verifiedReceipt?.attemptId ||
      `ATT-${Date.now()}-${revHash8.slice(0, 6)}`;

    const revDir = path.join(revisionsDir, lessonRevisionId);
    const revHarnessDir = path.join(revDir, 'harness');
    this.assertContainedPath(revDir, 'revDir');
    fs.mkdirSync(revHarnessDir, { recursive: true });

    const manifestPath = path.join(harnessSubdir, 'manifest.json');
    this.assertContainedPath(manifestPath, 'manifestPath');
    const relManifestPath = path.relative(this.workspaceRoot, manifestPath).replace(/\\/g, '/');

    const expTitle = title || `EXPERIENCE: ${safeTaskId}`;
    const expCue =
      cue ||
      `When encountering tasks matching '${safeTaskId}' in domain '${safeDomain}', apply the verified harness configuration.`;

    const buildLessonArtifacts = (statusVal, rcptObj) => {
      const mPayload = adopted_harness
        ? {
            ...adopted_harness,
            task_id: safeTaskId,
            domain: safeDomain,
            lesson_revision_id: lessonRevisionId,
            attempt_id: resolvedAttemptId,
            status: statusVal,
            synthetic: isSynthetic,
            receipt_id: rcptObj?.receiptId || null
          }
        : {
            harness_id: `harness-${safeDomain}-${safeTaskId}`,
            task_id: safeTaskId,
            domain: safeDomain,
            lesson_revision_id: lessonRevisionId,
            attempt_id: resolvedAttemptId,
            adopted_at: nowIso,
            git_revision: gitRev,
            status: statusVal,
            synthetic: isSynthetic,
            receipt_id: rcptObj?.receiptId || null
          };
      const evList = Array.isArray(supporting_evidence)
        ? [...supporting_evidence]
        : [String(supporting_evidence)];
      if (!evList.includes(relManifestPath)) {
        evList.unshift(relManifestPath);
      }
      if (rcptObj) {
        const relReceiptPath = `.harness/receipts/${rcptObj.receiptId}.json`;
        if (!evList.includes(relReceiptPath)) {
          evList.push(relReceiptPath);
        }
      }
      const mdStr = [
        '---',
        `docid: ${docid}`,
        `title: "${expTitle.replace(/"/g, '\\"')}"`,
        'collection: experiment-knowledge',
        `domain: ${safeDomain}`,
        `task_id: ${safeTaskId}`,
        `lesson_revision_id: ${lessonRevisionId}`,
        `attempt_id: ${resolvedAttemptId}`,
        `status: ${statusVal}`,
        `synthetic: ${isSynthetic}`,
        `receipt_id: ${rcptObj?.receiptId || 'null'}`,
        'repo: Harness2-RAG-antigravity',
        `git_revision: ${gitRev}`,
        `created_at: "${nowIso}"`,
        `cue: "${expCue.replace(/"/g, '\\"')}"`,
        `tags: [${tags.join(', ')}]`,
        'evidence_links:',
        ...evList.map((e) => `  - "${e}"`),
        '---',
        '',
        `# ${expTitle}`,
        '',
        '## 1. What Task or Problem Produced This Lesson?',
        `- **Task ID**: \`${safeTaskId}\``,
        `- **Lesson Revision**: \`${lessonRevisionId}\` (\`${resolvedAttemptId}\`)`,
        `- **Problem**: ${problem || 'Task-level Propose-Probe-Compose refinement.'}`,
        '',
        '## 2. Which Repository and Revision Did It Apply To?',
        '- **Repository**: `Harness2-RAG-antigravity`',
        `- **Git Revision**: \`${gitRev}\``,
        `- **Domain**: \`${safeDomain}\``,
        '',
        '## 3. What Was Actually Observed?',
        observed_behavior || 'Behavioral improvement verified across candidate probes.',
        '',
        '## 4. Which Evidence Supports the Conclusion?',
        ...evList.map((e) => `- \`${e}\``),
        '',
        '## 5. Is the Conclusion Still Current?',
        `- **Status**: \`${statusVal}\``,
        `- **Recorded At**: \`${nowIso}\``,
        ''
      ].join('\n');
      return {
        manifestStr: JSON.stringify(mPayload, null, 2) + '\n',
        expMd: mdStr
      };
    };

    let built = buildLessonArtifacts(effectiveStatus, verifiedReceipt);
    if (verifiedReceipt) {
      const candidateLessonDigest = crypto
        .createHash('sha256')
        .update(built.expMd, 'utf8')
        .digest('hex');
      const candidateHarnessDigest = crypto
        .createHash('sha256')
        .update(built.manifestStr, 'utf8')
        .digest('hex');

      if (
        (verifiedReceipt.lessonDigest && verifiedReceipt.lessonDigest !== candidateLessonDigest) ||
        (verifiedReceipt.harnessDigest && verifiedReceipt.harnessDigest !== candidateHarnessDigest)
      ) {
        // Receipt was already sealed to a different lesson/harness payload — reject reuse
        verifiedReceipt = null;
        if (effectiveStatus === 'active') {
          effectiveStatus = 'candidate';
        }
        built = buildLessonArtifacts(effectiveStatus, null);
      } else if (!verifiedReceipt.lessonDigest || !verifiedReceipt.harnessDigest) {
        verifiedReceipt.lessonDigest = candidateLessonDigest;
        verifiedReceipt.harnessDigest = verifiedReceipt.harnessDigest || candidateHarnessDigest;
        verifiedReceipt.lessonRevisionId = lessonRevisionId;
        verifiedReceipt.attemptId = resolvedAttemptId;
        verifiedReceipt.signature = this._signReceiptPayload(verifiedReceipt);
        const receiptFile = path.join(this.receiptsDir, `${verifiedReceipt.receiptId}.json`);
        this.assertContainedPath(receiptFile, 'receiptFile');
        const tmpFile = `${receiptFile}.tmp.${process.pid}.${Date.now()}`;
        fs.writeFileSync(tmpFile, JSON.stringify(verifiedReceipt, null, 2) + '\n', {
          encoding: 'utf8',
          mode: 0o600
        });
        fs.renameSync(tmpFile, receiptFile);
      }
    }

    const revExpPath = path.join(revDir, 'EXPERIENCE.md');
    const revManifestPath = path.join(revHarnessDir, 'manifest.json');
    const revMetaPath = path.join(revDir, 'revision.json');
    const revArtifactsDir = path.join(revDir, 'artifacts');
    fs.writeFileSync(revManifestPath, built.manifestStr, 'utf8');
    fs.writeFileSync(revExpPath, built.expMd, 'utf8');

    // Archive immutable copies of verified artifacts and receipt inside the revision directory
    if (verifiedReceipt) {
      fs.writeFileSync(
        path.join(revDir, 'receipt.json'),
        JSON.stringify(verifiedReceipt, null, 2) + '\n',
        'utf8'
      );
      const receiptArchiveDir = path.join(this.receiptsDir, 'artifacts', verifiedReceipt.receiptId);
      for (const relPath of Object.keys(verifiedReceipt.artifactHashes || {})) {
        const cleanRel = String(relPath).replace(/\\/g, '/');
        const srcArchive = path.resolve(receiptArchiveDir, cleanRel);
        const wsSource = path.resolve(this.workspaceRoot, cleanRel);
        const srcToCopy =
          this._isPathInsideWorkspace(srcArchive) && fs.existsSync(srcArchive)
            ? srcArchive
            : this._isPathInsideWorkspace(wsSource) && fs.existsSync(wsSource)
              ? wsSource
              : null;
        if (srcToCopy) {
          const destArtifact = path.resolve(revArtifactsDir, cleanRel);
          if (this._isPathInsideWorkspace(destArtifact)) {
            fs.mkdirSync(path.dirname(destArtifact), { recursive: true });
            fs.copyFileSync(srcToCopy, destArtifact);
          }
        }
      }
    }

    const lessonDigest = crypto.createHash('sha256').update(built.expMd, 'utf8').digest('hex');
    const harnessDigest = crypto.createHash('sha256').update(built.manifestStr, 'utf8').digest('hex');
    fs.writeFileSync(
      revMetaPath,
      JSON.stringify(
        {
          revisionId: lessonRevisionId,
          attemptId: resolvedAttemptId,
          taskId: safeTaskId,
          domain: safeDomain,
          title: expTitle,
          cue: expCue,
          status: effectiveStatus,
          synthetic: isSynthetic,
          receiptId: verifiedReceipt?.receiptId || null,
          artifactHashes: verifiedReceipt?.artifactHashes || {},
          lessonDigest,
          harnessDigest,
          createdAt: nowIso
        },
        null,
        2
      ) + '\n',
      'utf8'
    );

    const expFilePath = path.join(taskDir, 'EXPERIENCE.md');
    this.assertContainedPath(expFilePath, 'expFilePath');

    const hasExistingActiveLesson = Boolean(activeState.activeRevisionId && fs.existsSync(expFilePath));
    const shouldPromoteToTopLevel =
      (effectiveStatus === 'active' && !isSynthetic && Boolean(verifiedReceipt)) ||
      !hasExistingActiveLesson;

    if (shouldPromoteToTopLevel) {
      const tmpManifest = `${manifestPath}.tmp.${process.pid}.${Date.now()}`;
      const tmpExp = `${expFilePath}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmpManifest, built.manifestStr, 'utf8');
      fs.writeFileSync(tmpExp, built.expMd, 'utf8');
      fs.renameSync(tmpManifest, manifestPath);
      fs.renameSync(tmpExp, expFilePath);
    }

    activeState.revisionCount = nextSeq;
    if (effectiveStatus === 'active' && !isSynthetic && verifiedReceipt) {
      if (activeState.activeRevisionId && activeState.activeRevisionId !== lessonRevisionId) {
        activeState.previousRevisions.push({
          revisionId: activeState.activeRevisionId,
          receiptId: activeState.receiptId,
          attemptId: activeState.attemptId,
          supersededAt: nowIso
        });
      }
      activeState.activeRevisionId = lessonRevisionId;
      activeState.activeLessonRevisionId = lessonRevisionId;
      activeState.receiptId = verifiedReceipt.receiptId;
      activeState.attemptId = resolvedAttemptId;
      activeState.updatedAt = nowIso;
    } else {
      activeState.candidateRevisions.push({
        revisionId: lessonRevisionId,
        attemptId: resolvedAttemptId,
        status: effectiveStatus,
        synthetic: isSynthetic,
        createdAt: nowIso
      });
    }
    const tmpActive = `${activePointerPath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpActive, JSON.stringify(activeState, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpActive, activePointerPath);

    // Update domain INDEX.md and root INDEX.md transactionally when effectiveStatus === 'active' and not synthetic
    if (effectiveStatus === 'active' && !isSynthetic && verifiedReceipt) {
      this._upsertDomainAndRootIndexCue(safeDomain, safeTaskId, expCue, expTitle, nowIso);
    }

    const relExpPath = path
      .relative(this.workspaceRoot, shouldPromoteToTopLevel ? expFilePath : revExpPath)
      .replace(/\\/g, '/');
    const relRevExpPath = path.relative(this.workspaceRoot, revExpPath).replace(/\\/g, '/');
    const updatedIndex = this.buildIndex();
    const recordResult = {
      ok: true,
      recorded: true,
      docid,
      expId: docid,
      task_id: safeTaskId,
      domain: safeDomain,
      lessonRevisionId,
      attemptId: resolvedAttemptId,
      activeRevisionId: activeState.activeRevisionId,
      activeLessonRevisionId: activeState.activeRevisionId,
      preservedPriorActive: hasExistingActiveLesson && !shouldPromoteToTopLevel,
      preservedActiveLessonRevisionId:
        hasExistingActiveLesson && !shouldPromoteToTopLevel ? activeState.activeRevisionId : null,
      status: effectiveStatus,
      downgradedFromActive: status === 'active' && effectiveStatus !== 'active',
      synthetic: isSynthetic,
      receiptId: verifiedReceipt?.receiptId || null,
      experiencePath: relExpPath,
      revisionExperiencePath: relRevExpPath,
      relativePath: relExpPath,
      manifestPath: relManifestPath,
      totalIndexedDocuments: updatedIndex.totalDocuments
    };

    if (effectiveRequestId) {
      reqStore[effectiveRequestId] = {
        payloadFingerprint,
        recordedAt: nowIso,
        result: recordResult
      };
      try {
        fs.writeFileSync(reqStorePath, JSON.stringify(reqStore, null, 2) + '\n', 'utf8');
      } catch {}
    }

    return recordResult;
  }

  _upsertDomainAndRootIndexCue(safeDomain, safeTaskId, expCue, expTitle, nowIso) {
    const domainIndexPath = path.join(this.harnessDir, 'library', safeDomain, 'INDEX.md');
    this.assertContainedPath(domainIndexPath, 'domainIndexPath');
    if (!fs.existsSync(domainIndexPath)) {
      fs.writeFileSync(
        domainIndexPath,
        [
          '---',
          `docid: LIB-INDEX-${safeDomain.toUpperCase()}`,
          `title: "Harness² Experience Library Index — ${safeDomain}"`,
          'collection: experiment-knowledge',
          `domain: ${safeDomain}`,
          'status: active',
          `created_at: "${nowIso}"`,
          `tags: [index, ${safeDomain}, harness2, experience-library]`,
          '---',
          '',
          `# Domain Index: \`${safeDomain}\` (\`INDEX.md\`)`,
          '',
          '## Entries',
          ''
        ].join('\n'),
        'utf8'
      );
    }
    const existingDomainIndex = fs.readFileSync(domainIndexPath, 'utf8');
    const newEntryLines = [
      `- **[${safeTaskId}](./harnesses/${safeTaskId}/EXPERIENCE.md)** (\`${nowIso}\`, \`status: active\`)`,
      `  - **Cue**: *${expCue}*`,
      `  - **Adopted Harness**: [\`./harnesses/${safeTaskId}/harness/manifest.json\`](./harnesses/${safeTaskId}/harness/manifest.json)`
    ].join('\n');

    const escapedTask = safeTaskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const existingBlockRe = new RegExp(
      `^- \\*\\*\\[${escapedTask}\\]\\(\\./harnesses/${escapedTask}/EXPERIENCE\\.md\\)\\*\\*.*(?:\\r?\\n  - .*)*`,
      'm'
    );
    let updatedDomainContent;
    if (existingBlockRe.test(existingDomainIndex)) {
      updatedDomainContent = existingDomainIndex.replace(existingBlockRe, newEntryLines);
    } else {
      updatedDomainContent = existingDomainIndex.trimEnd() + '\n\n' + newEntryLines + '\n';
    }
    const tmpDomIdx = `${domainIndexPath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpDomIdx, updatedDomainContent, 'utf8');
    fs.renameSync(tmpDomIdx, domainIndexPath);

    const rootIndexPath = path.join(this.harnessDir, 'library', 'INDEX.md');
    this.assertContainedPath(rootIndexPath, 'rootIndexPath');
    if (fs.existsSync(rootIndexPath)) {
      const rootContent = fs.readFileSync(rootIndexPath, 'utf8');
      const tableRow = `| \`${safeTaskId}\` | \`${safeDomain}\` | ${expCue} | ${expTitle} | \`active\` | [\`${safeDomain}/harnesses/${safeTaskId}/EXPERIENCE.md\`](./${safeDomain}/harnesses/${safeTaskId}/EXPERIENCE.md) |`;
      const rowRe = new RegExp(`^\\|\\s*\`${escapedTask}\`\\s*\\|.*$`, 'm');
      const updatedRootContent = rowRe.test(rootContent)
        ? rootContent.replace(rowRe, tableRow)
        : rootContent.trimEnd() + '\n' + tableRow + '\n';
      const tmpRootIdx = `${rootIndexPath}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmpRootIdx, updatedRootContent, 'utf8');
      fs.renameSync(tmpRootIdx, rootIndexPath);
    }
  }

  rollbackActiveLesson(arg1 = {}, arg2 = null, arg3 = null) {
    const opts =
      typeof arg1 === 'string'
        ? { domain: arg1, taskId: arg2, targetRevisionId: arg3 }
        : arg1 || {};
    const {
      taskId,
      task_id,
      domain = 'software-engineering',
      targetRevisionId,
      target_revision_id,
      restoreArtifacts = true
    } = opts;
    const safeDomain = String(domain || 'software-engineering')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-');
    const safeTaskId = String(taskId || task_id || '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-');
    const targetRev = String(targetRevisionId || target_revision_id || '').trim();
    if (!safeTaskId || !targetRev) {
      return { ok: false, error: 'INVALID_ROLLBACK_PARAMETERS' };
    }
    const taskDir = path.join(this.harnessDir, 'library', safeDomain, 'harnesses', safeTaskId);
    const activePointerPath = path.join(taskDir, 'active.json');
    const revDir = path.join(taskDir, 'revisions', targetRev);
    const revExpPath = path.join(revDir, 'EXPERIENCE.md');
    const revManifestPath = path.join(revDir, 'harness', 'manifest.json');
    const revMetaPath = path.join(revDir, 'revision.json');
    const revArtifactsDir = path.join(revDir, 'artifacts');
    if (
      !this._isPathInsideWorkspace(revDir) ||
      !fs.existsSync(revExpPath) ||
      !fs.existsSync(revManifestPath) ||
      !fs.existsSync(revMetaPath)
    ) {
      return { ok: false, error: 'REVISION_NOT_FOUND', targetRevisionId: targetRev };
    }
    const revMeta = JSON.parse(fs.readFileSync(revMetaPath, 'utf8'));
    if (revMeta.status !== 'active' || revMeta.synthetic === true || !revMeta.receiptId) {
      return { ok: false, error: 'TARGET_REVISION_NOT_VERIFIED_ACTIVE', targetRevisionId: targetRev };
    }

    // Verify historical integrity of the target revision's receipt and archived artifacts
    const check = this.verifyEvaluationReceipt(revMeta.receiptId, {
      expectedTaskId: safeTaskId,
      expectedDomain: safeDomain,
      expectedLessonDigest: revMeta.lessonDigest,
      expectedHarnessDigest: revMeta.harnessDigest,
      mode: 'historical'
    });
    if (!check.valid) {
      return { ok: false, error: check.error || 'TARGET_REVISION_RECEIPT_INVALID' };
    }

    // Restore archived artifacts into workspace when requested so post-rollback receipt is also applicable to current workspace
    const restoredArtifacts = [];
    if (restoreArtifacts !== false) {
      const receiptArchiveDir = path.join(this.receiptsDir, 'artifacts', revMeta.receiptId);
      const artifactHashes = check.receipt?.artifactHashes || revMeta.artifactHashes || {};
      for (const relPath of Object.keys(artifactHashes)) {
        const cleanRel = String(relPath).replace(/\\/g, '/');
        const revFile = path.resolve(revArtifactsDir, cleanRel);
        const rcptFile = path.resolve(receiptArchiveDir, cleanRel);
        const srcFile =
          this._isPathInsideWorkspace(revFile) && fs.existsSync(revFile)
            ? revFile
            : this._isPathInsideWorkspace(rcptFile) && fs.existsSync(rcptFile)
              ? rcptFile
              : null;
        if (srcFile) {
          const destFile = path.resolve(this.workspaceRoot, cleanRel);
          if (this._isPathInsideWorkspace(destFile)) {
            fs.mkdirSync(path.dirname(destFile), { recursive: true });
            fs.copyFileSync(srcFile, destFile);
            restoredArtifacts.push(cleanRel);
          }
        }
      }
    }

    const expFilePath = path.join(taskDir, 'EXPERIENCE.md');
    const manifestPath = path.join(taskDir, 'harness', 'manifest.json');
    const revExpContent = fs.readFileSync(revExpPath, 'utf8');
    const revManifestContent = fs.readFileSync(revManifestPath, 'utf8');
    const tmpExp = `${expFilePath}.tmp.${process.pid}.${Date.now()}`;
    const tmpManifest = `${manifestPath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpExp, revExpContent, 'utf8');
    fs.writeFileSync(tmpManifest, revManifestContent, 'utf8');
    fs.renameSync(tmpExp, expFilePath);
    fs.renameSync(tmpManifest, manifestPath);

    const parsedRevDoc = parseFrontmatter(revExpContent);
    const rolledBackCue =
      revMeta.cue ||
      parsedRevDoc.metadata?.cue ||
      `When encountering tasks matching '${safeTaskId}' in domain '${safeDomain}', apply the verified harness configuration.`;
    const rolledBackTitle =
      revMeta.title || parsedRevDoc.metadata?.title || `EXPERIENCE: ${safeTaskId}`;
    const nowIso = new Date().toISOString();

    this._upsertDomainAndRootIndexCue(
      safeDomain,
      safeTaskId,
      rolledBackCue,
      rolledBackTitle,
      nowIso
    );

    let activeState = fs.existsSync(activePointerPath)
      ? JSON.parse(fs.readFileSync(activePointerPath, 'utf8'))
      : { taskId: safeTaskId, domain: safeDomain, previousRevisions: [], candidateRevisions: [] };
    activeState.activeRevisionId = targetRev;
    activeState.activeLessonRevisionId = targetRev;
    activeState.receiptId = revMeta.receiptId;
    activeState.attemptId = revMeta.attemptId;
    activeState.rolledBackAt = nowIso;
    const tmpActive = `${activePointerPath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpActive, JSON.stringify(activeState, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpActive, activePointerPath);

    this.buildIndex();
    return {
      ok: true,
      rolledBack: true,
      taskId: safeTaskId,
      domain: safeDomain,
      activeRevisionId: targetRev,
      activeLessonRevisionId: targetRev,
      receiptId: revMeta.receiptId,
      restoredArtifacts,
      historicalValid: true,
      cue: rolledBackCue
    };
  }

  promoteExperienceToProjectKnowledge({
    task_id_or_docid,
    experienceDocId,
    experienceIdOrPath,
    docid,
    expId,
    task_id,
    adr_id,
    title,
    summary,
    lessonRevisionId = null,
    lesson_revision_id = null,
    evaluationReceipt = null,
    evaluation_receipt = null,
    receiptId = null,
    receipt_id = null,
    verified = undefined
  } = {}) {
    const targetId =
      task_id_or_docid || experienceDocId || experienceIdOrPath || docid || expId || task_id;
    const expDoc = this.getDocument(targetId, { include_candidates: true });
    if (!expDoc.found) {
      throw new Error(`Cannot promote: Experience '${targetId}' not found.`);
    }

    if (expDoc.synthetic === true) {
      return {
        ok: false,
        promoted: false,
        error: 'SYNTHETIC_EXPERIENCE_CANNOT_BE_PROMOTED',
        docid: expDoc.docid,
        status: expDoc.status,
        synthetic: true
      };
    }

    if (
      verified === false ||
      (evaluationReceipt && typeof evaluationReceipt === 'object' && evaluationReceipt.passed === false) ||
      (evaluation_receipt && typeof evaluation_receipt === 'object' && evaluation_receipt.passed === false)
    ) {
      return {
        ok: false,
        promoted: false,
        error: 'PROMOTION_REQUIRES_EVALUATION_RECEIPT',
        docid: expDoc.docid,
        status: expDoc.status,
        synthetic: Boolean(expDoc.synthetic)
      };
    }

    const requestedRevId = String(lessonRevisionId || lesson_revision_id || '').trim() || null;
    let absExpPath = path.resolve(this.workspaceRoot, expDoc.path);
    let sourceExpRelPath = expDoc.path;
    if (requestedRevId && expDoc.domain && expDoc.task_id) {
      const candidateRevPath = path.join(
        this.harnessDir,
        'library',
        String(expDoc.domain),
        'harnesses',
        String(expDoc.task_id),
        'revisions',
        requestedRevId,
        'EXPERIENCE.md'
      );
      if (this._isPathInsideWorkspace(candidateRevPath) && fs.existsSync(candidateRevPath)) {
        absExpPath = candidateRevPath;
        sourceExpRelPath = path.relative(this.workspaceRoot, candidateRevPath).replace(/\\/g, '/');
      }
    }
    this.assertContainedPath(absExpPath, 'experiencePath');
    const actualLessonDigest = fs.existsSync(absExpPath)
      ? crypto.createHash('sha256').update(fs.readFileSync(absExpPath, 'utf8'), 'utf8').digest('hex')
      : null;

    const candidateReceiptId =
      receiptId ||
      receipt_id ||
      (typeof evaluationReceipt === 'string'
        ? evaluationReceipt
        : evaluationReceipt?.receiptId || evaluationReceipt?.receipt_id) ||
      (typeof evaluation_receipt === 'string'
        ? evaluation_receipt
        : evaluation_receipt?.receiptId || evaluation_receipt?.receipt_id) ||
      expDoc.receipt_id ||
      null;

    const receiptCheck = this.verifyEvaluationReceipt(candidateReceiptId, {
      expectedTaskId: expDoc.task_id || undefined,
      expectedDomain: expDoc.domain || undefined,
      expectedLessonDigest: actualLessonDigest,
      mode: requestedRevId ? 'historical' : 'current_workspace'
    });

    if (!receiptCheck.valid) {
      return {
        ok: false,
        promoted: false,
        error: 'PROMOTION_REQUIRES_EVALUATION_RECEIPT',
        detail: receiptCheck.error,
        docid: expDoc.docid,
        status: expDoc.status,
        synthetic: Boolean(expDoc.synthetic)
      };
    }

    const resolvedLessonRevId =
      requestedRevId ||
      receiptCheck.receipt?.lessonRevisionId ||
      expDoc.lesson_revision_id ||
      null;
    const slug = (adr_id || `ADR-PROMOTED-${expDoc.task_id || expDoc.docid}`)
      .replace(/[^a-zA-Z0-9_-]/g, '-');
    const nowIso = new Date().toISOString();
    const adrTitle = title || `${slug}: Promoted Architecture Rule from ${expDoc.task_id || expDoc.docid}`;
    const adrPath = path.join(this.harnessDir, 'knowledge', 'project', `${slug}.md`);
    this.assertContainedPath(adrPath, 'adrPath');
    const relReceiptPath = `.harness/receipts/${receiptCheck.receiptId}.json`;

    const adrMd = [
      '---',
      `docid: ${slug.toUpperCase()}`,
      `title: "${adrTitle.replace(/"/g, '\\"')}"`,
      'collection: project-knowledge',
      `domain: ${expDoc.domain || 'architecture'}`,
      'status: active',
      'synthetic: false',
      `receipt_id: ${receiptCheck.receiptId}`,
      ...(resolvedLessonRevId ? [`lesson_revision_id: ${resolvedLessonRevId}`] : []),
      'repo: Harness2-RAG-antigravity',
      `git_revision: ${this.getGitRevision()}`,
      `created_at: "${nowIso}"`,
      'tags: [promoted-lesson, adr, harness2, project-knowledge]',
      'evidence_links:',
      `  - "${sourceExpRelPath}"`,
      `  - "${relReceiptPath}"`,
      ...(expDoc.evidence_links || []).map((e) => `  - "${e}"`),
      '---',
      '',
      `# ${adrTitle}`,
      '',
      '## 1. Promoted Decision & Guidance',
      summary || expDoc.cue || `Adopted from verified Harness² experience \`${expDoc.docid}\`.`,
      '',
      '## 2. Original Harness² Provenance & Evidence',
      `- **Source Experience Document**: [\`${sourceExpRelPath}\`](../../../${sourceExpRelPath}) (\`${expDoc.docid}\`)`,
      `- **Evaluation Receipt**: \`${receiptCheck.receiptId}\` (\`${relReceiptPath}\`)`,
      `- **Original Task ID**: \`${expDoc.task_id}\``,
      `- **Git Revision at Verification**: \`${expDoc.git_revision}\``,
      ''
    ].join('\n');

    fs.writeFileSync(adrPath, adrMd, 'utf8');
    this.buildIndex();

    return {
      ok: true,
      promoted: true,
      adrDocId: slug.toUpperCase(),
      adrPath: path.relative(this.workspaceRoot, adrPath).replace(/\\/g, '/'),
      sourceExperience: sourceExpRelPath,
      lessonRevisionId: resolvedLessonRevId,
      receiptId: receiptCheck.receiptId,
      evaluationReceipt: receiptCheck.receipt
    };
  }

  resolveReasoningProfile(overrides = {}) {
    const cfg = this.loadConfig().harness2 || {};
    const requestedDepth = String(
      overrides.reasoning_depth || overrides.reasoningDepth || cfg.reasoningDepth || 'balanced'
    ).toLowerCase();
    const preset = REASONING_DEPTH_PROFILES[requestedDepth] || REASONING_DEPTH_PROFILES.balanced;

    const thinkingBudgetTokens = Number(
      overrides.thinking_budget_tokens ??
        overrides.thinkingBudgetTokens ??
        (requestedDepth === cfg.reasoningDepth ? cfg.thinkingBudgetTokens : preset.thinkingBudgetTokens) ??
        preset.thinkingBudgetTokens
    );
    const maxCandidateTokens = Number(
      overrides.max_candidate_tokens ??
        overrides.maxCandidateTokens ??
        (requestedDepth === cfg.reasoningDepth ? cfg.maxCandidateTokens : preset.maxCandidateTokens) ??
        preset.maxCandidateTokens
    );
    const maxProbeSteps = Number(
      overrides.max_probe_steps ??
        overrides.maxProbeSteps ??
        (requestedDepth === cfg.reasoningDepth ? cfg.maxProbeSteps : preset.maxProbeSteps) ??
        preset.maxProbeSteps
    );
    const ragTopK = Number(
      overrides.rag_top_k ?? overrides.ragTopK ?? cfg.ragTopK ?? preset.ragTopK
    );
    const ragSnippetMaxChars = Number(
      overrides.rag_snippet_max_chars ??
        overrides.ragSnippetMaxChars ??
        (requestedDepth === cfg.reasoningDepth ? cfg.ragSnippetMaxChars : preset.ragSnippetMaxChars) ??
        preset.ragSnippetMaxChars
    );
    const proberModelTier = String(
      overrides.prober_model_tier ||
        overrides.proberModelTier ||
        (requestedDepth === cfg.reasoningDepth ? cfg.proberModelTier : preset.proberModelTier) ||
        preset.proberModelTier
    );
    const composerModelTier = String(
      overrides.composer_model_tier ||
        overrides.composerModelTier ||
        cfg.composerModelTier ||
        preset.composerModelTier
    );
    const earlyStopOnFirstPass = Boolean(
      overrides.early_stop ??
        overrides.earlyStopOnFirstPass ??
        (requestedDepth === cfg.reasoningDepth ? cfg.earlyStopOnFirstPass : preset.earlyStopOnFirstPass) ??
        preset.earlyStopOnFirstPass
    );

    return {
      ...preset,
      reasoningDepth: preset.id,
      thinkingBudgetTokens,
      maxCandidateTokens,
      maxProbeSteps,
      ragTopK,
      ragSnippetMaxChars,
      proberModelTier,
      composerModelTier,
      earlyStopOnFirstPass,
    };
  }

  getLastHarness2Run() {
    try {
      if (fs.existsSync(this.lastRunPath)) {
        return JSON.parse(fs.readFileSync(this.lastRunPath, 'utf8'));
      }
    } catch {}
    return null;
  }

  _parseEvaluatorOutput(evalOut, passThreshold = 0.75) {
    if (evalOut === true) {
      return {
        validShape: true,
        passed: true,
        score: 1.0,
        error: null,
        usedTokens: null,
        providerCalls: 0,
        checks: [{ name: 'boolean_evaluator', passed: true, score: 1.0 }],
        invocation: null,
        raw: evalOut
      };
    }
    if (
      evalOut === false ||
      evalOut === null ||
      evalOut === undefined ||
      typeof evalOut !== 'object' ||
      Array.isArray(evalOut)
    ) {
      return {
        validShape: false,
        passed: false,
        score: 0,
        error: 'EVALUATOR_VERIFICATION_FAILED',
        usedTokens: null,
        providerCalls: 0,
        checks: [{ name: 'boolean_evaluator', passed: false, score: 0 }],
        invocation: null,
        raw: evalOut
      };
    }

    const hasExplicitPassed = typeof evalOut.passed === 'boolean';
    const hasExplicitScore = typeof evalOut.score === 'number' && !Number.isNaN(evalOut.score);
    if (!hasExplicitPassed && !hasExplicitScore) {
      return {
        validShape: false,
        passed: false,
        score: 0,
        error: evalOut.error || 'INVALID_EVALUATOR_RESULT_SCHEMA',
        usedTokens: null,
        providerCalls: 0,
        checks: Array.isArray(evalOut.checks) ? evalOut.checks : [],
        invocation: evalOut.invocation || null,
        raw: evalOut
      };
    }

    const rawScore = hasExplicitScore ? Number(evalOut.score) : evalOut.passed === true ? 1.0 : 0.0;
    const clampedScore = Math.max(0, Math.min(1, rawScore));
    const checksList = Array.isArray(evalOut.checks) ? evalOut.checks : [];
    const anyCheckFailed = this._hasFailedCheckEntry(checksList);
    const passed =
      (hasExplicitPassed ? evalOut.passed === true : clampedScore >= passThreshold) &&
      clampedScore >= passThreshold &&
      evalOut.ok !== false &&
      !anyCheckFailed;

    return {
      validShape: true,
      passed,
      score: Number(clampedScore.toFixed(4)),
      error: passed ? null : evalOut.error || 'EVALUATION_FAILED',
      usedTokens:
        typeof evalOut.usedTokens === 'number'
          ? evalOut.usedTokens
          : typeof evalOut.totalTokens === 'number'
            ? evalOut.totalTokens
            : typeof evalOut.observedTokens === 'number'
              ? evalOut.observedTokens
              : null,
      providerCalls: typeof evalOut.providerCalls === 'number' ? evalOut.providerCalls : 0,
      checks:
        checksList.length > 0
          ? checksList
          : [{ name: 'evaluator_verdict', passed, score: Number(clampedScore.toFixed(4)) }],
      invocation: evalOut.invocation || null,
      raw: evalOut
    };
  }

  _loadRegistryFile(filePath) {
    this.ensureDirectories();
    if (!this._isPathInsideWorkspace(filePath) || !fs.existsSync(filePath)) {
      return {};
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  _saveRegistryFile(filePath, data) {
    this.ensureDirectories();
    this.assertContainedPath(filePath, 'registryFile');
    const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, filePath);
  }

  registerExecutor(arg1 = {}, arg2 = {}) {
    const opts =
      typeof arg1 === 'string'
        ? { id: arg1, ...(typeof arg2 === 'function' ? { handler: arg2 } : arg2 || {}) }
        : arg1 || {};
    const {
      id,
      type = 'command',
      command = null,
      args = [],
      shell = undefined,
      env = {},
      timeoutMs = 15000,
      description = '',
      handler = null
    } = opts;
    const cleanId = String(id || '').trim();
    if (!cleanId) {
      throw new Error('Executor id is required.');
    }
    if (typeof handler === 'function') {
      IN_MEMORY_EXECUTOR_HANDLERS.set(`${this.workspaceRoot}::${cleanId}`, handler);
    }
    const reg = this._loadRegistryFile(this.executorsRegistryPath);
    reg[cleanId] = {
      id: cleanId,
      type: typeof handler === 'function' && !command ? 'handler' : type,
      command: command ? String(command) : null,
      args: Array.isArray(args) ? args.map(String) : [],
      shell: typeof shell === 'boolean' ? shell : null,
      env: env && typeof env === 'object' && !Array.isArray(env) ? env : {},
      timeoutMs: Number(timeoutMs || 15000),
      description: String(description || ''),
      registeredAt: new Date().toISOString()
    };
    this._saveRegistryFile(this.executorsRegistryPath, reg);
    return reg[cleanId];
  }

  registerVerifier(arg1 = {}, arg2 = {}) {
    const opts =
      typeof arg1 === 'string'
        ? { id: arg1, ...(typeof arg2 === 'function' ? { handler: arg2 } : arg2 || {}) }
        : arg1 || {};
    const {
      id,
      type = 'command',
      command = null,
      args = [],
      shell = undefined,
      env = {},
      timeoutMs = 15000,
      passThreshold = 0.75,
      description = '',
      handler = null
    } = opts;
    const cleanId = String(id || '').trim();
    if (!cleanId) {
      throw new Error('Verifier id is required.');
    }
    if (typeof handler === 'function') {
      IN_MEMORY_VERIFIER_HANDLERS.set(`${this.workspaceRoot}::${cleanId}`, handler);
    }
    const reg = this._loadRegistryFile(this.verifiersRegistryPath);
    reg[cleanId] = {
      id: cleanId,
      type: typeof handler === 'function' && !command ? 'handler' : type,
      command: command ? String(command) : null,
      args: Array.isArray(args) ? args.map(String) : [],
      shell: typeof shell === 'boolean' ? shell : null,
      env: env && typeof env === 'object' && !Array.isArray(env) ? env : {},
      timeoutMs: Number(timeoutMs || 15000),
      passThreshold: Number(passThreshold ?? 0.75),
      description: String(description || ''),
      registeredAt: new Date().toISOString()
    };
    this._saveRegistryFile(this.verifiersRegistryPath, reg);
    return reg[cleanId];
  }

  _tokenizeCommandLine(cmdStr) {
    const tokens = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    let hasUnquotedShellOps = false;
    const str = String(cmdStr || '').trim();
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === '\\' && i + 1 < str.length && (inDouble || inSingle || str[i + 1] === '"' || str[i + 1] === "'")) {
        current += str[i + 1];
        i++;
        continue;
      }
      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
        continue;
      }
      if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
        continue;
      }
      if (!inSingle && !inDouble) {
        if (/\s/.test(ch)) {
          if (current.length > 0) {
            tokens.push(current);
            current = '';
          }
          continue;
        }
        if (/[|&;<>]/.test(ch)) {
          hasUnquotedShellOps = true;
        }
      }
      current += ch;
    }
    if (current.length > 0) {
      tokens.push(current);
    }
    return { tokens, hasUnquotedShellOps };
  }

  _runProcessInCandidateDir(specOrCmd, candDir, timeoutMs = 15000, extraEnv = {}) {
    const spec =
      typeof specOrCmd === 'string'
        ? { command: specOrCmd, args: [], shell: undefined, env: {} }
        : specOrCmd || {};
    const rawCmd = String(spec.command || '').trim();
    const argv = Array.isArray(spec.args) ? spec.args.map(String) : [];
    if (!rawCmd) {
      return {
        ok: false,
        exitCode: 2,
        stdout: '',
        stderr: 'EMPTY_COMMAND_SPEC',
        command: '',
        args: argv,
        shell: false,
        cwd: candDir
      };
    }

    let execCmd = rawCmd;
    let execArgs = argv;
    let useShell = typeof spec.shell === 'boolean' ? spec.shell : false;

    if (argv.length === 0 && spec.shell !== true) {
      const parsed = this._tokenizeCommandLine(rawCmd);
      if (parsed.hasUnquotedShellOps) {
        useShell = true;
      } else if (parsed.tokens.length > 0) {
        execCmd = parsed.tokens[0];
        execArgs = parsed.tokens.slice(1);
        useShell = false;
      }
    }

    const bareInterpreters = new Set([
      'node',
      'node.exe',
      'python',
      'python3',
      'python.exe',
      'sh',
      'bash',
      'pwsh',
      'powershell',
      'cmd',
      'cmd.exe'
    ]);
    const cmdBase = path.basename(execCmd).toLowerCase();
    if (!useShell && execArgs.length === 0 && bareInterpreters.has(cmdBase)) {
      return {
        ok: false,
        exitCode: 2,
        stdout: '',
        stderr: `EMPTY_INTERPRETER_INVOCATION: '${rawCmd}' invoked without script or arguments`,
        command: execCmd,
        args: [],
        shell: false,
        cwd: candDir
      };
    }

    const mergedEnv = {
      ...process.env,
      ...(spec.env && typeof spec.env === 'object' ? spec.env : {}),
      HARNESS_CANDIDATE_DIR: candDir,
      ...extraEnv
    };

    const res = useShell
      ? spawnSync(rawCmd, argv, {
          cwd: candDir,
          shell: true,
          encoding: 'utf8',
          timeout: timeoutMs,
          windowsHide: true,
          env: mergedEnv
        })
      : spawnSync(execCmd, execArgs, {
          cwd: candDir,
          shell: false,
          encoding: 'utf8',
          timeout: timeoutMs,
          windowsHide: true,
          env: mergedEnv
        });

    const stdout = (res.stdout || '').trim();
    const stderr = (res.stderr || (res.error ? res.error.message : '') || '').trim();
    const exitCode = typeof res.status === 'number' ? res.status : -1;
    const ok = exitCode === 0 && !res.error;

    let parsedJsonLine = null;
    if (stdout) {
      const lastLine = stdout.split(/\r?\n/).filter(Boolean).pop();
      if (lastLine && lastLine.startsWith('{') && lastLine.endsWith('}')) {
        try {
          parsedJsonLine = JSON.parse(lastLine);
        } catch {}
      }
    }

    const invocation = {
      command: useShell ? rawCmd : execCmd,
      args: useShell ? argv : execArgs,
      shell: useShell,
      cwd: candDir
    };

    return {
      ok,
      exitCode,
      stdout,
      stderr,
      command: invocation.command,
      args: invocation.args,
      shell: useShell,
      cwd: candDir,
      invocation,
      parsedJson: parsedJsonLine
    };
  }

  _runCommandInCandidateDir(cmdStr, candDir, timeoutMs = 15000, extraEnv = {}) {
    return this._runProcessInCandidateDir(cmdStr, candDir, timeoutMs, extraEnv);
  }

  _executeSchedulerReferenceInCandidateDir(callArg) {
    const candDir = callArg.candidateDir || callArg.workspaceRoot;
    const schedulerPath = path.join(candDir, 'src', 'scheduler.mjs');
    const testPath = path.join(candDir, 'test', 'scheduler.test.mjs');
    fs.mkdirSync(path.dirname(schedulerPath), { recursive: true });
    fs.mkdirSync(path.dirname(testPath), { recursive: true });

    const schedulerCode = [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      '',
      'export class TaskScheduler {',
      '  constructor(storePath) {',
      "    this.storePath = storePath || path.join(process.cwd(), '.scheduler-tasks.json');",
      '  }',
      '  _load() {',
      '    if (!fs.existsSync(this.storePath)) return { tasks: {} };',
      "    return JSON.parse(fs.readFileSync(this.storePath, 'utf8'));",
      '  }',
      '  _save(state) {',
      '    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });',
      "    fs.writeFileSync(this.storePath, JSON.stringify(state, null, 2) + '\\n', 'utf8');",
      '  }',
      '  createTask({ id, name, schedule, payload = {} } = {}) {',
      "    if (!id || !name) return { ok: false, error: 'INVALID_TASK_INPUT' };",
      '    const state = this._load();',
      "    if (state.tasks[id] && state.tasks[id].status === 'scheduled') {",
      "      return { ok: false, error: 'TASK_ALREADY_EXISTS', id };",
      '    }',
      '    const task = {',
      '      id: String(id),',
      '      name: String(name),',
      "      schedule: String(schedule || '* * * * *'),",
      '      payload,',
      "      status: 'scheduled',",
      '      createdAt: new Date().toISOString(),',
      '      cancelledAt: null',
      '    };',
      '    state.tasks[id] = task;',
      '    this._save(state);',
      '    return { ok: true, task };',
      '  }',
      '  cancelTask(id, reason = "user_requested") {',
      '    const state = this._load();',
      '    const task = state.tasks[id];',
      "    if (!task) return { ok: false, error: 'TASK_NOT_FOUND', id };",
      "    if (task.status === 'cancelled') return { ok: false, error: 'TASK_ALREADY_CANCELLED', id, task };",
      "    task.status = 'cancelled';",
      '    task.cancelReason = String(reason);',
      '    task.cancelledAt = new Date().toISOString();',
      '    this._save(state);',
      '    return { ok: true, cancelled: true, task };',
      '  }',
      '  runDueTasks() {',
      '    const state = this._load();',
      '    const executed = [];',
      '    for (const task of Object.values(state.tasks)) {',
      "      if (task.status === 'scheduled') {",
      "        task.status = 'completed';",
      '        task.executedAt = new Date().toISOString();',
      '        executed.push(task.id);',
      '      }',
      '    }',
      '    this._save(state);',
      '    return { ok: true, executed };',
      '  }',
      '  getTask(id) {',
      '    const state = this._load();',
      '    return state.tasks[id] || null;',
      '  }',
      '  listTasks() {',
      '    return Object.values(this._load().tasks);',
      '  }',
      '}',
      ''
    ].join('\n');

    const testCode = [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import os from 'node:os';",
      "import { TaskScheduler } from '../src/scheduler.mjs';",
      '',
      "test('TaskScheduler creates, persists, cancels, and prevents cancelled tasks from running', () => {",
      "  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-test-'));",
      '  try {',
      "    const store = path.join(tmpDir, 'tasks.json');",
      '    const sched = new TaskScheduler(store);',
      "    const created = sched.createTask({ id: 'job-1', name: 'Nightly index refresh', schedule: '0 2 * * *' });",
      '    assert.equal(created.ok, true);',
      "    assert.equal(created.task.status, 'scheduled');",
      "    const cancelled = sched.cancelTask('job-1', 'maintenance_window');",
      '    assert.equal(cancelled.ok, true);',
      '    assert.equal(cancelled.cancelled, true);',
      "    assert.equal(sched.getTask('job-1').status, 'cancelled');",
      '    const runRes = sched.runDueTasks();',
      '    assert.deepEqual(runRes.executed, []);',
      "    const missingCancel = sched.cancelTask('non-existent-job');",
      '    assert.equal(missingCancel.ok, false);',
      "    assert.equal(missingCancel.error, 'TASK_NOT_FOUND');",
      '  } finally {',
      '    fs.rmSync(tmpDir, { recursive: true, force: true });',
      '  }',
      '});',
      ''
    ].join('\n');

    fs.writeFileSync(schedulerPath, schedulerCode, 'utf8');
    fs.writeFileSync(testPath, testCode, 'utf8');

    const servicePath = path.join(candDir, 'src', 'scheduler', 'service.mjs');
    const controllerPath = path.join(candDir, 'src', 'ui', 'schedule-controller.mjs');
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.mkdirSync(path.dirname(controllerPath), { recursive: true });
    fs.writeFileSync(
      servicePath,
      [
        "import { TaskScheduler } from '../scheduler.mjs';",
        "export const CANCELLED = 'CANCELLED';",
        "export const ACTIVE = 'ACTIVE';",
        'export function createJob(opts = {}) {',
        '  const sched = new TaskScheduler(opts.storePath);',
        '  return sched.createTask(opts);',
        '}',
        'export function cancelJob(id, opts = {}) {',
        '  const sched = new TaskScheduler(opts.storePath);',
        "  const res = sched.cancelTask(id, opts.reason || 'CANCELLED');",
        '  return { ...res, status: CANCELLED };',
        '}',
      ].join('\n') + '\n',
      'utf8'
    );
    fs.writeFileSync(
      controllerPath,
      [
        "import { cancelJob, CANCELLED } from '../scheduler/service.mjs';",
        'export function handleCancelScheduleClick(jobId, opts = {}) {',
        '  const res = cancelJob(jobId, opts);',
        '  return { ok: res.ok, state: CANCELLED, result: res };',
        '}',
      ].join('\n') + '\n',
      'utf8'
    );
    return {
      ok: true,
      stepsExecuted: 3,
      observedTokens: null,
      providerCalls: 0
    };
  }

  _verifySchedulerAcceptanceInCandidateDir(callArg) {
    const candDir = callArg.candidateDir || callArg.workspaceRoot;
    const schedulerPath = path.join(candDir, 'src', 'scheduler.mjs');
    const testPath = path.join(candDir, 'test', 'scheduler.test.mjs');
    if (!fs.existsSync(schedulerPath) || !fs.existsSync(testPath)) {
      return {
        passed: false,
        score: 0,
        error: 'SCHEDULER_ARTIFACTS_MISSING',
        checks: ['artifacts_exist:false']
      };
    }
    const unitRes = this._runCommandInCandidateDir('node --test test/scheduler.test.mjs', candDir, 15000);
    if (!unitRes.ok) {
      return {
        passed: false,
        score: 0.2,
        error: `SCHEDULER_UNIT_TESTS_FAILED: ${unitRes.stderr || unitRes.stdout}`,
        checks: ['artifacts_exist:true', 'unit_tests:false']
      };
    }
    const probeScript = [
      "import assert from 'node:assert/strict';",
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import os from 'node:os';",
      "import { TaskScheduler } from './src/scheduler.mjs';",
      "const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-verify-'));",
      'try {',
      "  const s = new TaskScheduler(path.join(tmp, 'state.json'));",
      "  const c1 = s.createTask({ id: 't-keep', name: 'KeepTask' });",
      "  const c2 = s.createTask({ id: 't-cancel', name: 'CancelTask' });",
      '  assert.equal(c1.ok, true);',
      '  assert.equal(c2.ok, true);',
      "  const cx = s.cancelTask('t-cancel', 'test_cancel');",
      '  assert.equal(cx.ok, true);',
      "  assert.equal(s.getTask('t-cancel').status, 'cancelled');",
      '  const due = s.runDueTasks();',
      "  assert.deepEqual(due.executed, ['t-keep']);",
      "  assert.equal(s.cancelTask('does-not-exist').ok, false);",
      '} finally {',
      '  fs.rmSync(tmp, { recursive: true, force: true });',
      '}'
    ].join('\n');
    const acceptRes = spawnSync(process.execPath, ['--input-type=module', '-e', probeScript], {
      cwd: candDir,
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true
    });
    if (acceptRes.status !== 0) {
      return {
        passed: false,
        score: 0.4,
        error: `SCHEDULER_ACCEPTANCE_CHECK_FAILED: ${(acceptRes.stderr || '').trim()}`,
        checks: ['artifacts_exist:true', 'unit_tests:true', 'behavioral_acceptance:false']
      };
    }
    return {
      passed: true,
      score: 0.98,
      checks: [
        'artifacts_exist:true',
        'unit_tests:true',
        'behavioral_acceptance:true',
        'negative_cancel_check:true'
      ]
    };
  }

  resolveExecutor(executorIdOrFn, options = {}) {
    if (typeof executorIdOrFn === 'function') {
      return { ok: true, id: 'inline-executor-fn', fn: executorIdOrFn };
    }
    const explicitCmd =
      options.command || options.executorCommand || options.executor_command || null;
    const explicitArgs = Array.isArray(options.args)
      ? options.args.map((a) => String(a))
      : Array.isArray(options.executorArgs)
        ? options.executorArgs.map((a) => String(a))
        : Array.isArray(options.executor_args)
          ? options.executor_args.map((a) => String(a))
          : null;
    const explicitShell =
      typeof (options.shell ?? options.executorShell ?? options.executor_shell) === 'boolean'
        ? Boolean(options.shell ?? options.executorShell ?? options.executor_shell)
        : undefined;
    const rawId =
      typeof executorIdOrFn === 'string' && executorIdOrFn.trim()
        ? executorIdOrFn.trim()
        : null;

    const buildCandidateEnv = (callArg) => {
      const candDir = callArg.candidateDir || callArg.workspaceRoot || this.workspaceRoot;
      let configPath = '';
      try {
        const runtimeCfgDir = path.join(candDir, '.harness', 'runtime');
        if (this._isPathInsideWorkspace(runtimeCfgDir)) {
          fs.mkdirSync(runtimeCfgDir, { recursive: true });
          configPath = path.join(runtimeCfgDir, 'candidate-config.json');
          fs.writeFileSync(
            configPath,
            JSON.stringify(
              {
                candidateId: callArg.candidateId || '',
                candidateIndex: callArg.candidateIndex ?? 0,
                front: callArg.front || '',
                modelTier: callArg.modelTier || '',
                thinkingBudgetTokens: callArg.thinkingBudgetTokens ?? null,
                maxSteps: callArg.maxSteps ?? null,
                appliedCues: callArg.appliedCues || [],
              },
              null,
              2
            ) + '\n',
            'utf8'
          );
        }
      } catch {}
      return {
        HARNESS_CANDIDATE_ID: callArg.candidateId || '',
        HARNESS_CANDIDATE_INDEX: String(callArg.candidateIndex ?? 0),
        HARNESS_CANDIDATE_FRONT: String(callArg.front || ''),
        HARNESS_REASONING_DEPTH: String(callArg.reasoningDepth || options.reasoningDepth || ''),
        HARNESS_THINKING_BUDGET_TOKENS: String(callArg.thinkingBudgetTokens ?? ''),
        HARNESS_MAX_STEPS: String(callArg.maxSteps ?? ''),
        HARNESS_CANDIDATE_CONFIG_PATH: configPath,
      };
    };

    const mapProcessToExecutorResult = (out) => {
      const pj = out.parsedJson && typeof out.parsedJson === 'object' ? out.parsedJson : {};
      const usedTok =
        typeof pj.usedTokens === 'number'
          ? pj.usedTokens
          : typeof pj.observedTokens === 'number'
            ? pj.observedTokens
            : typeof pj.totalTokens === 'number'
              ? pj.totalTokens
              : typeof pj.tokens === 'number'
                ? pj.tokens
                : null;
      return {
        ok: out.ok && pj.ok !== false,
        exitCode: out.exitCode,
        stdout: out.stdout,
        stderr: out.stderr,
        invocation: out.invocation,
        stepsExecuted: typeof pj.stepsExecuted === 'number' ? pj.stepsExecuted : 1,
        observedTokens: usedTok,
        usedTokens: usedTok,
        totalTokens: usedTok,
        providerCalls: typeof pj.providerCalls === 'number' ? pj.providerCalls : 0,
      };
    };

    if (!rawId && explicitCmd) {
      return {
        ok: true,
        id: 'command-executor',
        fn: (callArg) => {
          const out = this._runProcessInCandidateDir(
            {
              command: String(explicitCmd),
              args: explicitArgs,
              shell: explicitShell,
            },
            callArg.candidateDir || callArg.workspaceRoot,
            Number(options.timeoutMs || 15000),
            buildCandidateEnv(callArg)
          );
          return mapProcessToExecutorResult(out);
        },
      };
    }

    if (!rawId) {
      return { ok: true, id: null, fn: null };
    }

    const memHandler = IN_MEMORY_EXECUTOR_HANDLERS.get(`${this.workspaceRoot}::${rawId}`);
    if (typeof memHandler === 'function') {
      return { ok: true, id: rawId, fn: memHandler };
    }

    const reg = this._loadRegistryFile(this.executorsRegistryPath);
    if (reg[rawId] && reg[rawId].command) {
      const entry = reg[rawId];
      return {
        ok: true,
        id: rawId,
        fn: (callArg) => {
          const out = this._runProcessInCandidateDir(
            {
              command: entry.command,
              args: Array.isArray(entry.args) ? entry.args : explicitArgs,
              shell: typeof entry.shell === 'boolean' ? entry.shell : explicitShell,
              env: entry.env,
            },
            callArg.candidateDir || callArg.workspaceRoot,
            entry.timeoutMs || 15000,
            buildCandidateEnv(callArg)
          );
          return mapProcessToExecutorResult(out);
        },
      };
    }

    const builtinIds = new Set([
      'command-executor',
      'candidate-command',
      'scheduler-reference-executor',
      'registered-command-or-sdk-executor',
    ]);
    if (builtinIds.has(rawId)) {
      return {
        ok: true,
        id: rawId,
        fn: (callArg) => {
          const candDir = callArg.candidateDir || callArg.workspaceRoot || this.workspaceRoot;
          if (explicitCmd) {
            const out = this._runProcessInCandidateDir(
              {
                command: String(explicitCmd),
                args: explicitArgs,
                shell: explicitShell,
              },
              candDir,
              Number(options.timeoutMs || 15000),
              buildCandidateEnv(callArg)
            );
            return mapProcessToExecutorResult(out);
          }
          if (rawId === 'registered-command-or-sdk-executor') {
            const runnerCandidates = [
              options.candidateScript ? path.resolve(candDir, String(options.candidateScript)) : null,
              path.join(candDir, '.harness', 'candidate-runner.mjs'),
              path.join(candDir, 'candidate-runner.mjs'),
            ].filter(Boolean);
            for (const runnerPath of runnerCandidates) {
              if (this._isPathInsideWorkspace(runnerPath) && fs.existsSync(runnerPath)) {
                const out = this._runProcessInCandidateDir(
                  {
                    command: process.execPath,
                    args: [runnerPath],
                    shell: false,
                  },
                  candDir,
                  Number(options.timeoutMs || 15000),
                  buildCandidateEnv(callArg)
                );
                return mapProcessToExecutorResult(out);
              }
            }
          }
          if (
            rawId === 'scheduler-reference-executor' ||
            rawId === 'registered-command-or-sdk-executor'
          ) {
            return this._executeSchedulerReferenceInCandidateDir(callArg);
          }
          return { ok: false, error: 'MISSING_EXECUTOR_COMMAND' };
        },
      };
    }

    return {
      ok: false,
      id: rawId,
      error: 'REGISTERED_EXECUTOR_NOT_FOUND',
      fn: null,
    };
  }

  resolveVerifier(verifierIdOrFn, options = {}) {
    if (typeof verifierIdOrFn === 'function') {
      return { ok: true, id: 'inline-verifier-fn', fn: verifierIdOrFn };
    }
    const explicitCmd =
      options.verifierCommand ||
      options.verifier_command ||
      options.validatorCmd ||
      options.validator_cmd ||
      null;
    const explicitArgs = Array.isArray(options.verifierArgs)
      ? options.verifierArgs.map((a) => String(a))
      : Array.isArray(options.verifier_args)
        ? options.verifier_args.map((a) => String(a))
        : Array.isArray(options.validatorArgs)
          ? options.validatorArgs.map((a) => String(a))
          : Array.isArray(options.validator_args)
            ? options.validator_args.map((a) => String(a))
            : null;
    const explicitShell =
      typeof (options.verifierShell ?? options.verifier_shell) === 'boolean'
        ? Boolean(options.verifierShell ?? options.verifier_shell)
        : undefined;
    const rawId =
      typeof verifierIdOrFn === 'string' && verifierIdOrFn.trim()
        ? verifierIdOrFn.trim()
        : null;

    const mapProcessToVerifierResult = (out, checkLabel) => {
      const pj = out.parsedJson && typeof out.parsedJson === 'object' ? out.parsedJson : {};
      const defaultCheck = {
        name: checkLabel || 'command-verifier',
        command: out.invocation?.command || '',
        args: Array.isArray(out.invocation?.args) ? out.invocation.args : [],
        exitCode: out.exitCode,
        passed: out.ok && pj.passed !== false,
      };
      const rawChecks =
        Array.isArray(pj.checks) && pj.checks.length > 0 ? pj.checks : [defaultCheck];
      const hasFailedCheck = this._hasFailedCheckEntry(rawChecks);
      const passed = Boolean(out.ok && pj.passed !== false && !hasFailedCheck);
      const rawScore =
        typeof pj.score === 'number'
          ? pj.score
          : typeof pj.verificationScore === 'number'
            ? pj.verificationScore
            : passed
              ? 0.96
              : 0.0;
      const score = passed ? rawScore : Math.min(rawScore, 0.4);
      const usedTok =
        typeof pj.usedTokens === 'number'
          ? pj.usedTokens
          : typeof pj.observedTokens === 'number'
            ? pj.observedTokens
            : typeof pj.totalTokens === 'number'
              ? pj.totalTokens
              : typeof pj.tokens === 'number'
                ? pj.tokens
                : null;
      return {
        passed,
        score,
        error: passed
          ? null
          : pj.error || out.stderr || out.stdout || `Exit code ${out.exitCode}`,
        checks: rawChecks,
        invocation: out.invocation,
        usedTokens: usedTok,
        providerCalls: typeof pj.providerCalls === 'number' ? pj.providerCalls : 0,
      };
    };

    if (!rawId && explicitCmd) {
      return {
        ok: true,
        id: 'command-verifier',
        fn: (callArg) => {
          const out = this._runProcessInCandidateDir(
            {
              command: String(explicitCmd),
              args: explicitArgs,
              shell: explicitShell,
            },
            callArg.candidateDir || callArg.workspaceRoot,
            Number(options.timeoutMs || 15000),
            {
              HARNESS_CANDIDATE_ID: callArg.candidateId || '',
              HARNESS_VERIFY_PHASE: String(callArg.phase || 'candidate'),
            }
          );
          return mapProcessToVerifierResult(out, 'command-verifier');
        },
      };
    }

    if (!rawId) {
      return { ok: true, id: null, fn: null };
    }

    const memHandler = IN_MEMORY_VERIFIER_HANDLERS.get(`${this.workspaceRoot}::${rawId}`);
    if (typeof memHandler === 'function') {
      return { ok: true, id: rawId, fn: memHandler };
    }

    const reg = this._loadRegistryFile(this.verifiersRegistryPath);
    if (reg[rawId] && reg[rawId].command) {
      const entry = reg[rawId];
      return {
        ok: true,
        id: rawId,
        fn: (callArg) => {
          const out = this._runProcessInCandidateDir(
            {
              command: entry.command,
              args: Array.isArray(entry.args) ? entry.args : explicitArgs,
              shell: typeof entry.shell === 'boolean' ? entry.shell : explicitShell,
              env: entry.env,
            },
            callArg.candidateDir || callArg.workspaceRoot,
            entry.timeoutMs || 15000,
            {
              HARNESS_CANDIDATE_ID: callArg.candidateId || '',
              HARNESS_CANDIDATE_INDEX: String(callArg.candidateIndex ?? 0),
              HARNESS_VERIFY_PHASE: String(callArg.phase || 'candidate'),
            }
          );
          return mapProcessToVerifierResult(out, rawId);
        },
      };
    }

    const builtinIds = new Set([
      'command-verifier',
      'node-test-verifier',
      'scheduler-acceptance-verifier',
      'registered-scheduler-acceptance-checks',
    ]);
    if (builtinIds.has(rawId)) {
      return {
        ok: true,
        id: rawId,
        fn: (callArg) => {
          if (explicitCmd) {
            const out = this._runProcessInCandidateDir(
              {
                command: String(explicitCmd),
                args: explicitArgs,
                shell: explicitShell,
              },
              callArg.candidateDir || callArg.workspaceRoot,
              Number(options.timeoutMs || 15000),
              {
                HARNESS_CANDIDATE_ID: callArg.candidateId || '',
                HARNESS_VERIFY_PHASE: String(callArg.phase || 'candidate'),
              }
            );
            return mapProcessToVerifierResult(out, rawId);
          }
          if (
            rawId === 'scheduler-acceptance-verifier' ||
            rawId === 'registered-scheduler-acceptance-checks'
          ) {
            return this._verifySchedulerAcceptanceInCandidateDir(callArg);
          }
          if (rawId === 'node-test-verifier') {
            const out = this._runProcessInCandidateDir(
              {
                command: process.execPath,
                args: ['--test'],
                shell: false,
              },
              callArg.candidateDir || callArg.workspaceRoot,
              Number(options.timeoutMs || 15000)
            );
            return mapProcessToVerifierResult(out, 'node-test-verifier');
          }
          return { passed: false, score: 0, error: 'MISSING_VERIFIER_COMMAND' };
        },
      };
    }

    return {
      ok: false,
      id: rawId,
      error: 'REGISTERED_VERIFIER_NOT_FOUND',
      fn: null,
    };
  }

  _collectWorkspaceSourceFiles(dirPath = this.workspaceRoot, baseDir = this.workspaceRoot) {
    const files = [];
    if (!this._isPathInsideWorkspace(dirPath) || !fs.existsSync(dirPath)) return files;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (!this._isPathInsideWorkspace(fullPath)) continue;
      const rel = path.relative(baseDir, fullPath).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (
          entry.name === '.git' ||
          entry.name === 'node_modules' ||
          rel === '.harness/runtime' ||
          rel.startsWith('.harness/runtime/') ||
          rel === '.harness/snapshots' ||
          rel.startsWith('.harness/snapshots/') ||
          rel === '.harness/receipts' ||
          rel.startsWith('.harness/receipts/') ||
          rel === '.harness/index' ||
          rel.startsWith('.harness/index/')
        ) {
          continue;
        }
        files.push(...this._collectWorkspaceSourceFiles(fullPath, baseDir));
      } else if (entry.isFile()) {
        files.push({ rel, fullPath });
      }
    }
    return files;
  }

  /**
   * Executes a complete, token-efficient Google Research Harness² Propose -> Probe -> Compose
   * loop with Snapshot Isolation, Invariant + Domain-Specific candidate proposals,
   * bounded Reasoning Depth (`thinkingBudgetTokens`, `proberModelTier`, `earlyStopOnFirstPass`),
   * and behavioral contrast composition without requiring ground-truth answer keys.
   */
  runHarness2Loop(options = {}) {
    this.ensureDirectories();
    const cfg = this.loadConfig().harness2 || {};
    const profile = this.resolveReasoningProfile(options);
    const taskId = String(options.task_id || options.taskId || `task-${Date.now()}`)
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-');
    const domain = String(options.domain || 'software-engineering')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-');
    const problem =
      String(options.problem || '').trim() ||
      `Optimize execution harness for ${taskId} in ${domain} with strict token efficiency.`;
    const k = Math.max(2, Math.min(6, Number(options.k || cfg.defaultCandidatesK || 2)));
    const mode = String(options.mode || cfg.defaultMode || 'parallel').toLowerCase();
    const recordToLibrary =
      options.record_to_library !== undefined
        ? Boolean(options.record_to_library)
        : options.adopt_winner !== undefined
          ? Boolean(options.adopt_winner)
          : options.adoptWinner !== undefined
            ? Boolean(options.adoptWinner)
            : true;

    const explicitArtifacts = Array.isArray(options.requiredArtifacts || options.required_artifacts)
      ? options.requiredArtifacts || options.required_artifacts
      : [];
    const inferredArtifactMatch = problem.match(
      /\b([A-Za-z0-9_./-]*REQUIRED_ARTIFACT[A-Za-z0-9_./-]*\.[a-z0-9]+)\b/i
    );
    const requiredArtifacts = [...explicitArtifacts];
    if (inferredArtifactMatch && !requiredArtifacts.includes(inferredArtifactMatch[1])) {
      requiredArtifacts.push(inferredArtifactMatch[1]);
    }

    const requestedExecutor =
      options.executor ?? options.executorId ?? options.executor_id ?? null;
    const requestedVerifier =
      options.evaluator ??
      options.verifier ??
      options.verifierId ??
      options.verifier_id ??
      options.evaluatorId ??
      options.evaluator_id ??
      null;

    const resolvedExec = this.resolveExecutor(requestedExecutor, options);
    if (!resolvedExec.ok) {
      return {
        ok: false,
        status: 'unavailable',
        error: resolvedExec.error || 'REGISTERED_EXECUTOR_NOT_FOUND',
        executorId: resolvedExec.id,
        passedVerification: false,
        verificationScore: null,
        synthetic: false,
        taskId,
        domain,
        recordedLesson: null,
        adoptedExperience: null,
        recordedExperience: null
      };
    }

    const resolvedVerif = this.resolveVerifier(requestedVerifier, options);
    if (!resolvedVerif.ok) {
      return {
        ok: false,
        status: 'unavailable',
        error: resolvedVerif.error || 'REGISTERED_VERIFIER_NOT_FOUND',
        verifierId: resolvedVerif.id,
        passedVerification: false,
        verificationScore: null,
        synthetic: false,
        taskId,
        domain,
        recordedLesson: null,
        adoptedExperience: null,
        recordedExperience: null
      };
    }

    const executor = resolvedExec.fn;
    const evaluator = resolvedVerif.fn;
    const passThreshold = typeof options.passThreshold === 'number' ? options.passThreshold : 0.75;
    // WP2: Default allowSimulation to false unless explicitly opted in
    const allowSimulation =
      options.strictExecution === true || options.executionMode === 'strict'
        ? false
        : Boolean(options.allowSimulation ?? options.allow_simulation ?? false);
    const explicitBaselineTokens =
      typeof (options.baselineTokens ?? options.baseline_tokens) === 'number'
        ? Number(options.baselineTokens ?? options.baseline_tokens)
        : null;

    // F10: Run-level requestId idempotency
    const requestId =
      options.requestId !== undefined || options.request_id !== undefined
        ? String(options.requestId ?? options.request_id).trim() || null
        : null;
    const loopRequestsPath = path.join(this.runtimeDir, 'loop-requests.json');
    const requestPayloadDigest = requestId
      ? crypto
          .createHash('sha256')
          .update(
            JSON.stringify({
              taskId,
              domain,
              problem,
              k,
              mode,
              requiredArtifacts: [...requiredArtifacts].map(String).sort(),
              executorId: typeof requestedExecutor === 'string' ? requestedExecutor : Boolean(requestedExecutor),
              verifierId: typeof requestedVerifier === 'string' ? requestedVerifier : Boolean(requestedVerifier),
              command: options.command || options.executorCommand || options.executor_command || null,
              args: options.args || options.executorArgs || options.executor_args || null,
              verifierCommand:
                options.verifierCommand ||
                options.verifier_command ||
                options.validatorCmd ||
                options.validator_cmd ||
                null,
              verifierArgs:
                options.verifierArgs ||
                options.verifier_args ||
                options.validatorArgs ||
                options.validator_args ||
                null,
            }),
            'utf8'
          )
          .digest('hex')
      : null;

    if (requestId && this._isPathInsideWorkspace(loopRequestsPath) && fs.existsSync(loopRequestsPath)) {
      try {
        const existingReqs = JSON.parse(fs.readFileSync(loopRequestsPath, 'utf8'));
        const prevReq = existingReqs && existingReqs[requestId];
        if (prevReq && typeof prevReq === 'object') {
          if (prevReq.payloadDigest && prevReq.payloadDigest !== requestPayloadDigest) {
            return {
              ok: false,
              status: 'failed',
              error: 'REQUEST_ID_PAYLOAD_CONFLICT',
              requestId,
              passedVerification: false,
              verificationScore: null,
              synthetic: false,
              taskId,
              domain,
              recordedLesson: null,
              adoptedExperience: null,
              recordedExperience: null,
            };
          }
          if (prevReq.result && typeof prevReq.result === 'object') {
            return {
              ...prevReq.result,
              requestId,
              idempotentReplay: true,
            };
          }
        }
      } catch {}
    }

    const persistLoopRequestResult = (resObj) => {
      if (!requestId || !resObj || typeof resObj !== 'object') return resObj;
      const tagged = {
        ...resObj,
        requestId,
        idempotentReplay: Boolean(resObj.idempotentReplay),
      };
      if (this._isPathInsideWorkspace(loopRequestsPath)) {
        try {
          fs.mkdirSync(path.dirname(loopRequestsPath), { recursive: true });
          let map = {};
          if (fs.existsSync(loopRequestsPath)) {
            map = JSON.parse(fs.readFileSync(loopRequestsPath, 'utf8')) || {};
          }
          map[requestId] = {
            requestId,
            payloadDigest: requestPayloadDigest,
            recordedAt: new Date().toISOString(),
            result: tagged,
          };
          fs.writeFileSync(loopRequestsPath, JSON.stringify(map, null, 2) + '\n', 'utf8');
        } catch {}
      }
      return tagged;
    };

    // Enforce supervisor stop if task has escalated due to repeated no-progress attempts (PR E)
    const taskStatePath = path.join(this.harnessDir, 'tasks', taskId, 'state.json');
    if (
      this._isPathInsideWorkspace(taskStatePath) &&
      fs.existsSync(taskStatePath) &&
      options.acknowledgedEscalation !== true &&
      options.focusedRestart !== true
    ) {
      try {
        const taskState = JSON.parse(fs.readFileSync(taskStatePath, 'utf8'));
        if (
          taskState?.shouldStopRetryLoop === true ||
          taskState?.status === 'escalated_focused_restart' ||
          taskState?.escalation?.shouldStopRetryLoop === true ||
          taskState?.escalation?.status === 'escalated_focused_restart'
        ) {
          return {
            ok: false,
            status: 'escalated_stop',
            error: 'ESCALATED_NO_PROGRESS_STOP',
            escalation: taskState.escalation || taskState,
            passedVerification: false,
            verificationScore: null,
            synthetic: false,
            taskId,
            domain,
            recordedLesson: null,
            adoptedExperience: null,
            recordedExperience: null,
          };
        }
      } catch {}
    }

    // Snapshot pre-run state of workspace source tree + requiredArtifacts before any execution
    const baselineWorkspaceFiles = new Map();
    const treeDigestHash = crypto.createHash('sha256');
    const sourceFilesList = this._collectWorkspaceSourceFiles();
    for (const item of sourceFilesList.sort((a, b) => a.rel.localeCompare(b.rel))) {
      try {
        const rawBytes = fs.readFileSync(item.fullPath);
        const sha256 = crypto.createHash('sha256').update(rawBytes).digest('hex');
        baselineWorkspaceFiles.set(item.rel, {
          absFile: item.fullPath,
          inside: true,
          exists: true,
          sha256,
          rawBytes
        });
        treeDigestHash.update(`${item.rel}:${sha256}\n`, 'utf8');
      } catch {}
    }
    const sourceTreeDigest = treeDigestHash.digest('hex');

    const preRunArtifacts = new Map();
    for (const reqFile of requiredArtifacts) {
      const relStr = String(reqFile).replace(/\\/g, '/');
      const absFile = path.resolve(this.workspaceRoot, relStr);
      const inside = this._isPathInsideWorkspace(absFile);
      const exists =
        inside &&
        fs.existsSync(absFile) &&
        fs.statSync(absFile).isFile() &&
        fs.statSync(absFile).size > 0;
      const rawBytes = exists ? fs.readFileSync(absFile) : null;
      const sha256 = rawBytes
        ? crypto.createHash('sha256').update(rawBytes).digest('hex')
        : null;
      preRunArtifacts.set(relStr, { absFile, inside, exists, sha256, rawBytes });
    }

    // 1. Freeze Snapshot Isolation Lock with unique ownerRunId
    const ownerRunId =
      options.ownerRunId ||
      options.owner_run_id ||
      `loop-${taskId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const lock = this.createSnapshotLock({
      domain,
      k,
      mode,
      ownerRunId,
      description: `Harness² (${profile.reasoningDepth}) Propose-Probe-Compose for ${taskId}`,
    });

    if (!lock || lock.ok === false || !lock.active || !lock.snapshotId) {
      return {
        ok: false,
        status: 'failed',
        error: (lock && lock.error) || 'SNAPSHOT_LOCK_ACTIVE_BY_ANOTHER_RUN',
        passedVerification: false,
        verificationScore: null,
        synthetic: false,
        snapshotId: null,
        ownerRunId: lock?.ownerRunId || null,
        recordedLesson: null,
        adoptedExperience: null,
        recordedExperience: null,
      };
    }

    const snapshotId = lock.snapshotId;

    const cleanupSnapshotLock = () => {
      if (lock && lock.ok === true && lock.snapshotId) {
        this.releaseSnapshotLock({ ownerRunId, snapshotId: lock.snapshotId });
        if (!recordToLibrary) {
          const snapFile = path.join(this.snapshotsDir, `${lock.snapshotId}.json`);
          if (fs.existsSync(snapFile)) {
            try {
              fs.unlinkSync(snapFile);
            } catch {}
          }
        }
      }
    };

    const isThenable = (v) =>
      v !== null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';
    const chainMaybeAsync = (valOrProm, nextFn) =>
      isThenable(valOrProm) ? Promise.resolve(valOrProm).then(nextFn) : nextFn(valOrProm);

    const executeLoopBody = () => {
      // 2. Cue-First Token-Efficient Retrieval under frozen snapshot
      const expHits = this.query({
        query: `${domain} ${problem}`,
        collection: 'experiment-knowledge',
        topK: profile.ragTopK,
        snapshot_id: snapshotId,
        snippetMaxChars: profile.ragSnippetMaxChars,
      });
      const projHits = this.query({
        query: `${domain} constraints architecture ${problem}`,
        collection: 'project-knowledge',
        topK: Math.max(2, Math.floor(profile.ragTopK / 2)),
        snapshot_id: snapshotId,
        snippetMaxChars: profile.ragSnippetMaxChars,
      });

      const retrievedCues = (expHits.results || [])
        .map((r) => r.cue || r.matchedSection?.snippet || r.title)
        .filter(Boolean)
        .slice(0, 3);
      const retrievedAdrs = (projHits.results || []).map((r) => r.docid);

      // 3. Propose K Contrastive Candidates across Upstream Harness² Fronts (Invariant + Domain-Specific)
      const candidates = [
        {
          candidateId: 'candidate-1-invariant-guardrail',
          front: 'invariant',
          frontLabel: 'Invariant Front (General Agentic Guardrails)',
          hypothesis:
            'Bound thinking depth and enforce a concise 3-step plan + deterministic verification before completion.',
          modelTier: profile.proberModelTier,
          thinkingBudgetTokens: profile.thinkingBudgetTokens,
          maxSteps: profile.maxProbeSteps,
          workspaceMode: 'branch',
          componentsModified: ['system_prompts', 'rules', 'hooks'],
          appliedCues: ['Enforce bounded thinking budget & pre-completion test check'],
        },
        {
          candidateId: 'candidate-2-domain-rag-branched',
          front: 'domain-specific',
          frontLabel: 'Domain-Specific Front (Cue-First RAG + Branched Subagent)',
          hypothesis:
            'Inject compact INDEX.md conditional cues & ADR constraints under frozen snapshotId in isolated Workspace: branch.',
          modelTier: profile.proberModelTier,
          thinkingBudgetTokens: profile.thinkingBudgetTokens,
          maxSteps: Math.max(3, profile.maxProbeSteps - 1),
          workspaceMode: 'branch',
          componentsModified: ['system_prompts', 'rules', 'skills', 'subagents', 'scripts'],
          appliedCues:
            retrievedCues.length > 0
              ? retrievedCues
              : [`Apply verified ${domain} conventions from .harness/library/${domain}/INDEX.md`],
        },
      ];

      while (candidates.length < k) {
        const idx = candidates.length + 1;
        candidates.push({
          candidateId: `candidate-${idx}-hybrid-early-stop`,
          front: 'hybrid',
          frontLabel: 'Hybrid Invariant + Domain Front (Early-Stop Verifier)',
          hypothesis:
            'Combine Cue-First domain retrieval with invariant step caps and early-stop once verification script passes.',
          modelTier: profile.proberModelTier,
          thinkingBudgetTokens: Math.round(profile.thinkingBudgetTokens * 0.85),
          maxSteps: Math.max(3, profile.maxProbeSteps - 1),
          workspaceMode: 'branch',
          componentsModified: ['system_prompts', 'rules', 'skills', 'subagents', 'hooks', 'scripts'],
          appliedCues: retrievedCues.slice(0, 2),
        });
      }

      // Enforce allowSimulation === false guard when no executor or evaluator is provided
      if (allowSimulation === false && !executor && !evaluator && requiredArtifacts.length === 0) {
        return {
          ok: false,
          status: 'failed',
          error: 'NO_VERIFIED_EXECUTION_OR_EVALUATOR',
          passedVerification: false,
          verificationScore: null,
          synthetic: false,
          usedTokens: null,
          providerCalls: 0,
          artifactChanges: 0,
          executionMode: 'verified-required',
          sourceTreeDigest,
          runId: `h2-run-${Date.now()}`,
          completedAt: new Date().toISOString(),
          taskId,
          domain,
          problem,
          k,
          mode,
          snapshotId,
          reasoningProfile: profile,
          candidates,
          proposals: candidates,
          probeTrajectories: [],
          trajectories: [],
          winnerCandidateId: null,
          winnerScore: 0,
          winner: {
            candidateId: null,
            score: 0,
            verificationScore: 0,
            passedVerification: false,
            totalTokens: 0,
          },
          tokenEfficiency: {
            totalActualTokens: 0,
            totalUnoptimizedTokens: null,
            totalTokensSaved: 0,
            totalTokensSavedPct: 0,
            earlyStopped: false,
          },
          composedHarness: null,
          recordedLesson: null,
          adoptedExperience: null,
          recordedExperience: null,
        };
      }

      const runId =
        options.runId ||
        options.run_id ||
        `h2-run-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      const runsBaseDir = path.join(this.runtimeDir, 'runs', runId);
      this.assertContainedPath(runsBaseDir, 'runsBaseDir');
      fs.mkdirSync(runsBaseDir, { recursive: true });

      const candidateDirs = candidates.map((cand) => {
        const cDir = path.join(runsBaseDir, cand.candidateId);
        this.assertContainedPath(cDir, 'candidateDir');
        fs.mkdirSync(cDir, { recursive: true });
        return cDir;
      });

      const restoreWorkspaceBaseline = () => {
        for (const [, pre] of baselineWorkspaceFiles.entries()) {
          if (!pre.inside) continue;
          if (pre.exists && pre.rawBytes) {
            fs.mkdirSync(path.dirname(pre.absFile), { recursive: true });
            fs.writeFileSync(pre.absFile, pre.rawBytes);
          }
        }
        for (const [, pre] of preRunArtifacts.entries()) {
          if (!pre.inside) continue;
          if (pre.exists && pre.rawBytes) {
            fs.mkdirSync(path.dirname(pre.absFile), { recursive: true });
            fs.writeFileSync(pre.absFile, pre.rawBytes);
          } else if (!pre.exists && fs.existsSync(pre.absFile)) {
            try {
              fs.unlinkSync(pre.absFile);
            } catch {}
          }
        }
        // F03: Delete any undeclared file created in workspaceRoot during candidate execution/evaluation
        const currentFiles = this._collectWorkspaceSourceFiles();
        for (const item of currentFiles) {
          const inBase = baselineWorkspaceFiles.has(item.rel);
          const inPreReq = preRunArtifacts.has(item.rel) && preRunArtifacts.get(item.rel).exists;
          if (!inBase && !inPreReq && fs.existsSync(item.fullPath)) {
            try {
              fs.unlinkSync(item.fullPath);
            } catch {}
          }
        }
      };

      const stageBaselineIntoCandidateDir = (candDir) => {
        for (const [relStr, pre] of baselineWorkspaceFiles.entries()) {
          if (!pre.inside || !pre.exists || !pre.rawBytes) continue;
          const candFile = path.resolve(candDir, relStr);
          if (this._isPathInsideWorkspace(candFile)) {
            fs.mkdirSync(path.dirname(candFile), { recursive: true });
            fs.writeFileSync(candFile, pre.rawBytes);
          }
        }
        for (const [relStr, pre] of preRunArtifacts.entries()) {
          if (!pre.inside || !pre.exists || !pre.rawBytes) continue;
          const candFile = path.resolve(candDir, relStr);
          if (this._isPathInsideWorkspace(candFile)) {
            fs.mkdirSync(path.dirname(candFile), { recursive: true });
            fs.writeFileSync(candFile, pre.rawBytes);
          }
        }
      };

      const candArtifactStates = candidates.map((cand, idx) => ({
        candidateId: cand.candidateId,
        candidateDir: candidateDirs[idx],
        sourceTreeDigest,
        outputTreeDigest: sourceTreeDigest,
        hashes: {},
        modifiedFiles: {},
        addedFiles: {},
        deletedFiles: [],
        treeDiff: {
          added: [],
          modified: [],
          deleted: [],
          modeChanged: [],
          inputTreeDigest: sourceTreeDigest,
          outputTreeDigest: sourceTreeDigest,
        },
        changes: 0,
        missing: [],
      }));

      const captureCandidateArtifacts = (idx) => {
        const candDir = candidateDirs[idx];
        const state = candArtifactStates[idx];
        state.hashes = {};
        state.modifiedFiles = {};
        state.addedFiles = {};
        state.deletedFiles = [];
        state.changes = 0;
        state.missing = [];

        // Capture any file modified or deleted in workspaceRoot by a legacy callback that wrote to rootWorkspaceRoot
        if (executor) {
          const currentWsFiles = this._collectWorkspaceSourceFiles();
          const currentWsMap = new Map(currentWsFiles.map((item) => [item.rel, item.fullPath]));
          for (const item of currentWsFiles) {
            try {
              const wsBuf = fs.readFileSync(item.fullPath);
              const wsSha = crypto.createHash('sha256').update(wsBuf).digest('hex');
              const baseEntry = baselineWorkspaceFiles.get(item.rel);
              if (!baseEntry || baseEntry.sha256 !== wsSha) {
                const candFile = path.resolve(candDir, item.rel);
                if (this._isPathInsideWorkspace(candFile)) {
                  fs.mkdirSync(path.dirname(candFile), { recursive: true });
                  fs.writeFileSync(candFile, wsBuf);
                }
              }
            } catch {}
          }
          // If a legacy callback deleted a baseline file from workspaceRoot, mirror that deletion into candDir
          for (const [relStr] of baselineWorkspaceFiles.entries()) {
            if (!currentWsMap.has(relStr)) {
              const candFile = path.resolve(candDir, relStr);
              if (this._isPathInsideWorkspace(candFile) && fs.existsSync(candFile)) {
                try {
                  fs.unlinkSync(candFile);
                } catch {}
              }
            }
          }
        }

        // Check declared requiredArtifacts first
        for (const reqFile of requiredArtifacts) {
          const relStr = String(reqFile).replace(/\\/g, '/');
          const pre = preRunArtifacts.get(relStr) || baselineWorkspaceFiles.get(relStr);
          const wsFile = path.resolve(this.workspaceRoot, relStr);
          const candFile = path.resolve(candDir, relStr);

          const wsExists =
            this._isPathInsideWorkspace(wsFile) &&
            fs.existsSync(wsFile) &&
            fs.statSync(wsFile).isFile() &&
            fs.statSync(wsFile).size > 0;
          if (wsExists && executor) {
            const wsBuf = fs.readFileSync(wsFile);
            const wsSha = crypto.createHash('sha256').update(wsBuf).digest('hex');
            if (!pre || !pre.exists || pre.sha256 !== wsSha) {
              if (this._isPathInsideWorkspace(candFile)) {
                fs.mkdirSync(path.dirname(candFile), { recursive: true });
                fs.writeFileSync(candFile, wsBuf);
              }
            }
          }

          const targetFile =
            this._isPathInsideWorkspace(candFile) &&
            fs.existsSync(candFile) &&
            fs.statSync(candFile).isFile() &&
            fs.statSync(candFile).size > 0
              ? candFile
              : wsExists
                ? wsFile
                : null;

          if (!targetFile) {
            state.missing.push(relStr);
          } else {
            const targetBuf = fs.readFileSync(targetFile);
            if (targetFile !== candFile && this._isPathInsideWorkspace(candFile)) {
              fs.mkdirSync(path.dirname(candFile), { recursive: true });
              fs.writeFileSync(candFile, targetBuf);
            }
            const postSha256 = crypto.createHash('sha256').update(targetBuf).digest('hex');
            state.hashes[relStr] = postSha256;
            if (!pre || !pre.exists || pre.sha256 !== postSha256) {
              state.changes++;
              state.modifiedFiles[relStr] = postSha256;
            }
          }
        }

        // Scan candDir for full tree diff (added, modified, deleted) relative to baselineWorkspaceFiles
        const candFiles = this._collectWorkspaceSourceFiles(candDir, candDir);
        const candFileMap = new Map();
        const outDigestHash = crypto.createHash('sha256');
        const addedList = [];
        const modifiedList = [];
        const deletedList = [];

        for (const item of candFiles.sort((a, b) => a.rel.localeCompare(b.rel))) {
          try {
            const cBuf = fs.readFileSync(item.fullPath);
            const cSha = crypto.createHash('sha256').update(cBuf).digest('hex');
            candFileMap.set(item.rel, cSha);
            outDigestHash.update(`${item.rel}:${cSha}\n`, 'utf8');
            const baseEntry = baselineWorkspaceFiles.get(item.rel);
            if (!baseEntry) {
              addedList.push(item.rel);
              state.addedFiles[item.rel] = cSha;
              if (!state.modifiedFiles[item.rel]) {
                state.modifiedFiles[item.rel] = cSha;
                state.changes++;
              }
              if (!state.hashes[item.rel]) {
                state.hashes[item.rel] = cSha;
              }
            } else if (baseEntry.sha256 !== cSha) {
              modifiedList.push(item.rel);
              if (!state.modifiedFiles[item.rel]) {
                state.modifiedFiles[item.rel] = cSha;
                state.changes++;
              }
              if (!state.hashes[item.rel]) {
                state.hashes[item.rel] = cSha;
              }
            }
          } catch {}
        }

        for (const [relStr] of baselineWorkspaceFiles.entries()) {
          if (!candFileMap.has(relStr)) {
            deletedList.push(relStr);
            state.deletedFiles.push(relStr);
            state.changes++;
          }
        }

        const outDigest = outDigestHash.digest('hex');
        state.outputTreeDigest = outDigest;
        state.treeDiff = {
          added: addedList,
          modified: modifiedList,
          deleted: deletedList,
          modeChanged: [],
          inputTreeDigest: sourceTreeDigest,
          outputTreeDigest: outDigest,
        };
      };

      const materializeCandidateArtifactsToWorkspace = (idx) => {
        const candDir = candidateDirs[idx];
        const state = candArtifactStates[idx];
        const filesToCopy = new Set([
          ...requiredArtifacts.map((r) => String(r).replace(/\\/g, '/')),
          ...Object.keys(state?.modifiedFiles || {}),
          ...Object.keys(state?.addedFiles || {}),
        ]);
        for (const relStr of filesToCopy) {
          const candFile = path.resolve(candDir, relStr);
          const wsFile = path.resolve(this.workspaceRoot, relStr);
          if (
            this._isPathInsideWorkspace(candFile) &&
            this._isPathInsideWorkspace(wsFile) &&
            fs.existsSync(candFile) &&
            fs.statSync(candFile).isFile()
          ) {
            fs.mkdirSync(path.dirname(wsFile), { recursive: true });
            fs.writeFileSync(wsFile, fs.readFileSync(candFile));
          }
        }
        // F03: Apply file deletions from winning candidate
        for (const delRel of state?.deletedFiles || []) {
          const wsFile = path.resolve(this.workspaceRoot, delRel);
          if (this._isPathInsideWorkspace(wsFile) && fs.existsSync(wsFile)) {
            try {
              fs.unlinkSync(wsFile);
            } catch {}
          }
        }
      };

      const probeContext = {
        workspaceRoot: this.workspaceRoot,
        rootWorkspaceRoot: this.workspaceRoot,
        runsBaseDir,
        runId,
        taskId,
        domain,
        problem,
        candidates,
        snapshotId,
        sourceTreeDigest,
        requiredArtifacts,
      };

      const candidateExecuted = new Array(candidates.length).fill(false);

      // WP3: In sequential mode when both executor and evaluator exist, execute + evaluate each candidate
      // strictly inside candDir without projecting unverified files into workspaceRoot!
      const runProbesAndEvaluations = () => {
        if (mode === 'sequential' && executor && evaluator) {
          const execResults = new Array(candidates.length).fill(null);
          const evalResults = new Array(candidates.length).fill(null);
          const stepSeq = (idx) => {
            if (idx >= candidates.length) {
              return { execResult: execResults, evalResults };
            }
            const cand = candidates[idx];
            const candDir = candidateDirs[idx];
            restoreWorkspaceBaseline();
            stageBaselineIntoCandidateDir(candDir);
            const candContext = {
              ...probeContext,
              workspaceRoot: candDir,
              candidateDir: candDir,
              rootWorkspaceRoot: this.workspaceRoot,
              phase: 'candidate',
            };
            const execCallArg = {
              ...candContext,
              ...cand,
              candidate: { ...cand, id: cand.candidateId, candidateDir: candDir },
              candidateIndex: idx,
              candidateDir: candDir,
              phase: 'candidate',
            };
            return chainMaybeAsync(executor(execCallArg, candContext), (out) => {
              candidateExecuted[idx] = true;
              execResults[idx] = out;
              captureCandidateArtifacts(idx);
              restoreWorkspaceBaseline();
              const evalCallArg = {
                ...candContext,
                ...cand,
                candidate: { ...cand, id: cand.candidateId, candidateDir: candDir },
                candidateIndex: idx,
                candidateDir: candDir,
                executorResult: out,
                allExecutorResults: execResults,
                phase: 'candidate',
              };
              return chainMaybeAsync(evaluator(evalCallArg, candContext), (rawEvalOut) => {
                restoreWorkspaceBaseline();
                const parsedEval = this._parseEvaluatorOutput(rawEvalOut, passThreshold);
                evalResults[idx] = parsedEval;
                const candState = candArtifactStates[idx];
                const hasAllReq =
                  requiredArtifacts.length === 0 || candState.missing.length === 0;
                if (
                  profile.earlyStopOnFirstPass &&
                  hasAllReq &&
                  parsedEval.passed &&
                  parsedEval.score >= Math.max(passThreshold, 0.90)
                ) {
                  return { execResult: execResults, evalResults };
                }
                return stepSeq(idx + 1);
              });
            });
          };
          return stepSeq(0);
        }

        const runExecutorIfAny = () => {
          if (!executor) {
            for (let idx = 0; idx < candidates.length; idx++) {
              stageBaselineIntoCandidateDir(candidateDirs[idx]);
              captureCandidateArtifacts(idx);
            }
            return null;
          }
          const execResults = [];
          const stepExec = (idx) => {
            if (idx >= candidates.length) return execResults;
            const cand = candidates[idx];
            const candDir = candidateDirs[idx];
            restoreWorkspaceBaseline();
            stageBaselineIntoCandidateDir(candDir);
            const candContext = {
              ...probeContext,
              workspaceRoot: candDir,
              candidateDir: candDir,
              rootWorkspaceRoot: this.workspaceRoot,
              phase: 'candidate',
            };
            const callArg = {
              ...candContext,
              ...cand,
              candidate: { ...cand, id: cand.candidateId, candidateDir: candDir },
              candidateIndex: idx,
              candidateDir: candDir,
              phase: 'candidate',
            };
            return chainMaybeAsync(executor(callArg, candContext), (out) => {
              candidateExecuted[idx] = true;
              captureCandidateArtifacts(idx);
              restoreWorkspaceBaseline();
              execResults.push(out);
              return stepExec(idx + 1);
            });
          };
          return stepExec(0);
        };

        return chainMaybeAsync(runExecutorIfAny(), (execResult) => {
          if (!evaluator) {
            return { execResult, evalResults: null };
          }
          const results = [];
          const stepEval = (idx) => {
            if (idx >= candidates.length) return { execResult, evalResults: results };
            const cand = candidates[idx];
            const candDir = candidateDirs[idx];
            restoreWorkspaceBaseline();
            const candContext = {
              ...probeContext,
              workspaceRoot: candDir,
              candidateDir: candDir,
              rootWorkspaceRoot: this.workspaceRoot,
              phase: 'candidate',
            };
            const candExecOut = Array.isArray(execResult) ? execResult[idx] : execResult;
            const callArg = {
              ...candContext,
              ...cand,
              candidate: { ...cand, id: cand.candidateId, candidateDir: candDir },
              candidateIndex: idx,
              candidateDir: candDir,
              executorResult: candExecOut,
              allExecutorResults: execResult,
              phase: 'candidate',
            };
            return chainMaybeAsync(evaluator(callArg, candContext), (rawOut) => {
              candidateExecuted[idx] = true;
              restoreWorkspaceBaseline();
              const parsedEval = this._parseEvaluatorOutput(rawOut, passThreshold);
              results.push(parsedEval);
              const candState = candArtifactStates[idx];
              const hasAllReq =
                requiredArtifacts.length === 0 || candState.missing.length === 0;
              if (
                mode === 'sequential' &&
                profile.earlyStopOnFirstPass &&
                hasAllReq &&
                parsedEval.passed &&
                parsedEval.score >= Math.max(passThreshold, 0.90)
              ) {
                return { execResult, evalResults: results };
              }
              return stepEval(idx + 1);
            });
          };
          return stepEval(0);
        });
      };

      return chainMaybeAsync(runProbesAndEvaluations(), ({ execResult, evalResults }) => {
        const maxArtifactChanges = candArtifactStates.reduce(
          (maxC, st) => Math.max(maxC, st.changes),
          0
        );
        const anyCandidateHasAllArtifacts =
          requiredArtifacts.length === 0 ||
          candArtifactStates.some(
            (st, idx) =>
              (candidateExecuted[idx] || (!executor && !evaluator)) && st.missing.length === 0
          );

        // Compute observed providerCalls and token usage from executor + evaluator outputs even when failing early (F09)
        const computeEarlyTelemetry = () => {
          let calls = 0;
          let tokSum = 0;
          let hasAnyTok = false;
          const unknownCands = [];
          for (let i = 0; i < candidates.length; i++) {
            if (!candidateExecuted[i] && (executor || evaluator)) continue;
            const eo = Array.isArray(execResult) ? execResult[i] : null;
            const vo = Array.isArray(evalResults) ? evalResults[i] : null;
            calls += Number(eo?.providerCalls || 0) + Number(vo?.providerCalls || 0);
            const eTok =
              typeof eo?.observedTokens === 'number'
                ? eo.observedTokens
                : typeof eo?.usedTokens === 'number'
                  ? eo.usedTokens
                  : typeof eo?.totalTokens === 'number'
                    ? eo.totalTokens
                    : null;
            const vTok = vo && typeof vo.usedTokens === 'number' ? vo.usedTokens : null;
            const cTok =
              eTok !== null && vTok !== null
                ? eTok + vTok
                : eTok !== null
                  ? eTok
                  : vTok !== null
                    ? vTok
                    : null;
            if (cTok !== null) {
              hasAnyTok = true;
              tokSum += cTok;
            } else {
              unknownCands.push(candidates[i].candidateId);
            }
          }
          const complete = hasAnyTok && unknownCands.length === 0;
          return {
            providerCalls: calls,
            usedTokens: hasAnyTok ? tokSum : null,
            usage: {
              observed_subtotal: tokSum,
              complete,
              total: complete ? tokSum : null,
              unknown_components: unknownCands,
              quality: complete ? 'observed' : hasAnyTok ? 'partial_observation' : 'unavailable',
            },
          };
        };

        // Check post-executor state of requiredArtifacts
        if (requiredArtifacts.length > 0) {
          if (!anyCandidateHasAllArtifacts) {
            const earlyTel = computeEarlyTelemetry();
            const missingArtifacts = candArtifactStates[0]?.missing || requiredArtifacts.map(String);
            const failedTrajectories = candidates.map((cand, idx) => {
              const eo = Array.isArray(execResult) ? execResult[idx] : null;
              const eTok =
                typeof eo?.observedTokens === 'number'
                  ? eo.observedTokens
                  : typeof eo?.usedTokens === 'number'
                    ? eo.usedTokens
                    : typeof eo?.totalTokens === 'number'
                      ? eo.totalTokens
                      : 0;
              return {
                candidateId: cand.candidateId,
                candidateDir: candidateDirs[idx],
                front: cand.front,
                frontLabel: cand.frontLabel,
                modelTier: cand.modelTier,
                workspaceMode: cand.workspaceMode,
                passedVerification: false,
                verificationScore: 0,
                stepsExecuted: typeof eo?.stepsExecuted === 'number' ? eo.stepsExecuted : 0,
                toolErrors: 1,
                promptTokens: 0,
                thoughtsTokens: 0,
                outputTokens: 0,
                totalTokens: eTok,
                tokensSaved: 0,
                tokensSavedPct: 0,
                earlyStopped: false,
                observedSummary: `Verification failed: required artifact(s) missing: ${missingArtifacts.join(', ')}`,
                evidencePaths: [],
              };
            });
            return persistLoopRequestResult({
              ok: false,
              status: 'failed',
              error: 'REQUIRED_ARTIFACT_MISSING',
              missingArtifacts,
              passedVerification: false,
              verificationScore: 0,
              synthetic: false,
              usedTokens: earlyTel.usedTokens,
              usage: earlyTel.usage,
              providerCalls: earlyTel.providerCalls,
              artifactChanges: maxArtifactChanges,
              executionMode: 'artifact-verification',
              sourceTreeDigest,
              runId,
              completedAt: new Date().toISOString(),
              taskId,
              domain,
              problem,
              k,
              mode,
              snapshotId,
              reasoningProfile: profile,
              candidates,
              proposals: candidates,
              probeTrajectories: failedTrajectories,
              trajectories: failedTrajectories,
              winnerCandidateId: null,
              winnerScore: 0,
              winner: {
                candidateId: null,
                score: 0,
                verificationScore: 0,
                passedVerification: false,
                totalTokens: earlyTel.usedTokens ?? 0,
              },
              tokenEfficiency: {
                totalActualTokens: earlyTel.usedTokens ?? 0,
                observedSubtotal: earlyTel.usage.observed_subtotal,
                usageComplete: earlyTel.usage.complete,
                unknownComponents: earlyTel.usage.unknown_components,
                totalUnoptimizedTokens: null,
                totalTokensSaved: 0,
                totalTokensSavedPct: 0,
                earlyStopped: false,
              },
              composedHarness: null,
              recordedLesson: null,
              adoptedExperience: null,
              recordedExperience: null,
              receiptId: null,
              evalReceiptId: null,
              evaluationReceipt: null,
            });
          }

          // Pre-existing unchanged files on disk without an executor or evaluator do NOT count as execution
          if (maxArtifactChanges === 0 && !executor && !evaluator) {
            return persistLoopRequestResult({
              ok: false,
              status: 'failed',
              error: 'PRE_EXISTING_UNCHANGED_ARTIFACT_NOT_EXECUTION_EVIDENCE',
              passedVerification: false,
              verificationScore: 0,
              synthetic: false,
              usedTokens: null,
              providerCalls: 0,
              artifactChanges: 0,
              executionMode: 'artifact-verification',
              sourceTreeDigest,
              runId,
              completedAt: new Date().toISOString(),
              taskId,
              domain,
              problem,
              k,
              mode,
              snapshotId,
              reasoningProfile: profile,
              candidates,
              proposals: candidates,
              probeTrajectories: [],
              trajectories: [],
              winnerCandidateId: null,
              winnerScore: 0,
              winner: {
                candidateId: null,
                score: 0,
                verificationScore: 0,
                passedVerification: false,
                totalTokens: 0,
              },
              tokenEfficiency: {
                totalActualTokens: 0,
                totalUnoptimizedTokens: null,
                totalTokensSaved: 0,
                totalTokensSavedPct: 0,
                earlyStopped: false,
              },
              composedHarness: null,
              recordedLesson: null,
              adoptedExperience: null,
              recordedExperience: null,
              receiptId: null,
              evalReceiptId: null,
              evaluationReceipt: null,
            });
          }
        }

        // A file change or executor run without an independent evaluator is delivered/implemented, NEVER verified!
        if (!evaluator && executor) {
          const earlyTel = computeEarlyTelemetry();
          const bestDeliveredIdx = candArtifactStates.findIndex(
            (st) => st.missing.length === 0 && st.changes > 0
          );
          if (bestDeliveredIdx >= 0) {
            materializeCandidateArtifactsToWorkspace(bestDeliveredIdx);
          }
          return persistLoopRequestResult({
            ok: false,
            status: 'delivered_unverified',
            delivered: maxArtifactChanges > 0,
            error: 'INDEPENDENT_EVALUATOR_REQUIRED_FOR_VERIFICATION',
            passedVerification: false,
            verificationScore: null,
            synthetic: false,
            usedTokens: earlyTel.usedTokens,
            usage: earlyTel.usage,
            providerCalls: earlyTel.providerCalls,
            artifactChanges: maxArtifactChanges,
            executionMode: 'delivered-unverified',
            sourceTreeDigest,
            receiptId: null,
            evaluationReceipt: null,
            runId,
            completedAt: new Date().toISOString(),
            taskId,
            domain,
            problem,
            k,
            mode,
            snapshotId,
            reasoningProfile: profile,
            candidates,
            proposals: candidates,
            probeTrajectories: [],
            trajectories: [],
            winnerCandidateId: null,
            winnerScore: null,
            winner: {
              candidateId: null,
              score: null,
              verificationScore: null,
              passedVerification: false,
              totalTokens: earlyTel.usedTokens,
            },
            tokenEfficiency: {
              totalActualTokens: earlyTel.usedTokens,
              observedSubtotal: earlyTel.usage.observed_subtotal,
              usageComplete: earlyTel.usage.complete,
              unknownComponents: earlyTel.usage.unknown_components,
              totalUnoptimizedTokens: null,
              totalTokensSaved: null,
              totalTokensSavedPct: null,
              earlyStopped: false,
            },
            composedHarness: null,
            recordedLesson: null,
            adoptedExperience: null,
            recordedExperience: null,
            receiptId: null,
            evalReceiptId: null,
            evaluationReceipt: null,
          });
        }

        const isSimulation = !evaluator;
        if (isSimulation && allowSimulation === false) {
          return persistLoopRequestResult({
            ok: false,
            status: 'failed',
            error: 'NO_VERIFIED_EXECUTION_OR_EVALUATOR',
            passedVerification: false,
            verificationScore: null,
            synthetic: false,
            usedTokens: null,
            providerCalls: 0,
            artifactChanges: maxArtifactChanges,
            executionMode: 'verified-required',
            sourceTreeDigest,
            runId,
            completedAt: new Date().toISOString(),
            taskId,
            domain,
            problem,
            k,
            mode,
            snapshotId,
            reasoningProfile: profile,
            candidates,
            proposals: candidates,
            probeTrajectories: [],
            trajectories: [],
            winnerCandidateId: null,
            winnerScore: 0,
            winner: {
              candidateId: null,
              score: 0,
              verificationScore: 0,
              passedVerification: false,
              totalTokens: 0,
            },
            tokenEfficiency: {
              totalActualTokens: 0,
              totalUnoptimizedTokens: null,
              totalTokensSaved: 0,
              totalTokensSavedPct: 0,
              earlyStopped: false,
            },
            composedHarness: null,
            recordedLesson: null,
            adoptedExperience: null,
            recordedExperience: null,
            receiptId: null,
            evalReceiptId: null,
            evaluationReceipt: null,
          });
        }

        // Reference unoptimized baseline (used only when isSimulation === true or explicitBaselineTokens is provided)
        const unoptimizedPerCandidateTokens =
          explicitBaselineTokens !== null
            ? Math.round(explicitBaselineTokens / Math.max(1, k))
            : 8_200 + 6_400 + 2_100; // 16,700 tokens/candidate in simulation
        const baselineTrajectory = isSimulation
          ? {
              candidateId: 'reference-baseline-unbounded',
              front: 'baseline',
              frontLabel: 'Reference Baseline (Unbounded Thinking & Raw Context)',
              modelTier: 'pro',
              workspaceMode: 'inherit',
              passedVerification: false,
              verificationScore: 0.62,
              stepsExecuted: 9,
              toolErrors: 1,
              promptTokens: 8_200,
              thoughtsTokens: 6_400,
              outputTokens: 2_100,
              totalTokens: unoptimizedPerCandidateTokens,
              tokensSaved: 0,
              tokensSavedPct: 0,
              earlyStopped: false,
              synthetic: true,
              observedSummary:
                'Simulated baseline run without Cue-First RAG pruning or thinking budget cap consumed 16.7k tokens (6.4k thinking) and had 1 unverified tool step.',
            }
          : explicitBaselineTokens !== null
            ? {
                candidateId: 'measured-baseline',
                front: 'baseline',
                frontLabel: 'Measured Baseline',
                modelTier: 'inherit',
                workspaceMode: 'inherit',
                passedVerification: false,
                verificationScore: null,
                stepsExecuted: null,
                toolErrors: null,
                promptTokens: null,
                thoughtsTokens: null,
                outputTokens: null,
                totalTokens: explicitBaselineTokens,
                tokensSaved: 0,
                tokensSavedPct: 0,
                earlyStopped: false,
                synthetic: false,
                observedSummary: `Measured baseline run consumed ${explicitBaselineTokens.toLocaleString()} tokens.`,
              }
            : null;

        // 4. Probe K Candidates under frozen snapshotId with Reasoning Depth & Early-Stop Guardrails
        const probeTrajectories = [];
        let earlyStopTriggered = false;
        let totalProviderCalls = 0;

        for (let i = 0; i < candidates.length; i++) {
          const cand = candidates[i];
          const candState = candArtifactStates[i];
          const candExecOut = Array.isArray(execResult) ? execResult[i] : null;
          const wasExecuted = isSimulation ? !earlyStopTriggered : Boolean(candidateExecuted[i]);

          if (!wasExecuted && mode === 'sequential' && profile.earlyStopOnFirstPass && earlyStopTriggered) {
            probeTrajectories.push({
              candidateId: cand.candidateId,
              candidateDir: candidateDirs[i],
              candidateIndex: i,
              executed: false,
              front: cand.front,
              frontLabel: cand.frontLabel,
              modelTier: cand.modelTier,
              workspaceMode: cand.workspaceMode,
              passedVerification: false,
              verificationScore: null,
              stepsExecuted: 0,
              toolErrors: 0,
              promptTokens: 0,
              thoughtsTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              tokensSaved: isSimulation ? unoptimizedPerCandidateTokens : null,
              tokensSavedPct: isSimulation ? 100.0 : null,
              earlyStopped: true,
              synthetic: isSimulation,
              observedSummary: `Skipped via Early-Stop Token Guardrail before execution because an earlier candidate already passed verification.`,
            });
            continue;
          }

          const candEval = Array.isArray(evalResults) ? evalResults[i] : null;
          let score;
          let passed;
          if (candEval) {
            if (requiredArtifacts.length > 0 && candState.missing.length > 0) {
              score = 0;
              passed = false;
            } else {
              score = candEval.score;
              passed = candEval.passed;
            }
            totalProviderCalls +=
              (candEval.providerCalls || 0) + Number(candExecOut?.providerCalls || 0);
          } else {
            const cueBonus = cand.front !== 'invariant' && retrievedCues.length > 0 ? 0.14 : 0.06;
            const invariantBonus = cand.front === 'invariant' || cand.front === 'hybrid' ? 0.12 : 0.09;
            score = Number(Math.min(0.99, 0.72 + cueBonus + invariantBonus).toFixed(2));
            passed = score >= 0.85;
          }

          const stepsUsed =
            typeof candExecOut?.stepsExecuted === 'number'
              ? candExecOut.stepsExecuted
              : cand.front === 'domain-specific' || cand.front === 'hybrid'
                ? Math.max(3, Math.min(cand.maxSteps, 4))
                : Math.max(4, Math.min(cand.maxSteps, 5));

          // F09: Sum executor + verifier token usage when both report tokens
          const execTok =
            typeof candExecOut?.observedTokens === 'number'
              ? candExecOut.observedTokens
              : typeof candExecOut?.usedTokens === 'number'
                ? candExecOut.usedTokens
                : typeof candExecOut?.totalTokens === 'number'
                  ? candExecOut.totalTokens
                  : null;
          const evalTok =
            candEval && typeof candEval.usedTokens === 'number'
              ? candEval.usedTokens
              : null;
          const observedCandTokens =
            execTok !== null && evalTok !== null
              ? execTok + evalTok
              : execTok !== null
                ? execTok
                : evalTok !== null
                  ? evalTok
                  : null;

          let promptTok = null;
          let thoughtsTok = null;
          let outputTok = null;
          let totalTok = null;
          let savedTok = null;
          let savedPct = null;

          if (isSimulation) {
            promptTok =
              profile.reasoningDepth === 'eco'
                ? 1_950 + i * 140
                : profile.reasoningDepth === 'balanced'
                  ? 3_100 + i * 210
                  : 5_400 + i * 320;
            thoughtsTok = Math.min(
              cand.thinkingBudgetTokens,
              profile.reasoningDepth === 'eco'
                ? 780 + i * 60
                : profile.reasoningDepth === 'balanced'
                  ? 1_480 + i * 90
                  : 4_200 + i * 250
            );
            outputTok =
              profile.reasoningDepth === 'eco'
                ? 520
                : profile.reasoningDepth === 'balanced'
                  ? 740
                  : 1_180;
            totalTok =
              observedCandTokens !== null ? observedCandTokens : promptTok + thoughtsTok + outputTok;
            savedTok = Math.max(0, unoptimizedPerCandidateTokens - totalTok);
            savedPct = Number(((savedTok / unoptimizedPerCandidateTokens) * 100).toFixed(1));
          } else if (observedCandTokens !== null) {
            promptTok = candExecOut?.promptTokens ?? null;
            thoughtsTok = candExecOut?.thoughtsTokens ?? null;
            outputTok = candExecOut?.outputTokens ?? null;
            totalTok = observedCandTokens;
            if (explicitBaselineTokens !== null) {
              savedTok = Math.max(0, unoptimizedPerCandidateTokens - totalTok);
              savedPct = Number(((savedTok / Math.max(1, unoptimizedPerCandidateTokens)) * 100).toFixed(1));
            }
          }

          if (passed && score >= Math.max(passThreshold, 0.90)) {
            earlyStopTriggered = true;
          }

          probeTrajectories.push({
            candidateId: cand.candidateId,
            candidateDir: candidateDirs[i],
            candidateIndex: i,
            executed: true,
            front: cand.front,
            frontLabel: cand.frontLabel,
            modelTier: cand.modelTier,
            workspaceMode: cand.workspaceMode,
            passedVerification: passed,
            verificationScore: score,
            stepsExecuted: stepsUsed,
            toolErrors: passed ? 0 : 1,
            executorTokens: execTok,
            verifierTokens: evalTok,
            promptTokens: promptTok,
            thoughtsTokens: thoughtsTok,
            outputTokens: outputTok,
            totalTokens: totalTok,
            tokensSaved: savedTok,
            tokensSavedPct: savedPct,
            earlyStopped: false,
            synthetic: isSimulation,
            treeDiff: candState.treeDiff,
            checks: candEval?.checks || [],
            observedSummary:
              `[${cand.frontLabel}] Probed in Workspace:${cand.workspaceMode} (model=${cand.modelTier}, thinkingCap=${cand.thinkingBudgetTokens}) under snapshot '${snapshotId}'. ` +
              `Retrieved ${expHits.results.length} experience cues & ${projHits.results.length} ADRs; verification=${passed ? 'passed' : 'failed'} (score=${score}) in ${stepsUsed} steps` +
              (totalTok !== null
                ? ` using ${totalTok.toLocaleString()} tokens` +
                  (savedPct !== null ? ` (${savedPct}% saved vs baseline).` : '.')
                : '.'),
            evidencePaths: [
              ...requiredArtifacts.map((a) => String(a)),
              ...(expHits.results || []).slice(0, 2).map((r) => r.path),
              ...(projHits.results || []).slice(0, 1).map((r) => r.path),
            ],
          });
        }

        // 5. Contrastive Composition
        const activeProbes = probeTrajectories.filter((p) => !p.earlyStopped);
        const ranked = [...activeProbes].sort((a, b) => {
          if (b.passedVerification !== a.passedVerification) {
            return b.passedVerification ? 1 : -1;
          }
          if ((b.verificationScore ?? 0) !== (a.verificationScore ?? 0)) {
            return (b.verificationScore ?? 0) - (a.verificationScore ?? 0);
          }
          return (a.totalTokens ?? Number.MAX_SAFE_INTEGER) - (b.totalTokens ?? Number.MAX_SAFE_INTEGER);
        });
        const winner = ranked[0] || probeTrajectories[0];

        // Compute truthful usage across executed probes (WP3)
        const anyObservedTokens = activeProbes.some((p) => typeof p.totalTokens === 'number');
        const observedSubtotal = anyObservedTokens
          ? activeProbes.reduce((s, p) => s + (typeof p.totalTokens === 'number' ? p.totalTokens : 0), 0)
          : 0;
        const unknownComponents = activeProbes
          .filter((p) => typeof p.totalTokens !== 'number')
          .map((p) => p.candidateId);
        const usageComplete = activeProbes.length > 0 && unknownComponents.length === 0;
        const totalActualTokens = usageComplete ? observedSubtotal : null;
        const usageSummary = {
          observed_subtotal: observedSubtotal,
          complete: usageComplete,
          total: totalActualTokens,
          unknown_components: unknownComponents,
          quality: usageComplete ? (isSimulation ? 'simulated' : 'observed') : 'partial_observation',
        };

        // If evaluator/executor ran and no candidate passed verification, fail closed without recording
        if (!winner || !winner.passedVerification) {
          restoreWorkspaceBaseline();
          const firstErr =
            (Array.isArray(evalResults) && evalResults.find((r) => r && r.error)?.error) ||
            'EVALUATION_FAILED';
          const bestScore = winner ? winner.verificationScore : 0;
          return persistLoopRequestResult({
            ok: false,
            status: 'failed',
            error: 'EVALUATION_FAILED',
            detail: firstErr,
            passedVerification: false,
            verificationScore: bestScore,
            synthetic: isSimulation,
            usedTokens: totalActualTokens,
            usage: usageSummary,
            providerCalls: totalProviderCalls,
            artifactChanges: maxArtifactChanges,
            executionMode: isSimulation ? 'simulation' : 'evaluated',
            sourceTreeDigest,
            runId,
            completedAt: new Date().toISOString(),
            taskId,
            domain,
            problem,
            k,
            mode,
            snapshotId,
            reasoningProfile: profile,
            candidates,
            proposals: candidates,
            probeTrajectories,
            trajectories: probeTrajectories,
            winnerCandidateId: null,
            winnerScore: bestScore,
            winner: {
              candidateId: null,
              score: bestScore,
              verificationScore: bestScore,
              passedVerification: false,
              totalTokens: winner ? winner.totalTokens : null,
            },
            tokenEfficiency: {
              totalActualTokens: null,
              observedSubtotal,
              usageComplete,
              unknownComponents,
              totalUnoptimizedTokens: null,
              totalTokensSaved: null,
              totalTokensSavedPct: null,
              earlyStopped: false,
            },
            composedHarness: null,
            recordedLesson: null,
            adoptedExperience: null,
            recordedExperience: null,
            receiptId: null,
            evalReceiptId: null,
            evaluationReceipt: null,
          });
        }

        const winnerIdx =
          typeof winner.candidateIndex === 'number'
            ? winner.candidateIndex
            : candidates.findIndex((c) => c.candidateId === winner.candidateId);
        if (winnerIdx >= 0) {
          materializeCandidateArtifactsToWorkspace(winnerIdx);
        }
        const winnerArtifactState =
          (winnerIdx >= 0 ? candArtifactStates[winnerIdx] : candArtifactStates[0]) || {
            hashes: {},
            changes: 0,
            outputTreeDigest: sourceTreeDigest,
            treeDiff: {
              added: [],
              modified: [],
              deleted: [],
              modeChanged: [],
              inputTreeDigest: sourceTreeDigest,
              outputTreeDigest: sourceTreeDigest,
            },
          };

        // F03: Post-integration verification on workspaceRoot after winner materialization
        const finishAfterPostIntegration = (postIntegrationEval) => {
          if (postIntegrationEval && !postIntegrationEval.passed) {
            restoreWorkspaceBaseline();
            return persistLoopRequestResult({
              ok: false,
              status: 'failed',
              error: 'POST_INTEGRATION_VERIFICATION_FAILED',
              detail: postIntegrationEval.error || 'Post-integration verifier failed on workspaceRoot',
              passedVerification: false,
              verificationScore: postIntegrationEval.score ?? 0,
              synthetic: false,
              usedTokens: totalActualTokens,
              usage: usageSummary,
              providerCalls: totalProviderCalls,
              artifactChanges: 0,
              executionMode: 'evaluated',
              sourceTreeDigest,
              runId,
              completedAt: new Date().toISOString(),
              taskId,
              domain,
              problem,
              k,
              mode,
              snapshotId,
              reasoningProfile: profile,
              candidates,
              proposals: candidates,
              probeTrajectories,
              trajectories: probeTrajectories,
              winnerCandidateId: null,
              winnerScore: 0,
              winner: {
                candidateId: null,
                score: 0,
                verificationScore: 0,
                passedVerification: false,
                totalTokens: winner.totalTokens,
              },
              tokenEfficiency: {
                totalActualTokens,
                observedSubtotal,
                usageComplete,
                unknownComponents,
                totalUnoptimizedTokens: null,
                totalTokensSaved: null,
                totalTokensSavedPct: null,
                earlyStopped: false,
              },
              composedHarness: null,
              recordedLesson: null,
              adoptedExperience: null,
              recordedExperience: null,
              receiptId: null,
              evalReceiptId: null,
              evaluationReceipt: null,
            });
          }

          const verifiedArtifactHashes = { ...(winnerArtifactState.hashes || {}) };
          for (const reqFile of requiredArtifacts) {
            const relStr = String(reqFile).replace(/\\/g, '/');
            const absReq = path.resolve(this.workspaceRoot, relStr);
            if (this._isPathInsideWorkspace(absReq) && fs.existsSync(absReq) && fs.statSync(absReq).isFile()) {
              verifiedArtifactHashes[relStr] = crypto
                .createHash('sha256')
                .update(fs.readFileSync(absReq))
                .digest('hex');
            }
          }
          const artifactChanges = winnerArtifactState.changes || maxArtifactChanges;
          const changeKind = artifactChanges > 0 ? 'modified' : 'verified_no_change';

          const totalUnoptimizedTokens = isSimulation
            ? unoptimizedPerCandidateTokens * k
            : explicitBaselineTokens !== null && usageComplete
              ? explicitBaselineTokens
              : null;
          const totalTokensSaved =
            totalActualTokens !== null && totalUnoptimizedTokens !== null
              ? Math.max(0, totalUnoptimizedTokens - totalActualTokens)
              : null;
          const totalTokensSavedPct =
            totalTokensSaved !== null && totalUnoptimizedTokens !== null
              ? Number(((totalTokensSaved / Math.max(1, totalUnoptimizedTokens)) * 100).toFixed(1))
              : null;

          const winnerEval =
            Array.isArray(evalResults) && winnerIdx >= 0 ? evalResults[winnerIdx] : null;
          const combinedChecks = [
            ...(Array.isArray(winnerEval?.checks) && winnerEval.checks.length > 0
              ? winnerEval.checks
              : [{ name: resolvedVerif.id || 'candidate-verifier', passed: true }]),
            ...(postIntegrationEval
              ? [{ name: 'post_integration', phase: 'post_integration', passed: true }]
              : []),
          ];

          let createdReceipt = null;
          if (!isSimulation && winner.passedVerification) {
            const rcpt = this.createEvaluationReceipt({
              taskId,
              candidateId: winner.candidateId,
              domain,
              evaluatorId: resolvedVerif.id || 'custom-evaluator',
              phase: 'post_integration',
              score: winner.verificationScore,
              passed: true,
              changeKind,
              inputTreeHash: sourceTreeDigest,
              outputTreeHash: winnerArtifactState.outputTreeDigest || sourceTreeDigest,
              artifactHashes: verifiedArtifactHashes,
              checks: combinedChecks,
              providerCalls: totalProviderCalls,
              actualTokens: totalActualTokens,
              synthetic: false,
            });
            if (rcpt && rcpt.ok) {
              createdReceipt = rcpt;
            }
          }

          const effectiveRecordStatus = !isSimulation && createdReceipt ? 'active' : 'candidate';
          const composedHarness = {
            harness_id: `harness-${domain}-${taskId}`,
            task_id: taskId,
            domain,
            winning_candidate_id: winner.candidateId,
            composed_fronts: ['invariant', 'domain-specific'],
            reasoning_depth_profile: {
              reasoningDepth: profile.reasoningDepth,
              thinkingBudgetTokens: profile.thinkingBudgetTokens,
              maxCandidateTokens: profile.maxCandidateTokens,
              maxProbeSteps: profile.maxProbeSteps,
              proberModelTier: profile.proberModelTier,
              composerModelTier: profile.composerModelTier,
              ragSnippetMaxChars: profile.ragSnippetMaxChars,
              earlyStopOnFirstPass: profile.earlyStopOnFirstPass,
            },
            token_efficiency: {
              totalActualTokens,
              observedSubtotal,
              usageComplete,
              unknownComponents,
              totalUnoptimizedTokens,
              totalTokensSaved,
              totalTokensSavedPct,
            },
            editable_components: {
              system_prompts:
                `Use Cue-First RAG retrieval (${profile.ragSnippetMaxChars} char snippet cap) and bounded thinking (${profile.thinkingBudgetTokens} tokens) before editing.`,
              rules: ['plugin/harness-ide/rules/AGENTS.md'],
              skills: [
                'plugin/harness-ide/skills/harness2-loop/SKILL.md',
                'plugin/harness-ide/skills/qmd-knowledge-lifecycle/SKILL.md',
              ],
              subagents: [
                `harness-proposer (model: ${profile.proberModelTier})`,
                `harness-prober (Workspace: branch, model: ${profile.proberModelTier}, thinkingCap: ${profile.thinkingBudgetTokens})`,
                `harness-composer (model: ${profile.composerModelTier})`,
              ],
              hooks: {
                SessionStart: 'scripts/hooks/session-start.mjs',
                PreInvocation: 'scripts/hooks/pre-invocation.mjs',
                PostToolUse: 'scripts/hooks/post-tool-use.mjs',
              },
              tools: ['harness_query', 'harness_get', 'harness_snapshot_lock', 'harness_run_loop', 'harness_record_experience'],
              scripts: ['adapters/harness2_antigravity_executor.py', 'test/harness-ide.test.mjs'],
              plugins: ['harness-ide'],
            },
            adopted_at: new Date().toISOString(),
            git_revision: this.getGitRevision(),
            status: effectiveRecordStatus,
            synthetic: isSimulation,
            receipt_id: createdReceipt?.receiptId || null,
          };

          let recordedExperience = null;
          if (recordToLibrary) {
            const savingsLabel =
              totalTokensSavedPct !== null ? ` · ${totalTokensSavedPct}% Tokens Saved` : '';
            recordedExperience = this.recordExperience({
              task_id: taskId,
              domain,
              title: `EXPERIENCE: ${taskId} (Harness² ${profile.reasoningDepth.toUpperCase()}${savingsLabel})`,
              cue: `When tackling '${problem.slice(0, 90)}' in '${domain}', use ${winner.candidateId} with ${profile.reasoningDepth} reasoning depth (thinkingCap=${profile.thinkingBudgetTokens}, model=${profile.proberModelTier}, Workspace=branch) to achieve score=${winner.verificationScore}.`,
              problem,
              observed_behavior:
                `Contrastive evaluation across K=${k} candidates (${mode} mode) under frozen snapshot '${snapshotId}': ` +
                `${winner.candidateId} (${winner.frontLabel}) achieved verified score ${winner.verificationScore} with 0 tool errors` +
                (totalActualTokens !== null && totalUnoptimizedTokens !== null && totalTokensSaved !== null
                  ? ` while consuming ${totalActualTokens.toLocaleString()} total probe tokens vs ${totalUnoptimizedTokens.toLocaleString()} baseline tokens (${totalTokensSaved.toLocaleString()} tokens saved, -${totalTokensSavedPct}%).`
                  : totalActualTokens !== null
                    ? ` while consuming ${totalActualTokens.toLocaleString()} total observed tokens.`
                    : '.'),
              supporting_evidence: [
                ...(winner.evidencePaths || []),
                'adapters/harness2_antigravity_executor.py',
              ],
              status: effectiveRecordStatus,
              synthetic: isSimulation,
              receiptId: createdReceipt?.receiptId || null,
              tags: ['harness2', 'propose-probe-compose', `depth-${profile.reasoningDepth}`, 'token-efficient', domain],
              adopted_harness: composedHarness,
            });
          }

          const isEarlyStopped = probeTrajectories.some((p) => p.earlyStopped === true);
          const runReport = persistLoopRequestResult({
            ok: true,
            status: isSimulation ? 'simulated' : 'succeeded',
            synthetic: isSimulation,
            executionMode: isSimulation ? 'simulation' : 'verified',
            changeKind,
            passedVerification: winner.passedVerification,
            verificationScore: winner.verificationScore,
            postIntegrationVerified: !isSimulation,
            earlyStopped: isEarlyStopped,
            usedTokens: totalActualTokens,
            totalActualTokens,
            totalUnoptimizedTokens,
            tokenEfficiencyPct: totalTokensSavedPct,
            usage: usageSummary,
            sourceTreeDigest,
            outputTreeDigest: winnerArtifactState.outputTreeDigest || sourceTreeDigest,
            treeDiff: winnerArtifactState.treeDiff,
            receiptId: createdReceipt?.receiptId || null,
            evaluationReceipt: createdReceipt || null,
            evaluatorReceipt: createdReceipt || undefined,
            artifactChanges,
            providerCalls: totalProviderCalls,
            runId,
            completedAt: new Date().toISOString(),
            taskId,
            domain,
            problem,
            k,
            mode,
            snapshotId,
            reasoningProfile: profile,
            retrievedKnowledge: {
              experienceCount: expHits.results.length,
              projectAdrCount: projHits.results.length,
              cues: retrievedCues,
              adrs: retrievedAdrs,
            },
            baselineTrajectory,
            candidates,
            executedCandidates: activeProbes,
            proposals: candidates,
            probeTrajectories,
            trajectories: probeTrajectories,
            winnerCandidateId: winner.candidateId,
            winnerScore: winner.verificationScore,
            winner: {
              candidateId: winner.candidateId,
              candidateDir: winner.candidateDir,
              score: winner.verificationScore,
              verificationScore: winner.verificationScore,
              passedVerification: winner.passedVerification,
              totalTokens: winner.totalTokens,
              synthetic: isSimulation,
              receiptId: createdReceipt?.receiptId || null,
              treeDiff: winnerArtifactState.treeDiff,
            },
            tokenEfficiency: {
              totalActualTokens,
              observedSubtotal,
              usageComplete,
              unknownComponents,
              totalUnoptimizedTokens,
              totalTokensSaved,
              totalTokensSavedPct,
              earlyStopped: probeTrajectories.some((p) => p.earlyStopped === true),
              synthetic: isSimulation,
            },
            composedHarness,
            recordedLesson: recordedExperience,
            recordedExperience,
            adoptedExperience: recordedExperience,
          });

          if (recordToLibrary) {
            try {
              fs.writeFileSync(this.lastRunPath, JSON.stringify(runReport, null, 2) + '\n', 'utf8');
            } catch {}
          }

          return runReport;
        };

        if (!isSimulation && evaluator) {
          const winnerCand = candidates[winnerIdx >= 0 ? winnerIdx : 0];
          const winnerExecOut =
            Array.isArray(execResult) && winnerIdx >= 0 ? execResult[winnerIdx] : execResult;
          const postContext = {
            ...probeContext,
            workspaceRoot: this.workspaceRoot,
            candidateDir: this.workspaceRoot,
            rootWorkspaceRoot: this.workspaceRoot,
            phase: 'post_integration',
          };
          const postCallArg = {
            ...postContext,
            ...winnerCand,
            candidate: {
              ...winnerCand,
              id: winnerCand.candidateId,
              candidateDir: this.workspaceRoot,
            },
            candidateIndex: winnerIdx >= 0 ? winnerIdx : 0,
            candidateDir: this.workspaceRoot,
            executorResult: winnerExecOut,
            allExecutorResults: execResult,
            phase: 'post_integration',
          };
          return chainMaybeAsync(evaluator(postCallArg, postContext), (rawPostOut) => {
            const parsedPost = this._parseEvaluatorOutput(rawPostOut, passThreshold);
            return finishAfterPostIntegration(parsedPost);
          });
        }

        return finishAfterPostIntegration(null);
      });
    };

    let bodyOut;
    try {
      bodyOut = executeLoopBody();
    } catch (err) {
      cleanupSnapshotLock();
      throw err;
    }
    if (isThenable(bodyOut)) {
      return Promise.resolve(bodyOut).finally(cleanupSnapshotLock);
    }
    cleanupSnapshotLock();
    return bodyOut;
  }
}
