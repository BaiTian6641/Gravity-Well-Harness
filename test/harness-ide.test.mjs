import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HarnessKnowledgeEngine, tokenize } from '../src/rag-engine.mjs';
import {
  setSecretInVault,
  resolveSecretCredential,
  getSecretVaultStatusSummary,
  redactSecrets,
  validateCredentialOrigin,
  withVaultLock,
} from '../src/secret-vault.mjs';
import {
  invokeUnifiedModel,
  injectOrConveySwarmMessage,
  consumePendingSwarmMessages,
  searchWebMultiEngine,
  loadHubConfig,
  saveHubConfig,
  withMessageBusLock,
} from '../src/model-hub.mjs';
import { ContextResilienceManager } from '../src/context-resilience.mjs';
import { handleToolCall, handleJsonRpcMessage } from '../mcp/harness-rag-server.mjs';
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
  const app = createHarnessMonitorApp({ demoMode: true, requireAuth: false });
  await app.run(0);
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const htmlRes = await fetch(`${base}/`);
    assert.equal(htmlRes.status, 200);
    const htmlText = await htmlRes.text();
    assert.ok(htmlText.includes('Gravity Well Harness'));
    assert.ok(htmlText.includes('node-hover-preview'));
    assert.ok(htmlText.includes('inactive-subagents-dock'));
    assert.ok(htmlText.includes('btn-toggle-hide-inactive'));

    // Ensure clean subagent lifecycle state first
    await fetch(`${base}/api/swarm/recall`, {
      method: 'POST',
      body: JSON.stringify({ workspaceRoot: REPO_ROOT, action: 'reset' }),
    });

    const pulseRes = await fetch(`${base}/api/live-pulse`, {
      method: 'POST',
      body: JSON.stringify({ workspaceRoot: REPO_ROOT }),
    });
    assert.equal(pulseRes.status, 200);
    const pulseData = await pulseRes.json();
    assert.equal(pulseData.ok, true);
    assert.ok(typeof pulseData.liveRevision === 'string' && pulseData.liveRevision.length > 0);

    const dashRes = await fetch(`${base}/api/dashboard`, {
      method: 'POST',
      body: JSON.stringify({ workspaceRoot: REPO_ROOT }),
    });
    assert.equal(dashRes.status, 200);
    const dashData = await dashRes.json();
    assert.equal(dashData.ok, true);
    assert.equal(dashData.formalName, 'Gravity Well Harness');
    assert.ok(typeof dashData.liveRevision === 'string' && dashData.liveRevision.length > 0);
    assert.equal(dashData.swarm.configuredSwarmRoles.length, 4);

    // Verify ONLY the Current Workspace Agent Swarm ('live-harness2') is present (demo formations removed)
    assert.deepEqual(Object.keys(dashData.swarm.formations), ['live-harness2']);
    assert.equal(dashData.swarm.formations['compact-verification'], undefined);
    assert.equal(dashData.swarm.formations['multi-stage-team'], undefined);
    assert.ok(dashData.swarm.formations['live-harness2'].edges.length >= 5);
    assert.ok(dashData.swarm.formations['live-harness2'].teams.length >= 3);

    // Verify Multi-Model Hub Catalog (DeepSeek Official 1M + OpenCode Go Coding Plan + Antigravity Native)
    assert.ok(dashData.modelHub);
    assert.ok(dashData.modelHub.catalog.length >= 22);
    const modelIds = dashData.modelHub.catalog.map((m) => m.id);
    for (const expectedId of [
      'deepseek-v4-pro',
      'deepseek-flash',
      'deepseek-reasoner',
      'deepseek-chat',
      'opencode-go/grok-4.7',
      'opencode-go/gpt-6-luna',
      'opencode-go/claude-haiku-5-5',
      'opencode-go/gemini-4-argon',
      'opencode-go/kimi-k3.1-pro',
      'opencode-go/kimi-k2.7-code',
      'opencode-go/glm-5.3',
      'opencode-go/mimo-v2.6-pro',
      'opencode-go/minimax-m3.1-flash',
      'opencode-go/qwen3.7-max',
      'opencode-go/longcat-2.0',
      'opencode-go/step-5-preview',
    ]) {
      assert.ok(modelIds.includes(expectedId), `Expected model catalog to include ${expectedId}`);
    }
    const dsPro = dashData.modelHub.catalog.find((m) => m.id === 'deepseek-v4-pro');
    assert.equal(dsPro.underlyingModel, 'DeepSeek-V4-Pro-0813');
    assert.equal(dsPro.contextWindowTokens, 1000000);
    assert.ok(dsPro.reasoningDepth);
    assert.ok(dsPro.reasoningEffort);
    assert.ok(typeof dsPro.contextUsedPct === 'number');

    // Verify finished subagents are accurately marked COMPLETED when no probe lock is active
    const liveFormation = dashData.swarm.formations['live-harness2'];
    const prober1Before = liveFormation.nodes.find((n) => n.id === 'harness-prober-1');
    assert.ok(prober1Before);
    assert.equal(prober1Before.status, 'COMPLETED');
    assert.equal(prober1Before.isActive, false);
    assert.ok(liveFormation.inactiveSubagentCount >= 5);

    // Verify recalling an inactive subagent transitions it back to RUNNING and rejoins the active network
    const recallRes = await fetch(`${base}/api/swarm/recall`, {
      method: 'POST',
      body: JSON.stringify({
        workspaceRoot: REPO_ROOT,
        formationId: 'live-harness2',
        nodeId: 'harness-prober-1',
        action: 'recall',
      }),
    });
    assert.equal(recallRes.status, 200);
    const recallData = await recallRes.json();
    assert.equal(recallData.ok, true);

    const dashAfterRecallRes = await fetch(`${base}/api/dashboard`, {
      method: 'POST',
      body: JSON.stringify({ workspaceRoot: REPO_ROOT }),
    });
    const dashAfterRecall = await dashAfterRecallRes.json();
    const prober1AfterRecall = dashAfterRecall.swarm.formations['live-harness2'].nodes.find(
      (n) => n.id === 'harness-prober-1',
    );
    assert.equal(prober1AfterRecall.status, 'RUNNING');
    assert.equal(prober1AfterRecall.isActive, true);
    assert.equal(prober1AfterRecall.recalled, true);

    // Verify completing a subagent transitions it back to COMPLETED (inactive)
    const completeRes = await fetch(`${base}/api/swarm/recall`, {
      method: 'POST',
      body: JSON.stringify({
        workspaceRoot: REPO_ROOT,
        formationId: 'live-harness2',
        nodeId: 'harness-prober-1',
        action: 'complete',
      }),
    });
    assert.equal(completeRes.status, 200);
    const dashAfterCompleteRes = await fetch(`${base}/api/dashboard`, {
      method: 'POST',
      body: JSON.stringify({ workspaceRoot: REPO_ROOT }),
    });
    const dashAfterComplete = await dashAfterCompleteRes.json();
    const prober1AfterComplete = dashAfterComplete.swarm.formations['live-harness2'].nodes.find(
      (n) => n.id === 'harness-prober-1',
    );
    assert.equal(prober1AfterComplete.status, 'COMPLETED');
    assert.equal(prober1AfterComplete.isActive, false);

    // Reset lifecycle state
    await fetch(`${base}/api/swarm/recall`, {
      method: 'POST',
      body: JSON.stringify({ workspaceRoot: REPO_ROOT, action: 'reset' }),
    });

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

test('6. Python AntigravityExecutor adapter completes Propose-Probe-Compose self-test across reasoning depths', () => {
  const pyRes = spawnSync(
    'python',
    [path.join(REPO_ROOT, 'adapters', 'harness2_antigravity_executor.py'), '--reasoning-depth', 'balanced', '--self-test'],
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
  assert.equal(out.reasoningProfile.reasoning_depth, 'balanced');
  assert.equal(out.reasoningProfile.thinking_budget_tokens, 2048);
  assert.ok(out.tokenEfficiency.totalTokensSaved > 0);
  assert.ok(out.tokenEfficiency.totalTokensSavedPct >= 40);

  const ecoRes = spawnSync(
    'python',
    [path.join(REPO_ROOT, 'adapters', 'harness2_antigravity_executor.py'), '--reasoning-depth', 'eco', '--self-test'],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 15000,
    }
  );
  assert.equal(ecoRes.status, 0, `Python adapter eco failed: ${ecoRes.stderr}`);
  const ecoOut = JSON.parse(ecoRes.stdout.trim());
  assert.equal(ecoOut.reasoningProfile.reasoning_depth, 'eco');
  assert.equal(ecoOut.reasoningProfile.thinking_budget_tokens, 1024);
  assert.ok(
    ecoOut.tokenEfficiency.totalActualTokens < out.tokenEfficiency.totalActualTokens,
    'Eco reasoning depth must use fewer tokens than balanced'
  );
});

test('7. Google Harness2 end-to-end Propose-Probe-Compose loop & Adaptive Reasoning Depth token efficiency', async () => {
  const engine = new HarnessKnowledgeEngine(REPO_ROOT);

  // Run Eco, Balanced, and Deep without writing permanent library entries during comparison
  const ecoRun = engine.runHarness2Loop({
    taskId: 'test-harness2-eco',
    domain: 'software-engineering',
    problem: 'Optimize agent harness with bounded reasoning depth and snapshot isolation',
    k: 3,
    mode: 'parallel',
    reasoningDepth: 'eco',
    earlyStopOnFirstPass: false,
    adoptWinner: false,
    allowSimulation: true,
  });

  const balancedRun = engine.runHarness2Loop({
    taskId: 'test-harness2-balanced',
    domain: 'software-engineering',
    problem: 'Optimize agent harness with bounded reasoning depth and snapshot isolation',
    k: 3,
    mode: 'parallel',
    reasoningDepth: 'balanced',
    earlyStopOnFirstPass: false,
    adoptWinner: false,
    allowSimulation: true,
  });

  const deepRun = engine.runHarness2Loop({
    taskId: 'test-harness2-deep',
    domain: 'software-engineering',
    problem: 'Optimize agent harness with bounded reasoning depth and snapshot isolation',
    k: 3,
    mode: 'parallel',
    reasoningDepth: 'deep',
    earlyStopOnFirstPass: false,
    adoptWinner: false,
    allowSimulation: true,
  });

  assert.equal(ecoRun.ok, true);
  assert.equal(balancedRun.ok, true);
  assert.equal(deepRun.ok, true);

  // Verify two-front proposals (Invariant + Domain-Specific + Hybrid)
  assert.equal(balancedRun.proposals.length, 3);
  assert.equal(balancedRun.proposals[0].front, 'invariant');
  assert.equal(balancedRun.proposals[1].front, 'domain-specific');
  assert.equal(balancedRun.proposals[2].front, 'hybrid');

  // Verify strict token ordering: eco < balanced < deep
  assert.ok(
    ecoRun.tokenEfficiency.totalActualTokens < balancedRun.tokenEfficiency.totalActualTokens,
    `Expected eco (${ecoRun.tokenEfficiency.totalActualTokens}) < balanced (${balancedRun.tokenEfficiency.totalActualTokens})`
  );
  assert.ok(
    balancedRun.tokenEfficiency.totalActualTokens < deepRun.tokenEfficiency.totalActualTokens,
    `Expected balanced (${balancedRun.tokenEfficiency.totalActualTokens}) < deep (${deepRun.tokenEfficiency.totalActualTokens})`
  );
  assert.ok(balancedRun.tokenEfficiency.totalTokensSavedPct >= 45);

  // Verify sequential mode with earlyStopOnFirstPass skips remaining candidates once verified
  const seqEarlyRun = engine.runHarness2Loop({
    taskId: 'test-harness2-seq-early',
    domain: 'software-engineering',
    problem: 'Verify sequential early-stop on first passing candidate',
    k: 3,
    mode: 'sequential',
    reasoningDepth: 'balanced',
    earlyStopOnFirstPass: true,
    adoptWinner: false,
    allowSimulation: true,
  });
  assert.equal(seqEarlyRun.tokenEfficiency.earlyStopped, true);
  assert.ok(seqEarlyRun.trajectories.some((t) => t.earlyStopped === true));

  // Verify snapshot lock was cleanly released after runHarness2Loop
  assert.equal(engine.getActiveSnapshotLock(), null);

  // Verify MCP tool harness_run_loop
  const mcpLoop = await handleToolCall('harness_run_loop', {
    workspace_root: REPO_ROOT,
    task_id: 'test-mcp-harness2-loop',
    domain: 'software-engineering',
    problem: 'Validate MCP harness_run_loop tool with balanced reasoning depth',
    k: 3,
    mode: 'sequential',
    reasoning_depth: 'balanced',
    early_stop: true,
    record_to_library: false,
    allow_simulation: true,
  });
  assert.equal(mcpLoop.ok, true);
  assert.equal(mcpLoop.reasoningProfile.reasoningDepth, 'balanced');
  assert.ok(mcpLoop.winner.score >= 0.85);
});

test('8. Multi-Model Hub (DeepSeek Official + OpenCode Go), Bidirectional Subagent Calling, Multi-Engine Search, Message Injection & Self-Improvement', async () => {
  const app = createHarnessMonitorApp({ demoMode: true, requireAuth: false });
  await app.run(0);
  try {
    const base = `http://127.0.0.1:${app.port}`;

    // 1. Bidirectional Model Invocation: DeepSeek V4 Pro calling OpenCode Go Kimi K2.7 Code as subagent
    const invokeRes = await fetch(`${base}/api/models/invoke`, {
      method: 'POST',
      body: JSON.stringify({
        workspaceRoot: REPO_ROOT,
        modelId: 'deepseek-v4-pro',
        reasoningDepth: 'deep',
        callerModel: 'gemini-4-argon',
        callerAgent: 'main-orchestrator',
        delegateToPeerModel: 'opencode-go/kimi-k2.7-code',
        prompt: 'Verify snapshot isolation and multi-model subagent handoff under frozen RAG cutoff',
      }),
    });
    assert.equal(invokeRes.status, 200);
    const invokeData = await invokeRes.json();
    assert.equal(invokeData.ok, true);
    assert.equal(invokeData.modelId, 'deepseek-v4-pro');
    assert.equal(invokeData.reasoningDepth, 'deep');
    assert.equal(invokeData.reasoningEffort, 'max');
    assert.ok(invokeData.reasoning_content.includes('DeepSeek-V4-Pro-0813'));
    assert.ok(invokeData.peerDelegation);
    assert.equal(invokeData.peerDelegation.modelId, 'opencode-go/kimi-k2.7-code');

    // 2. Multi-Engine Web Search Hub (Reciprocal Rank Fusion across DeepSeek/Parallel/Tavily/Free engines)
    const searchRes = await fetch(`${base}/api/search/multi`, {
      method: 'POST',
      body: JSON.stringify({
        workspaceRoot: REPO_ROOT,
        query: 'DeepSeek V4 Pro OpenCode Go Harness2 recursive self-improvement',
        engine: 'multi-fusion',
        maxResults: 5,
      }),
    });
    assert.equal(searchRes.status, 200);
    const searchData = await searchRes.json();
    assert.equal(searchData.ok, true);
    assert.ok(Array.isArray(searchData.results) && searchData.results.length >= 1);

    // 3. Inter-Model Message Injection & Convey (and auto-recall onto 2D swarm graph)
    const injectRes = await fetch(`${base}/api/swarm/message-inject`, {
      method: 'POST',
      body: JSON.stringify({
        workspaceRoot: REPO_ROOT,
        action: 'inject',
        fromAgent: 'main-orchestrator',
        fromModel: 'deepseek-v4-pro',
        toAgent: 'harness-prober-2',
        toModel: 'opencode-go/glm-5.3',
        messageType: 'PEER_CRITIQUE',
        reasoningDepth: 'balanced',
        content: 'Apply Cue-First RAG retrieval before patching src/model-hub.mjs',
        autoRecallTarget: true,
      }),
    });
    assert.equal(injectRes.status, 200);
    const injectData = await injectRes.json();
    assert.equal(injectData.ok, true);
    assert.equal(injectData.message.toAgent, 'harness-prober-2');
    assert.equal(injectData.message.toModel, 'opencode-go/glm-5.3');

    // Verify pre-invocation hook consumes the pending injected message into injectSteps
    const hooksDir = path.join(REPO_ROOT, 'plugin', 'harness-ide', 'scripts', 'hooks');
    const preRes = spawnSync('node', [path.join(hooksDir, 'pre-invocation.mjs')], {
      input: JSON.stringify({
        conversationId: 'test-conv-inject',
        workspacePaths: [REPO_ROOT],
        prompt: 'Continue implementing the multi-model swarm',
      }),
      encoding: 'utf8',
    });
    assert.equal(preRes.status, 0);
    const preJson = JSON.parse(preRes.stdout.trim());
    assert.ok(
      Array.isArray(preJson.injectSteps) &&
        preJson.injectSteps.some((s) =>
          String(typeof s === 'string' ? s : s.ephemeralMessage || s.content || '').includes(
            'Swarm Message Injection'
          )
        ),
      'Expected pre-invocation hook to inject pending Swarm Message Bus directives'
    );

    // 4. Multi-Model Self-Improvement & Cooperation Cycle (without polluting permanent library during test)
    const rsiData = await handleToolCall('harness_self_improve', {
      workspace_root: REPO_ROOT,
      task_id: 'test-rsi-coop',
      domain: 'software-engineering',
      problem: 'Coordinate DeepSeek V4 Pro and OpenCode Go models for self-improving verification',
      proposer_model: 'deepseek-v4-pro',
      prober_models: ['opencode-go/kimi-k2.7-code', 'opencode-go/glm-5.3', 'deepseek-flash'],
      composer_model: 'opencode-go/gpt-6-luna',
      reasoning_depth: 'balanced',
      record_to_library: false,
      allow_simulation: true,
    });
    assert.equal(rsiData.ok, true);
    assert.equal(rsiData.cooperationRoster.proposerModel, 'deepseek-v4-pro');
    assert.equal(rsiData.cooperationRoster.composerModel, 'opencode-go/gpt-6-luna');
    assert.ok(rsiData.peerCritiques.length >= 2);
    assert.ok(rsiData.winner.score >= 0.85);

    // 5. Verify Antigravity IDE Settings (.vscode/settings.json), Pure Debugging & Preview Sidecar UI, Chat Box Model Sync, and AES-256-GCM Secret Vault (Zero Leakage)
    const indexHtml = fs.readFileSync(
      path.join(REPO_ROOT, 'sidecars', 'harness-ide-monitor', 'ui', 'index.html'),
      'utf8'
    );
    assert.ok(
      !indexHtml.includes('id="tab-settings"'),
      'Sidecar Monitor UI must be strictly a Monitor page without a Settings tab'
    );
    assert.ok(
      !indexHtml.includes('id="header-model-selector"'),
      'Sidecar Monitor UI must not have a model selection dropdown on the main page (model selection belongs to Antigravity IDE Chat Box)'
    );
    assert.ok(
      !indexHtml.includes('id="multi-model-coop-bar"'),
      'Sidecar Monitor UI must not include interactive message injection forms'
    );
    assert.ok(
      !indexHtml.includes('type="password"'),
      'Sidecar Monitor UI must not contain password/API key input fields'
    );

    // Verify official Antigravity Chat Box modelName sync & /usage View Usage in pre-invocation.mjs
    const usageHookRes = spawnSync('node', [path.join(hooksDir, 'pre-invocation.mjs')], {
      input: JSON.stringify({
        conversationId: 'test-conv-chatbox-sync',
        workspacePaths: [REPO_ROOT],
        modelName: 'Gemini 4 Argon (High)',
        lastUserInput: '/usage',
      }),
      encoding: 'utf8',
    });
    assert.equal(usageHookRes.status, 0);
    const usageHookJson = JSON.parse(usageHookRes.stdout.trim());
    const usageBanner =
      usageHookJson.injectSteps?.[0]?.systemMessage?.metadata?.user_markdown || '';
    assert.ok(
      usageBanner.includes('Gemini 4 Argon'),
      'Expected pre-invocation hook to sync Gemini 4 Argon (High) from Antigravity chat box modelName'
    );

    const ideSettingsPath = path.join(REPO_ROOT, '.vscode', 'settings.json');
    assert.ok(fs.existsSync(ideSettingsPath), 'Expected .vscode/settings.json for Antigravity IDE Settings');
    const ideSettings = JSON.parse(fs.readFileSync(ideSettingsPath, 'utf8'));
    assert.ok(ideSettings['antigravity.harness.activeModel'], 'Expected antigravity.harness.activeModel in IDE settings');
    assert.ok(ideSettings['antigravity.harness.reasoningDepth'], 'Expected antigravity.harness.reasoningDepth in IDE settings');
    assert.ok(ideSettings['antigravity.harness.swarmRoleModels'], 'Expected antigravity.harness.swarmRoleModels for multi-model subagent role routing');

    // Test storing a synthetic API key via /api/models/config and verifying zero leakage in disk JSON or HTTP responses
    const testSecretVal = 'sk-test-vault-never-leak-9988776655443322';
    const prevDeepSeekCred = resolveSecretCredential('DEEPSEEK_API_KEY');
    try {
      const cfgSaveRes = await fetch(`${base}/api/models/config`, {
        method: 'POST',
        body: JSON.stringify({
          workspaceRoot: REPO_ROOT,
          providers: {
            'deepseek-official': {
              baseUrl: 'https://api.deepseek.com',
              apiKey: testSecretVal,
            },
          },
        }),
      });
      assert.equal(cfgSaveRes.status, 200);
      const cfgSaveData = await cfgSaveRes.json();
      assert.ok(
        !JSON.stringify(cfgSaveData).includes(testSecretVal),
        'API response from /api/models/config must never echo or leak the API key'
      );

      // Verify encrypted vault resolves the secret in memory
      const resolved = resolveSecretCredential('DEEPSEEK_API_KEY');
      assert.equal(resolved.hasKey, true);
      assert.equal(resolved.value, testSecretVal);
      assert.ok(resolved.source.includes('aes-256-gcm-vault'));

      // Verify .harness/runtime/model-search-hub.json, .vscode/settings.json, and /api/dashboard NEVER contain the secret
      const hubDiskRaw = fs.readFileSync(
        path.join(REPO_ROOT, '.harness', 'runtime', 'model-search-hub.json'),
        'utf8'
      );
      assert.ok(!hubDiskRaw.includes(testSecretVal), 'model-search-hub.json must never contain plaintext API keys');
      const ideDiskRaw = fs.readFileSync(ideSettingsPath, 'utf8');
      assert.ok(!ideDiskRaw.includes(testSecretVal), '.vscode/settings.json must never contain plaintext API keys');

      const dashVerifyRes = await fetch(`${base}/api/dashboard`, {
        method: 'POST',
        body: JSON.stringify({ workspaceRoot: REPO_ROOT }),
      });
      const dashVerifyJson = await dashVerifyRes.json();
      assert.ok(
        !JSON.stringify(dashVerifyJson).includes(testSecretVal),
        '/api/dashboard HTTP response must never leak plaintext API keys'
      );
      assert.equal(
        dashVerifyJson.modelHub.config.providers['deepseek-official'].hasApiKey,
        true
      );
      assert.equal(
        redactSecrets(`Bearer ${testSecretVal}`),
        'Bearer [REDACTED_API_KEY]'
      );
      assert.ok(getSecretVaultStatusSummary().cipher.includes('AES-256-GCM'));

      // Verify /api/vault/signin and /api/vault/status direct loopback sign-in procedure
      const vaultSigninRes = await fetch(`${base}/api/vault/signin`, {
        method: 'POST',
        body: JSON.stringify({
          keyName: 'DEEPSEEK_API_KEY',
          secretValue: testSecretVal,
        }),
      });
      assert.equal(vaultSigninRes.status, 200);
      const vaultSigninJson = await vaultSigninRes.json();
      assert.equal(vaultSigninJson.ok, true);
      assert.equal(vaultSigninJson.configured, true);
      assert.ok(
        !JSON.stringify(vaultSigninJson).includes(testSecretVal),
        '/api/vault/signin must never echo or leak the API key'
      );
    } finally {
      // Restore previous DEEPSEEK_API_KEY vault state
      if (prevDeepSeekCred.hasKey && prevDeepSeekCred.source.includes('aes-256-gcm-vault')) {
        setSecretInVault('DEEPSEEK_API_KEY', prevDeepSeekCred.value);
      } else {
        setSecretInVault('DEEPSEEK_API_KEY', '');
      }
    }

    // Clean up recall state and consume any remaining test message-bus messages
    await fetch(`${base}/api/swarm/recall`, {
      method: 'POST',
      body: JSON.stringify({ workspaceRoot: REPO_ROOT, action: 'reset' }),
    });
    const msgBusFile = path.join(REPO_ROOT, '.harness', 'runtime', 'message-bus.json');
    if (fs.existsSync(msgBusFile)) {
      fs.unlinkSync(msgBusFile);
    }
  } finally {
    await app.close();
  }
});

test('9. F01, F03, F06 & F12: Immutable Snapshot Blobs, CAS Locks, Missing/Traversal Snapshot Rejection, Promotion Gate, CJK Tokenization & Truthful Loop', () => {
  const engine = new HarnessKnowledgeEngine(REPO_ROOT);

  // F12: Chinese/CJK tokenization produces characters and bigrams
  const cjkTokens = tokenize('内存架构证据与快照隔离');
  assert.ok(cjkTokens.length >= 6, `Expected CJK tokens & bigrams, got ${cjkTokens.length}`);
  assert.ok(cjkTokens.includes('内存') || cjkTokens.includes('快照'));

  // F03: Missing or path-traversal snapshot_id fails closed
  const badQuery = engine.query({
    query: 'memory architecture',
    snapshotId: '../package',
  });
  assert.equal(badQuery.results.length, 0);
  assert.equal(badQuery.snapshotIsolation.error, 'INVALID_OR_MISSING_SNAPSHOT');

  const badGet = engine.getDocument('ADR-001', '../package');
  assert.equal(badGet.found, false);
  assert.equal(badGet.error, 'INVALID_OR_MISSING_SNAPSHOT');

  // F03: Create snapshot lock with ownerRunId and verify CAS lock protection + content-addressed blob immutability
  const lock = engine.createSnapshotLock({
    domain: 'software-engineering',
    k: 2,
    mode: 'parallel',
    ownerRunId: 'run-alpha',
    description: 'F03 immutable blob and CAS lock test',
  });
  assert.equal(lock.active, true);
  assert.equal(lock.ownerRunId, 'run-alpha');
  const snapFile = path.join(REPO_ROOT, '.harness', 'snapshots', `${lock.snapshotId}.json`);

  try {
    // Another run without force cannot overwrite or release run-alpha's lock
    const conflictLock = engine.createSnapshotLock({
      domain: 'software-engineering',
      ownerRunId: 'run-beta',
    });
    assert.equal(conflictLock.ok, false);
    assert.equal(conflictLock.error, 'SNAPSHOT_LOCK_ACTIVE_BY_ANOTHER_RUN');

    const wrongRelease = engine.releaseSnapshotLock({ ownerRunId: 'run-beta' });
    assert.equal(wrongRelease.released, false);
    assert.equal(wrongRelease.error, 'SNAPSHOT_LOCK_OWNED_BY_ANOTHER_RUN');

    // Verify frozen document content is served from immutable snapshot even if live index changes
    const docSnap = engine.getDocument('ADR-001', lock.snapshotId);
    assert.equal(docSnap.found, true);
    assert.equal(docSnap.fromImmutableSnapshot, true);
    assert.ok(docSnap.content.includes('ADR-001'));
  } finally {
    const rightRelease = engine.releaseSnapshotLock({ ownerRunId: 'run-alpha' });
    assert.equal(rightRelease.released, true);
    if (fs.existsSync(snapFile)) fs.unlinkSync(snapFile);
  }

  // F01: runHarness2Loop fails closed when requiredArtifacts are missing or allowSimulation is false without evaluator
  const missingArtRun = engine.runHarness2Loop({
    taskId: 'test-f01-missing-artifact',
    domain: 'software-engineering',
    problem: 'Produce verified artifact',
    requiredArtifacts: ['.harness/non-existent-required-output-12345.json'],
    adoptWinner: true,
    allowSimulation: true,
  });
  assert.equal(missingArtRun.ok, false);
  assert.equal(missingArtRun.status, 'failed');
  assert.equal(missingArtRun.error, 'REQUIRED_ARTIFACT_MISSING');
  assert.equal(missingArtRun.passedVerification, false);
  assert.equal(missingArtRun.adoptedExperience || null, null);

  const strictNoEvalRun = engine.runHarness2Loop({
    taskId: 'test-f01-strict-no-eval',
    domain: 'software-engineering',
    problem: 'Strict execution without evaluator',
    allowSimulation: false,
    adoptWinner: false,
  });
  assert.equal(strictNoEvalRun.ok, false);
  assert.equal(strictNoEvalRun.error, 'NO_VERIFIED_EXECUTION_OR_EVALUATOR');

  // F06 & F03: Long task_id collision avoidance + Promotion Gate requires evaluationReceipt for candidate entries
  const longPrefix = 'task-identical-16char-prefix-test';
  const recA = engine.recordExperience({
    task_id: `${longPrefix}-alpha`,
    domain: 'software-engineering',
    title: 'Candidate Alpha',
    problem: 'Test collision A',
    observed_behavior: 'Observed A',
    status: 'candidate',
  });
  const recB = engine.recordExperience({
    task_id: `${longPrefix}-beta`,
    domain: 'software-engineering',
    title: 'Candidate Beta',
    problem: 'Test collision B',
    observed_behavior: 'Observed B',
    status: 'candidate',
  });
  try {
    assert.notEqual(recA.docid, recB.docid, 'Long task_id values sharing 16-char prefix must not collide');

    // Ungated promotion of candidate without evaluationReceipt must fail
    const ungatedPromo = engine.promoteExperienceToProjectKnowledge({
      experienceDocId: recA.docid,
    });
    assert.equal(ungatedPromo.ok, false);
    assert.equal(ungatedPromo.error, 'PROMOTION_REQUIRES_EVALUATION_RECEIPT');
  } finally {
    const dirA = path.dirname(path.join(REPO_ROOT, recA.relativePath));
    const dirB = path.dirname(path.join(REPO_ROOT, recB.relativePath));
    if (fs.existsSync(dirA)) fs.rmSync(dirA, { recursive: true, force: true });
    if (fs.existsSync(dirB)) fs.rmSync(dirB, { recursive: true, force: true });
    engine.buildIndex();
  }
});

test('10. F02, F04, F05 & F13: Credential Origin Allowlist, Strict Provider Execution, Recipient-Isolated Message Bus', async () => {
  // F05: Credential Origin Allowlist validation
  const validDeepSeek = validateCredentialOrigin(
    'DEEPSEEK_API_KEY',
    'https://api.deepseek.com/chat/completions'
  );
  assert.equal(validDeepSeek.ok, true);

  const untrustedOrigin = validateCredentialOrigin(
    'DEEPSEEK_API_KEY',
    'https://evil-collector.example.com/v1/chat/completions'
  );
  assert.equal(untrustedOrigin.ok, false);

  const insecureHttp = validateCredentialOrigin(
    'DEEPSEEK_API_KEY',
    'http://api.deepseek.com/chat/completions'
  );
  assert.equal(insecureHttp.ok, false);

  // F02 & F05: Unknown model ID and strict execution checks
  const unknownModelRes = await invokeUnifiedModel(REPO_ROOT, {
    modelId: 'non-existent-model-xyz',
    prompt: 'Test unknown model',
  });
  assert.equal(unknownModelRes.ok, false);
  assert.equal(unknownModelRes.status, 'unsupported');

  const nativeStrictRes = await invokeUnifiedModel(REPO_ROOT, {
    modelId: 'gemini-4-argon',
    prompt: 'Test native host model in strict HTTP mode',
    allowSimulation: false,
  });
  assert.equal(nativeStrictRes.ok, false);
  assert.equal(nativeStrictRes.status, 'unsupported');

  // F04: Recipient-isolated transactional message bus & broadcast per-recipient acks
  const msgBusFile = path.join(REPO_ROOT, '.harness', 'runtime', 'message-bus.json');
  if (fs.existsSync(msgBusFile)) fs.unlinkSync(msgBusFile);

  try {
    // 20 concurrent sends must lose 0 messages
    await Promise.all(
      Array.from({ length: 20 }, (_, idx) =>
        injectOrConveySwarmMessage(REPO_ROOT, {
          fromAgent: 'orchestrator',
          toAgent: idx % 2 === 0 ? 'worker-a' : 'worker-b',
          content: `Concurrent msg #${idx}`,
          executeTargetModel: false,
        })
      )
    );
    // Also inject a broadcast message
    await injectOrConveySwarmMessage(REPO_ROOT, {
      fromAgent: 'orchestrator',
      toAgent: 'all',
      content: 'Broadcast directive to all workers',
      executeTargetModel: false,
    });

    // Consume for worker-a: must receive 10 direct messages + 1 broadcast = 11 messages, and NEVER worker-b's messages
    const forWorkerA = consumePendingSwarmMessages(REPO_ROOT, 'worker-a');
    assert.equal(forWorkerA.length, 11);
    assert.ok(forWorkerA.every((m) => m.toAgent === 'worker-a' || m.toAgent === 'all'));

    // Re-consuming for worker-a immediately returns 0 (already acked by worker-a)
    const forWorkerASecond = consumePendingSwarmMessages(REPO_ROOT, 'worker-a');
    assert.equal(forWorkerASecond.length, 0);

    // Consume for worker-b: must STILL receive all 10 direct messages for worker-b + the 1 broadcast = 11 messages
    const forWorkerB = consumePendingSwarmMessages(REPO_ROOT, 'worker-b');
    assert.equal(forWorkerB.length, 11);
    assert.ok(forWorkerB.every((m) => m.toAgent === 'worker-b' || m.toAgent === 'all'));
  } finally {
    if (fs.existsSync(msgBusFile)) fs.unlinkSync(msgBusFile);
  }
});

test('11. F09, F11 & F15: Batched Subagent Hook Decoding, MCP JSON-RPC Protocol Conformance & HTTP Method/Origin Guards', async () => {
  // F11: Batched invoke_subagent with two same-role workers creates two distinct RUNNING entries
  const hooksDir = path.join(REPO_ROOT, 'plugin', 'harness-ide', 'scripts', 'hooks');
  const convId = `test-f11-batch-subagents-${Date.now()}`;
  const batchHookRes = spawnSync('node', [path.join(hooksDir, 'post-tool-use.mjs')], {
    input: JSON.stringify({
      conversationId: convId,
      workspacePaths: [REPO_ROOT],
      stepIdx: 10,
      toolCall: {
        name: 'invoke_subagent',
        args: {
          Subagents: [
            {
              Role: 'Verification Engineer',
              TypeName: 'harness-verifier',
              Workspace: 'branch',
              Prompt: 'Verify module A',
            },
            {
              Role: 'Verification Engineer',
              TypeName: 'harness-verifier',
              Workspace: 'branch',
              Prompt: 'Verify module B',
            },
          ],
        },
      },
    }),
    encoding: 'utf8',
  });
  assert.equal(batchHookRes.status, 0);

  // Simulate 10 subsequent parent tool calls — neither subagent may be auto-completed by step count
  for (let s = 11; s <= 20; s++) {
    spawnSync('node', [path.join(hooksDir, 'post-tool-use.mjs')], {
      input: JSON.stringify({
        conversationId: convId,
        workspacePaths: [REPO_ROOT],
        stepIdx: s,
        toolCall: { name: 'read_file', args: { Path: 'README.md' } },
      }),
      encoding: 'utf8',
    });
  }

  const telPath = path.join(REPO_ROOT, '.harness', 'runtime', 'telemetry.json');
  const telJson = JSON.parse(fs.readFileSync(telPath, 'utf8'));
  const sessionSubs = telJson.sessions?.[convId]?.subagents || [];
  assert.equal(sessionSubs.length, 2, 'Both same-role batched subagents must be recorded distinctly');
  assert.notEqual(sessionSubs[0].id, sessionSubs[1].id);
  assert.equal(sessionSubs[0].status, 'RUNNING');
  assert.equal(sessionSubs[1].status, 'RUNNING');

  // F15: MCP JSON-RPC protocol conformance (-32601 unknown method, -32602 invalid params/protocolVersion)
  const badInit = await handleJsonRpcMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '1999-01-01' },
  });
  assert.equal(badInit.error?.code, -32602);

  const unknownMethod = await handleJsonRpcMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'unknown/method',
    params: {},
  });
  assert.equal(unknownMethod.error?.code, -32601);

  const missingParamCall = await handleJsonRpcMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'harness_query', arguments: { workspace_root: REPO_ROOT } },
  });
  assert.equal(missingParamCall.error?.code, -32602);

  // F09: Local HTTP server enforces Method (405 on GET) and Origin (403 on foreign Origin)
  const app = createHarnessMonitorApp();
  await app.run(0);
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const getMutatingRes = await fetch(`${base}/api/models/config`, { method: 'GET' });
    assert.equal(getMutatingRes.status, 405);

    const foreignOriginRes = await fetch(`${base}/api/models/config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ workspaceRoot: REPO_ROOT }),
    });
    assert.equal(foreignOriginRes.status, 403);
  } finally {
    await app.close();
  }
});

test('12. F10 & F14: Python Upstream Substrate/BenchmarkAdapter Seams & Sidecar Package Completeness', () => {
  // F14: Verify sidecars/harness-ide-monitor/package.json includes all runtime modules
  const sidecarPkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'sidecars', 'harness-ide-monitor', 'package.json'), 'utf8')
  );
  for (const requiredFile of [
    'server.mjs',
    'rag-engine.mjs',
    'model-hub.mjs',
    'secret-vault.mjs',
    'context-resilience.mjs',
  ]) {
    assert.ok(
      sidecarPkg.files.includes(requiredFile),
      `sidecars/harness-ide-monitor/package.json files array must include ${requiredFile}`
    );
  }

  // F10: Verify Python Substrate and BenchmarkAdapter methods (pinned upstream google-research/harness2 protocols)
  const pyCode = [
    'import json, tempfile, pathlib',
    'from adapters.harness2_antigravity_executor import AntigravityExecutor, AntigravityBenchmarkAdapter, Substrate, BenchmarkAdapter',
    'ex = AntigravityExecutor(workspace_root=".")',
    'surf = ex.surface()',
    'pre = ex.preflight()',
    'bench = AntigravityBenchmarkAdapter(required_files=["README.md"])',
    'ws_root_deliv = bench.delivered(".")',
    'tmp_run = pathlib.Path(tempfile.mkdtemp())',
    '(tmp_run / "deliverables").mkdir(parents=True, exist_ok=True)',
    '(tmp_run / "deliverables" / "README.md").write_text("# Delivered\\n", encoding="utf-8")',
    '(tmp_run / "receipt.json").write_text(json.dumps({"executed": True, "delivered": True, "synthetic": False, "passed_verification": True, "verification_score": 0.95}), encoding="utf-8")',
    '(tmp_run / "trajectory.json").write_text(json.dumps({"events": [{"step": 1, "action": "write_file"}]}), encoding="utf-8")',
    'deliv = bench.delivered(tmp_run)',
    'val = bench.validate_tree({"plugin.json": "{}", "AGENTS.md": "# Rules"})',
    'sc = bench.score(tmp_run, "task-01")',
    'print(json.dumps({"is_substrate": isinstance(ex, Substrate), "is_benchmark": isinstance(bench, BenchmarkAdapter), "surface_ok": hasattr(surf, "editable") or "editable_components" in surf, "preflight_ok": pre["ok"], "ws_root_rejected": ws_root_deliv is False, "delivered_ok": deliv is True, "validate_ok": val is None, "score_ok": isinstance(sc, dict) and sc.get("passed") is True}))',
  ].join('; ');
  const pyRes = spawnSync('python', ['-c', pyCode], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(pyRes.status, 0, `Python Substrate check failed: ${pyRes.stderr}`);
  const parsed = JSON.parse(pyRes.stdout.trim());
  assert.equal(parsed.is_substrate, true);
  assert.equal(parsed.is_benchmark, true);
  assert.equal(parsed.surface_ok, true);
  assert.equal(parsed.preflight_ok, true);
  assert.equal(parsed.ws_root_rejected, true);
  assert.equal(parsed.delivered_ok, true);
  assert.equal(parsed.validate_ok, true);
  assert.equal(parsed.score_ok, true);
});

test('13. CTX-01..CTX-12: Gemini 4 Argon Context Resilience (Requirement Ledger, Contract Registry, Atomic Checkpoints & Escalation)', () => {
  const tempTaskId = 'test-ctx-resilience-suite';
  const ctxMgr = new ContextResilienceManager(REPO_ROOT);
  const taskDir = ctxMgr._resolveSafeTaskDir(tempTaskId);

  try {
    // CTX-06 & CTX-07: Requirement Ledger prevents unwired UI controls (empty consumerRefs) or missing provider credentials from becoming verified
    assert.throws(
      () =>
        ctxMgr.upsertRequirementLedger(tempTaskId, {
          objective: 'Test CTX-06 unwired control rejection',
          requirements: [
            {
              id: 'REQ-UNWIRED',
              behavior: 'Unwired UI button with no backend consumer',
              state: 'verified',
              acceptanceChecks: ['check-1'],
              evidenceRefs: ['test/harness-ide.test.mjs'],
              consumerRefs: [],
            },
          ],
        }),
      /CTX-06 violation/
    );

    assert.throws(
      () =>
        ctxMgr.upsertRequirementLedger(tempTaskId, {
          objective: 'Test CTX-07 missing provider credential rejection',
          requirements: [
            {
              id: 'REQ-NO-CRED',
              behavior: 'Live external provider call without credentials',
              state: 'verified',
              requiresProviderCredentials: true,
              providerCredentialAvailable: false,
              acceptanceChecks: ['check-1'],
              evidenceRefs: ['test/harness-ide.test.mjs'],
              consumerRefs: ['src/model-hub.mjs'],
            },
          ],
        }),
      /CTX-07 violation/
    );

    // Valid Requirement Ledger upsert (using a passing non-synthetic verification verdict JSON)
    const tempVerdictRel = `.harness/runtime/verdict-ctx13-${Date.now()}.json`;
    const tempVerdictAbs = path.join(REPO_ROOT, tempVerdictRel);
    fs.mkdirSync(path.dirname(tempVerdictAbs), { recursive: true });
    fs.writeFileSync(
      tempVerdictAbs,
      JSON.stringify({ passed: true, score: 0.99, synthetic: false }, null, 2),
      'utf8'
    );
    let ledger;
    try {
      ledger = ctxMgr.upsertRequirementLedger(tempTaskId, {
        objective: 'Verify Argon Context Resilience end-to-end',
        userCorrection: 'Never expose plaintext API keys or use private host RPCs',
        requirements: [
          {
            id: 'REQ-01',
            behavior: 'Validate cross-file units and schemas',
            state: 'verified',
            acceptanceChecks: ['validateContracts returns ok: true'],
            evidenceRefs: [tempVerdictRel],
            consumerRefs: [{ file: 'src/context-resilience.mjs', symbol: 'validateContracts' }],
          },
          {
            id: 'REQ-02',
            behavior: 'Complete remaining integration',
            state: 'implemented',
          },
        ],
      });
    } finally {
      if (fs.existsSync(tempVerdictAbs)) fs.unlinkSync(tempVerdictAbs);
    }
    assert.equal(ledger.requirements.length, 2);
    assert.equal(ledger.userCorrections.length, 1);

    // CTX-01: Register contract catches unit mismatch ('ms' vs 's') immediately
    assert.throws(
      () =>
        ctxMgr.registerContract(tempTaskId, {
          contractId: 'CONTRACT-TIMEOUT-MISMATCH',
          symbolName: 'workerTimeout',
          unit: 'ms',
          consumerUnit: 's',
        }),
      /CTX-01 Unit mismatch/
    );

    // CTX-02 & CTX-05: Register contract and detect key drift when storageKey is absent from consumer file
    ctxMgr.registerContract(tempTaskId, {
      contractId: 'CONTRACT-KEY-DRIFT',
      symbolName: 'activeModelId',
      storageKey: 'NON_EXISTENT_DRIFTED_STORAGE_KEY_999',
      unit: 'string',
      consumerUnit: 'string',
      producerFile: 'README.md',
      consumerFile: 'README.md',
    });
    const validation = ctxMgr.validateContracts(tempTaskId);
    assert.equal(validation.ok, false);
    assert.ok(validation.issues.some((i) => i.code === 'CTX-02_KEY_DRIFT_PRODUCER'));
    assert.ok(validation.issues.some((i) => i.code === 'CTX-02_KEY_DRIFT_CONSUMER'));

    // CTX-04, CTX-09 & CTX-10: Atomic checkpoint write + recovery from simulated interruption before pointer swap
    const cp1 = ctxMgr.writeCheckpoint(tempTaskId, {
      activeWorkers: [
        {
          workerId: 'worker-sub-1',
          parentId: 'main-orchestrator',
          ownership: ['src/context-resilience.mjs'],
          openChecks: ['REQ-02'],
        },
      ],
      nextAction: 'Verify REQ-02',
    });
    assert.equal(cp1.checkpointRevision, 1);
    assert.equal(cp1.contextMetrics.quality, 'unavailable');

    assert.throws(
      () =>
        ctxMgr.writeCheckpoint(tempTaskId, {
          nextAction: 'Interrupted checkpoint',
          simulateCrashBeforePointerSwap: true,
        }),
      /CTX-09 simulated interruption/
    );

    // Current checkpoint pointer still points to intact rev 1
    const loadedCp = ctxMgr.loadLatestCheckpoint(tempTaskId);
    assert.equal(loadedCp.checkpointRevision, 1);
    assert.equal(loadedCp.nextAction, 'Verify REQ-02');

    // CTX-04: Subagent resume state restoration from checkpoint
    const restoredWorker = ctxMgr.restoreSubagentFromCheckpoint(tempTaskId, 'worker-sub-1');
    assert.equal(restoredWorker.ok, true);
    assert.equal(restoredWorker.workerId, 'worker-sub-1');
    assert.deepEqual(restoredWorker.ownership, ['src/context-resilience.mjs']);
    assert.equal(restoredWorker.materialUserCorrections.length, 1);

    // CTX-08: Bounded tool output externalization
    const largeLog = Array.from(
      { length: 100 },
      (_, i) => `Line ${i + 1}: ERROR_CODE_42 failure detail`
    ).join('\n');
    const bounded = ctxMgr.storeBoundedToolOutput(tempTaskId, 'npm_test', largeLog, 300);
    assert.equal(bounded.stored, true);
    assert.equal(bounded.truncated, true);
    assert.ok(fs.existsSync(path.join(REPO_ROOT, bounded.artifactRef)));

    // CTX-11: Provenance vs. source conflict resolution (present source code wins over stale note)
    const conflictRes = ctxMgr.resolveNoteVsSourceConflict({
      retrievedNote: { docid: 'EXP-OLD-001' },
      sourceFile: 'package.json',
    });
    assert.equal(conflictRes.authority, 'present_source_code');
    assert.equal(conflictRes.reReadSourceRequired, true);

    // CTX-12: Bounded no-progress escalation after 3 stagnant attempts
    ctxMgr.recordAttemptProgress(tempTaskId, { madeProgress: false, maxStagnantAttempts: 3 });
    ctxMgr.recordAttemptProgress(tempTaskId, { madeProgress: false, maxStagnantAttempts: 3 });
    const attempt3 = ctxMgr.recordAttemptProgress(tempTaskId, {
      madeProgress: false,
      maxStagnantAttempts: 3,
    });
    assert.equal(attempt3.shouldStopRetryLoop, true);
    assert.equal(attempt3.status, 'escalated_focused_restart');
  } finally {
    if (fs.existsSync(taskDir)) {
      fs.rmSync(taskDir, { recursive: true, force: true });
    }
  }
});

test('14. WP1: Pre-Existing File Rejection, Async/Low-Score Evaluator Handling, Python Strict Loop & Cryptographic Evaluation Receipts', async () => {
  const engine = new HarnessKnowledgeEngine(REPO_ROOT);

  // 1. Supplying an unrelated, pre-existing artifact (README.md) with allowSimulation: false and no executor must FAIL
  const preExistingRun = engine.runHarness2Loop({
    taskId: 'wp1-preexisting-file-test',
    problem: 'Ensure pre-existing unchanged README.md is never treated as candidate execution evidence',
    domain: 'software-engineering',
    allowSimulation: false,
    requiredArtifacts: ['README.md'],
  });
  assert.equal(preExistingRun.ok, false, 'Pre-existing unchanged file must not pass as verified work');
  assert.equal(preExistingRun.status, 'failed');
  assert.equal(preExistingRun.passedVerification, false);
  assert.equal(preExistingRun.synthetic, false);
  assert.equal(preExistingRun.recordedExperience, null);

  // 2. Evaluator returning empty object {} must fail
  const emptyObjEvalRun = engine.runHarness2Loop({
    taskId: 'wp1-empty-obj-eval',
    problem: 'Empty evaluator object must fail',
    domain: 'software-engineering',
    allowSimulation: false,
    evaluator: () => ({}),
  });
  assert.equal(emptyObjEvalRun.ok, false);
  assert.equal(emptyObjEvalRun.passedVerification, false);

  // 3. Asynchronous evaluator returning Promise<false> must be awaited and fail
  const asyncFalseRun = await engine.runHarness2Loop({
    taskId: 'wp1-async-false-eval',
    problem: 'Async evaluator returning false must fail',
    domain: 'software-engineering',
    allowSimulation: false,
    evaluator: async () => false,
  });
  assert.equal(asyncFalseRun.ok, false);
  assert.equal(asyncFalseRun.passedVerification, false);

  // 4. Supplied evaluator score of 0.12 must NEVER be overwritten by formula 0.90
  const lowScoreRun = await engine.runHarness2Loop({
    taskId: 'wp1-low-score-eval',
    problem: 'Evaluator score 0.12 must be preserved',
    domain: 'software-engineering',
    allowSimulation: false,
    evaluator: async () => ({ passed: false, score: 0.12, observedTokens: 1450 }),
  });
  assert.equal(lowScoreRun.ok, false);
  assert.equal(lowScoreRun.passedVerification, false);
  assert.equal(lowScoreRun.verificationScore, 0.12);
  assert.equal(lowScoreRun.winner.totalTokens, 1450);

  // 5. Python ordinary run_loop defaults to allow_simulation=False and fails closed without real execution
  const pyFailClosed = spawnSync(
    'python',
    [
      '-c',
      [
        'import json',
        'from adapters.harness2_antigravity_executor import AntigravityExecutor',
        'ex = AntigravityExecutor(workspace_root=".")',
        'res = ex.run_loop(task_id="wp1-py-no-sim", problem="Create non-existent artifact without credentials", required_files=[".harness/runtime/non-existent-wp1.txt"])',
        'print(json.dumps(res))',
      ].join('; '),
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10000 }
  );
  assert.equal(pyFailClosed.status, 0, pyFailClosed.stderr);
  const pyRes = JSON.parse(pyFailClosed.stdout.trim());
  assert.equal(pyRes.ok, false);
  assert.equal(pyRes.winner.passed_verification, false);
  assert.equal(pyRes.recordedExperience, null);

  // 6. Cryptographic Evaluation Receipt gate for promotion + recordExperience defaults to candidate
  const tempTaskId = `task-wp1-receipt-${Date.now()}`;
  const tempArtifactRel = `.harness/runtime/wp1-artifact-${Date.now()}.txt`;
  const tempArtifactAbs = path.join(REPO_ROOT, tempArtifactRel);
  const tempTaskDir = path.join(
    REPO_ROOT,
    '.harness',
    'library',
    'software-engineering',
    'harnesses',
    tempTaskId
  );
  let createdReceiptId = null;
  let promotedAdrPath = null;

  try {
    fs.mkdirSync(path.dirname(tempArtifactAbs), { recursive: true });
    fs.writeFileSync(tempArtifactAbs, 'WP1 verified artifact content\n', 'utf8');
    const expectedSha = crypto
      .createHash('sha256')
      .update(fs.readFileSync(tempArtifactAbs))
      .digest('hex');

    // recordExperience defaults to 'candidate' when status is omitted
    const rec = engine.recordExperience({
      task_id: tempTaskId,
      domain: 'software-engineering',
      title: 'WP1 Receipt Gate Test Lesson',
      problem: 'Test receipt-gated promotion',
      observed_behavior: 'Candidate produced verified artifact',
      supporting_evidence: [tempArtifactRel],
    });
    assert.equal(rec.status, 'candidate');

    // Caller-asserted inline object or verified: true without stored cryptographic receipt MUST be rejected
    const fakePromote = engine.promoteExperienceToProjectKnowledge({
      task_id_or_docid: tempTaskId,
      verified: true,
      evaluationReceipt: { passed: true, score: 0.99 },
    });
    assert.equal(fakePromote.ok, false);
    assert.equal(fakePromote.error, 'PROMOTION_REQUIRES_EVALUATION_RECEIPT');

    // Issue a real HMAC-SHA256 evaluation receipt bound to tempTaskId and tempArtifactRel
    const receipt = engine.createEvaluationReceipt({
      taskId: tempTaskId,
      candidateId: 'CAND-WP1-1',
      artifactHashes: { [tempArtifactRel]: expectedSha },
      checks: [{ name: 'artifact_check', passed: true }],
      passed: true,
      score: 0.95,
    });
    assert.equal(receipt.ok, true);
    createdReceiptId = receipt.receiptId;

    // Tamper with the artifact on disk -> receipt verification must fail with RECEIPT_ARTIFACT_HASH_MISMATCH
    fs.writeFileSync(tempArtifactAbs, 'TAMPERED CONTENT\n', 'utf8');
    const tamperedPromote = engine.promoteExperienceToProjectKnowledge({
      task_id_or_docid: tempTaskId,
      receiptId: createdReceiptId,
    });
    assert.equal(tamperedPromote.ok, false);
    assert.equal(tamperedPromote.detail, 'RECEIPT_ARTIFACT_HASH_MISMATCH');

    // Restore original artifact content -> promotion succeeds
    fs.writeFileSync(tempArtifactAbs, 'WP1 verified artifact content\n', 'utf8');
    const validPromote = engine.promoteExperienceToProjectKnowledge({
      task_id_or_docid: tempTaskId,
      adr_id: `ADR-WP1-${Date.now()}`,
      receiptId: createdReceiptId,
    });
    assert.equal(validPromote.ok, true);
    assert.equal(validPromote.promoted, true);
    promotedAdrPath = path.join(REPO_ROOT, validPromote.adrPath || validPromote.path);
  } finally {
    if (fs.existsSync(tempArtifactAbs)) fs.unlinkSync(tempArtifactAbs);
    if (fs.existsSync(tempTaskDir)) fs.rmSync(tempTaskDir, { recursive: true, force: true });
    if (createdReceiptId) {
      const rFile = path.join(REPO_ROOT, '.harness', 'receipts', `${createdReceiptId}.json`);
      if (fs.existsSync(rFile)) fs.unlinkSync(rFile);
    }
    if (promotedAdrPath && fs.existsSync(promotedAdrPath)) {
      fs.unlinkSync(promotedAdrPath);
    }
    engine.buildIndex();
  }
});

test('15. WP2 & WP3: Packaged 16-Tool MCP Parity Outside Source Tree, Strict Policy Propagation & Idempotent Message Bus', async () => {
  // Spawn the exact packaged plugin entry (`plugin/harness-ide/scripts/mcp-entry.mjs`) with cwd set to os.tmpdir()
  const pluginMcpEntry = path.join(REPO_ROOT, 'plugin', 'harness-ide', 'scripts', 'mcp-entry.mjs');
  assert.ok(fs.existsSync(pluginMcpEntry), 'Packaged plugin mcp-entry.mjs must exist');

  const rpcRequests = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'unknown/method',
      params: {},
    },
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'harness_model_invoke',
        arguments: {
          workspace_root: REPO_ROOT,
          model_id: 'deepseek-v4-pro',
          prompt: 'Strict invocation without credentials',
          strict_execution: true,
        },
      },
    },
  ];

  const procRes = spawnSync('node', [pluginMcpEntry], {
    cwd: os.tmpdir(),
    input: rpcRequests.map((r) => JSON.stringify(r)).join('\n') + '\n',
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: '',
      OPENCODE_API_KEY: '',
      OPENCODE_GO_API_KEY: '',
    },
  });
  assert.equal(procRes.status, 0, `Packaged MCP entry failed: ${procRes.stderr}`);
  const lines = procRes.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  // Verify 16 tools advertised by packaged plugin entry
  const toolsListRes = lines.find((m) => m.id === 2);
  assert.ok(toolsListRes?.result?.tools, 'tools/list must return tools array');
  assert.equal(
    toolsListRes.result.tools.length,
    16,
    `Packaged plugin MCP entry must advertise all 16 tools, got ${toolsListRes.result.tools.length}`
  );
  for (const expectedTool of [
    'harness_model_invoke',
    'harness_web_search',
    'harness_message_inject',
    'harness_self_improve',
    'harness_task_ledger',
    'harness_checkpoint',
  ]) {
    assert.ok(
      toolsListRes.result.tools.some((t) => t.name === expectedTool),
      `Packaged MCP entry missing ${expectedTool}`
    );
  }

  // Verify unknown method returns -32601
  const unknownRes = lines.find((m) => m.id === 3);
  assert.equal(unknownRes?.error?.code, -32601);

  // Verify strict_execution is propagated through MCP harness_model_invoke
  const strictCallRes = lines.find((m) => m.id === 4);
  const strictPayload = JSON.parse(strictCallRes.result.content[0].text);
  assert.equal(strictPayload.ok, false);
  assert.equal(strictPayload.status, 'unauthorized');

  // Verify searchWebMultiEngine returns status: 'empty' and results: [] when no engine produces hits and demoMode is false
  const emptySearch = await searchWebMultiEngine(REPO_ROOT, {
    query: 'xyzzynonexistentquery987654321',
    engine: 'tavily',
    demoMode: false,
  });
  assert.equal(emptySearch.status, 'empty');
  assert.deepEqual(emptySearch.results, []);
  assert.ok(!emptySearch.synthetic);

  // Verify message bus idempotency on consumed message IDs & DELIVERY_FAILED on disabled provider
  const msgBusFile = path.join(REPO_ROOT, '.harness', 'runtime', 'message-bus.json');
  const hubCfgBefore = loadHubConfig(REPO_ROOT);
  try {
    if (fs.existsSync(msgBusFile)) fs.unlinkSync(msgBusFile);

    const fixedId = `MSG-IDEMPOTENT-${Date.now()}`;
    const firstSend = await injectOrConveySwarmMessage(REPO_ROOT, {
      id: fixedId,
      fromAgent: 'main-orchestrator',
      toAgent: 'worker-idempotent',
      type: 'CONVEY_CONTEXT',
      content: 'Deliver once only',
      executeModelCall: false,
    });
    assert.equal(firstSend.ok, true);
    assert.equal(firstSend.message.consumed, false);

    // Consume message for worker-idempotent
    const consumedList = consumePendingSwarmMessages(REPO_ROOT, 'worker-idempotent');
    assert.equal(consumedList.length, 1);
    assert.equal(consumedList[0].id, fixedId);
    assert.equal(consumedList[0].consumed, true);

    // Retry injecting the SAME message ID -> must return idempotentDuplicate: true and preserve consumed: true
    const duplicateSend = await injectOrConveySwarmMessage(REPO_ROOT, {
      id: fixedId,
      fromAgent: 'main-orchestrator',
      toAgent: 'worker-idempotent',
      type: 'CONVEY_CONTEXT',
      content: 'Duplicate retry',
      executeModelCall: false,
    });
    assert.equal(duplicateSend.ok, true);
    assert.equal(duplicateSend.idempotentDuplicate, true);
    assert.equal(duplicateSend.message.consumed, true);
    assert.equal(consumePendingSwarmMessages(REPO_ROOT, 'worker-idempotent').length, 0);

    // Disabled provider with executeModelCall: true must report status: 'DELIVERY_FAILED' and ok: false
    saveHubConfig(REPO_ROOT, {
      providers: { deepseek: { enabled: false } },
    });
    const failedDelivery = await injectOrConveySwarmMessage(REPO_ROOT, {
      fromAgent: 'main-orchestrator',
      toAgent: 'deepseek-peer-reasoner',
      targetModelId: 'deepseek-v4-pro',
      content: 'Should fail delivery when provider disabled',
      executeModelCall: true,
    });
    assert.equal(failedDelivery.ok, false);
    assert.equal(failedDelivery.message.status, 'DELIVERY_FAILED');
  } finally {
    saveHubConfig(REPO_ROOT, hubCfgBefore);
    if (fs.existsSync(msgBusFile)) fs.unlinkSync(msgBusFile);
  }
});

test('16. WP4 & WP5: Public Antigravity Interfaces, Default Rule Deployment, Comment-Stripped Contracts & Live Context Recovery', () => {
  // 1. Static scan: setup.mjs and sidecars/harness-ide-monitor/server.mjs must contain ZERO private host RPCs
  const setupSrc = fs.readFileSync(path.join(REPO_ROOT, 'setup.mjs'), 'utf8');
  const serverSrc = fs.readFileSync(
    path.join(REPO_ROOT, 'sidecars', 'harness-ide-monitor', 'server.mjs'),
    'utf8'
  );
  for (const forbidden of [
    'JetboxWriteState',
    'GetAllCascadeTrajectories',
    'manageSidecar',
    'getSidecars',
    'killSidecarProcessByPortOrPid',
    '/__launcher/retry',
  ]) {
    assert.ok(!setupSrc.includes(forbidden), `setup.mjs must not reference ${forbidden}`);
    assert.ok(!serverSrc.includes(forbidden), `server.mjs must not reference ${forbidden}`);
  }

  // 2. Verify gravity-well-default.md is deployed into plugin/harness-ide/rules/gravity-well-default.md
  const pluginRulePath = path.join(
    REPO_ROOT,
    'plugin',
    'harness-ide',
    'rules',
    'gravity-well-default.md'
  );
  assert.ok(fs.existsSync(pluginRulePath), 'plugin/harness-ide/rules/gravity-well-default.md must exist');

  // 3. WP5 ContextResilienceManager: comment-only symbols, missing evidence files, contract drift demotion, monotonic checkpoints & live worker recovery
  const tempTaskId = `test-wp5-live-recovery-${Date.now()}`;
  const ctxMgr = new ContextResilienceManager(REPO_ROOT);
  const taskDir = ctxMgr._resolveSafeTaskDir(tempTaskId);
  const tempSourceRel = `.harness/runtime/wp5-consumer-${Date.now()}.mjs`;
  const tempSourceAbs = path.join(REPO_ROOT, tempSourceRel);
  const tempVerdictRel = `.harness/runtime/wp5-verdict-${Date.now()}.json`;
  const tempVerdictAbs = path.join(REPO_ROOT, tempVerdictRel);

  try {
    fs.mkdirSync(path.dirname(tempSourceAbs), { recursive: true });
    // File has `commentedOutHandler` ONLY inside a comment
    fs.writeFileSync(
      tempSourceAbs,
      '// commentedOutHandler is not implemented yet\nexport function activeHandler() { return "ACT_KEY_1"; }\n',
      'utf8'
    );
    fs.writeFileSync(
      tempVerdictAbs,
      JSON.stringify({ passed: true, score: 0.98, synthetic: false }, null, 2),
      'utf8'
    );

    // Rejects consumerRef whose symbol only appears in comments
    assert.throws(
      () =>
        ctxMgr.upsertRequirementLedger(tempTaskId, {
          objective: 'Test comment-stripped consumer symbol check',
          requirements: [
            {
              id: 'REQ-COMMENT-ONLY',
              behavior: 'Must fail if symbol is only in comments',
              state: 'verified',
              acceptanceChecks: ['symbol check'],
              evidenceRefs: [tempVerdictRel],
              consumerRefs: [{ file: tempSourceRel, symbol: 'commentedOutHandler' }],
            },
          ],
        }),
      /in executable code \(comments and string literals excluded\)/
    );

    // Rejects nonexistent evidenceRef
    assert.throws(
      () =>
        ctxMgr.upsertRequirementLedger(tempTaskId, {
          objective: 'Test nonexistent evidenceRef rejection',
          requirements: [
            {
              id: 'REQ-MISSING-EVIDENCE',
              behavior: 'Must fail if evidence file does not exist',
              state: 'verified',
              acceptanceChecks: ['evidence check'],
              evidenceRefs: ['.harness/runtime/does-not-exist-99999.txt'],
              consumerRefs: [{ file: tempSourceRel, symbol: 'activeHandler' }],
            },
          ],
        }),
      /does not exist on disk/
    );

    // Valid verified requirement referencing real activeHandler + real passing verification verdict JSON
    ctxMgr.upsertRequirementLedger(tempTaskId, {
      objective: 'Live recovery & contract drift invalidation',
      userCorrection: 'Always verify live files before claiming verified',
      requirements: [
        {
          id: 'REQ-LIVE-01',
          behavior: 'Maintain ACT_KEY_1 contract between producer and consumer',
          state: 'verified',
          acceptanceChecks: ['ACT_KEY_1 present'],
          evidenceRefs: [tempVerdictRel],
          consumerRefs: [{ file: tempSourceRel, symbol: 'activeHandler' }],
        },
      ],
    });

    ctxMgr.registerContract(tempTaskId, {
      contractId: 'CONTRACT-ACT-KEY',
      symbolName: 'activeHandler',
      storageKey: 'ACT_KEY_1',
      unit: 'ms',
      consumerUnit: 'ms',
      producerFile: tempSourceRel,
      consumerFile: tempSourceRel,
    });
    assert.equal(ctxMgr.validateContracts(tempTaskId).ok, true);

    // Checkpoint monotonic revision allocation after simulated crash
    const cp1 = ctxMgr.writeCheckpoint(tempTaskId, {
      activeWorkers: [
        {
          workerId: 'worker-live-1',
          parentId: 'main-orchestrator',
          ownership: [tempSourceRel],
          openChecks: ['REQ-LIVE-01'],
        },
      ],
      nextAction: 'Step 1',
    });
    assert.equal(cp1.checkpointRevision, 1);

    // Simulated crash leaves rev-2.json on disk without updating pointer
    assert.throws(() =>
      ctxMgr.writeCheckpoint(tempTaskId, {
        nextAction: 'Crashed Step 2',
        simulateCrashBeforePointerSwap: true,
      })
    );

    // Next checkpoint must allocate rev-3 (never overwriting rev-2)
    const cp3 = ctxMgr.writeCheckpoint(tempTaskId, {
      activeWorkers: [
        {
          workerId: 'worker-live-1',
          parentId: 'main-orchestrator',
          ownership: [tempSourceRel],
          openChecks: ['REQ-LIVE-01'],
        },
      ],
      nextAction: 'Step 3 after crash',
    });
    assert.equal(cp3.checkpointRevision, 3);

    // Mutate tempSourceAbs to remove ACT_KEY_1 AND add a new userCorrection AFTER the checkpoint!
    fs.writeFileSync(
      tempSourceAbs,
      'export function activeHandler() { return "DRIFTED_KEY_2"; }\n',
      'utf8'
    );
    ctxMgr.upsertRequirementLedger(tempTaskId, {
      userCorrection: 'Post-checkpoint correction: handle DRIFTED_KEY_2',
    });

    // Live worker recovery must reflect the post-checkpoint userCorrection AND demote REQ-LIVE-01 to implemented_unverified!
    const recovery = ctxMgr.restoreSubagentFromCheckpoint(tempTaskId, 'worker-live-1', {
      executorSessionId: 'SESSION-RESUMED-42',
    });
    assert.equal(recovery.ok, true);
    assert.equal(recovery.executorSessionId, 'SESSION-RESUMED-42');
    assert.equal(recovery.contractValidation.ok, false);
    assert.ok(recovery.invalidatedRequirements.includes('REQ-LIVE-01'));
    assert.equal(recovery.materialUserCorrections.length, 2);

    const ack = ctxMgr.acknowledgeRecoveryPacket(tempTaskId, 'worker-live-1', {
      executorSessionId: 'SESSION-RESUMED-42',
      checkpointRevision: recovery.checkpointRevision,
      recoveryToken: recovery.recoveryToken,
    });
    assert.equal(ack.ok, true);
  } finally {
    if (fs.existsSync(tempSourceAbs)) fs.unlinkSync(tempSourceAbs);
    if (fs.existsSync(tempVerdictAbs)) fs.unlinkSync(tempVerdictAbs);
    if (fs.existsSync(taskDir)) fs.rmSync(taskDir, { recursive: true, force: true });
  }
});

test('17. WP6, WP7 & WP8: Multi-Process Concurrency, Symlink Containment, Authenticated Monitor, Zero-Event Telemetry & Installed End-to-End Task', async () => {
  // 1. Multi-process concurrent Requirement Ledger updates (10 parallel workers -> 0 lost updates)
  const concTaskId = `test-wp6-concurrent-ledger-${Date.now()}`;
  const ctxMgr = new ContextResilienceManager(REPO_ROOT);
  const concTaskDir = ctxMgr._resolveSafeTaskDir(concTaskId);

  try {
    const workerProcs = Array.from({ length: 10 }, (_, idx) => {
      const reqId = `REQ-CONC-${String(idx + 1).padStart(2, '0')}`;
      return new Promise((resolve, reject) => {
        const child = spawn(
          'node',
          [
            '-e',
            `import('./src/context-resilience.mjs').then(({ ContextResilienceManager }) => {
              const m = new ContextResilienceManager(process.cwd());
              m.upsertRequirementLedger(${JSON.stringify(concTaskId)}, {
                userCorrection: ${JSON.stringify(`Correction-${idx + 1}`)},
                requirements: [{ id: ${JSON.stringify(reqId)}, behavior: 'Concurrent requirement', state: 'implemented' }]
              });
            });`,
          ],
          { cwd: REPO_ROOT, stdio: 'pipe' }
        );
        let stderr = '';
        child.stderr.on('data', (d) => (stderr += d.toString()));
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Worker ${idx} exited ${code}: ${stderr}`));
        });
      });
    });
    await Promise.all(workerProcs);
    const mergedLedger = ctxMgr.loadRequirementLedger(concTaskId);
    assert.equal(
      mergedLedger.requirements.length,
      10,
      `All 10 concurrent requirements must be preserved, got ${mergedLedger.requirements.length}`
    );
    assert.equal(mergedLedger.userCorrections.length, 10);
  } finally {
    if (fs.existsSync(concTaskDir)) fs.rmSync(concTaskDir, { recursive: true, force: true });
  }

  // 2. Fail-closed lock timeout verification for Vault and Message Bus
  const globalCfgDir = path.join(os.homedir(), '.gemini', 'config');
  fs.mkdirSync(globalCfgDir, { recursive: true });
  const vaultLockPath = path.join(globalCfgDir, '.vault.lock');
  fs.writeFileSync(
    vaultLockPath,
    JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
    'utf8'
  );
  try {
    assert.throws(
      () => withVaultLock(() => 'should-not-run', 60),
      (err) => err.code === 'VAULT_LOCK_TIMEOUT'
    );
  } finally {
    if (fs.existsSync(vaultLockPath)) fs.unlinkSync(vaultLockPath);
  }

  const msgLockPath = path.join(REPO_ROOT, '.harness', 'runtime', 'message-bus.lock');
  fs.mkdirSync(path.dirname(msgLockPath), { recursive: true });
  fs.writeFileSync(
    msgLockPath,
    JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
    'utf8'
  );
  try {
    assert.throws(
      () => withMessageBusLock(REPO_ROOT, () => 'should-not-run', 60),
      (err) => err.code === 'MESSAGE_BUS_LOCK_TIMEOUT'
    );
  } finally {
    if (fs.existsSync(msgLockPath)) fs.unlinkSync(msgLockPath);
  }

  // 3. Snapshot lock contention in runHarness2Loop: must abort without releasing incumbent lock
  const engine = new HarnessKnowledgeEngine(REPO_ROOT);
  const incumbentLock = engine.createSnapshotLock({
    domain: 'software-engineering',
    k: 2,
    mode: 'parallel',
    description: 'Incumbent snapshot lock',
  });
  assert.equal(incumbentLock.ok, true);
  try {
    const contendedRun = engine.runHarness2Loop({
      taskId: 'wp3-contended-run',
      problem: 'Contended loop must not release incumbent lock',
      domain: 'software-engineering',
      allowSimulation: true,
    });
    assert.equal(contendedRun.ok, false);
    assert.equal(contendedRun.error, 'SNAPSHOT_LOCK_ACTIVE_BY_ANOTHER_RUN');
    const stillActive = engine.getActiveSnapshotLock();
    assert.equal(stillActive.active, true);
    assert.equal(stillActive.snapshotId, incumbentLock.snapshotId);
  } finally {
    engine.releaseSnapshotLock();
    const snapFile = path.join(
      REPO_ROOT,
      '.harness',
      'snapshots',
      `${incumbentLock.snapshotId}.json`
    );
    if (fs.existsSync(snapFile)) fs.unlinkSync(snapFile);
  }

  // 4. Hook manage_subagents error preservation vs CANCELLED state
  const hooksDir = path.join(REPO_ROOT, 'plugin', 'harness-ide', 'scripts', 'hooks');
  const convId = `test-wp6-hook-cancel-${Date.now()}`;
  spawnSync('node', [path.join(hooksDir, 'post-tool-use.mjs')], {
    input: JSON.stringify({
      conversationId: convId,
      workspacePaths: [REPO_ROOT],
      stepIdx: 1,
      toolCall: {
        name: 'invoke_subagent',
        args: { Role: 'Cancelable Worker', TypeName: 'self', Workspace: 'branch' },
        result: { conversationId: 'sub-cancel-1' },
      },
    }),
    encoding: 'utf8',
  });

  // Failed manage_subagents call must keep sub-cancel-1 RUNNING
  spawnSync('node', [path.join(hooksDir, 'post-tool-use.mjs')], {
    input: JSON.stringify({
      conversationId: convId,
      workspacePaths: [REPO_ROOT],
      stepIdx: 2,
      toolCall: {
        name: 'manage_subagents',
        args: { Action: 'kill', ConversationIds: ['sub-cancel-1'] },
        status: 'ERROR',
        error: 'Failed to kill worker',
      },
    }),
    encoding: 'utf8',
  });
  let telJson = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, '.harness', 'runtime', 'telemetry.json'), 'utf8')
  );
  assert.equal(telJson.sessions?.[convId]?.subagents?.[0]?.status, 'RUNNING');

  // Successful manage_subagents kill marks worker CANCELLED (not COMPLETED)
  spawnSync('node', [path.join(hooksDir, 'post-tool-use.mjs')], {
    input: JSON.stringify({
      conversationId: convId,
      workspacePaths: [REPO_ROOT],
      stepIdx: 3,
      toolCall: {
        name: 'manage_subagents',
        args: { Action: 'kill', ConversationIds: ['sub-cancel-1'] },
        status: 'DONE',
      },
    }),
    encoding: 'utf8',
  });
  telJson = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, '.harness', 'runtime', 'telemetry.json'), 'utf8')
  );
  assert.equal(telJson.sessions?.[convId]?.subagents?.[0]?.status, 'CANCELLED');

  // 5. Authenticated Monitor, Strict URL-Parsed Origin, Zero-Event Empty Workspace Telemetry & Unknown Worker Recall Rejection
  const emptyWs = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-empty-ws-'));
  const app = createHarnessMonitorApp({
    requireAuth: true,
    sessionToken: 'test-session-token-wp6',
    registeredWorkspaces: [REPO_ROOT, emptyWs],
  });
  await app.run(0);
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const authHeaders = {
      'Content-Type': 'application/json',
      'X-Sidecar-Token': 'test-session-token-wp6',
    };

    // Spoofed prefix origin http://127.0.0.1.evil.com must be rejected with 403
    const spoofOriginRes = await fetch(`${base}/api/status`, {
      headers: {
        ...authHeaders,
        Origin: 'http://127.0.0.1.evil.com',
      },
    });
    assert.equal(spoofOriginRes.status, 403);

    // Missing token when requireAuth: true must be rejected with 401
    const noTokenRes = await fetch(`${base}/api/status`);
    assert.equal(noTokenRes.status, 401);

    // Zero-event empty workspace must report telemetryQuality: 'unavailable', observedSteps: 0, observedTokens: null
    const dashRes = await fetch(
      `${base}/api/dashboard?workspaceRoot=${encodeURIComponent(emptyWs)}`,
      { headers: authHeaders }
    );
    assert.equal(dashRes.status, 200);
    const dashData = await dashRes.json();
    assert.equal(dashData.telemetryQuality, 'unavailable');
    assert.equal(dashData.contextAnalytics.observedSteps, 0);
    assert.equal(dashData.contextAnalytics.observedTokens, null);
    assert.equal(dashData.swarm.observedSubagentCount, 0);

    // Unknown worker recall must be rejected with 404 and ok: false
    const recallUnknownRes = await fetch(`${base}/api/swarm/recall`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        workspaceRoot: emptyWs,
        nodeId: 'unknown-nonexistent-worker-999',
      }),
    });
    assert.equal(recallUnknownRes.status, 404);
    const recallUnknownJson = await recallUnknownRes.json();
    assert.equal(recallUnknownJson.ok, false);
  } finally {
    await app.close();
    fs.rmSync(emptyWs, { recursive: true, force: true });
  }

  // 6. WP7 Installed End-to-End Task Gate through the packaged plugin MCP entry
  const e2eWs = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-wp7-e2e-'));
  const pluginMcpEntry = path.join(REPO_ROOT, 'plugin', 'harness-ide', 'scripts', 'mcp-entry.mjs');
  try {
    // Initialize .harness directories and a real source consumer file + verdict file in e2eWs
    const e2eEngine = new HarnessKnowledgeEngine(e2eWs);
    e2eEngine.ensureDirectories();
    fs.mkdirSync(path.join(e2eWs, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(e2eWs, 'src', 'feature.mjs'),
      'export function runVerifiedFeature() { return "WP7_CONTRACT_KEY"; }\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(e2eWs, '.harness', 'runtime', 'wp7-verdict.json'),
      JSON.stringify({ passed: true, score: 0.99, synthetic: false }, null, 2),
      'utf8'
    );

    // Step A: Register task ledger & contract via MCP harness_task_ledger
    const ledgerCall = await handleToolCall('harness_task_ledger', {
      workspace_root: e2eWs,
      action: 'upsert',
      task_id: 'task-wp7-e2e',
      objective: 'Deliver verified WP7 feature artifact end-to-end',
      user_correction: 'Require cryptographic receipt before promotion',
      requirements: [
        {
          id: 'REQ-WP7-1',
          behavior: 'Create src/feature.mjs with runVerifiedFeature and WP7_CONTRACT_KEY',
          state: 'verified',
          acceptanceChecks: ['runVerifiedFeature returns WP7_CONTRACT_KEY'],
          evidenceRefs: ['.harness/runtime/wp7-verdict.json'],
          consumerRefs: [{ file: 'src/feature.mjs', symbol: 'runVerifiedFeature' }],
        },
      ],
    });
    assert.equal(ledgerCall.taskId, 'task-wp7-e2e');

    const contractCall = await handleToolCall('harness_task_ledger', {
      workspace_root: e2eWs,
      action: 'register_contract',
      task_id: 'task-wp7-e2e',
      contract_id: 'CONTRACT-WP7',
      symbol_name: 'runVerifiedFeature',
      storage_key: 'WP7_CONTRACT_KEY',
      unit: 'string',
      consumer_unit: 'string',
      producer_file: 'src/feature.mjs',
      consumer_file: 'src/feature.mjs',
    });
    assert.equal(contractCall.contractId, 'CONTRACT-WP7');

    // Step B: Write checkpoint, simulate interruption, and restore + acknowledge worker recovery via MCP harness_checkpoint
    const cpWrite = await handleToolCall('harness_checkpoint', {
      workspace_root: e2eWs,
      action: 'write',
      task_id: 'task-wp7-e2e',
      active_workers: [
        {
          workerId: 'wp7-worker-1',
          parentId: 'main-orchestrator',
          ownership: ['src/feature.mjs'],
          openChecks: [],
        },
      ],
      next_action: 'Run evaluator and promote lesson',
    });
    assert.equal(cpWrite.checkpointRevision, 1);

    const workerRestore = await handleToolCall('harness_checkpoint', {
      workspace_root: e2eWs,
      action: 'restore_subagent',
      task_id: 'task-wp7-e2e',
      worker_id: 'wp7-worker-1',
      executor_session_id: 'WP7-SESSION-1',
    });
    assert.equal(workerRestore.ok, true);
    assert.equal(workerRestore.contractValidation.ok, true);

    const workerAck = await handleToolCall('harness_checkpoint', {
      workspace_root: e2eWs,
      action: 'acknowledge_recovery',
      task_id: 'task-wp7-e2e',
      worker_id: 'wp7-worker-1',
      executor_session_id: 'WP7-SESSION-1',
      checkpoint_revision: workerRestore.checkpointRevision,
      recovery_token: workerRestore.recoveryToken,
    });
    assert.equal(workerAck.ok, true);

    // Step C: Execute a real candidate via runHarness2Loop (allowSimulation: false) that creates a new artifact and passes real evaluation
    const loopRes = await e2eEngine.runHarness2Loop({
      taskId: 'task-wp7-e2e',
      problem: 'Generate verified WP7 output artifact',
      domain: 'software-engineering',
      allowSimulation: false,
      requiredArtifacts: ['src/wp7-delivered.json'],
      executor: async ({ candidate }) => {
        fs.writeFileSync(
          path.join(e2eWs, 'src', 'wp7-delivered.json'),
          JSON.stringify({ deliveredBy: candidate.id, contract: 'WP7_CONTRACT_KEY' }, null, 2),
          'utf8'
        );
        return { observedTokens: 1820 };
      },
      evaluator: async () => {
        const raw = JSON.parse(
          fs.readFileSync(path.join(e2eWs, 'src', 'wp7-delivered.json'), 'utf8')
        );
        return {
          passed: raw.contract === 'WP7_CONTRACT_KEY',
          score: 0.96,
          observedTokens: 1820,
        };
      },
    });
    assert.equal(loopRes.ok, true);
    assert.equal(loopRes.passedVerification, true);
    assert.equal(loopRes.synthetic, false);
    assert.ok(loopRes.receiptId, 'Real verified loop must issue a receiptId');

    // Step D: Promote the recorded experience via packaged plugin MCP stdio using the cryptographic receipt_id
    const promoteStdio = spawnSync(
      'node',
      [pluginMcpEntry],
      {
        cwd: os.tmpdir(),
        input:
          JSON.stringify({
            jsonrpc: '2.0',
            id: 99,
            method: 'tools/call',
            params: {
              name: 'harness_promote_lesson',
              arguments: {
                workspace_root: e2eWs,
                task_id_or_docid: 'task-wp7-e2e',
                adr_id: 'ADR-WP7-E2E',
                receipt_id: loopRes.receiptId,
              },
            },
          }) + '\n',
        encoding: 'utf8',
        timeout: 15000,
      }
    );
    assert.equal(promoteStdio.status, 0, promoteStdio.stderr);
    const promoteRpc = JSON.parse(promoteStdio.stdout.trim().split(/\r?\n/).pop());
    const promoteData = JSON.parse(promoteRpc.result.content[0].text);
    assert.equal(promoteData.ok, true);
    assert.equal(promoteData.promoted, true);
    assert.equal(promoteData.receiptId, loopRes.receiptId);
  } finally {
    fs.rmSync(e2eWs, { recursive: true, force: true });
  }
});

test('18. PR A–G: Verification Authority, Frozen Snapshot Query Blobs, Dangling Symlinks, In-Flight Message Reservation, Context Recovery Tokens & Honest Monitor Telemetry', async () => {
  const isoWs = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-pr-ag-'));
  try {
    const engine = new HarnessKnowledgeEngine(isoWs);
    engine.ensureDirectories();

    // --- PR A: Verification Authority & Promotion Gate ---
    // 1. Caller-injected allowUnverifiedActive via MCP harness_record_experience must be ignored
    const bypassRec = await handleToolCall('harness_record_experience', {
      workspace_root: isoWs,
      task_id: 'pr-a-bypass-attempt',
      domain: 'software-engineering',
      title: 'Bypass attempt',
      problem: 'Attempt to record active without receipt via allowUnverifiedActive',
      observed_behavior: 'Unverified claim',
      status: 'active',
      allowUnverifiedActive: true,
    });
    assert.equal(bypassRec.status, 'candidate', 'allowUnverifiedActive must be ignored without a valid receipt');
    assert.equal(bypassRec.downgradedFromActive, true);

    // 2. Executor that modifies a file WITHOUT an independent evaluator must return status: 'delivered_unverified' and passedVerification: false
    const unverifiedDelivery = await engine.runHarness2Loop({
      taskId: 'pr-a-delivered-unverified',
      problem: 'Modify file without evaluator',
      domain: 'software-engineering',
      allowSimulation: false,
      k: 1,
      requiredArtifacts: ['src/unverified.txt'],
      executor: async () => {
        fs.mkdirSync(path.join(isoWs, 'src'), { recursive: true });
        fs.writeFileSync(path.join(isoWs, 'src', 'unverified.txt'), 'changed without evaluator\n', 'utf8');
        return {};
      },
    });
    assert.equal(unverifiedDelivery.ok, false);
    assert.equal(unverifiedDelivery.status, 'delivered_unverified');
    assert.equal(unverifiedDelivery.passedVerification, false);
    assert.equal(unverifiedDelivery.winner.totalTokens, null, 'Unobserved tokens must be null');
    assert.equal(unverifiedDelivery.tokenEfficiency.totalActualTokens, null);

    // 3. Multi-candidate workspace isolation: Candidate 1 and Candidate 2 write different values to the same path;
    //    evaluator scores each candidate against its own isolated workspace state, and winning candidate state is restored
    const multiCandRes = await engine.runHarness2Loop({
      taskId: 'pr-a-multi-cand-isolation',
      problem: 'Isolate candidate workspaces during K-candidate evaluation',
      domain: 'software-engineering',
      allowSimulation: false,
      k: 2,
      mode: 'sequential',
      earlyStopOnFirstPass: false,
      adoptWinner: true,
      requiredArtifacts: ['src/isolated-out.txt'],
      executor: async ({ candidateIndex }) => {
        fs.mkdirSync(path.join(isoWs, 'src'), { recursive: true });
        const content = candidateIndex === 0 ? 'CANDIDATE_1_WINNER\n' : 'CANDIDATE_2_LOSER\n';
        fs.writeFileSync(path.join(isoWs, 'src', 'isolated-out.txt'), content, 'utf8');
        return { observedTokens: 500 + candidateIndex * 100 };
      },
      evaluator: async ({ workspaceRoot }) => {
        const txt = fs.readFileSync(path.join(workspaceRoot, 'src', 'isolated-out.txt'), 'utf8').trim();
        const isCand1 = txt === 'CANDIDATE_1_WINNER';
        return {
          passed: isCand1,
          score: isCand1 ? 0.97 : 0.25,
          observedTokens: 500,
        };
      },
    });
    assert.equal(multiCandRes.ok, true);
    assert.equal(multiCandRes.passedVerification, true);
    assert.equal(
      fs.readFileSync(path.join(isoWs, 'src', 'isolated-out.txt'), 'utf8').trim(),
      'CANDIDATE_1_WINNER',
      'Winning Candidate 1 artifact must be restored to workspaceRoot after Candidate 2 ran'
    );
    assert.ok(multiCandRes.receiptId);

    // 4. Receipt lessonDigest binding: tampering with EXPERIENCE.md after receipt creation must fail promotion with RECEIPT_LESSON_DIGEST_MISMATCH
    const expPath = path.join(
      isoWs,
      '.harness',
      'library',
      'software-engineering',
      'harnesses',
      'pr-a-multi-cand-isolation',
      'EXPERIENCE.md'
    );
    const origExp = fs.readFileSync(expPath, 'utf8');
    fs.writeFileSync(expPath, origExp + '\n<!-- tampered lesson text -->\n', 'utf8');
    const tamperedLessonPromo = engine.promoteExperienceToProjectKnowledge({
      task_id_or_docid: 'pr-a-multi-cand-isolation',
      receiptId: multiCandRes.receiptId,
    });
    assert.equal(tamperedLessonPromo.ok, false);
    assert.equal(tamperedLessonPromo.detail, 'RECEIPT_LESSON_DIGEST_MISMATCH');
    fs.writeFileSync(expPath, origExp, 'utf8');
    const validLessonPromo = engine.promoteExperienceToProjectKnowledge({
      task_id_or_docid: 'pr-a-multi-cand-isolation',
      adr_id: 'ADR-PR-A-ISOLATED',
      receiptId: multiCandRes.receiptId,
    });
    assert.equal(validLessonPromo.ok, true);

    // --- PR B: Snapshot Query from Frozen Blobs, Stale Index Detection & Dangling Symlinks ---
    const snapDocPath = path.join(isoWs, '.harness', 'knowledge', 'project', 'ADR-SNAP-BLOB.md');
    fs.mkdirSync(path.dirname(snapDocPath), { recursive: true });
    fs.writeFileSync(
      snapDocPath,
      [
        '---',
        'docid: ADR-SNAP-BLOB',
        'title: Frozen Snapshot Blob Test',
        'collection: project-knowledge',
        'domain: software-engineering',
        'status: active',
        'created_at: 2026-01-01T00:00:00.000Z',
        '---',
        '',
        '# Frozen Snapshot Blob Test',
        '',
        'Original frozen keyword FROZEN_ALPHA_TOKEN_777.',
      ].join('\n'),
      'utf8'
    );
    // Automatic stale index detection in loadOrBuildIndex() when file is added
    const autoDetected = engine.query({ query: 'FROZEN_ALPHA_TOKEN_777' });
    assert.equal(autoDetected.results[0]?.docid, 'ADR-SNAP-BLOB');

    const snap = engine.createSnapshotLock({
      domain: 'software-engineering',
      k: 2,
      mode: 'parallel',
    });
    assert.equal(snap.ok, true);

    // Mutate live ADR-SNAP-BLOB.md on disk and rebuild live index
    fs.writeFileSync(
      snapDocPath,
      [
        '---',
        'docid: ADR-SNAP-BLOB',
        'title: Mutated Live Document',
        'collection: project-knowledge',
        'domain: software-engineering',
        'status: active',
        'created_at: 2026-01-01T00:00:00.000Z',
        '---',
        '',
        '# Mutated Live Document',
        '',
        'Mutated live keyword MUTATED_OMEGA_TOKEN_888.',
      ].join('\n'),
      'utf8'
    );
    engine.buildIndex();

    // Query under snapshotId must score and snippet strictly from the frozen blob (finding FROZEN_ALPHA_TOKEN_777 and NOT MUTATED_OMEGA_TOKEN_888)
    const frozenQueryHit = engine.query({
      query: 'FROZEN_ALPHA_TOKEN_777',
      snapshotId: snap.snapshotId,
    });
    assert.equal(frozenQueryHit.results[0]?.docid, 'ADR-SNAP-BLOB');
    assert.ok(frozenQueryHit.results[0]?.snippet.includes('FROZEN_ALPHA_TOKEN_777'));

    const mutatedQueryMiss = engine.query({
      query: 'MUTATED_OMEGA_TOKEN_888',
      snapshotId: snap.snapshotId,
    });
    assert.ok(!mutatedQueryMiss.results.some((r) => r.docid === 'ADR-SNAP-BLOB'));
    engine.releaseSnapshotLock();

    // Dangling symlink pointing outside workspaceRoot must be rejected by _isPathInsideWorkspace
    const outsideTarget = path.join(os.tmpdir(), `outside-nonexistent-target-${Date.now()}.txt`);
    const danglingLink = path.join(isoWs, 'src', 'dangling-outside-link.txt');
    let symlinkCreated = false;
    try {
      fs.symlinkSync(outsideTarget, danglingLink);
      symlinkCreated = true;
    } catch {
      // Windows without developer mode may disallow file symlinks; test directory junction if needed
      try {
        fs.symlinkSync(path.dirname(outsideTarget), danglingLink, 'junction');
        symlinkCreated = true;
      } catch {}
    }
    if (symlinkCreated) {
      assert.equal(
        engine._isPathInsideWorkspace(danglingLink),
        false,
        'Symlink/junction pointing outside workspaceRoot must be rejected'
      );
      fs.unlinkSync(danglingLink);
    }

    // --- PR C & PR G: Python Stage Interpolation, Execute, Assistant Prose Exclusion & Benchmark Prompts ---
    const pyCheck = spawnSync(
      'python',
      [
        '-c',
        [
          'import json, pathlib, tempfile',
          'from adapters.harness2_antigravity_executor import AntigravityExecutor, AntigravityBenchmarkAdapter, resolve_prompts',
          'ws = pathlib.Path(r"' + isoWs.replace(/\\/g, '\\\\') + '")',
          'ex = AntigravityExecutor(workspace_root=str(ws))',
          'stage_dir = pathlib.Path(tempfile.mkdtemp())',
          'ex.materialise({"AGENTS.md": "Task={{task_ref}}Out={{out_dir}}"}, stage_dir, {"task_ref": "T-99", "out_dir": "deliverables"})',
          'rendered = (stage_dir / "AGENTS.md").read_text(encoding="utf-8")',
          'bench = AntigravityBenchmarkAdapter(required_files=["result.txt"])',
          'prompts = resolve_prompts(bench)',
          'run_dir = pathlib.Path(tempfile.mkdtemp())',
          '(run_dir / "assistant_response.md").write_text("Model prose only", encoding="utf-8")',
          '(run_dir / "receipt.json").write_text(json.dumps({"executed": True, "delivered": True, "synthetic": False}), encoding="utf-8")',
          '(run_dir / "trajectory.json").write_text(json.dumps({"events": [{"step": 1}]}), encoding="utf-8")',
          'prose_only_delivered = bench.delivered(run_dir)',
          'print(json.dumps({"rendered": rendered, "has_prompts": bool(prompts.proposer and prompts.composer), "prose_only_delivered": prose_only_delivered}))',
        ].join('; '),
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 10000 }
    );
    assert.equal(pyCheck.status, 0, pyCheck.stderr);
    const pyOut = JSON.parse(pyCheck.stdout.trim());
    assert.equal(pyOut.rendered, 'Task=T-99Out=deliverables');
    assert.equal(pyOut.has_prompts, true);
    assert.equal(pyOut.prose_only_delivered, false, 'assistant_response.md prose must not satisfy delivered()');

    // --- PR D: Default Strict Model Hub, In-Flight Message Reservation & Verified-Only Self-Improve Cue ---
    const defaultStrictInvoke = await invokeUnifiedModel(isoWs, {
      modelId: 'deepseek-v4-pro',
      prompt: 'Default strict invocation without allowSimulation',
    });
    // Ensure when no credentials exist (or if vault has none in isolated env), it does not silently simulate
    if (!resolveSecretCredential('DEEPSEEK_API_KEY').hasKey) {
      assert.equal(defaultStrictInvoke.ok, false);
      assert.equal(defaultStrictInvoke.status, 'unauthorized');
    }

    // Concurrent injectOrConveySwarmMessage with same ID must reserve IN_FLIGHT and call provider only once
    let providerCallCount = 0;
    const prevKey = resolveSecretCredential('DEEPSEEK_API_KEY');
    setSecretInVault('DEEPSEEK_API_KEY', 'sk-temp-concurrent-bus-test');
    try {
      const mockFetch = async () => {
        providerCallCount += 1;
        await new Promise((r) => setTimeout(r, 40));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: 'Verified single provider call' } }],
            usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
          }),
        };
      };
      const sharedMsgId = `MSG-CONC-ONCE-${Date.now()}`;
      const [c1, c2] = await Promise.all([
        injectOrConveySwarmMessage(isoWs, {
          id: sharedMsgId,
          fromAgent: 'main-orchestrator',
          toAgent: 'deepseek-peer-reasoner',
          targetModelId: 'deepseek-v4-pro',
          content: 'Execute exactly once',
          executeModelCall: true,
          fetchImpl: mockFetch,
        }),
        injectOrConveySwarmMessage(isoWs, {
          id: sharedMsgId,
          fromAgent: 'main-orchestrator',
          toAgent: 'deepseek-peer-reasoner',
          targetModelId: 'deepseek-v4-pro',
          content: 'Execute exactly once',
          executeModelCall: true,
          fetchImpl: mockFetch,
        }),
      ]);
      assert.equal(providerCallCount, 1, 'Concurrent duplicate message IDs must invoke provider at most once');
      assert.ok(c1.idempotentDuplicate || c2.idempotentDuplicate);
    } finally {
      if (prevKey.hasKey && prevKey.source.includes('aes-256-gcm-vault')) {
        setSecretInVault('DEEPSEEK_API_KEY', prevKey.value);
      } else {
        setSecretInVault('DEEPSEEK_API_KEY', '');
      }
    }

    // --- PR E: String-Literal Symbol Rejection, Recovery Token Gate, Hook Priority & Supervisor Stop ---
    const ctxMgr = new ContextResilienceManager(isoWs);
    fs.mkdirSync(path.join(isoWs, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(isoWs, 'src', 'string-only.mjs'),
      'export const label = "stringLiteralOnlySymbol";\nexport function realSymbol() { return 1; }\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(isoWs, '.harness', 'runtime', 'verdict-pass.json'),
      JSON.stringify({ passed: true, score: 1.0, synthetic: false }),
      'utf8'
    );

    // Rejects source code file as evidenceRefs
    assert.throws(
      () =>
        ctxMgr.upsertRequirementLedger('task-pr-e', {
          objective: 'Reject source file evidence',
          requirements: [
            {
              id: 'REQ-SRC-EVID',
              behavior: 'Source file is not verification evidence',
              state: 'verified',
              acceptanceChecks: ['check'],
              evidenceRefs: ['src/string-only.mjs'],
              consumerRefs: [{ file: 'src/string-only.mjs', symbol: 'realSymbol' }],
            },
          ],
        }),
      /must be a passing evaluation receipt/
    );

    // Rejects symbol that appears only inside a string literal
    assert.throws(
      () =>
        ctxMgr.upsertRequirementLedger('task-pr-e', {
          objective: 'Reject string-literal-only symbol',
          requirements: [
            {
              id: 'REQ-STR-SYM',
              behavior: 'Symbol in string literal is not executable implementation',
              state: 'verified',
              acceptanceChecks: ['check'],
              evidenceRefs: ['.harness/runtime/verdict-pass.json'],
              consumerRefs: [{ file: 'src/string-only.mjs', symbol: 'stringLiteralOnlySymbol' }],
            },
          ],
        }),
      /in executable code \(comments and string literals excluded\)/
    );

    // Valid upsert + recovery token & stale packet rejection
    ctxMgr.upsertRequirementLedger('task-pr-e', {
      objective: 'A'.repeat(2000),
      userCorrection: 'CRITICAL_USER_CORRECTION_NEVER_DROP',
      requirements: [
        {
          id: 'REQ-OPEN-99',
          behavior: 'Open requirement must stay visible in hook packet',
          state: 'implemented',
        },
      ],
    });
    ctxMgr.writeCheckpoint('task-pr-e', {
      activeWorkers: [{ workerId: 'worker-e1', ownership: ['src/string-only.mjs'], openChecks: ['REQ-OPEN-99'] }],
      nextAction: 'Verify token',
    });
    const restoreE1 = ctxMgr.restoreSubagentFromCheckpoint('task-pr-e', 'worker-e1', {
      executorSessionId: 'SES-E1',
    });
    assert.ok(restoreE1.recoveryToken);

    // Missing recoveryToken must fail
    const missingTokenAck = ctxMgr.acknowledgeRecoveryPacket('task-pr-e', 'worker-e1', {
      executorSessionId: 'SES-E1',
      checkpointRevision: restoreE1.checkpointRevision,
    });
    assert.equal(missingTokenAck.ok, false);
    assert.equal(missingTokenAck.error, 'RECOVERY_TOKEN_REQUIRED');

    // Advance ledger after restore -> acknowledging old recovery packet must fail with STALE_RECOVERY_PACKET
    ctxMgr.upsertRequirementLedger('task-pr-e', {
      userCorrection: 'Second correction after restore',
    });
    const staleAck = ctxMgr.acknowledgeRecoveryPacket('task-pr-e', 'worker-e1', {
      executorSessionId: 'SES-E1',
      checkpointRevision: restoreE1.checkpointRevision,
      recoveryToken: restoreE1.recoveryToken,
    });
    assert.equal(staleAck.ok, false);
    assert.equal(staleAck.error, 'STALE_RECOVERY_PACKET');

    // Hook packet prioritization: even with 2,000-char Objective, Latest Correction and Open Reqs are preserved under 700 chars
    const hookPkt = ctxMgr.buildActiveTasksHookPacket(700);
    assert.ok(hookPkt.length <= 700);
    assert.ok(hookPkt.includes('CRITICAL_USER_CORRECTION_NEVER_DROP') || hookPkt.includes('Second correction after restore'));
    assert.ok(hookPkt.includes('REQ-OPEN-99'));

    // Supervisor stop after 3 stagnant attempts blocks runHarness2Loop and invokeUnifiedModel
    ctxMgr.recordAttemptProgress('task-pr-e', { madeProgress: false, maxStagnantAttempts: 3 });
    ctxMgr.recordAttemptProgress('task-pr-e', { madeProgress: false, maxStagnantAttempts: 3 });
    ctxMgr.recordAttemptProgress('task-pr-e', { madeProgress: false, maxStagnantAttempts: 3 });

    const stoppedLoop = await engine.runHarness2Loop({
      taskId: 'task-pr-e',
      problem: 'Should be halted by supervisor stop',
      allowSimulation: true,
    });
    assert.equal(stoppedLoop.ok, false);
    assert.equal(stoppedLoop.error, 'ESCALATED_NO_PROGRESS_STOP');

    const stoppedModel = await invokeUnifiedModel(isoWs, {
      taskId: 'task-pr-e',
      modelId: 'deepseek-v4-pro',
      prompt: 'Should be halted by supervisor stop',
      allowSimulation: true,
    });
    assert.equal(stoppedModel.ok, false);
    assert.equal(stoppedModel.error, 'ESCALATED_NO_PROGRESS_STOP');

    // --- PR F: Default Monitor Auth, Honest Partial Telemetry & Template Worker Recall Guard ---
    // Write a single tool-call event without token counts into telemetry.json
    fs.writeFileSync(
      path.join(isoWs, '.harness', 'runtime', 'telemetry.json'),
      JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          events: [{ timestamp: new Date().toISOString(), hook: 'postToolUse', toolName: 'read_file', stepIdx: 1 }],
          sessions: {},
        },
        null,
        2
      ),
      'utf8'
    );

    const strictApp = createHarnessMonitorApp({
      registeredWorkspaces: [isoWs],
    });
    await strictApp.run(0);
    try {
      const base = `http://127.0.0.1:${strictApp.port}`;
      // Default app requires authentication (401 without X-Sidecar-Token)
      const unauthRes = await fetch(`${base}/api/status`);
      assert.equal(unauthRes.status, 401);

      const headers = {
        'Content-Type': 'application/json',
        'X-Sidecar-Token': strictApp.sessionToken,
      };

      // Request body cannot override allowUnregisteredWorkspaces
      const unregisteredWs = fs.mkdtempSync(path.join(os.tmpdir(), 'unregistered-ws-'));
      try {
        const unregRes = await fetch(`${base}/api/dashboard`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            workspaceRoot: unregisteredWs,
            allowUnregisteredWorkspaces: true,
          }),
        });
        assert.equal(unregRes.status, 403);
      } finally {
        fs.rmSync(unregisteredWs, { recursive: true, force: true });
      }

      // Partial telemetry (1 tool event, 0 token counts, 0 spawned subagents) must NOT fabricate 29,700 tokens or 7 template subagents
      const dashRes = await fetch(`${base}/api/dashboard`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ workspaceRoot: isoWs }),
      });
      assert.equal(dashRes.status, 200);
      const dash = await dashRes.json();
      assert.equal(dash.contextAnalytics.observedSteps, 1);
      assert.equal(dash.contextAnalytics.observedTokens, null);
      assert.equal(dash.contextAnalytics.currentWindow.totalTokens, null);
      assert.equal(dash.contextAnalytics.currentWindow.cacheHitPct, null);
      assert.equal(dash.swarm.formations['live-harness2'].nodes.length, 1);
      assert.equal(dash.swarm.formations['live-harness2'].nodes[0].id, 'main-orchestrator');

      // Recalling a template worker when no real subagent was spawned must return 409 NO_REGISTERED_EXECUTOR_FOR_WORKER
      const templateRecallRes = await fetch(`${base}/api/swarm/recall`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          workspaceRoot: isoWs,
          nodeId: 'harness-proposer',
          action: 'recall',
        }),
      });
      assert.equal(templateRecallRes.status, 409);
      const templateRecallJson = await templateRecallRes.json();
      assert.equal(templateRecallJson.error, 'NO_REGISTERED_EXECUTOR_FOR_WORKER');
    } finally {
      await strictApp.close();
    }
  } finally {
    fs.rmSync(isoWs, { recursive: true, force: true });
  }
});

