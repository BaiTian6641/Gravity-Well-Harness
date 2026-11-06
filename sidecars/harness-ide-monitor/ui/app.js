(function () {
  const apiFetch = async (endpoint, payload = {}) => {
    const fn = window.sidecar?.fetch || window.fetch.bind(window);
    const res = await fn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json();
  };

  const escapeHtml = (str) =>
    String(str ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );

  const showToast = (msg) => {
    const el = document.getElementById('toast-banner');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(window.__toastTimer);
    window.__toastTimer = setTimeout(() => el.classList.add('hidden'), 4200);
  };

  // Tab navigation
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-tab');
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = document.getElementById(`tab-${target}`);
      if (panel) panel.classList.add('active');
    });
  });

  let latestDashboard = null;
  let settingsInitialized = false;

  function renderSwarmTab(data) {
    const swarm = data.swarm || {};
    const main = swarm.mainAgent || {};

    document.getElementById('workspace-label').textContent =
      `Workspace: ${data.workspaceRoot || main.workspaceRoot || 'local'}`;
    document.getElementById('main-agent-role').textContent =
      main.role || 'Main Orchestrator Agent';
    document.getElementById('main-agent-model').textContent =
      main.model || 'Gemini 4 Argon';
    document.getElementById('main-agent-steps').textContent = String(main.totalSteps ?? 0);
    document.getElementById('main-agent-subcount').textContent = String(
      (swarm.liveSubagents || []).length
    );
    document.getElementById('main-agent-ls').textContent = swarm.lsConnected
      ? 'Connected (LS RPC)'
      : 'Local Transcript Sync';
    document.getElementById('main-agent-prompt').textContent =
      main.lastUserPrompt || 'Active coding & harnessing session';

    // Render 4 Harness2 Swarm Roles
    const rolesGrid = document.getElementById('swarm-roles-grid');
    const roles = swarm.configuredSwarmRoles || [];
    rolesGrid.innerHTML = roles
      .map(
        (r) => `
      <div class="swarm-node">
        <div class="swarm-node-top">
          <span class="swarm-node-title">${escapeHtml(r.role)}</span>
          <span class="status-chip ${r.workspace === 'branch' ? 'status-branch' : 'status-active'}">
            ${escapeHtml(r.workspace === 'branch' ? 'branch' : r.status)}
          </span>
        </div>
        <div class="muted-text">Agent: <code>${escapeHtml(r.typeName)}</code> | Workspace: <code>${escapeHtml(r.workspace)}</code></div>
        <div class="muted-text">${escapeHtml(r.description)}</div>
      </div>
    `
      )
      .join('');

    // Render Live Invoked Subagents
    const liveList = document.getElementById('live-subagents-list');
    const liveSubs = swarm.liveSubagents || [];
    if (liveSubs.length === 0) {
      liveList.innerHTML = `<div class="muted-text">No subagents spawned in the current turn yet. Invoke <code>harness-proposer</code>, <code>harness-prober</code> (with <code>Workspace: "branch"</code>), or <code>research</code> to see live swarm nodes here.</div>`;
    } else {
      liveList.innerHTML = liveSubs
        .map(
          (s) => `
        <div class="list-item">
          <div class="list-item-header">
            <span class="list-item-title">${escapeHtml(s.role)} (<code>${escapeHtml(s.typeName)}</code>)</span>
            <span class="status-chip ${s.workspace === 'branch' ? 'status-branch' : 'status-active'}">
              Workspace: ${escapeHtml(s.workspace || 'inherit')} • ${escapeHtml(s.status || 'DONE')}
            </span>
          </div>
          <div class="muted-text">${escapeHtml(s.promptPreview || '')}</div>
        </div>
      `
        )
        .join('');
    }

    // Render MCP Servers
    const mcpList = document.getElementById('mcp-servers-list');
    mcpList.innerHTML = (swarm.mcpServers || [])
      .map(
        (m) => `
      <div class="list-item">
        <div class="list-item-header">
          <span class="list-item-title"><code>${escapeHtml(m.name)}</code></span>
          <span class="status-chip status-active">${escapeHtml(m.status)} (${Number(m.toolCount || 0)} tools)</span>
        </div>
      </div>
    `
      )
      .join('');

    // Render Recent Tool Calls
    const eventsList = document.getElementById('recent-events-list');
    const events = swarm.recentEvents || [];
    if (events.length === 0) {
      eventsList.innerHTML = `<div class="muted-text">No recent tool calls recorded yet.</div>`;
    } else {
      eventsList.innerHTML = events
        .slice(0, 15)
        .map(
          (ev) => `
        <div class="list-item">
          <div class="list-item-header">
            <span class="list-item-title"><code>${escapeHtml(ev.toolName)}</code></span>
            <span class="muted-text">Step #${Number(ev.stepIdx ?? ev.stepIndex ?? 0)}</span>
          </div>
          <div class="muted-text">${escapeHtml(ev.summary || '')}</div>
        </div>
      `
        )
        .join('');
    }
  }

  function renderHarness2Tab(data) {
    const h2 = data.harness2 || {};
    const lock = h2.activeSnapshotLock || { active: false };
    const headerBadge = document.getElementById('snapshot-header-badge');
    const studioBadge = document.getElementById('studio-lock-badge');
    const detailsBox = document.getElementById('active-lock-details');

    if (lock.active) {
      headerBadge.textContent = `🔒 Snapshot: ${lock.snapshotId}`;
      headerBadge.className = 'pill-badge pill-locked';
      studioBadge.textContent = `LOCKED (${lock.snapshotId})`;
      studioBadge.className = 'status-chip status-branch';
      detailsBox.innerHTML = `
        <strong>Active Snapshot Isolation Lock:</strong> <code>${escapeHtml(lock.snapshotId)}</code><br/>
        <span>Cutoff Timestamp: <code>${escapeHtml(lock.cutoffTimestamp)}</code> | Git Rev: <code>${escapeHtml(lock.gitRevision)}</code> | Eligible Docs: <strong>${Number(lock.eligibleDocCount || 0)}</strong> | Mode: <code>K=${Number(lock.k || 2)} (${escapeHtml(lock.mode)})</code></span>
      `;
    } else {
      headerBadge.textContent = 'Snapshot: Unlocked';
      headerBadge.className = 'pill-badge';
      studioBadge.textContent = 'UNLOCKED (Live Index)';
      studioBadge.className = 'status-chip status-active';
      detailsBox.innerHTML = `No active candidate probe lock. All <code>status: active</code> documents across all collections are eligible for retrieval.`;
    }

    const expList = document.getElementById('experiences-list');
    const exps = h2.experiences || [];
    if (exps.length === 0) {
      expList.innerHTML = `<div class="muted-text">No experience entries indexed yet.</div>`;
    } else {
      expList.innerHTML = exps
        .map(
          (doc) => `
        <div class="list-item">
          <div class="list-item-header">
            <span class="list-item-title">${escapeHtml(doc.title)} (<code>${escapeHtml(doc.docid)}</code>)</span>
            <div class="inline-pair">
              <span class="status-chip status-active">${escapeHtml(doc.domain)} • ${escapeHtml(doc.status)}</span>
              <button class="icon-btn btn-inspect-doc" data-docid="${escapeHtml(doc.docid)}">Inspect Source</button>
              ${
                doc.task_id
                  ? `<button class="icon-btn btn-promote-doc" data-taskid="${escapeHtml(doc.task_id)}">Promote to ADR</button>`
                  : ''
              }
            </div>
          </div>
          ${doc.cue ? `<div class="muted-text"><strong>Cue:</strong> <em>${escapeHtml(doc.cue)}</em></div>` : ''}
          <div class="muted-text">Path: <code>${escapeHtml(doc.path)}</code> | Git Rev: <code>${escapeHtml(doc.git_revision)}</code></div>
        </div>
      `
        )
        .join('');

      expList.querySelectorAll('.btn-inspect-doc').forEach((btn) => {
        btn.addEventListener('click', () => {
          const docid = btn.getAttribute('data-docid');
          document.querySelector('[data-tab="rag"]').click();
          openDocumentViewer(docid);
        });
      });

      expList.querySelectorAll('.btn-promote-doc').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const taskId = btn.getAttribute('data-taskid');
          const res = await apiFetch('/api/harness2/experience', {
            action: 'promote',
            task_id_or_docid: taskId,
          });
          if (res.ok) {
            showToast(`Promoted '${taskId}' to Project Knowledge (${res.adrPath})`);
            await refreshDashboard();
          }
        });
      });
    }
  }

  function renderRagTab(data) {
    const rag = data.rag || {};
    const status = rag.status || {};
    document.getElementById('rag-header-badge').textContent =
      `RAG: ${Number(status.totalDocuments || 0)} docs`;

    const colsContainer = document.getElementById('rag-collections-cards');
    const cols = status.collections || {};
    colsContainer.innerHTML = Object.entries(cols)
      .map(
        ([colName, info]) => `
      <div class="card">
        <span class="eyebrow">${escapeHtml(colName)}</span>
        <div class="card-title" style="font-size: 18px; margin: 4px 0;">${Number(info.count || 0)} Documents</div>
        <div class="muted-text">${escapeHtml(info.description || '')}</div>
      </div>
    `
      )
      .join('');
  }

  function renderSettingsTab(data) {
    if (settingsInitialized) return;
    const s = data.settings || {};
    document.getElementById('set-rag-backend').value = s.rag?.primaryBackend || 'qmd-hybrid';
    document.getElementById('set-auto-index').checked = s.rag?.autoIndexOnChange !== false;
    document.getElementById('set-qmd-cli').checked = s.rag?.enableQmdCliIfAvailable !== false;
    document.getElementById('set-basic-memory').checked = Boolean(
      s.rag?.optionalBackends?.basicMemory?.enabled
    );
    document.getElementById('set-context7-enabled').checked =
      s.externalDocs?.context7?.enabled !== false;
    document.getElementById('set-context7-key').value = s.externalDocs?.context7?.apiKey || '';
    document.getElementById('set-google-dev-enabled').checked = Boolean(
      s.externalDocs?.googleDeveloperKnowledge?.enabled
    );
    document.getElementById('set-h2-level').value =
      s.harness2?.executionLevel || 'native-antigravity-swarm';
    document.getElementById('set-strict-snapshot').checked =
      s.harness2?.strictSnapshotIsolation !== false;
    document.getElementById('set-h2-mode').value = s.harness2?.defaultMode || 'parallel';
    document.getElementById('set-h2-k').value = String(s.harness2?.defaultCandidatesK || 2);
    document.getElementById('set-hook-preplan').checked =
      s.uiMonitor?.enablePrePlanningRagHook !== false;
    document.getElementById('set-hook-telemetry').checked =
      s.uiMonitor?.enablePostToolTelemetryHook !== false;
    settingsInitialized = true;
  }

  async function runRagSearch(customQuery) {
    const qInput = document.getElementById('rag-query-input');
    if (customQuery !== undefined) qInput.value = customQuery;
    const query = qInput.value.trim();
    const mode = document.getElementById('rag-mode-select').value;
    const collection = document.getElementById('rag-collection-select').value;

    const res = await apiFetch('/api/rag/query', { query, mode, collection, topK: 8 });
    const metaEl = document.getElementById('rag-search-meta');
    const listEl = document.getElementById('rag-results-list');

    const snapText = res.snapshotIsolation?.active
      ? ` | 🔒 Filtered by Snapshot Lock ${res.snapshotIsolation.snapshotId} (${res.snapshotIsolation.filteredBySnapshotCount} post-cutoff/candidate docs hidden)`
      : '';
    metaEl.innerHTML = `Found <strong>${(res.results || []).length}</strong> results across <strong>${Number(res.totalEligible || 0)}</strong> eligible docs (mode: <code>${escapeHtml(mode)}</code>)${snapText}`;

    if (!res.results || res.results.length === 0) {
      listEl.innerHTML = `<div class="muted-text">No matching documents found. Try broadening your query or switching collection to "All Collections".</div>`;
      return;
    }

    listEl.innerHTML = res.results
      .map(
        (r) => `
      <div class="list-item">
        <div class="list-item-header">
          <span class="list-item-title">${escapeHtml(r.title)} (<code>${escapeHtml(r.docid)}</code>)</span>
          <div class="inline-pair">
            <span class="pill-badge">${escapeHtml(r.collection)}</span>
            <span class="pill-badge pill-ok">Score: ${Number(r.score).toFixed(3)} (BM25: ${Number(r.lexScore).toFixed(2)} | Vec: ${Number(r.vecScore).toFixed(2)})</span>
            <button class="icon-btn btn-open-doc" data-docid="${escapeHtml(r.docid)}">Read Full Note</button>
          </div>
        </div>
        ${r.cue ? `<div class="muted-text"><strong>Cue:</strong> <em>${escapeHtml(r.cue)}</em></div>` : ''}
        ${
          r.matchedSection
            ? `<div class="muted-text"><strong>§ ${escapeHtml(r.matchedSection.heading)}:</strong> ${escapeHtml(r.matchedSection.snippet)}</div>`
            : ''
        }
        <div class="muted-text">Path: <code>${escapeHtml(r.path)}</code> | Rev: <code>${escapeHtml(r.git_revision)}</code> | Status: <code>${escapeHtml(r.status)}</code></div>
      </div>
    `
      )
      .join('');

    listEl.querySelectorAll('.btn-open-doc').forEach((btn) => {
      btn.addEventListener('click', () => openDocumentViewer(btn.getAttribute('data-docid')));
    });
  }

  async function openDocumentViewer(docid) {
    const res = await apiFetch('/api/rag/doc', { id: docid });
    const card = document.getElementById('doc-viewer-card');
    if (!res.found) {
      showToast(res.error || `Document ${docid} not found`);
      return;
    }
    document.getElementById('viewer-doc-meta').textContent =
      `${res.collection} • ${res.docid} • Rev: ${res.git_revision} • Status: ${res.status}`;
    document.getElementById('viewer-doc-title').textContent = `${res.title} (${res.path})`;
    document.getElementById('viewer-doc-content').textContent = res.content || '';
    card.classList.remove('hidden');
  }

  async function refreshDashboard() {
    try {
      const data = await apiFetch('/api/dashboard', {});
      if (!data.ok) return;
      latestDashboard = data;
      renderSwarmTab(data);
      renderHarness2Tab(data);
      renderRagTab(data);
      renderSettingsTab(data);
    } catch {
      // ignore transient poll error
    }
  }

  // Wire buttons
  document.getElementById('btn-manual-refresh').addEventListener('click', async () => {
    await refreshDashboard();
    showToast('Dashboard state refreshed.');
  });

  document.getElementById('btn-run-search').addEventListener('click', () => runRagSearch());
  document.getElementById('rag-query-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runRagSearch();
  });

  document.querySelectorAll('.chip-btn').forEach((chip) => {
    chip.addEventListener('click', () => runRagSearch(chip.getAttribute('data-preset')));
  });

  document.getElementById('btn-close-viewer').addEventListener('click', () => {
    document.getElementById('doc-viewer-card').classList.add('hidden');
  });

  document.getElementById('btn-reindex-rag').addEventListener('click', async () => {
    const res = await apiFetch('/api/rag/refresh', {});
    if (res.ok) {
      showToast(`Re-indexed ${res.totalDocuments} local documents (Git rev: ${res.gitRevision}).`);
      await refreshDashboard();
      await runRagSearch();
    }
  });

  document.getElementById('btn-lock-snapshot').addEventListener('click', async () => {
    const domain = document.getElementById('snap-domain-input').value.trim() || 'software-engineering';
    const mode = document.getElementById('snap-mode-select').value;
    const k = Number(document.getElementById('snap-k-input').value || 2);
    const res = await apiFetch('/api/harness2/snapshot', {
      action: 'create',
      domain,
      mode,
      k,
    });
    if (res.ok && res.lock) {
      showToast(
        `Snapshot Isolation Lock '${res.lock.snapshotId}' created (${res.lock.eligibleDocCount} eligible docs frozen).`
      );
      await refreshDashboard();
    }
  });

  document.getElementById('btn-release-snapshot').addEventListener('click', async () => {
    const res = await apiFetch('/api/harness2/snapshot', { action: 'release' });
    if (res.ok) {
      showToast('Snapshot Isolation Lock released.');
      await refreshDashboard();
    }
  });

  document.getElementById('btn-record-experience').addEventListener('click', async () => {
    const task_id = document.getElementById('exp-task-id').value.trim();
    const domain = document.getElementById('exp-domain').value.trim() || 'software-engineering';
    const title = document.getElementById('exp-title').value.trim();
    const cue = document.getElementById('exp-cue').value.trim();
    const problem = document.getElementById('exp-problem').value.trim();
    const observed_behavior = document.getElementById('exp-observed').value.trim();
    const evidenceRaw = document.getElementById('exp-evidence').value.trim();
    const status = document.getElementById('exp-status').value;

    if (!task_id || !problem || !observed_behavior) {
      showToast('Please fill in Task ID, Problem, and Observed Behavior.');
      return;
    }

    const supporting_evidence = evidenceRaw
      ? evidenceRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

    const res = await apiFetch('/api/harness2/experience', {
      action: 'record',
      task_id,
      domain,
      title,
      cue,
      problem,
      observed_behavior,
      supporting_evidence,
      status,
    });

    if (res.ok) {
      showToast(`Recorded ${res.docid} (${res.experiencePath}) and updated INDEX.md!`);
      document.getElementById('exp-task-id').value = '';
      document.getElementById('exp-title').value = '';
      document.getElementById('exp-cue').value = '';
      document.getElementById('exp-problem').value = '';
      document.getElementById('exp-observed').value = '';
      await refreshDashboard();
    }
  });

  document.getElementById('btn-save-note').addEventListener('click', async () => {
    const collection = document.getElementById('note-collection').value;
    const filename = document.getElementById('note-filename').value.trim();
    const title = document.getElementById('note-title').value.trim();
    const domain = document.getElementById('note-domain').value.trim() || 'architecture';
    const tags = document.getElementById('note-tags').value.trim();
    const content = document.getElementById('note-content').value.trim();

    if (!filename || !title || !content) {
      showToast('Please provide Filename, Title, and Markdown Content.');
      return;
    }

    const res = await apiFetch('/api/rag/doc', {
      action: 'save',
      collection,
      filename,
      title,
      domain,
      tags,
      content,
    });

    if (res.ok) {
      showToast(`Saved ${res.path} (${res.docid}) and refreshed index!`);
      document.getElementById('note-filename').value = '';
      document.getElementById('note-title').value = '';
      document.getElementById('note-content').value = '';
      await refreshDashboard();
      await runRagSearch(title);
    }
  });

  document.getElementById('btn-save-settings').addEventListener('click', async () => {
    const settingsPayload = {
      rag: {
        primaryBackend: document.getElementById('set-rag-backend').value,
        autoIndexOnChange: document.getElementById('set-auto-index').checked,
        enableQmdCliIfAvailable: document.getElementById('set-qmd-cli').checked,
        optionalBackends: {
          basicMemory: {
            enabled: document.getElementById('set-basic-memory').checked,
          },
        },
      },
      externalDocs: {
        context7: {
          enabled: document.getElementById('set-context7-enabled').checked,
          apiKey: document.getElementById('set-context7-key').value.trim(),
        },
        googleDeveloperKnowledge: {
          enabled: document.getElementById('set-google-dev-enabled').checked,
        },
      },
      harness2: {
        executionLevel: document.getElementById('set-h2-level').value,
        strictSnapshotIsolation: document.getElementById('set-strict-snapshot').checked,
        defaultMode: document.getElementById('set-h2-mode').value,
        defaultCandidatesK: Number(document.getElementById('set-h2-k').value || 2),
      },
      uiMonitor: {
        enablePrePlanningRagHook: document.getElementById('set-hook-preplan').checked,
        enablePostToolTelemetryHook: document.getElementById('set-hook-telemetry').checked,
      },
    };

    const res = await apiFetch('/api/settings/save', { settings: settingsPayload });
    if (res.ok) {
      showToast('Settings saved to .harness/config.json, global config, and plugin MCP config!');
      await refreshDashboard();
    }
  });

  // Initial load + initial search + live polling
  refreshDashboard().then(() => {
    runRagSearch('What evidence supported our previous choice of memory architecture?');
  });
  setInterval(refreshDashboard, 3500);
})();
