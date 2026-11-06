import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

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
  const raw = String(text)
    .toLowerCase()
    .replace(/harness²/g, 'harness2')
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
  return tokens;
}

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

export class HarnessKnowledgeEngine {
  constructor(workspaceRoot = process.cwd()) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.harnessDir = path.join(this.workspaceRoot, '.harness');
    this.configPath = path.join(this.harnessDir, 'config.json');
    this.indexDir = path.join(this.harnessDir, 'index');
    this.indexFilePath = path.join(this.indexDir, 'local-rag-index.json');
    this.snapshotsDir = path.join(this.harnessDir, 'snapshots');
    this.activeLockPath = path.join(this.snapshotsDir, 'active.lock.json');
    this.runtimeDir = path.join(this.harnessDir, 'runtime');
    this.telemetryPath = path.join(this.runtimeDir, 'telemetry.json');
  }

  ensureDirectories() {
    const dirs = [
      this.harnessDir,
      this.indexDir,
      this.snapshotsDir,
      this.runtimeDir,
      path.join(this.harnessDir, 'knowledge', 'project'),
      path.join(this.harnessDir, 'knowledge', 'experiments'),
      path.join(this.harnessDir, 'knowledge', 'reference'),
      path.join(this.harnessDir, 'library')
    ];
    for (const d of dirs) {
      fs.mkdirSync(d, { recursive: true });
    }
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
          ragflow: { enabled: false, baseUrl: 'http://127.0.0.1:9380', apiKey: '' }
        }
      },
      externalDocs: {
        context7: { enabled: true, serverUrl: 'https://mcp.context7.com/mcp', apiKey: '' },
        googleDeveloperKnowledge: { enabled: false, serverUrl: 'https://developers.google.com/knowledge/mcp' }
      },
      harness2: {
        executionLevel: 'native-antigravity-swarm',
        defaultMode: 'parallel',
        defaultCandidatesK: 2,
        strictSnapshotIsolation: true,
        autoRecordExperiencePrompt: true
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

    return baseConfig;
  }

  saveConfig(partialConfig, saveGlobal = true) {
    this.ensureDirectories();
    const merged = this._deepMerge(this.loadConfig(), partialConfig);
    fs.writeFileSync(this.configPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    if (saveGlobal) {
      try {
        fs.mkdirSync(path.dirname(GLOBAL_SETTINGS_PATH), { recursive: true });
        fs.writeFileSync(GLOBAL_SETTINGS_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
      } catch {
        // Ignore if global config dir is read-only
      }
    }
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
    if (!fs.existsSync(dirPath)) return results;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'index') continue;
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
        const files = this._walkMarkdownFiles(absDir);
        for (const filePath of files) {
          const relFile = path.relative(this.workspaceRoot, filePath).replace(/\\/g, '/');
          const rawContent = fs.readFileSync(filePath, 'utf8');
          const stat = fs.statSync(filePath);

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
                created_at: jsonObj.adopted_at || stat.mtime.toISOString(),
                status: 'active',
                tags: ['harness-manifest', 'adopted-harness']
              };
              title = metadata.title;
            } catch {
              // Keep raw
            }
          }

          const docid =
            metadata.docid ||
            crypto.createHash('sha1').update(relFile).digest('hex').slice(0, 10).toUpperCase();
          const createdAt = metadata.created_at || stat.mtime.toISOString();
          const status = metadata.status || 'active';
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
          for (const uniqueTok of Object.keys(tf)) {
            dfMap[uniqueTok] = (dfMap[uniqueTok] || 0) + 1;
          }

          const boostTokens = tokenize(`${title} ${cue} ${tags.join(' ')}`, false);
          const vector = computeDenseVector(`${title}\n${cue}\n${headings}\n${body}`, boostTokens);

          const sections = this._extractSections(body, title);

          documents.push({
            docid,
            path: relFile,
            title,
            collection: metadata.collection || collectionName,
            domain,
            task_id: metadata.task_id || '',
            status,
            repo: metadata.repo || 'Harness2-RAG-antigravity',
            git_revision: metadata.git_revision || 'HEAD',
            created_at: createdAt,
            mtime_iso: stat.mtime.toISOString(),
            cue,
            tags,
            evidence_links: Array.isArray(metadata.evidence_links) ? metadata.evidence_links : [],
            sections,
            excerpt: body.replace(/^#+\s+.+$/gm, '').trim().slice(0, 360),
            tokenCount: tokens.length,
            tf,
            vector
          });
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
      return JSON.parse(fs.readFileSync(this.indexFilePath, 'utf8'));
    } catch {
      return this.buildIndex();
    }
  }

  getActiveSnapshotLock() {
    if (!fs.existsSync(this.activeLockPath)) {
      return null;
    }
    try {
      const lock = JSON.parse(fs.readFileSync(this.activeLockPath, 'utf8'));
      if (lock && lock.active) return lock;
      return null;
    } catch {
      return null;
    }
  }

  createSnapshotLock({
    domain = 'software-engineering',
    k = 2,
    mode = 'parallel',
    description = 'Harness2 candidate probe comparison lock',
    cutoffTimestamp = null
  } = {}) {
    this.ensureDirectories();
    const index = this.buildIndex();
    const cutoff = cutoffTimestamp || new Date().toISOString();
    const snapshotId = `SNAP-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto
      .randomBytes(2)
      .toString('hex')
      .toUpperCase()}`;

    const eligibleDocIds = index.documents
      .filter((d) => {
        if (d.status === 'candidate') return false;
        if (cutoffTimestamp && d.created_at > cutoffTimestamp) return false;
        return true;
      })
      .map((d) => d.docid);

    const lockPayload = {
      active: true,
      snapshotId,
      createdAt: new Date().toISOString(),
      cutoffTimestamp: cutoff,
      gitRevision: this.getGitRevision(),
      domain,
      k,
      mode,
      description,
      eligibleDocCount: eligibleDocIds.length,
      eligibleDocIds
    };

    fs.writeFileSync(
      path.join(this.snapshotsDir, `${snapshotId}.json`),
      JSON.stringify(lockPayload, null, 2),
      'utf8'
    );
    fs.writeFileSync(this.activeLockPath, JSON.stringify(lockPayload, null, 2), 'utf8');
    return lockPayload;
  }

  releaseSnapshotLock() {
    const current = this.getActiveSnapshotLock();
    if (fs.existsSync(this.activeLockPath)) {
      fs.unlinkSync(this.activeLockPath);
    }
    return {
      released: Boolean(current),
      previousLock: current
    };
  }

  listSnapshots() {
    this.ensureDirectories();
    const active = this.getActiveSnapshotLock();
    const files = fs
      .readdirSync(this.snapshotsDir)
      .filter((f) => f.startsWith('SNAP-') && f.endsWith('.json'));
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

  _resolveSnapshotFilter(snapshotIdParam) {
    const config = this.loadConfig();
    if (snapshotIdParam) {
      const snapFile = path.join(this.snapshotsDir, `${snapshotIdParam}.json`);
      if (fs.existsSync(snapFile)) {
        try {
          return JSON.parse(fs.readFileSync(snapFile, 'utf8'));
        } catch {
          // fallback
        }
      }
    }
    if (config.harness2?.strictSnapshotIsolation !== false) {
      return this.getActiveSnapshotLock();
    }
    return null;
  }

  _isDocEligibleForSnapshot(doc, snapLock, includeCandidates = false) {
    if (!snapLock) {
      if (!includeCandidates && doc.status === 'candidate') return false;
      return true;
    }
    if (doc.status === 'candidate') return false;
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
    include_candidates = false
  } = {}) {
    const index = this.loadOrBuildIndex();
    const snapLock = this._resolveSnapshotFilter(snapshot_id);
    let filteredBySnapshotCount = 0;

    const candidates = index.documents.filter((doc) => {
      if (!this._isDocEligibleForSnapshot(doc, snapLock, include_candidates)) {
        filteredBySnapshotCount++;
        return false;
      }
      if (collection && collection !== 'all' && doc.collection !== collection) return false;
      if (domain && domain !== 'all' && doc.domain !== domain && doc.domain !== 'all') return false;
      if (status && status !== 'all' && !include_candidates && doc.status !== status) return false;
      return true;
    });

    if (!queryText || !queryText.trim()) {
      return {
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
    const N = Math.max(1, index.totalDocuments || candidates.length);
    const avgLen = Math.max(1, index.avgDocLen || 100);
    const k1 = 1.5;
    const b = 0.75;

    const scored = candidates.map((doc) => {
      // 1. BM25 score
      let bm25 = 0;
      for (const qt of qTokens) {
        const tf = doc.tf?.[qt] || 0;
        if (tf > 0) {
          const df = index.dfMap?.[qt] || 1;
          const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
          const denom = tf + k1 * (1 - b + b * ((doc.tokenCount || 1) / avgLen));
          bm25 += idf * ((tf * (k1 + 1)) / denom);
        }
      }

      // 2. Semantic Vector cosine similarity
      const vecScore = Math.max(0, cosineSimilarity(qVec, doc.vector));

      // Best matching section snippet
      let bestSection = doc.sections?.[0] || { heading: doc.title, content: doc.excerpt };
      let bestSecOverlap = -1;
      for (const sec of doc.sections || []) {
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
        doc,
        bm25,
        vecScore,
        bestSection
      };
    });

    const byLex = [...scored].sort((a, bItem) => bItem.bm25 - a.bm25);
    const byVec = [...scored].sort((a, bItem) => bItem.vecScore - a.vecScore);

    const lexRankMap = new Map();
    const vecRankMap = new Map();
    byLex.forEach((item, i) => lexRankMap.set(item.doc.docid, i + 1));
    byVec.forEach((item, i) => vecRankMap.set(item.doc.docid, i + 1));

    const rrfK = 60;
    const finalResults = scored
      .map((item) => {
        const rLex = lexRankMap.get(item.doc.docid) || 999;
        const rVec = vecRankMap.get(item.doc.docid) || 999;
        const rrfScore = 1 / (rrfK + rLex) + 1 / (rrfK + rVec);
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
      .sort((a, bItem) => bItem.combinedScore - a.combinedScore)
      .slice(0, topK)
      .map((item) =>
        this._formatSearchResult(
          item.doc,
          item.combinedScore,
          item.bm25,
          item.vecScore,
          item.bestSection
        )
      );

    return {
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

  _formatSearchResult(doc, score, bm25, vecScore, bestSection) {
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
      matchedSection: bestSection
        ? {
            heading: bestSection.heading,
            snippet: String(bestSection.content || '').slice(0, 320)
          }
        : undefined
    };
  }

  getDocument(identifier, { snapshot_id = null, include_candidates = false } = {}) {
    const index = this.loadOrBuildIndex();
    const snapLock = this._resolveSnapshotFilter(snapshot_id);
    const normId = String(identifier || '').trim().replace(/\\/g, '/');

    const eligibleDocs = index.documents.filter((d) =>
      this._isDocEligibleForSnapshot(d, snapLock, include_candidates)
    );

    let match = eligibleDocs.find(
      (d) =>
        d.docid.toLowerCase() === normId.toLowerCase() ||
        d.path.toLowerCase() === normId.toLowerCase() ||
        d.path.toLowerCase().endsWith(normId.toLowerCase()) ||
        d.task_id.toLowerCase() === normId.toLowerCase()
    );

    if (!match) {
      const blockedMatch = index.documents.find(
        (d) =>
          d.docid.toLowerCase() === normId.toLowerCase() ||
          d.path.toLowerCase().endsWith(normId.toLowerCase())
      );
      if (blockedMatch && snapLock) {
        return {
          found: false,
          blockedBySnapshotLock: true,
          snapshotId: snapLock.snapshotId,
          cutoffTimestamp: snapLock.cutoffTimestamp,
          error: `Document '${identifier}' (${blockedMatch.docid}) is excluded by active Harness² Snapshot Isolation lock ${snapLock.snapshotId} (cutoff ${snapLock.cutoffTimestamp}).`
        };
      }
      const suggestions = eligibleDocs
        .map((d) => ({ docid: d.docid, path: d.path, title: d.title }))
        .slice(0, 5);
      return {
        found: false,
        error: `Document '${identifier}' not found.`,
        suggestions
      };
    }

    const absPath = path.resolve(this.workspaceRoot, match.path);
    const content = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : match.excerpt;

    return {
      found: true,
      docid: match.docid,
      title: match.title,
      path: match.path,
      collection: match.collection,
      domain: match.domain,
      task_id: match.task_id,
      status: match.status,
      repo: match.repo,
      git_revision: match.git_revision,
      created_at: match.created_at,
      cue: match.cue,
      tags: match.tags,
      evidence_links: match.evidence_links,
      content
    };
  }

  multiGet(identifiersOrPattern, options = {}) {
    const index = this.loadOrBuildIndex();
    const snapLock = this._resolveSnapshotFilter(options.snapshot_id);
    const eligibleDocs = index.documents.filter((d) =>
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

  recordExperience({
    task_id,
    domain = 'software-engineering',
    title,
    cue,
    problem,
    observed_behavior,
    supporting_evidence = [],
    status = 'active',
    tags = ['harness2', 'experience'],
    adopted_harness = null
  }) {
    if (!task_id) {
      throw new Error('task_id is required to record a Harness² experience entry.');
    }
    this.ensureDirectories();
    const safeDomain = domain.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const safeTaskId = task_id.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const gitRev = this.getGitRevision();
    const nowIso = new Date().toISOString();
    const docid = `EXP-${safeDomain.slice(0, 4).toUpperCase()}-${safeTaskId.slice(0, 16).toUpperCase()}`;

    const taskDir = path.join(this.harnessDir, 'library', safeDomain, 'harnesses', safeTaskId);
    const harnessSubdir = path.join(taskDir, 'harness');
    fs.mkdirSync(harnessSubdir, { recursive: true });

    const manifestPath = path.join(harnessSubdir, 'manifest.json');
    const manifestPayload = adopted_harness || {
      harness_id: `harness-${safeDomain}-${safeTaskId}`,
      task_id: safeTaskId,
      domain: safeDomain,
      adopted_at: nowIso,
      git_revision: gitRev,
      status
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifestPayload, null, 2) + '\n', 'utf8');

    const relManifestPath = path.relative(this.workspaceRoot, manifestPath).replace(/\\/g, '/');
    const evidenceList = Array.isArray(supporting_evidence)
      ? supporting_evidence
      : [String(supporting_evidence)];
    if (!evidenceList.includes(relManifestPath)) {
      evidenceList.unshift(relManifestPath);
    }

    const expTitle = title || `EXPERIENCE: ${safeTaskId}`;
    const expCue =
      cue ||
      `When encountering tasks matching '${safeTaskId}' in domain '${safeDomain}', apply the verified harness configuration.`;

    const expMd = [
      '---',
      `docid: ${docid}`,
      `title: "${expTitle.replace(/"/g, '\\"')}"`,
      'collection: experiment-knowledge',
      `domain: ${safeDomain}`,
      `task_id: ${safeTaskId}`,
      `status: ${status}`,
      'repo: Harness2-RAG-antigravity',
      `git_revision: ${gitRev}`,
      `created_at: "${nowIso}"`,
      `cue: "${expCue.replace(/"/g, '\\"')}"`,
      `tags: [${tags.join(', ')}]`,
      'evidence_links:',
      ...evidenceList.map((e) => `  - "${e}"`),
      '---',
      '',
      `# ${expTitle}`,
      '',
      '## 1. What Task or Problem Produced This Lesson?',
      `- **Task ID**: \`${safeTaskId}\``,
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
      ...evidenceList.map((e) => `- \`${e}\``),
      '',
      '## 5. Is the Conclusion Still Current?',
      `- **Status**: \`${status}\``,
      `- **Recorded At**: \`${nowIso}\``,
      ''
    ].join('\n');

    const expFilePath = path.join(taskDir, 'EXPERIENCE.md');
    fs.writeFileSync(expFilePath, expMd, 'utf8');

    // Update domain INDEX.md and root INDEX.md when status === 'active'
    if (status === 'active') {
      const domainIndexPath = path.join(this.harnessDir, 'library', safeDomain, 'INDEX.md');
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
      if (!existingDomainIndex.includes(safeTaskId)) {
        const entryBlock = `\n- **[${safeTaskId}](./harnesses/${safeTaskId}/EXPERIENCE.md)** (\`${nowIso}\`, \`status: active\`)\n  - **Cue**: *${expCue}*\n  - **Adopted Harness**: [\`./harnesses/${safeTaskId}/harness/manifest.json\`](./harnesses/${safeTaskId}/harness/manifest.json)\n`;
        fs.writeFileSync(domainIndexPath, existingDomainIndex.trimEnd() + '\n' + entryBlock, 'utf8');
      }

      const rootIndexPath = path.join(this.harnessDir, 'library', 'INDEX.md');
      if (fs.existsSync(rootIndexPath)) {
        const rootContent = fs.readFileSync(rootIndexPath, 'utf8');
        if (!rootContent.includes(safeTaskId)) {
          const tableRow = `| \`${safeTaskId}\` | \`${safeDomain}\` | ${expCue} | ${expTitle} | \`active\` | [\`${safeDomain}/harnesses/${safeTaskId}/EXPERIENCE.md\`](./${safeDomain}/harnesses/${safeTaskId}/EXPERIENCE.md) |`;
          fs.writeFileSync(rootIndexPath, rootContent.trimEnd() + '\n' + tableRow + '\n', 'utf8');
        }
      }
    }

    const updatedIndex = this.buildIndex();
    return {
      recorded: true,
      docid,
      task_id: safeTaskId,
      domain: safeDomain,
      status,
      experiencePath: path.relative(this.workspaceRoot, expFilePath).replace(/\\/g, '/'),
      manifestPath: relManifestPath,
      totalIndexedDocuments: updatedIndex.totalDocuments
    };
  }

  promoteExperienceToProjectKnowledge({ task_id_or_docid, adr_id, title, summary }) {
    const expDoc = this.getDocument(task_id_or_docid, { include_candidates: true });
    if (!expDoc.found) {
      throw new Error(`Cannot promote: Experience '${task_id_or_docid}' not found.`);
    }
    const slug = (adr_id || `ADR-PROMOTED-${expDoc.task_id || expDoc.docid}`)
      .replace(/[^a-zA-Z0-9_-]/g, '-');
    const nowIso = new Date().toISOString();
    const adrTitle = title || `${slug}: Promoted Architecture Rule from ${expDoc.task_id || expDoc.docid}`;
    const adrPath = path.join(this.harnessDir, 'knowledge', 'project', `${slug}.md`);

    const adrMd = [
      '---',
      `docid: ${slug.toUpperCase()}`,
      `title: "${adrTitle.replace(/"/g, '\\"')}"`,
      'collection: project-knowledge',
      `domain: ${expDoc.domain || 'architecture'}`,
      'status: active',
      'repo: Harness2-RAG-antigravity',
      `git_revision: ${this.getGitRevision()}`,
      `created_at: "${nowIso}"`,
      'tags: [promoted-lesson, adr, harness2, project-knowledge]',
      'evidence_links:',
      `  - "${expDoc.path}"`,
      ...(expDoc.evidence_links || []).map((e) => `  - "${e}"`),
      '---',
      '',
      `# ${adrTitle}`,
      '',
      '## 1. Promoted Decision & Guidance',
      summary || expDoc.cue || `Adopted from verified Harness² experience \`${expDoc.docid}\`.`,
      '',
      '## 2. Original Harness² Provenance & Evidence',
      `- **Source Experience Document**: [\`${expDoc.path}\`](../../../${expDoc.path}) (\`${expDoc.docid}\`)`,
      `- **Original Task ID**: \`${expDoc.task_id}\``,
      `- **Git Revision at Verification**: \`${expDoc.git_revision}\``,
      ''
    ].join('\n');

    fs.writeFileSync(adrPath, adrMd, 'utf8');
    this.buildIndex();

    return {
      promoted: true,
      adrDocId: slug.toUpperCase(),
      adrPath: path.relative(this.workspaceRoot, adrPath).replace(/\\/g, '/'),
      sourceExperience: expDoc.path
    };
  }
}
