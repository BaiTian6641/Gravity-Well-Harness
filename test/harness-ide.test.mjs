import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HarnessKnowledgeEngine } from '../src/rag-engine.mjs';
import { handleToolCall } from '../mcp/harness-rag-server.mjs';
import { createHarnessMonitorApp } from '../sidecars/harness-ide-monitor/server.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');

test('1. Local Hybrid RAG Engine indexes all 3 collections and answers the 4 benchmark queries', () => {
  const engine = new HarnessKnowledgeEngine(REPO_ROOT);
  const index = engine.buildIndex();
  assert.ok(index.totalDocuments >= 9, `Expected >= 9 indexed docs, got ${index.totalDocuments}`);

  const q1 = engine.query({
    query: 'What evidence supported our previous choice of memory architecture?',
  });
  assert.equal(q1.results[0]?.docid, 'ADR-001');

  const q2 = engine.query({
    query: 'Which approaches failed in earlier training experiments, and under what conditions?',
  });
  assert.equal(q2.results[0]?.docid, 'EXP-LOG-001');

  const q3 = engine.query({
    query: 'What constraints did we establish for the Android frontend and Linux backend?',
  });
  assert.equal(q3.results[0]?.docid, 'CONSTRAINTS-001');

  const q4 = engine.query({
    query: 'Which earlier harness change helped with this type of task?',
  });
  assert.ok(
    ['LIB-INDEX-SWE', 'EXP-SWE-001', 'LIB-INDEX-ROOT'].includes(q4.results[0]?.docid),
    `Expected top hit to be a Harness2 library index/experience doc, got ${q4.results[0]?.docid}`
  );
});

test('2. Snapshot Isolation strictly blocks post-cutoff and candidate notes during active probe lock', () => {
  const engine = new HarnessKnowledgeEngine(REPO_ROOT);
  const lock = engine.createSnapshotLock({
    domain: 'software-engineering',
    k: 2,
    mode: 'parallel',
    description: 'Unit test snapshot isolation',
  });
  assert.ok(lock.active);
  assert.ok(lock.snapshotId.startsWith('SNAP-'));

  const tempTaskDir = path.join(
    REPO_ROOT,
    '.harness',
    'library',
    'software-engineering',
    'harnesses',
    'task-temp-leak-test'
  );
  const snapFile = path.join(REPO_ROOT, '.harness', 'snapshots', `${lock.snapshotId}.json`);

  try {
    // Record a post-lock experience entry (simulating Candidate #1 writing a note mid-probe)
    const rec = engine.recordExperience({
      task_id: 'task-temp-leak-test',
      domain: 'software-engineering',
      title: 'Temporary Candidate Leak Note',
      problem: 'Simulated mid-probe note',
      observed_behavior: 'Unique token XYZZY_LEAK_TOKEN_999',
      status: 'candidate',
    });

    // Query while snapshot lock is active: rec.docid must NOT be returned
    const lockedQuery = engine.query({ query: 'XYZZY_LEAK_TOKEN_999' });
    assert.equal(lockedQuery.snapshotIsolation.active, true);
    assert.ok(lockedQuery.snapshotIsolation.filteredBySnapshotCount >= 1);
    assert.ok(
      !lockedQuery.results.some((r) => r.docid === rec.docid),
      'Locked query must not leak post-lock candidate doc'
    );

    // Direct getDocument must also report blockedBySnapshotLock
    const lockedGet = engine.getDocument(rec.docid);
    assert.equal(lockedGet.found, false);
    assert.equal(lockedGet.blockedBySnapshotLock, true);
  } finally {
    engine.releaseSnapshotLock();
    if (fs.existsSync(tempTaskDir)) {
      fs.rmSync(tempTaskDir, { recursive: true, force: true });
    }
    if (fs.existsSync(snapFile)) {
      fs.unlinkSync(snapFile);
    }
    engine.buildIndex();
  }
});

test('3. MCP Server handleToolCall supports query, get, multi_get, status, metadata', async () => {
  const status = await handleToolCall('harness_status', { workspace_root: REPO_ROOT });
  assert.equal(status.healthy, true);
  assert.ok(status.collections['project-knowledge'].count >= 2);

  const meta = await handleToolCall('harness_metadata', { workspace_root: REPO_ROOT });
  assert.ok(meta.keys.collection['experiment-knowledge'] >= 4);

  const doc = await handleToolCall('harness_get', { id: 'ADR-001', workspace_root: REPO_ROOT });
  assert.equal(doc.found, true);
  assert.ok(doc.content.includes('ADR-001'));

  const batch = await handleToolCall('harness_multi_get', {
    pattern: 'ADR-001, CONSTRAINTS-001',
    workspace_root: REPO_ROOT,
  });
  assert.equal(batch.count, 2);
});

test('4. Plugin Lifecycle Hooks adhere to Antigravity stdin/stdout JSON contracts', () => {
  const hooksDir = path.join(REPO_ROOT, 'plugin', 'harness-ide', 'scripts', 'hooks');

  const startRes = spawnSync('node', [path.join(hooksDir, 'session-start.mjs')], {
    input: JSON.stringify({
      conversationId: 'test-conv-1',
      workspacePaths: [REPO_ROOT],
      modelName: 'auto',
    }),
    encoding: 'utf8',
  });
  assert.equal(startRes.status, 0);
  const startJson = JSON.parse(startRes.stdout.trim());
  assert.ok(Array.isArray(startJson.injectSteps));

  const postRes = spawnSync('node', [path.join(hooksDir, 'post-tool-use.mjs')], {
    input: JSON.stringify({
      conversationId: 'test-conv-1',
      workspacePaths: [REPO_ROOT],
      stepIdx: 3,
      toolCall: {
        name: 'invoke_subagent',
        args: {
          Role: 'Harness2 Prober #1',
          TypeName: 'harness-prober',
          Workspace: 'branch',
          Prompt: 'Probe candidate 1 under frozen snapshot',
        },
      },
    }),
    encoding: 'utf8',
  });
  assert.equal(postRes.status, 0);
  assert.deepEqual(JSON.parse(postRes.stdout.trim()), {});
});

test('5. Auxiliary Pane UI Sidecar Server responds on /, /api/status, /api/dashboard, /api/rag/query', async () => {
  const app = createHarnessMonitorApp();
  await app.run(0);
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const htmlRes = await fetch(`${base}/`);
    assert.equal(htmlRes.status, 200);
    const htmlText = await htmlRes.text();
    assert.ok(htmlText.includes('Gravity Well Harness'));

    const dashRes = await fetch(`${base}/api/dashboard`, {
      method: 'POST',
      body: JSON.stringify({ workspaceRoot: REPO_ROOT }),
    });
    assert.equal(dashRes.status, 200);
    const dashData = await dashRes.json();
    assert.equal(dashData.ok, true);
    assert.equal(dashData.formalName, 'Gravity Well Harness');
    assert.equal(dashData.swarm.configuredSwarmRoles.length, 4);

    // Verify Multi-Tier Swarm Hierarchy Formations & Teams
    assert.ok(dashData.swarm.formations['live-harness2']);
    assert.ok(dashData.swarm.formations['compact-verification']);
    assert.ok(dashData.swarm.formations['multi-stage-team']);
    assert.equal(dashData.swarm.formations['multi-stage-team'].nodes.length, 13);
    assert.ok(dashData.swarm.formations['live-harness2'].edges.length >= 5);
    assert.ok(dashData.swarm.formations['live-harness2'].teams.length >= 3);

    // Verify Context Window & Token DNA Analytics
    assert.ok(dashData.contextAnalytics);
    assert.equal(dashData.contextAnalytics.tokenStats.categories.length, 8);
    assert.equal(dashData.contextAnalytics.latencyStats.categories.length, 6);
    assert.equal(dashData.contextAnalytics.currentWindow.categories.length, 7);
    assert.ok(dashData.contextAnalytics.stepTrends.length >= 10);

    // Verify Smooth Workspace Switch Endpoint
    const switchRes = await fetch(`${base}/api/workspace/switch`, {
      method: 'POST',
      body: JSON.stringify({ workspaceRoot: REPO_ROOT }),
    });
    const switchData = await switchRes.json();
    assert.equal(switchData.ok, true);
    assert.equal(switchData.hasHarness, true);

    const searchRes = await fetch(`${base}/api/rag/query`, {
      method: 'POST',
      body: JSON.stringify({
        workspaceRoot: REPO_ROOT,
        query: 'Android frontend Linux backend constraints',
      }),
    });
    const searchData = await searchRes.json();
    assert.equal(searchData.ok, true);
    assert.equal(searchData.results[0]?.docid, 'CONSTRAINTS-001');
  } finally {
    await app.close();
  }
});

test('6. Python AntigravityExecutor adapter completes Propose-Probe-Compose self-test', () => {
  const pyRes = spawnSync(
    'python',
    [path.join(REPO_ROOT, 'adapters', 'harness2_antigravity_executor.py'), '--self-test'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 15000,
    }
  );
  assert.equal(pyRes.status, 0, `Python adapter failed: ${pyRes.stderr}`);
  const out = JSON.parse(pyRes.stdout.trim());
  assert.equal(out.winner.candidate_id, 'candidate-2-harness2-rag-branched');
  assert.equal(out.winner.passed_verification, true);
});
