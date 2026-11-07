(function () {
  // Workspace & Host Tracking State
  const urlParams = new URLSearchParams(window.location?.search || '');
  let autoFollowWorkspace = true;
  let pinnedWorkspaceRoot = '';
  let currentWorkspaceRoot = '';
  let hostClientWorkspaceUris = [];
  let hostConversationId =
    urlParams.get('conversationId') || window.sidecar?.conversationId || '';

  if (urlParams.get('workspace')) {
    hostClientWorkspaceUris = [urlParams.get('workspace')];
  } else if (window.sidecar?.workspace) {
    hostClientWorkspaceUris = [window.sidecar.workspace];
  }

  function resolveUiToken() {
    try {
      const qTok = new URLSearchParams(window.location?.search || '').get('token');
      if (qTok) return (window.__AGY_TOKEN__ = qTok);
      if (window.__AGY_TOKEN__) return window.__AGY_TOKEN__;
      const els = document?.querySelectorAll?.('script[src*="token="], link[href*="token="]') || [];
      for (const el of els) {
        const raw = el.getAttribute?.('src') || el.getAttribute?.('href') || '';
        const tok = new URL(raw, 'http://127.0.0.1').searchParams.get('token');
        if (tok) return (window.__AGY_TOKEN__ = tok);
      }
    } catch {}
    return '';
  }

  const apiFetch = async (endpoint, payload = {}) => {
    const fn = window.sidecar?.fetch || window.fetch.bind(window);
    const uiToken = resolveUiToken();
    const sep = endpoint.includes('?') ? '&' : '?';
    const targetUrl = `${endpoint}${sep}${uiToken ? `token=${encodeURIComponent(uiToken)}&` : ''}_ts=${Date.now()}`;
    const bodyPayload = {
      ...payload,
      _ts: Date.now(),
      ...( !autoFollowWorkspace && pinnedWorkspaceRoot
        ? { workspaceRoot: pinnedWorkspaceRoot, pinnedWorkspace: true }
        : {} ),
      ...( hostClientWorkspaceUris.length > 0
        ? { clientWorkspaceUris: hostClientWorkspaceUris }
        : {} ),
      ...( hostConversationId ? { conversationId: hostConversationId } : {} ),
    };
    const res = await fn(targetUrl, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store',
        ...(uiToken ? { 'X-Sidecar-Token': uiToken } : {}),
      },
      body: JSON.stringify(bodyPayload),
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

  function animateWorkspaceTransition(newWsName, newWsPath) {
    const rootEl = document.getElementById('app-root');
    if (rootEl) {
      rootEl.classList.add('workspace-switching');
      setTimeout(() => rootEl.classList.remove('workspace-switching'), 260);
    }
    showToast(`⚡ Active Workspace: ${newWsName} (${newWsPath})`);
  }

  // Listen for live workspace changes pushed by Antigravity host
  if (typeof window.sidecar?.onWorkspaceChange === 'function') {
    try {
      window.sidecar.onWorkspaceChange((uris) => {
        const list = Array.isArray(uris) ? uris : uris ? [String(uris)] : [];
        if (list.length > 0) {
          hostClientWorkspaceUris = list;
          if (autoFollowWorkspace) {
            pinnedWorkspaceRoot = '';
            refreshDashboard(true);
          }
        }
      });
    } catch {}
  }

  window.addEventListener('message', (ev) => {
    const d = ev?.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'workspace-change' || d.type === 'sidecar-workspace') {
      const uris = d.payload?.workspaceUris || d.workspaceUris || (d.workspace ? [d.workspace] : []);
      if (Array.isArray(uris) && uris.length > 0) {
        hostClientWorkspaceUris = uris;
        if (autoFollowWorkspace) {
          pinnedWorkspaceRoot = '';
          refreshDashboard(true);
        }
      }
    }
    if (d.conversationId && d.conversationId !== hostConversationId) {
      hostConversationId = d.conversationId;
      if (autoFollowWorkspace) refreshDashboard(true);
    }
  });

  // Tab navigation
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-tab');
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = document.getElementById(`tab-${target}`);
      if (panel) panel.classList.add('active');
      if (target === 'swarm') {
        requestAnimationFrame(() => drawHierarchyEdges());
      }
    });
  });

  // UI State for Swarm Formation, Interactive Canvas & Context DNA
  let latestDashboard = null;
  let settingsInitializedForWs = '';
  let activeFormationId = 'live-harness2';
  let hideInactiveSubagents = true;
  let selectedNodeId = null;
  let hoveredNodeId = null;
  let memberStatusFilter = 'ALL';
  let taskStatusFilter = 'ALL';
  let memberSearchQuery = '';
  let memberSortMode = 'tier';
  let zoomScale = 1.0;
  let panX = 0;
  let panY = 0;
  let isPanningCanvas = false;
  let panStartX = 0;
  let panStartY = 0;
  let panOriginX = 0;
  let panOriginY = 0;
  let draggingNodeId = null;
  let draggingNodeEl = null;
  let nodeDragMoved = false;
  let nodeDragStartX = 0;
  let nodeDragStartY = 0;
  let nodeOriginX = 0;
  let nodeOriginY = 0;
  const nodeOffsets = new Map(); // key: `${formationId}:${nodeId}` -> { x, y }
  let lastRenderedNodeSignature = '';
  let lastRenderedMemberSignature = '';
  let lastLiveRevision = '';
  let isRefreshing = false;
  const expandedDnaKeys = new Set(['injectedRag', 'toolResults']);

  const DNA_COLORS = {
    systemPrompt: '#6366f1',
    toolDefinitions: '#f59e0b',
    userMessages: '#10b981',
    injectedRag: '#a855f7',
    skillInjection: '#f97316',
    assistantMessages: '#3b82f6',
    toolResults: '#14b8a6',
    freeWindow: '#334155',
  };

  const DNA_LABELS = {
    systemPrompt: 'System Prompt',
    toolDefinitions: 'Tool Defs',
    userMessages: 'User Msg',
    injectedRag: 'Injected RAG',
    skillInjection: 'Skill Inject',
    assistantMessages: 'Assistant Msg',
    toolResults: 'Tool Results',
    freeWindow: 'Free Window',
  };

  function getNodeOffset(nodeId) {
    return nodeOffsets.get(`${activeFormationId}:${nodeId}`) || { x: 0, y: 0 };
  }

  function setNodeOffset(nodeId, x, y) {
    nodeOffsets.set(`${activeFormationId}:${nodeId}`, { x, y });
  }

  function applyStageTransform(immediate = false) {
    const stage = document.getElementById('hierarchy-stage');
    const lbl = document.getElementById('zoom-level-label');
    if (stage) {
      stage.classList.toggle('no-transition', immediate);
      stage.style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${zoomScale})`;
    }
    if (lbl) {
      lbl.textContent = `${Math.round(zoomScale * 100)}%`;
    }
    requestAnimationFrame(() => drawHierarchyEdges());
  }

  function renderWorkspaceHeader(data) {
    const wsRoot = data.workspaceRoot || '';
    const wsName = data.workspaceName || 'Workspace';
    const hasHarness = data.hasHarness !== false;

    if (currentWorkspaceRoot && currentWorkspaceRoot.toLowerCase() !== wsRoot.toLowerCase()) {
      animateWorkspaceTransition(wsName, wsRoot);
      settingsInitializedForWs = '';
    }
    currentWorkspaceRoot = wsRoot;

    const labelEl = document.getElementById('workspace-label');
    if (labelEl) {
      labelEl.textContent = `${wsName} — ${wsRoot}`;
    }

    const uninitBanner = document.getElementById('uninitialized-workspace-banner');
    const uninitName = document.getElementById('uninit-ws-name');
    if (uninitBanner) {
      if (!hasHarness) {
        if (uninitName) uninitName.textContent = wsName;
        uninitBanner.classList.remove('hidden');
      } else {
        uninitBanner.classList.add('hidden');
      }
    }

    const wsSelect = document.getElementById('workspace-switcher-select');
    const workspaces = data.availableWorkspaces || [];
    if (wsSelect && workspaces.length > 0) {
      wsSelect.innerHTML = workspaces
        .map((w) => {
          const isSel = w.path.toLowerCase() === wsRoot.toLowerCase();
          const badge = w.hasHarness ? '✓ .harness' : 'new';
          return `<option value="${escapeHtml(w.path)}" ${isSel ? 'selected' : ''}>${escapeHtml(w.name)} (${badge})</option>`;
        })
        .join('');
    }

    const autoBtn = document.getElementById('btn-auto-follow-ws');
    if (autoBtn) {
      autoBtn.classList.toggle('active', autoFollowWorkspace);
      autoBtn.textContent = autoFollowWorkspace ? '⚡ Auto-Follow IDE' : '📌 Pinned';
    }
  }

  function formatCompactContext(n) {
    const val = Number(n || 0);
    if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
    if (val >= 1_000) return `${(val / 1_000).toFixed(1)}k`;
    return String(val);
  }

  let lastModelCatalogSig = '';

  function renderInlineModelAndContextStrip(data) {
    const hub = data.modelHub || {};
    const catalog = hub.catalog || [];
    const cfg = hub.config || {};
    const activeModelId = cfg.activeModelId || 'deepseek-v4-pro';
    const activeModel = catalog.find((m) => m.id === activeModelId) || catalog[0] || {};
    const activeDepth = activeModel.reasoningDepth || cfg.activeReasoningDepth || 'balanced';

    const headerSelect = document.getElementById('header-model-selector');
    const injectModelSelect = document.getElementById('inject-to-model');
    const depthSelect = document.getElementById('header-depth-selector');

    const sig = `${activeModelId}:${activeDepth}:${catalog
      .map((m) => `${m.id}:${m.reasoningDepth}:${m.contextUsedPct}`)
      .join('|')}`;

    if (sig !== lastModelCatalogSig && catalog.length > 0) {
      lastModelCatalogSig = sig;
      const groups = new Map();
      for (const m of catalog) {
        const gName = m.providerLabel || m.provider || 'Models';
        if (!groups.has(gName)) groups.set(gName, []);
        groups.get(gName).push(m);
      }

      const buildOptionsHtml = (selectedId) =>
        Array.from(groups.entries())
          .map(
            ([gLabel, items]) => `
            <optgroup label="${escapeHtml(gLabel)}">
              ${items
                .map((m) => {
                  const depthUpper = String(m.reasoningDepth || 'balanced').toUpperCase();
                  const effort = m.reasoningEffort || 'high';
                  const ctxWin = formatCompactContext(m.contextWindowTokens || 256000);
                  const isSel = m.id === selectedId ? 'selected' : '';
                  return `<option value="${escapeHtml(m.id)}" ${isSel}>${escapeHtml(m.name)} [${depthUpper} · effort=${escapeHtml(effort)}] (${ctxWin} ctx · ${Number(m.contextUsedPct || 0)}%)</option>`;
                })
                .join('')}
            </optgroup>
          `
          )
          .join('');

      if (headerSelect) {
        headerSelect.innerHTML = buildOptionsHtml(activeModelId);
      }
      if (injectModelSelect) {
        const curInjectModel = injectModelSelect.value || 'opencode-go/kimi-k2.7-code';
        injectModelSelect.innerHTML = buildOptionsHtml(curInjectModel);
      }
    }

    if (depthSelect && document.activeElement !== depthSelect) {
      depthSelect.value = activeDepth;
    }

    // Update Always-Visible Inline Context Usage Bar in Antigravity UI
    const ctx = data.contextAnalytics || {};
    const win = ctx.currentWindow || {};
    const tok = ctx.tokenStats || {};
    const lat = ctx.latencyStats || {};

    const usedTokens = Number(activeModel.usedContextTokens || win.usedTokens || 55100);
    const maxTokens = Number(activeModel.contextWindowTokens || win.maxTokens || 1000000);
    const usedPct = Number(
      activeModel.contextUsedPct ??
        win.usedPct ??
        ((usedTokens / Math.max(1, maxTokens)) * 100).toFixed(1)
    );

    const tokEl = document.getElementById('inline-ctx-tokens');
    if (tokEl) {
      tokEl.textContent = `${formatCompactContext(usedTokens)} / ${formatCompactContext(maxTokens)}`;
    }
    const pctEl = document.getElementById('inline-ctx-pct');
    if (pctEl) {
      pctEl.textContent = `${usedPct}%`;
    }
    const cacheEl = document.getElementById('inline-ctx-cache');
    if (cacheEl) {
      const cacheHit = Number(tok.cacheHitPct || 94.2);
      const speed = Number(lat.outputSpeedTokPerSec || 226);
      cacheEl.textContent = `Cache ${cacheHit}% · ${speed} tok/s`;
    }
    const dnaBarEl = document.getElementById('inline-ctx-dna-bar');
    if (dnaBarEl && Array.isArray(win.categories)) {
      dnaBarEl.innerHTML = win.categories
        .map((c) => {
          const w = Math.max(2, Number(c.pct || 0));
          return `<span style="width:${w}%; background:${c.color}; height:100%;" title="${escapeHtml(c.label)}: ${escapeHtml(c.tokensFormatted)} (${Number(c.pct)}%)"></span>`;
        })
        .join('');
    }
  }

  // =========================================================================
  // TAB 1: DYNAMIC MULTI-TIER SUBAGENT SWARM HIERARCHY & TEAM FORMATION
  // =========================================================================
  function getActiveFormation(data) {
    const formations = data?.swarm?.formations || {};
    return (
      formations[activeFormationId] ||
      formations['live-harness2'] ||
      Object.values(formations)[0] ||
      null
    );
  }

  function getLineageSet(formation, targetNodeId) {
    if (!targetNodeId || !formation) return null;
    const related = new Set([targetNodeId]);
    const nodesById = new Map((formation.nodes || []).map((n) => [n.id, n]));

    // Walk ancestors
    const upQueue = [targetNodeId];
    while (upQueue.length > 0) {
      const curr = upQueue.shift();
      const node = nodesById.get(curr);
      for (const pid of node?.parentIds || []) {
        if (!related.has(pid)) {
          related.add(pid);
          upQueue.push(pid);
        }
      }
    }

    // Walk descendants
    const downQueue = [targetNodeId];
    while (downQueue.length > 0) {
      const curr = downQueue.shift();
      for (const n of formation.nodes || []) {
        if ((n.parentIds || []).includes(curr) && !related.has(n.id)) {
          related.add(n.id);
          downQueue.push(n.id);
        }
      }
    }

    return related;
  }

  function renderNodeDnaBar(dna = {}) {
    const keys = [
      'systemPrompt',
      'toolDefinitions',
      'userMessages',
      'injectedRag',
      'skillInjection',
      'assistantMessages',
      'toolResults',
      'freeWindow',
    ];
    return `
      <div class="h-node-dna-bar">
        ${keys
          .map((k) => {
            const w = Math.max(0, Number(dna[k] || 0));
            return `<span class="h-node-dna-seg" data-dna-seg="${k}" style="width:${w}%; background:${DNA_COLORS[k]}"></span>`;
          })
          .join('')}
      </div>
    `;
  }

  function buildHoverPreviewHtml(formation, node) {
    if (!node) return '';
    const dna = node.dna || {};
    const parentRoles = (node.parentIds || [])
      .map((pid) => (formation.nodes || []).find((x) => x.id === pid)?.role || pid)
      .filter(Boolean);
    const childRoles = (formation.nodes || [])
      .filter((x) => (x.parentIds || []).includes(node.id))
      .map((x) => x.role);

    const statusBadge =
      node.status === 'RUNNING'
        ? '<span class="status-chip status-active">● RUNNING</span>'
        : '<span class="pill-badge">✓ COMPLETED</span>';

    const dnaRowsHtml = Object.keys(DNA_LABELS)
      .map(
        (k) => `
        <div class="hover-dna-row">
          <span class="hover-dna-name"><i style="background:${DNA_COLORS[k]}"></i>${escapeHtml(DNA_LABELS[k])}</span>
          <strong>${Number(dna[k] || 0)}%</strong>
        </div>
      `
      )
      .join('');

    return `
      <div class="hover-preview-top">
        <div>
          <div class="hover-preview-role">${escapeHtml(node.role)}</div>
          <div class="hover-preview-team">${escapeHtml(node.teamName || `Tier ${node.tier}`)}</div>
        </div>
        ${statusBadge}
      </div>
      <div class="hover-preview-kpis">
        <div class="hover-kpi-box">
          <span class="hover-kpi-label">Tokens · Cost</span>
          <span class="hover-kpi-val">${escapeHtml(node.totalTokensFormatted)} · ${escapeHtml(node.costFormatted)}</span>
        </div>
        <div class="hover-kpi-box">
          <span class="hover-kpi-label">Context Used</span>
          <span class="hover-kpi-val" style="color:#34d399;">${escapeHtml(node.contextTokensFormatted || '94k')} (${Number(node.contextUsedPct || 0)}%)</span>
        </div>
        <div class="hover-kpi-box">
          <span class="hover-kpi-label">Elapsed · Steps</span>
          <span class="hover-kpi-val">${escapeHtml(node.durationFormatted)}</span>
        </div>
      </div>
      <div class="inline-pair" style="font-size:10.5px;">
        <span class="pill-badge">Model: <code>${escapeHtml(node.model)}</code></span>
        <span class="status-chip ${node.workspace === 'branch' ? 'status-branch' : 'status-active'}">
          Workspace: ${escapeHtml(node.workspace === 'branch' ? 'branch (Isolated)' : 'inherit')}
        </span>
      </div>
      ${renderNodeDnaBar(dna)}
      <div class="hover-dna-grid">${dnaRowsHtml}</div>
      <div class="hover-section-box">
        <div class="hover-section-title">Live Telemetry Report</div>
        <div>${escapeHtml(node.latestReport || 'Active')}</div>
      </div>
      <div class="hover-section-box" style="border-left-color:#a855f7;">
        <div class="hover-section-title">Delegated Task Prompt</div>
        <div>${escapeHtml(node.taskPrompt || '')}</div>
      </div>
      <div class="hover-lineage-row">
        <span>↑ Upstream: <strong>${parentRoles.length > 0 ? escapeHtml(parentRoles.join(', ')) : 'Root (Tier 0)'}</strong></span>
        <span>↓ Downstream: <strong>${childRoles.length} agents</strong></span>
      </div>
    `;
  }

  function positionHoverPreview(anchorEl, clientX, clientY) {
    const previewEl = document.getElementById('node-hover-preview');
    const viewport = document.getElementById('hierarchy-viewport');
    if (!previewEl || !viewport || previewEl.classList.contains('hidden')) return;

    const vpRect = viewport.getBoundingClientRect();
    const pw = previewEl.offsetWidth || 310;
    const ph = previewEl.offsetHeight || 280;

    let left = 14;
    let top = 14;

    if (anchorEl && viewport.contains(anchorEl)) {
      const r = anchorEl.getBoundingClientRect();
      left = r.right - vpRect.left + 12;
      if (left + pw > vpRect.width - 10) {
        left = Math.max(10, r.left - vpRect.left - pw - 12);
      }
      top = Math.min(Math.max(10, r.top - vpRect.top - 8), Math.max(10, vpRect.height - ph - 12));
    } else if (typeof clientX === 'number' && typeof clientY === 'number') {
      left = Math.min(Math.max(10, clientX - vpRect.left + 16), Math.max(10, vpRect.width - pw - 12));
      top = Math.min(Math.max(10, clientY - vpRect.top - 16), Math.max(10, vpRect.height - ph - 12));
    }

    previewEl.style.left = `${Math.round(left)}px`;
    previewEl.style.top = `${Math.round(top)}px`;
  }

  function showNodeHoverPreview(nodeId, anchorEl) {
    if (isPanningCanvas || draggingNodeId) return;
    const formation = getActiveFormation(latestDashboard);
    const previewEl = document.getElementById('node-hover-preview');
    if (!formation || !previewEl) return;

    const node = (formation.nodes || []).find((n) => n.id === nodeId);
    if (!node) return;

    hoveredNodeId = nodeId;
    previewEl.innerHTML = buildHoverPreviewHtml(formation, node);
    previewEl.classList.remove('hidden');
    positionHoverPreview(anchorEl);
    updateHierarchyVisualFocus(formation);
  }

  function hideNodeHoverPreview() {
    const previewEl = document.getElementById('node-hover-preview');
    if (previewEl) previewEl.classList.add('hidden');
    if (hoveredNodeId) {
      hoveredNodeId = null;
      const formation = getActiveFormation(latestDashboard);
      if (formation) updateHierarchyVisualFocus(formation);
    }
  }

  function updateHierarchyVisualFocus(formation) {
    const stage = document.getElementById('hierarchy-stage');
    if (!stage || !formation) return;
    const focusNodeId = selectedNodeId || hoveredNodeId;
    const lineage = getLineageSet(formation, focusNodeId);

    stage.querySelectorAll('.h-node-card').forEach((card) => {
      const nid = card.getAttribute('data-node-id');
      card.classList.toggle('node-selected', selectedNodeId === nid || hoveredNodeId === nid);
      card.classList.toggle('node-dimmed', Boolean(lineage && !lineage.has(nid)));
    });

    drawHierarchyEdges();
  }

  function computeGridColumns(count) {
    if (count <= 1) return 1;
    if (count === 2) return 2;
    if (count === 3) return 2; // 2x2 compact grid instead of wide 1x3 row
    if (count === 4) return 2; // 2x2 square grid instead of 1x4 straight line
    if (count <= 6) return 3;  // 3x2 compact grid instead of 1x6 straight line
    if (count <= 9) return 3;  // 3x3 compact grid
    return 4;                  // 4xM grid for 10+ subagents
  }

  function getVisibleGraphTopology(formation) {
    const allNodes = formation?.nodes || [];
    const nodesById = new Map(allNodes.map((n) => [n.id, n]));
    const rootNode = allNodes.find((n) => Number(n.tier || 0) === 0) || allNodes[0] || null;
    const rootId = rootNode?.id || 'main-orchestrator';

    const visibleNodes = [];
    const hiddenInactiveNodes = [];

    for (const n of allNodes) {
      const isRoot = Number(n.tier || 0) === 0;
      const isActive = n.status === 'RUNNING';
      if (isRoot || !hideInactiveSubagents || isActive) {
        visibleNodes.push(n);
      } else {
        hiddenInactiveNodes.push(n);
      }
    }

    const visibleIdSet = new Set(visibleNodes.map((n) => n.id));

    // Resolve nearest visible ancestor for each visible node so recalled subagents
    // connect cleanly even if an intermediate parent node is finished/hidden
    const resolveVisibleAncestors = (node) => {
      if (Number(node.tier || 0) === 0) return [];
      const found = new Set();
      const queue = [...(node.parentIds || [])];
      const visited = new Set();
      while (queue.length > 0) {
        const pid = queue.shift();
        if (!pid || visited.has(pid)) continue;
        visited.add(pid);
        if (visibleIdSet.has(pid)) {
          found.add(pid);
        } else {
          const pNode = nodesById.get(pid);
          if (pNode && Array.isArray(pNode.parentIds)) {
            queue.push(...pNode.parentIds);
          }
        }
      }
      if (found.size === 0 && visibleIdSet.has(rootId) && node.id !== rootId) {
        found.add(rootId);
      }
      return Array.from(found);
    };

    const palette = ['#38bdf8', '#10b981', '#a855f7', '#f59e0b', '#ec4899', '#6366f1'];
    let colorIdx = 0;
    const visibleEdges = [];
    const effectivePrimaryParent = new Map();

    for (const n of visibleNodes) {
      const ancestors = resolveVisibleAncestors(n);
      effectivePrimaryParent.set(n.id, ancestors[0] || rootId);
      for (const pid of ancestors) {
        visibleEdges.push({
          id: `${pid}->${n.id}`,
          from: pid,
          to: n.id,
          status: n.status === 'RUNNING' ? 'RUNNING' : 'COMPLETED',
          recalled: Boolean(n.recalled),
          color: palette[colorIdx++ % palette.length],
        });
      }
    }

    return {
      allNodes,
      visibleNodes,
      hiddenInactiveNodes,
      visibleEdges,
      effectivePrimaryParent,
      nodesById,
      rootId,
    };
  }

  async function triggerSubagentLifecycle(action, nodeId = '', nodeIds = []) {
    const res = await apiFetch('/api/swarm/recall', {
      formationId: activeFormationId,
      action,
      nodeId,
      nodeIds,
      durationSec: 180,
    });
    if (res && res.ok) {
      if (action === 'recall') {
        showToast(`↺ Recalled subagent '${nodeId}' — rejoined active 2D network graph!`);
      } else if (action === 'recall_all') {
        showToast(`↺ Recalled ${nodeIds.length} subagents to active 2D network graph!`);
      } else if (action === 'complete') {
        showToast(`✓ Marked '${nodeId}' completed (parked in inactive subagents).`);
      }
      lastRenderedNodeSignature = '';
      lastRenderedMemberSignature = '';
      await refreshDashboard(true);
    }
  }

  function drawHierarchyEdges() {
    const formation = getActiveFormation(latestDashboard);
    const svg = document.getElementById('hierarchy-edges-svg');
    const stage = document.getElementById('hierarchy-stage');
    if (!formation || !svg || !stage) return;

    const topology = getVisibleGraphTopology(formation);
    const stageRect = stage.getBoundingClientRect();
    const scale = zoomScale || 1;
    const width = Math.max(stage.scrollWidth, stageRect.width / scale, 540);
    const height = Math.max(stage.scrollHeight, stageRect.height / scale, 440);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.style.width = `${width}px`;
    svg.style.height = `${height}px`;

    const focusNodeId = selectedNodeId || hoveredNodeId;
    const lineage = getLineageSet(formation, focusNodeId);
    const pathsHtml = [];

    for (const edge of topology.visibleEdges) {
      const fromEl = stage.querySelector(`[data-node-id="${edge.from}"]`);
      const toEl = stage.querySelector(`[data-node-id="${edge.to}"]`);
      if (!fromEl || !toEl) continue;

      const r1 = fromEl.getBoundingClientRect();
      const r2 = toEl.getBoundingClientRect();

      const x1 = (r1.left - stageRect.left + r1.width / 2) / scale;
      const y1 = (r1.bottom - stageRect.top) / scale;
      const x2 = (r2.left - stageRect.left + r2.width / 2) / scale;
      const y2 = (r2.top - stageRect.top) / scale;
      const dy = Math.max(24, y2 - y1);
      const cp1Y = y1 + dy * 0.42;
      const cp2Y = y2 - dy * 0.38;

      const isHighlighted = lineage && lineage.has(edge.from) && lineage.has(edge.to);
      const isDimmed = lineage && !isHighlighted;
      const runningCls = edge.status === 'RUNNING' ? 'edge-running' : '';
      const focusCls = isHighlighted ? 'edge-highlighted' : isDimmed ? 'edge-dimmed' : '';
      const strokeColor = edge.recalled
        ? '#34d399'
        : edge.status === 'RUNNING'
          ? '#10b981'
          : edge.color || '#38bdf8';

      pathsHtml.push(
        `<path class="edge-path ${runningCls} ${focusCls}" d="M ${x1} ${y1} C ${x1} ${cp1Y}, ${x2} ${cp2Y}, ${x2} ${y2}" stroke="${strokeColor}" />`
      );
      pathsHtml.push(
        `<circle cx="${x2}" cy="${y2 - 2}" r="3" fill="${strokeColor}" opacity="${isDimmed ? 0.2 : 0.9}" />`
      );
    }

    svg.innerHTML = pathsHtml.join('');
  }

  function bindNodeCardInteractions(card) {
    const nid = card.getAttribute('data-node-id');
    if (!nid) return;

    card.addEventListener('mouseenter', () => {
      showNodeHoverPreview(nid, card);
    });

    card.addEventListener('mouseleave', () => {
      if (!draggingNodeId) hideNodeHoverPreview();
    });

    card.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      draggingNodeId = nid;
      draggingNodeEl = card;
      nodeDragMoved = false;
      nodeDragStartX = e.clientX;
      nodeDragStartY = e.clientY;
      const curOffset = getNodeOffset(nid);
      nodeOriginX = curOffset.x;
      nodeOriginY = curOffset.y;
      try {
        card.setPointerCapture(e.pointerId);
      } catch {}
    });

    card.addEventListener('pointermove', (e) => {
      if (draggingNodeId !== nid || !draggingNodeEl) return;
      const dxScreen = e.clientX - nodeDragStartX;
      const dyScreen = e.clientY - nodeDragStartY;
      if (!nodeDragMoved && Math.hypot(dxScreen, dyScreen) > 4) {
        nodeDragMoved = true;
        card.classList.add('is-dragging');
        hideNodeHoverPreview();
      }
      if (nodeDragMoved) {
        const scale = zoomScale || 1;
        const nextX = Math.round(nodeOriginX + dxScreen / scale);
        const nextY = Math.round(nodeOriginY + dyScreen / scale);
        setNodeOffset(nid, nextX, nextY);
        card.style.transform = `translate3d(${nextX}px, ${nextY}px, 0)`;
        drawHierarchyEdges();
      }
    });

    const finishNodePointer = (e) => {
      if (draggingNodeId !== nid) return;
      try {
        card.releasePointerCapture(e.pointerId);
      } catch {}
      card.classList.remove('is-dragging');
      const wasDragged = nodeDragMoved;
      draggingNodeId = null;
      draggingNodeEl = null;
      nodeDragMoved = false;

      if (!wasDragged) {
        selectedNodeId = selectedNodeId === nid ? null : nid;
        renderSwarmTab(latestDashboard);
      } else {
        drawHierarchyEdges();
      }
    };

    card.addEventListener('pointerup', finishNodePointer);
    card.addEventListener('pointercancel', finishNodePointer);
  }

  function renderSwarmTab(data) {
    const swarm = data.swarm || {};
    const formation = getActiveFormation(data);
    if (!formation) return;

    const sum = formation.summary || {};
    document.getElementById('swarm-sum-total').textContent = `${sum.totalAgents || 0} Agents`;
    document.getElementById('swarm-sum-running').textContent = `● ${sum.runningCount || 0} Running`;
    document.getElementById('swarm-sum-completed').textContent = `✓ ${sum.completedCount || 0} Completed`;
    document.getElementById('swarm-sum-context').textContent = `Total Context: ${sum.totalContextFormatted || '0'}`;
    document.getElementById('swarm-sum-cost').textContent = `Est. Cost: ${sum.estimatedCostFormatted || '$0.00'}`;

    const progPct = Math.round(
      ((sum.progressCompleted || 0) / Math.max(1, sum.progressTotal || 1)) * 100
    );
    document.getElementById('swarm-progress-fill').style.width = `${progPct}%`;
    document.getElementById('swarm-progress-label').textContent =
      `${sum.progressCompleted || 0}/${sum.progressTotal || 1}`;

    document.getElementById('formation-title').textContent = formation.name;

    const topology = getVisibleGraphTopology(formation);
    const { visibleNodes, hiddenInactiveNodes, effectivePrimaryParent, nodesById, rootId } =
      topology;

    const hideBtn = document.getElementById('btn-toggle-hide-inactive');
    if (hideBtn) {
      hideBtn.classList.toggle('active', hideInactiveSubagents);
      hideBtn.textContent = hideInactiveSubagents
        ? `🙈 Hide Inactive First (${hiddenInactiveNodes.length} hidden)`
        : `👁️ Showing All (+${(formation.nodes || []).filter((n) => n.tier > 0 && n.status !== 'RUNNING').length} inactive)`;
    }

    const recallAllBtn = document.getElementById('btn-recall-all-subagents');
    if (recallAllBtn) {
      const allFinishedSubIds = (formation.nodes || [])
        .filter((n) => Number(n.tier || 0) > 0 && n.status !== 'RUNNING')
        .map((n) => n.id);
      const allRunningSubIds = (formation.nodes || [])
        .filter((n) => Number(n.tier || 0) > 0 && n.status === 'RUNNING')
        .map((n) => n.id);
      if (allFinishedSubIds.length > 0) {
        recallAllBtn.textContent = `↺ Recall Finished (${allFinishedSubIds.length})`;
        recallAllBtn.setAttribute('data-action-mode', 'recall_all');
      } else if (allRunningSubIds.length > 0) {
        recallAllBtn.textContent = `✓ Finish Active (${allRunningSubIds.length})`;
        recallAllBtn.setAttribute('data-action-mode', 'complete_all');
      }
    }

    // Render Inactive / Finished Subagents Dock (when inactive subagents are hidden from graph)
    const dockEl = document.getElementById('inactive-subagents-dock');
    if (dockEl) {
      if (hideInactiveSubagents && hiddenInactiveNodes.length > 0) {
        dockEl.classList.remove('hidden');
        dockEl.innerHTML = `
          <div class="inactive-dock-top">
            <span>
              <strong style="color:#38bdf8;">✓ ${hiddenInactiveNodes.length} Finished Subagent${hiddenInactiveNodes.length === 1 ? '' : 's'} Hidden from Graph</strong>
              <span class="muted-text"> — Click <strong>↺ Recall</strong> (or call <code>send_message</code>) so a subagent rejoins the active 2D network graph:</span>
            </span>
            <div class="inline-pair">
              <button class="recall-mini-btn" id="dock-btn-recall-all">↺ Recall All (${hiddenInactiveNodes.length}) into 2D Grid</button>
              <button class="recall-mini-btn btn-complete-sub" id="dock-btn-show-inactive">👁️ Show Inactive on Graph</button>
            </div>
          </div>
          <div class="inactive-dock-chips">
            ${hiddenInactiveNodes
              .map(
                (hn) => `
              <div class="inactive-sub-chip" data-dock-node-id="${escapeHtml(hn.id)}">
                <span class="inactive-chip-name" title="${escapeHtml(hn.role)} (${escapeHtml(hn.durationFormatted)})">
                  <span class="status-dot dot-completed" style="display:inline-block;margin-right:4px;"></span>
                  ${escapeHtml(hn.role)}
                </span>
                <button class="recall-mini-btn btn-dock-recall-single" data-recall-id="${escapeHtml(hn.id)}" title="Recall ${escapeHtml(hn.role)} to rejoin the active network graph">
                  ↺ Recall
                </button>
              </div>
            `
              )
              .join('')}
          </div>
        `;
        dockEl.querySelectorAll('.btn-dock-recall-single').forEach((btn) => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const nid = btn.getAttribute('data-recall-id');
            if (nid) triggerSubagentLifecycle('recall', nid);
          });
        });
        dockEl.querySelector('#dock-btn-recall-all')?.addEventListener('click', (e) => {
          e.stopPropagation();
          triggerSubagentLifecycle(
            'recall_all',
            '',
            hiddenInactiveNodes.map((n) => n.id)
          );
        });
        dockEl.querySelector('#dock-btn-show-inactive')?.addEventListener('click', (e) => {
          e.stopPropagation();
          hideInactiveSubagents = false;
          lastRenderedNodeSignature = '';
          renderSwarmTab(latestDashboard);
        });
      } else {
        dockEl.classList.add('hidden');
        dockEl.innerHTML = '';
      }
    }

    // Group visible nodes by tier, then inside each tier group by effectiveParentId into 2D Grids!
    const tiersMap = new Map();
    for (const node of visibleNodes) {
      const t = Number(node.tier || 0);
      if (!tiersMap.has(t)) tiersMap.set(t, []);
      tiersMap.get(t).push(node);
    }
    const sortedTiers = Array.from(tiersMap.entries()).sort((a, b) => a[0] - b[0]);
    const focusNodeId = selectedNodeId || hoveredNodeId;
    const lineage = getLineageSet(formation, focusNodeId);

    const tiersContainer = document.getElementById('hierarchy-tiers-container');
    const currentSignature = `${activeFormationId}:hide=${hideInactiveSubagents}:${visibleNodes
      .map((n) => `${n.id}:${n.status}:${n.recalled ? 1 : 0}`)
      .join(',')}`;

    // Non-destructive in-place DOM patching when visible topology & statuses are unchanged
    if (
      currentSignature === lastRenderedNodeSignature &&
      tiersContainer.querySelectorAll('.h-node-card').length === visibleNodes.length
    ) {
      for (const n of visibleNodes) {
        const card = tiersContainer.querySelector(`[data-node-id="${n.id}"]`);
        if (!card) continue;
        const isSelected = selectedNodeId === n.id || hoveredNodeId === n.id;
        const isDimmed = Boolean(lineage && !lineage.has(n.id));
        card.classList.toggle('node-running', n.status === 'RUNNING');
        card.classList.toggle('node-recalled', Boolean(n.recalled && n.status === 'RUNNING'));
        card.classList.toggle('node-current', Boolean(n.isCurrent));
        card.classList.toggle('node-selected', isSelected);
        card.classList.toggle('node-dimmed', isDimmed);

        const dotEl = card.querySelector('.status-dot');
        if (dotEl) {
          dotEl.className = `status-dot ${
            n.status === 'RUNNING'
              ? 'dot-running'
              : n.status === 'COMPLETED'
                ? 'dot-completed'
                : 'dot-standby'
          }`;
        }
        const titleEl = card.querySelector('.h-node-title');
        if (titleEl) {
          titleEl.textContent = n.role;
          titleEl.title = n.role;
        }
        const tokEl = card.querySelector('.h-node-tokens');
        if (tokEl) {
          tokEl.textContent = `${n.totalTokensFormatted} · ${n.costFormatted}`;
        }
        const dna = n.dna || {};
        card.querySelectorAll('.h-node-dna-seg').forEach((seg) => {
          const k = seg.getAttribute('data-dna-seg');
          if (k) seg.style.width = `${Math.max(0, Number(dna[k] || 0))}%`;
        });
        const footerSpans = card.querySelectorAll('.h-node-footer span');
        if (footerSpans[0]) {
          footerSpans[0].textContent = n.durationFormatted;
        }
        if (footerSpans[1]) footerSpans[1].textContent = `${Number(n.contextUsedPct || 0)}%`;
      }

      if (hoveredNodeId) {
        const hoveredNode = (formation.nodes || []).find((n) => n.id === hoveredNodeId);
        const previewEl = document.getElementById('node-hover-preview');
        if (hoveredNode && previewEl && !previewEl.classList.contains('hidden')) {
          previewEl.innerHTML = buildHoverPreviewHtml(formation, hoveredNode);
        }
      }
    } else {
      lastRenderedNodeSignature = currentSignature;

      const renderSingleNodeCard = (n) => {
        const isSelected = selectedNodeId === n.id || hoveredNodeId === n.id;
        const isDimmed = lineage && !lineage.has(n.id);
        const isRecalledActive = Boolean(n.recalled && n.status === 'RUNNING');
        const dotClass =
          n.status === 'RUNNING'
            ? 'dot-running'
            : n.status === 'COMPLETED'
              ? 'dot-completed'
              : 'dot-standby';
        const badgeText = n.isCurrent
          ? 'Current'
          : isRecalledActive
            ? `↺ Recalled${n.recallCount > 1 ? ` #${n.recallCount}` : ''}`
            : n.workspace === 'branch'
              ? 'branch'
              : `T${n.tier}`;
        const badgeClass = isRecalledActive
          ? 'badge-recalled'
          : n.workspace === 'branch'
            ? 'badge-branch'
            : '';
        const offset = getNodeOffset(n.id);
        const transformStyle =
          offset.x || offset.y
            ? `style="transform: translate3d(${offset.x}px, ${offset.y}px, 0);"`
            : '';

        return `
          <div class="h-node-card ${n.status === 'RUNNING' ? 'node-running' : ''} ${isRecalledActive ? 'node-recalled' : ''} ${n.isCurrent ? 'node-current' : ''} ${isSelected ? 'node-selected' : ''} ${isDimmed ? 'node-dimmed' : ''}" data-node-id="${escapeHtml(n.id)}" ${transformStyle}>
            <div class="h-node-header">
              <div class="h-node-title-wrap">
                <span class="status-dot ${dotClass}"></span>
                <span class="h-node-title" title="${escapeHtml(n.role)}">${escapeHtml(n.role)}</span>
              </div>
              <span class="h-node-badge ${badgeClass}">${escapeHtml(badgeText)}</span>
            </div>
            <div class="h-node-tokens">${escapeHtml(n.totalTokensFormatted)} · ${escapeHtml(n.costFormatted)}</div>
            <div class="muted-text" style="font-size:9.5px; margin-bottom:2px;"><code>${escapeHtml(n.model)}</code> · <strong>${escapeHtml(String(n.reasoningDepth || 'balanced').toUpperCase())}</strong> (${escapeHtml(n.reasoningEffort || 'high')})</div>
            ${renderNodeDnaBar(n.dna)}
            <div class="h-node-footer">
              <span>${escapeHtml(n.durationFormatted)}</span>
              <span class="h-node-pct">${Number(n.contextUsedPct || 0)}%</span>
            </div>
          </div>
        `;
      };

      tiersContainer.innerHTML = sortedTiers
        .map(([tierNum, nodes]) => {
          if (tierNum === 0) {
            return `
              <div class="hierarchy-tier-row" data-tier="0">
                <div class="hierarchy-parent-cluster cluster-root">
                  <div class="subagent-cards-grid" style="--grid-cols: ${computeGridColumns(nodes.length)};">
                    ${nodes.map((n) => renderSingleNodeCard(n)).join('')}
                  </div>
                </div>
              </div>
            `;
          }

          // Group this tier's visible subagents by their primary parent node so each parent's
          // children are arranged in a compact 2D Multi-Column Grid instead of a 1D straight line!
          const parentGroups = new Map();
          for (const n of nodes) {
            const pid = effectivePrimaryParent.get(n.id) || n.parentIds?.[0] || rootId;
            if (!parentGroups.has(pid)) parentGroups.set(pid, []);
            parentGroups.get(pid).push(n);
          }

          const clustersHtml = Array.from(parentGroups.entries())
            .map(([pid, groupNodes]) => {
              const parentObj = nodesById.get(pid);
              const parentLabel = parentObj ? parentObj.role : 'Parent Orchestrator';
              const cols = computeGridColumns(groupNodes.length);
              const rows = Math.ceil(groupNodes.length / cols);
              const hiddenForParent = hiddenInactiveNodes.filter((hn) =>
                (hn.parentIds || []).includes(pid)
              ).length;

              return `
                <div class="hierarchy-parent-cluster" data-parent-cluster="${escapeHtml(pid)}">
                  <div class="cluster-header-bar">
                    <span>↳ ${escapeHtml(parentLabel)}</span>
                    <span class="cluster-grid-badge">
                      ⊞ ${cols}×${rows} Grid · ${groupNodes.length} shown${hiddenForParent > 0 ? ` · +${hiddenForParent} hidden` : ''}
                    </span>
                  </div>
                  <div class="subagent-cards-grid" style="--grid-cols: ${cols};">
                    ${groupNodes.map((n) => renderSingleNodeCard(n)).join('')}
                  </div>
                </div>
              `;
            })
            .join('');

          return `
            <div class="hierarchy-tier-row" data-tier="${tierNum}">
              ${clustersHtml}
            </div>
          `;
        })
        .join('');

      tiersContainer.querySelectorAll('.h-node-card').forEach((card) => {
        bindNodeCardInteractions(card);
      });
    }

    requestAnimationFrame(() => drawHierarchyEdges());

    // Render Right Top: Swarm Teams & Members (编队成员) with Recall / Complete controls
    const teamsContainer = document.getElementById('swarm-teams-container');
    document.getElementById('team-members-count-badge').textContent =
      `${(formation.nodes || []).length} Agents`;

    const filteredTeams = [];
    const visibleMemberIds = [];
    for (const team of formation.teams || []) {
      let members = [...(team.members || [])];
      if (memberStatusFilter !== 'ALL') {
        members = members.filter((m) => m.status === memberStatusFilter);
      }
      if (memberSearchQuery) {
        const q = memberSearchQuery.toLowerCase();
        members = members.filter(
          (m) =>
            m.role.toLowerCase().includes(q) ||
            m.model.toLowerCase().includes(q) ||
            team.teamName.toLowerCase().includes(q)
        );
      }
      if (memberSortMode === 'tokens') {
        members.sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0));
      } else if (memberSortMode === 'steps') {
        members.sort((a, b) => (b.steps || 0) - (a.steps || 0));
      }
      if (members.length > 0) {
        filteredTeams.push({ teamName: team.teamName, members });
        for (const m of members) visibleMemberIds.push(`${m.id}:${m.status}:${m.recalled ? 1 : 0}`);
      }
    }

    const memberSignature = `${activeFormationId}:${memberStatusFilter}:${memberSortMode}:${memberSearchQuery}:${visibleMemberIds.join(',')}`;
    if (
      memberSignature === lastRenderedMemberSignature &&
      teamsContainer.querySelectorAll('.member-card').length === visibleMemberIds.length
    ) {
      for (const team of filteredTeams) {
        for (const m of team.members) {
          const card = teamsContainer.querySelector(`[data-member-id="${m.id}"]`);
          if (!card) continue;
          const isRunning = m.status === 'RUNNING';
          card.classList.toggle('member-running', isRunning);
          card.classList.toggle('member-selected', selectedNodeId === m.id);
          const dot = card.querySelector('.status-dot');
          if (dot) dot.className = `status-dot ${isRunning ? 'dot-running' : 'dot-completed'}`;
          const reportEl = card.querySelector('.member-report');
          if (reportEl) reportEl.textContent = m.latestReport || '';
          const footerFirst = card.querySelector('.member-footer span');
          if (footerFirst) {
            footerFirst.textContent = `${m.contextTokensFormatted} · ${m.durationFormatted}`;
          }
        }
      }
    } else {
      lastRenderedMemberSignature = memberSignature;
      teamsContainer.innerHTML = filteredTeams
        .map(
          (team) => `
          <div class="team-group-block">
            <div class="team-group-header">
              <span>${escapeHtml(team.teamName)}</span>
              <span>${team.members.length} members</span>
            </div>
            <div class="team-members-grid">
              ${team.members
                .map((m) => {
                  const isRunning = m.status === 'RUNNING';
                  const isSel = selectedNodeId === m.id;
                  const isSub = Number(m.tier || 0) > 0;
                  const actionBtnHtml = isSub
                    ? isRunning
                      ? `<button class="recall-mini-btn btn-complete-sub btn-member-lifecycle" data-lc-action="complete" data-lc-node="${escapeHtml(m.id)}" title="Mark finished &amp; hide from active graph">✓ Finish</button>`
                      : `<button class="recall-mini-btn btn-member-lifecycle" data-lc-action="recall" data-lc-node="${escapeHtml(m.id)}" title="Recall subagent to rejoin the active 2D network graph">↺ Recall</button>`
                    : `<span>→</span>`;
                  const statusLabel = isRunning
                    ? m.recalled
                      ? `● Running (↺ Recalled #${m.recallCount || 1})`
                      : '● Running'
                    : '✓ Finished (Inactive)';

                  return `
                    <div class="member-card ${isRunning ? 'member-running' : ''} ${isSel ? 'member-selected' : ''}" data-member-id="${escapeHtml(m.id)}">
                      <div class="member-card-top">
                        <span class="member-role" title="${escapeHtml(m.role)}">${escapeHtml(m.role)}</span>
                        <span class="status-dot ${isRunning ? 'dot-running' : 'dot-completed'}"></span>
                      </div>
                      <div class="member-meta">${escapeHtml(statusLabel)} · <code>${escapeHtml(m.model)}</code> · <strong>${escapeHtml(String(m.reasoningDepth || 'balanced').toUpperCase())}</strong></div>
                      <div class="member-report">${escapeHtml(m.latestReport || '')}</div>
                      <div class="member-footer">
                        <span>${escapeHtml(m.contextTokensFormatted)} · ${escapeHtml(m.durationFormatted)}</span>
                        ${actionBtnHtml}
                      </div>
                    </div>
                  `;
                })
                .join('')}
            </div>
          </div>
        `
        )
        .join('');

      teamsContainer.querySelectorAll('.member-card').forEach((card) => {
        const mid = card.getAttribute('data-member-id');
        card.addEventListener('mouseenter', () => {
          const nodeEl = document.querySelector(`#hierarchy-stage [data-node-id="${mid}"]`);
          showNodeHoverPreview(mid, nodeEl || card);
        });
        card.addEventListener('mouseleave', () => {
          hideNodeHoverPreview();
        });
        card.addEventListener('click', (e) => {
          if (e.target.closest('.btn-member-lifecycle')) return;
          selectedNodeId = selectedNodeId === mid ? null : mid;
          renderSwarmTab(latestDashboard);
        });
      });

      teamsContainer.querySelectorAll('.btn-member-lifecycle').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const act = btn.getAttribute('data-lc-action') || 'recall';
          const nid = btn.getAttribute('data-lc-node') || '';
          if (nid) triggerSubagentLifecycle(act, nid);
        });
      });
    }

    // Render Right Middle: Delegated Tasks (任务)
    const tasksListEl = document.getElementById('swarm-tasks-list');
    let tasks = [...(formation.tasks || [])];
    if (selectedNodeId && selectedNodeId !== formation.nodes?.[0]?.id) {
      tasks = tasks.filter((t) => t.agentId === selectedNodeId);
    }
    if (taskStatusFilter !== 'ALL') {
      tasks = tasks.filter((t) => t.status === taskStatusFilter);
    }

    if (tasks.length === 0) {
      tasksListEl.innerHTML = `<div class="muted-text">No matching delegated tasks for current filter.</div>`;
    } else {
      tasksListEl.innerHTML = tasks
        .map(
          (t) => `
          <div class="list-item">
            <div class="list-item-header">
              <span class="list-item-title">
                <span class="status-dot ${t.status === 'RUNNING' ? 'dot-running' : 'dot-completed'}" style="display:inline-block;margin-right:5px;"></span>
                ${escapeHtml(t.role)}
              </span>
              <div class="inline-pair">
                <span class="status-chip ${t.workspace === 'branch' ? 'status-branch' : 'status-active'}">
                  ${escapeHtml(t.workspace === 'branch' ? 'Workspace: branch' : 'inherit')}
                </span>
                <span class="pill-badge">${escapeHtml(t.status === 'RUNNING' ? 'In Progress' : 'Completed')}</span>
              </div>
            </div>
            <div class="muted-text">${escapeHtml(t.prompt)}</div>
            <div class="muted-text">${escapeHtml(t.tokensFormatted)} · ${escapeHtml(t.durationFormatted)}</div>
          </div>
        `
        )
        .join('');
    }

    // Render Bottom Left: Inter-Agent Communication Bus (通讯记录)
    const commListEl = document.getElementById('inter-agent-messages-list');
    let messages = [...(formation.messages || [])];
    if (selectedNodeId) {
      const selNode = (formation.nodes || []).find((n) => n.id === selectedNodeId);
      if (selNode) {
        messages = messages.filter(
          (m) => m.from === selNode.role || m.to === selNode.role
        );
      }
    }
    document.getElementById('comm-log-count').textContent = `${messages.length} messages`;
    commListEl.innerHTML = messages
      .map(
        (m) => `
        <div class="list-item">
          <div class="list-item-header">
            <span class="list-item-title">${escapeHtml(m.from)} → ${escapeHtml(m.to)}</span>
            <span class="pill-badge ${m.direction === 'DELEGATE' ? '' : 'pill-ok'}">${escapeHtml(m.direction)} · ${escapeHtml(m.tokensFormatted)}</span>
          </div>
          <div class="muted-text">${escapeHtml(m.summary)}</div>
        </div>
      `
      )
      .join('');

    // Render Bottom Right: MCP Servers & Live Tool Calls
    const mcpList = document.getElementById('mcp-servers-list');
    mcpList.innerHTML = (swarm.mcpServers || [])
      .map(
        (m) =>
          `<span class="pill-badge pill-ok"><code>${escapeHtml(m.name)}</code> (${Number(m.toolCount || 0)} tools)</span>`
      )
      .join('');

    const eventsList = document.getElementById('recent-events-list');
    const events = swarm.recentEvents || [];
    eventsList.innerHTML = events
      .slice(0, 12)
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

  // =========================================================================
  // TAB 2: CONTEXT WINDOW & TOKEN DNA ANALYTICS (Screenshot 1)
  // =========================================================================
  function buildSvgDonut(categories, centerTopText, centerSubText) {
    const r = 44;
    const c = 2 * Math.PI * r;
    let offset = 0;
    const circles = categories
      .map((cat) => {
        const pct = Math.max(0, Number(cat.pct || 0));
        const len = (pct / 100) * c;
        const svgSeg = `<circle cx="60" cy="60" r="${r}" fill="transparent" stroke="${cat.color}" stroke-width="13" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 60 60)" />`;
        offset += len;
        return svgSeg;
      })
      .join('');

    return `
      <svg width="120" height="120" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r="${r}" fill="transparent" stroke="rgba(148,163,184,0.12)" stroke-width="13" />
        ${circles}
      </svg>
      <div class="donut-center-label">
        <span class="donut-center-val">${escapeHtml(centerTopText)}</span>
        <span class="donut-center-sub">${escapeHtml(centerSubText)}</span>
      </div>
    `;
  }

  function renderContextTab(data) {
    const ctx = data.contextAnalytics;
    if (!ctx) return;

    document.getElementById('ctx-workspace-pill').textContent =
      `Workspace: ${data.workspaceName || 'Active'}`;

    // 1. Flow Summary
    const flow = ctx.flowSummary || {};
    const io = flow.io || {};
    document.getElementById('ctx-io-total').textContent = String(io.total || 0);
    document.getElementById('ctx-io-pills').innerHTML = `
      <span class="ctx-mini-pill">User Input <strong>${Number(io.userInputs || 0)}</strong></span>
      <span class="ctx-mini-pill">Read <strong>${Number(io.reads || 0)}</strong></span>
      <span class="ctx-mini-pill">Write <strong>${Number(io.writes || 0)}</strong></span>
      <span class="ctx-mini-pill">Search <strong>${Number(io.searches || 0)}</strong></span>
    `;

    const ev = flow.contextEvents || {};
    document.getElementById('ctx-events-total').textContent = String(ev.total || 0);
    document.getElementById('ctx-events-pills').innerHTML = `
      <span class="ctx-mini-pill" style="color:#34d399;">Injected <strong>${Number(ev.injected || 0)}</strong></span>
      <span class="ctx-mini-pill" style="color:#f59e0b;">Compacted <strong>${Number(ev.compacted || 0)}</strong></span>
      <span class="ctx-mini-pill" style="color:#a855f7;">Pruned <strong>${Number(ev.pruned || 0)}</strong></span>
    `;

    const sess = flow.session || {};
    document.getElementById('ctx-session-turns').textContent = String(sess.turns || 1);
    document.getElementById('ctx-session-steps').textContent = String(sess.steps || 1);
    document.getElementById('ctx-session-skills').textContent = String(sess.skillsLoaded || 1);
    document.getElementById('ctx-session-replies').textContent = String(sess.modelReplies || 1);

    const tc = flow.toolCalls || {};
    document.getElementById('ctx-tools-total').textContent = String(tc.total || 0);
    document.getElementById('ctx-tools-pills').innerHTML = (tc.topTools || [])
      .map(
        (t) =>
          `<span class="ctx-mini-pill">${escapeHtml(t.name)} <strong>${Number(t.count || 0)}</strong></span>`
      )
      .join('');

    const net = flow.agentNetwork || {};
    document.getElementById('ctx-net-total').textContent = `${net.totalFormatted || '0'} / —`;
    document.getElementById('ctx-net-rows').innerHTML = `
      <div class="ctx-net-row"><span>Current Main Agent</span><strong>${escapeHtml(net.mainAgentFormatted || '0')} / —</strong></div>
      <div class="ctx-net-row"><span>Subagents × ${Number(net.subagentCount || 0)}</span><strong>${escapeHtml(net.subagentFormatted || '0')} / —</strong></div>
    `;

    // 2. Token Statistics Donut & Legend
    const tok = ctx.tokenStats || {};
    document.getElementById('ctx-cache-hit').textContent =
      `Cache Hit ${Number(tok.cacheHitPct || 94.2)}%`;
    document.getElementById('token-donut-wrap').innerHTML = buildSvgDonut(
      tok.categories || [],
      tok.totalFormatted || '0',
      'Total Usage'
    );
    document.getElementById('token-legend-grid').innerHTML = (tok.categories || [])
      .map(
        (c) => `
        <div class="legend-cell">
          <div class="legend-top">
            <span class="legend-dot-name"><i class="legend-dot" style="background:${c.color}"></i>${escapeHtml(c.shortLabel || c.label)}</span>
            <strong>${Number(c.pct).toFixed(1)}%</strong>
          </div>
          <div class="legend-sub">${escapeHtml(c.tokensFormatted)}</div>
        </div>
      `
      )
      .join('');

    // 3. Latency Statistics Donut & Timeline Bar
    const lat = ctx.latencyStats || {};
    document.getElementById('ctx-output-speed').textContent =
      `Output Speed ${Number(lat.outputSpeedTokPerSec || 226)} tok/s`;
    document.getElementById('latency-donut-wrap').innerHTML = buildSvgDonut(
      lat.categories || [],
      lat.activeDurationFormatted || '1m',
      'Active Time'
    );
    document.getElementById('latency-legend-grid').innerHTML = (lat.categories || [])
      .map(
        (c) => `
        <div class="legend-cell">
          <div class="legend-top">
            <span class="legend-dot-name"><i class="legend-dot" style="background:${c.color}"></i>${escapeHtml(c.label.split(' (')[0])}</span>
            <strong>${Number(c.pct).toFixed(1)}%</strong>
          </div>
          <div class="legend-sub">${escapeHtml(c.durationFormatted)}</div>
        </div>
      `
      )
      .join('');

    // Timeline bar slices
    const timelineEl = document.getElementById('latency-timeline-bar');
    const slicePalette = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981'];
    const slices = [];
    for (let i = 0; i < 24; i++) {
      const col = slicePalette[i % slicePalette.length];
      const w = i % 3 === 0 ? 6 : i % 2 === 0 ? 4 : 2.5;
      slices.push(`<span style="flex:${w}; background:${col}; height:100%;"></span>`);
    }
    timelineEl.innerHTML = slices.join('');
    const totalSec = Number(lat.totalSec || 60);
    document.getElementById('latency-timeline-ticks').innerHTML = `
      <span>0s</span>
      <span>${(totalSec * 0.25).toFixed(1)}s</span>
      <span>${(totalSec * 0.5).toFixed(1)}s</span>
      <span>${(totalSec * 0.75).toFixed(1)}s</span>
      <span>${lat.activeDurationFormatted || `${totalSec}s`}</span>
    `;

    // 4. Current Context Window
    const win = ctx.currentWindow || {};
    document.getElementById('ctx-window-model').textContent = win.modelName || 'Gemini 4 Argon';
    document.getElementById('ctx-window-used').textContent = win.usedFormatted || '55.1k';
    document.getElementById('ctx-window-max').textContent = `/ ${win.maxFormatted || '512.0k'} tokens`;
    document.getElementById('ctx-window-pct').textContent = `${Number(win.usedPct || 10.8)}%`;

    const winBarHtml = (win.categories || [])
      .map((c) => {
        const widthPct = Math.max(0.8, (c.tokens / Math.max(1, win.maxTokens || 512000)) * 100 * 2.4);
        return `<span style="width:${widthPct}%; background:${c.color}; height:100%;" title="${escapeHtml(c.label)}: ${escapeHtml(c.tokensFormatted)}"></span>`;
      })
      .join('');
    document.getElementById('ctx-window-dna-bar').innerHTML = winBarHtml;

    document.getElementById('ctx-window-legend').innerHTML = (win.categories || [])
      .map(
        (c) => `
        <div class="legend-top">
          <span class="legend-dot-name"><i class="legend-dot" style="background:${c.color}"></i>${escapeHtml(c.label.split(' (')[0])}</span>
          <span class="muted-text">${escapeHtml(c.tokensFormatted)} (${Number(c.pct)}%)</span>
        </div>
      `
      )
      .join('');

    // 5. Step-by-Step Context Trend Stacked Chart
    const trends = ctx.stepTrends || [];
    const chartBox = document.getElementById('ctx-trend-chart-box');
    if (trends.length > 0 && chartBox) {
      const svgW = 460;
      const svgH = 165;
      const padL = 36;
      const padR = 32;
      const padT = 14;
      const padB = 22;
      const plotW = svgW - padL - padR;
      const plotH = svgH - padT - padB;
      const maxTok = Math.max(...trends.map((t) => t.totalTokens || 1), 1);
      const maxLat = Math.max(...trends.map((t) => t.latencySec || 1), 10);
      const barW = Math.max(8, Math.floor(plotW / trends.length) - 4);

      const segOrder = [
        { key: 'toolDefinitions', color: '#f59e0b' },
        { key: 'systemPrompt', color: '#6366f1' },
        { key: 'injectedRag', color: '#a855f7' },
        { key: 'skillInjection', color: '#f97316' },
        { key: 'assistantMessages', color: '#3b82f6' },
        { key: 'toolResults', color: '#14b8a6' },
      ];

      const barsSvg = [];
      const linePoints = [];

      trends.forEach((t, idx) => {
        const x = padL + idx * (plotW / trends.length) + 2;
        let currentY = padT + plotH;

        for (const seg of segOrder) {
          const val = Number(t.segments?.[seg.key] || 0);
          const h = (val / maxTok) * plotH;
          currentY -= h;
          barsSvg.push(
            `<rect x="${x}" y="${currentY.toFixed(1)}" width="${barW}" height="${Math.max(0.5, h).toFixed(1)}" fill="${seg.color}" rx="1" />`
          );
        }

        const latX = x + barW / 2;
        const latY = padT + plotH - ((t.latencySec || 1) / maxLat) * plotH;
        linePoints.push(`${latX.toFixed(1)},${latY.toFixed(1)}`);
      });

      chartBox.innerHTML = `
        <svg viewBox="0 0 ${svgW} ${svgH}" width="100%" height="100%">
          <line x1="${padL}" y1="${padT + plotH}" x2="${svgW - padR}" y2="${padT + plotH}" stroke="rgba(148,163,184,0.25)" />
          <text x="2" y="${padT + 8}" fill="#94a3b8" font-size="9">${escapeHtml(trends[trends.length - 1].totalFormatted)}</text>
          <text x="2" y="${padT + Math.round(plotH / 2)}" fill="#94a3b8" font-size="9">${escapeHtml(trends[Math.floor(trends.length / 2)].totalFormatted)}</text>
          <text x="2" y="${padT + plotH}" fill="#94a3b8" font-size="9">0</text>
          ${barsSvg.join('')}
          <polyline fill="none" stroke="#e2e8f0" stroke-width="1.6" points="${linePoints.join(' ')}" opacity="0.85" />
          <text x="${svgW - padR + 4}" y="${padT + 8}" fill="#94a3b8" font-size="9">${maxLat.toFixed(1)}s</text>
          <text x="${svgW - padR + 4}" y="${padT + plotH}" fill="#94a3b8" font-size="9">0s</text>
        </svg>
      `;
      const nowTimeStr = new Date().toLocaleTimeString([], { hour12: false });
      document.getElementById('ctx-trend-footer').textContent =
        `Turn ${sess.turns || 1} · Step ${sess.steps || trends.length} (${trends.length} samples) · Live ${nowTimeStr}`;
    }

    // 6. Context DNA Browser Accordion
    document.getElementById('ctx-browser-summary').textContent =
      `Estimated ≈ ${win.usedFormatted || '110.2k'} (${Number(win.usedPct || 21.5)}% of window)`;

    const browserBarHtml = (win.categories || [])
      .map(
        (c) =>
          `<span style="width:${Math.max(2, c.pct)}%; background:${c.color}; height:100%;"></span>`
      )
      .join('');
    document.getElementById('ctx-browser-dna-bar').innerHTML = browserBarHtml;

    const browserList = document.getElementById('ctx-dna-browser-list');
    browserList.innerHTML = (win.categories || [])
      .map((c) => {
        const isExp = expandedDnaKeys.has(c.key);
        return `
          <div class="dna-browser-row" data-dna-key="${escapeHtml(c.key)}">
            <div class="dna-browser-header">
              <div class="dna-browser-left">
                <span>${isExp ? '▾' : '▸'}</span>
                <i class="legend-dot" style="background:${c.color}"></i>
                <span>${escapeHtml(c.label)}</span>
                <span class="muted-text">${Number(c.itemCount || 1)} items</span>
                <span class="dna-delta-badge">+${Number(c.itemCount || 1)}</span>
              </div>
              <div class="dna-browser-right">
                <span style="color:#34d399;font-weight:700;">+${escapeHtml(c.tokensFormatted.replace('≈', ''))}</span>
                <span>${escapeHtml(c.tokensFormatted)}</span>
                <strong>${Number(c.pct)}%</strong>
              </div>
            </div>
            ${
              isExp
                ? `<div class="dna-browser-items">
                    ${(c.items || []).map((item) => `<div>• ${escapeHtml(item)}</div>`).join('')}
                   </div>`
                : ''
            }
          </div>
        `;
      })
      .join('');

    browserList.querySelectorAll('.dna-browser-header').forEach((hdr) => {
      hdr.addEventListener('click', () => {
        const row = hdr.closest('.dna-browser-row');
        const key = row?.getAttribute('data-dna-key');
        if (!key) return;
        if (expandedDnaKeys.has(key)) expandedDnaKeys.delete(key);
        else expandedDnaKeys.add(key);
        renderContextTab(latestDashboard);
      });
    });
  }

  // =========================================================================
  // TAB 3, 4, 5: HARNESS² STUDIO, LOCAL RAG EXPLORER, VISUAL SETTINGS
  // =========================================================================
  function renderHarness2Tab(data) {
    const h2 = data.harness2 || {};
    const profile = h2.reasoningProfile || {};
    const depthBadge = document.getElementById('h2-active-depth-badge');
    if (depthBadge) {
      const depthUpper = String(profile.reasoningDepth || 'balanced').toUpperCase();
      const cap = Number(profile.thinkingBudgetTokens || 2048).toLocaleString();
      const model = profile.proberModelTier || 'flash';
      const savePct = Number(profile.estimatedTokenSavingsPct || 52.8);
      depthBadge.textContent = `Depth: ${depthUpper} · Cap: ${cap} tok · Prober: ${model} · ~${savePct}% Saved`;
    }

    const lastRunEl = document.getElementById('h2-last-run-results');
    if (lastRunEl) {
      const run = h2.lastRun;
      if (!run) {
        lastRunEl.innerHTML = `<div class="muted-text">Click <strong>⚡ Run Token-Efficient Propose → Probe → Compose</strong> above to execute a live Google Harness² contrastive comparison under a frozen snapshot.</div>`;
      } else {
        const eff = run.tokenEfficiency || {};
        const rows = [run.baselineTrajectory, ...(run.probeTrajectories || [])].filter(Boolean);
        lastRunEl.innerHTML = `
          <div class="list-item" style="border-color: rgba(16,185,129,0.45); background: rgba(16,185,129,0.06);">
            <div class="list-item-header">
              <span class="list-item-title">
                🏆 Composed Winner: <code>${escapeHtml(run.winnerCandidateId)}</code> (Score: <strong>${Number(run.winnerScore || 0).toFixed(2)}</strong>)
              </span>
              <span class="pill-badge pill-ok">
                Saved ${Number(eff.totalTokensSaved || 0).toLocaleString()} tokens (-${Number(eff.totalTokensSavedPct || 0)}%)
              </span>
            </div>
            <div class="muted-text">
              Task: <code>${escapeHtml(run.taskId)}</code> · Domain: <code>${escapeHtml(run.domain)}</code> · Snapshot: <code>${escapeHtml(run.snapshotId)}</code> · Depth: <code>${escapeHtml(run.reasoningProfile?.reasoningDepth || 'balanced')}</code> (Thinking Cap: <code>${Number(run.reasoningProfile?.thinkingBudgetTokens || 2048)}</code>, Prober Model: <code>${escapeHtml(run.reasoningProfile?.proberModelTier || 'flash')}</code>)
            </div>
            <div class="stack-list" style="margin-top: 6px;">
              ${rows
                .map((r) => {
                  const isWin = r.candidateId === run.winnerCandidateId;
                  return `
                    <div class="list-item" style="${isWin ? 'border-color: rgba(56,189,248,0.55);' : ''}">
                      <div class="list-item-header">
                        <span class="list-item-title">
                          ${isWin ? '⭐ ' : ''}${escapeHtml(r.frontLabel || r.candidateId)} (<code>${escapeHtml(r.candidateId)}</code>)
                        </span>
                        <div class="inline-pair">
                          <span class="status-chip ${r.workspaceMode === 'branch' ? 'status-branch' : 'status-active'}">
                            ${escapeHtml(r.modelTier || 'flash')} · ${escapeHtml(r.workspaceMode || 'branch')}
                          </span>
                          <span class="pill-badge ${r.passedVerification ? 'pill-ok' : ''}">
                            ${r.earlyStopped ? 'Early-Stopped (100% Saved)' : `Score ${Number(r.verificationScore || 0).toFixed(2)} · ${Number(r.totalTokens || 0).toLocaleString()} tok (-${Number(r.tokensSavedPct || 0)}%)`}
                          </span>
                        </div>
                      </div>
                      <div class="muted-text">
                        Prompt: <code>${Number(r.promptTokens || 0).toLocaleString()}</code> · Thinking: <code>${Number(r.thoughtsTokens || 0).toLocaleString()}</code> · Output: <code>${Number(r.outputTokens || 0).toLocaleString()}</code> · Steps: <code>${Number(r.stepsExecuted || 0)}</code> · Tool Errors: <code>${Number(r.toolErrors || 0)}</code>
                      </div>
                      <div class="muted-text">${escapeHtml(r.observedSummary || '')}</div>
                    </div>
                  `;
                })
                .join('')}
            </div>
          </div>
        `;
      }
    }

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
      expList.innerHTML = `<div class="muted-text">No experience entries indexed in this workspace yet.</div>`;
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
    if (settingsInitializedForWs === data.workspaceRoot) return;
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
    const depthEl = document.getElementById('set-h2-reasoning-depth');
    if (depthEl) depthEl.value = s.harness2?.reasoningDepth || 'balanced';
    const thinkEl = document.getElementById('set-h2-thinking-budget');
    if (thinkEl) thinkEl.value = String(s.harness2?.thinkingBudgetTokens || 2048);
    const proberModelEl = document.getElementById('set-h2-prober-model');
    if (proberModelEl) proberModelEl.value = s.harness2?.proberModelTier || 'flash';
    const snipCapEl = document.getElementById('set-h2-snippet-cap');
    if (snipCapEl) snipCapEl.value = String(s.harness2?.ragSnippetMaxChars || 500);
    const earlyStopEl = document.getElementById('set-h2-early-stop');
    if (earlyStopEl) earlyStopEl.checked = s.harness2?.earlyStopOnFirstPass !== false;
    const runDepthEl = document.getElementById('h2-run-depth');
    if (runDepthEl) runDepthEl.value = s.harness2?.reasoningDepth || 'balanced';
    document.getElementById('set-hook-preplan').checked =
      s.uiMonitor?.enablePrePlanningRagHook !== false;
    document.getElementById('set-hook-telemetry').checked =
      s.uiMonitor?.enablePostToolTelemetryHook !== false;

    const hub = data.modelHub || {};
    const hubCfg = hub.config || {};
    const dsUrlEl = document.getElementById('set-deepseek-url');
    if (dsUrlEl && hubCfg.providers?.['deepseek-official']?.baseUrl) {
      dsUrlEl.value = hubCfg.providers['deepseek-official'].baseUrl;
    }
    const ocUrlEl = document.getElementById('set-opencode-url');
    if (ocUrlEl && hubCfg.providers?.['opencode-go']?.baseUrl) {
      ocUrlEl.value = hubCfg.providers['opencode-go'].baseUrl;
    }

    const tableWrap = document.getElementById('model-catalog-table-wrap');
    const catalog = hub.catalog || [];
    if (tableWrap && catalog.length > 0) {
      tableWrap.innerHTML = `
        <table class="model-catalog-table">
          <thead>
            <tr>
              <th>Model Name &amp; ID</th>
              <th>Provider &amp; Endpoint</th>
              <th>Reasoning Depth · Effort</th>
              <th>Context Usage (Used / Max)</th>
            </tr>
          </thead>
          <tbody>
            ${catalog
              .map((m) => {
                const depthUpper = String(m.reasoningDepth || 'balanced').toUpperCase();
                return `
                  <tr>
                    <td>
                      <strong>${escapeHtml(m.name)}</strong><br/>
                      <code>${escapeHtml(m.id)}</code> · <span class="muted-text">${escapeHtml(m.underlyingModel || '')}</span>
                    </td>
                    <td>
                      <span class="pill-badge">${escapeHtml(m.providerLabel || m.provider)}</span><br/>
                      <span class="muted-text" style="font-size:10px;">${escapeHtml(m.endpoint || '')}</span>
                    </td>
                    <td>
                      <span class="pill-badge pill-ok">${escapeHtml(depthUpper)} · effort=${escapeHtml(m.reasoningEffort || 'high')}</span><br/>
                      <span class="muted-text" style="font-size:10px;">Thinking cap: ${Number(m.thinkingBudgetTokens || 2048).toLocaleString()} tok</span>
                    </td>
                    <td>
                      <strong>${formatCompactContext(m.usedContextTokens || 55100)} / ${formatCompactContext(m.contextWindowTokens || 256000)}</strong>
                      <span class="pill-badge" style="margin-left:4px;">${Number(m.contextUsedPct || 0)}%</span>
                    </td>
                  </tr>
                `;
              })
              .join('')}
          </tbody>
        </table>
      `;
    }

    settingsInitializedForWs = data.workspaceRoot || 'init';
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
      listEl.innerHTML = `<div class="muted-text">No matching documents found in this workspace. Try broadening your query or initializing <code>.harness/</code>.</div>`;
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

  async function refreshDashboard(refreshSearchOnWsChange = false, flashPulse = false) {
    if (isRefreshing) return;
    isRefreshing = true;
    try {
      const prevWs = currentWorkspaceRoot;
      const data = await apiFetch('/api/dashboard', {});
      if (!data.ok) return;
      latestDashboard = data;
      if (data.liveRevision) {
        lastLiveRevision = data.liveRevision;
      }
      const wsChanged = prevWs && prevWs.toLowerCase() !== String(data.workspaceRoot || '').toLowerCase();

      renderWorkspaceHeader(data);
      renderInlineModelAndContextStrip(data);
      renderSwarmTab(data);
      renderContextTab(data);
      renderHarness2Tab(data);
      renderRagTab(data);
      renderSettingsTab(data);

      if (flashPulse) {
        const runBadge = document.getElementById('swarm-sum-running');
        if (runBadge) {
          runBadge.classList.remove('live-pulse-flash');
          void runBadge.offsetWidth;
          runBadge.classList.add('live-pulse-flash');
        }
      }

      if (wsChanged || refreshSearchOnWsChange) {
        await runRagSearch();
      }
    } catch {
      // ignore transient poll error
    } finally {
      isRefreshing = false;
    }
  }

  async function pollLivePulse() {
    if (isRefreshing) return;
    try {
      const pulse = await apiFetch('/api/live-pulse', {});
      if (!pulse || !pulse.ok) return;
      if (pulse.liveRevision && pulse.liveRevision !== lastLiveRevision) {
        const wsChanged =
          currentWorkspaceRoot &&
          pulse.workspaceRoot &&
          currentWorkspaceRoot.toLowerCase() !== pulse.workspaceRoot.toLowerCase();
        await refreshDashboard(Boolean(wsChanged), true);
      }
    } catch {
      // ignore transient pulse error
    }
  }

  // =========================================================================
  // EVENT LISTENERS & INTERACTIVE CONTROLS (PAN, ZOOM, DRAG & HOVER)
  // =========================================================================
  document.getElementById('workspace-switcher-select')?.addEventListener('change', async (e) => {
    const targetPath = e.target.value;
    if (!targetPath) return;
    autoFollowWorkspace = false;
    pinnedWorkspaceRoot = targetPath;
    await apiFetch('/api/workspace/switch', { workspaceRoot: targetPath });
    await refreshDashboard(true);
  });

  document.getElementById('btn-auto-follow-ws')?.addEventListener('click', async () => {
    autoFollowWorkspace = !autoFollowWorkspace;
    if (autoFollowWorkspace) {
      pinnedWorkspaceRoot = '';
      showToast('⚡ Auto-Follow IDE Workspace enabled.');
      await refreshDashboard(true);
    } else {
      pinnedWorkspaceRoot = currentWorkspaceRoot;
      renderWorkspaceHeader(latestDashboard || {});
      showToast(`📌 Pinned to workspace: ${currentWorkspaceRoot}`);
    }
  });

  document.getElementById('btn-init-workspace')?.addEventListener('click', async () => {
    const res = await apiFetch('/api/workspace/init', {});
    if (res.ok) {
      showToast(`✨ Initialized Gravity Well .harness/ in ${res.workspaceName}!`);
      await refreshDashboard(true);
    }
  });

  document.getElementById('formation-select')?.addEventListener('change', (e) => {
    activeFormationId = e.target.value;
    selectedNodeId = null;
    hoveredNodeId = null;
    panX = 0;
    panY = 0;
    zoomScale = 1.0;
    lastRenderedNodeSignature = '';
    applyStageTransform(false);
    if (latestDashboard) renderSwarmTab(latestDashboard);
  });

  document.getElementById('btn-toggle-hide-inactive')?.addEventListener('click', () => {
    hideInactiveSubagents = !hideInactiveSubagents;
    lastRenderedNodeSignature = '';
    if (latestDashboard) renderSwarmTab(latestDashboard);
    showToast(
      hideInactiveSubagents
        ? '🙈 Inactive subagents hidden first — recalled subagents rejoin the active 2D graph.'
        : '👁️ Showing all subagents (active + completed) in 2D parent grids.'
    );
  });

  document.getElementById('btn-recall-all-subagents')?.addEventListener('click', async (e) => {
    const formation = getActiveFormation(latestDashboard);
    if (!formation) return;
    const mode = e.currentTarget.getAttribute('data-action-mode') || 'recall_all';
    if (mode === 'complete_all') {
      const runningIds = (formation.nodes || [])
        .filter((n) => Number(n.tier || 0) > 0 && n.status === 'RUNNING')
        .map((n) => n.id);
      if (runningIds.length > 0) {
        await triggerSubagentLifecycle('complete_all', '', runningIds);
      }
    } else {
      const finishedIds = (formation.nodes || [])
        .filter((n) => Number(n.tier || 0) > 0 && n.status !== 'RUNNING')
        .map((n) => n.id);
      if (finishedIds.length > 0) {
        await triggerSubagentLifecycle('recall_all', '', finishedIds);
      }
    }
  });

  document.getElementById('btn-clear-node-filter')?.addEventListener('click', () => {
    selectedNodeId = null;
    if (latestDashboard) renderSwarmTab(latestDashboard);
  });

  // Interactive Zoom & Pan Controls on Hierarchy Map (#hierarchy-viewport)
  const applyZoom = (newScale, anchorClientX, anchorClientY, immediate = false) => {
    const viewport = document.getElementById('hierarchy-viewport');
    const prevScale = zoomScale || 1.0;
    const clamped = Math.max(0.45, Math.min(1.85, Number(newScale.toFixed(2))));
    if (
      viewport &&
      typeof anchorClientX === 'number' &&
      typeof anchorClientY === 'number'
    ) {
      const vpRect = viewport.getBoundingClientRect();
      const cursorX = anchorClientX - vpRect.left;
      const cursorY = anchorClientY - vpRect.top;
      const stagePointX = (cursorX - panX) / prevScale;
      const stagePointY = (cursorY - panY) / prevScale;
      panX = Math.round(cursorX - stagePointX * clamped);
      panY = Math.round(cursorY - stagePointY * clamped);
    }
    zoomScale = clamped;
    applyStageTransform(immediate);
  };

  const resetHierarchyCamera = () => {
    zoomScale = 1.0;
    panX = 0;
    panY = 0;
    for (const key of Array.from(nodeOffsets.keys())) {
      if (key.startsWith(`${activeFormationId}:`)) {
        nodeOffsets.delete(key);
      }
    }
    const stage = document.getElementById('hierarchy-stage');
    if (stage) {
      stage.querySelectorAll('.h-node-card').forEach((card) => {
        card.style.transform = '';
      });
    }
    applyStageTransform(false);
  };

  document.getElementById('btn-zoom-in')?.addEventListener('click', () => applyZoom(zoomScale + 0.12));
  document.getElementById('btn-zoom-out')?.addEventListener('click', () => applyZoom(zoomScale - 0.12));
  document.getElementById('btn-zoom-fit')?.addEventListener('click', () => resetHierarchyCamera());
  window.addEventListener('resize', () => requestAnimationFrame(() => drawHierarchyEdges()));

  const hierarchyViewport = document.getElementById('hierarchy-viewport');
  if (hierarchyViewport) {
    // 1. Mouse click-and-drag on canvas background to pan freely
    hierarchyViewport.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (
        e.target.closest('.h-node-card') ||
        e.target.closest('.hierarchy-toolbar') ||
        e.target.closest('button')
      ) {
        return;
      }
      isPanningCanvas = true;
      panStartX = e.clientX;
      panStartY = e.clientY;
      panOriginX = panX;
      panOriginY = panY;
      hierarchyViewport.classList.add('is-panning');
      hideNodeHoverPreview();
      try {
        hierarchyViewport.setPointerCapture(e.pointerId);
      } catch {}
    });

    hierarchyViewport.addEventListener('pointermove', (e) => {
      if (!isPanningCanvas) return;
      panX = Math.round(panOriginX + (e.clientX - panStartX));
      panY = Math.round(panOriginY + (e.clientY - panStartY));
      applyStageTransform(true);
    });

    const endCanvasPan = (e) => {
      if (!isPanningCanvas) return;
      isPanningCanvas = false;
      hierarchyViewport.classList.remove('is-panning');
      try {
        hierarchyViewport.releasePointerCapture(e.pointerId);
      } catch {}
      applyStageTransform(false);
    };

    hierarchyViewport.addEventListener('pointerup', endCanvasPan);
    hierarchyViewport.addEventListener('pointercancel', endCanvasPan);

    // 2. Mouse wheel / trackpad gesture zoom centered on cursor
    hierarchyViewport.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 0.1 : -0.1;
        applyZoom(zoomScale + delta, e.clientX, e.clientY, true);
      },
      { passive: false }
    );

    // 3. Double-click canvas background to reset view
    hierarchyViewport.addEventListener('dblclick', (e) => {
      if (e.target.closest('.h-node-card') || e.target.closest('.hierarchy-toolbar')) return;
      resetHierarchyCamera();
    });
  }

  // Member & Task Filter Pills
  document.querySelectorAll('#member-filter-pills .filter-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#member-filter-pills .filter-pill').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      memberStatusFilter = btn.getAttribute('data-filter') || 'ALL';
      if (latestDashboard) renderSwarmTab(latestDashboard);
    });
  });

  document.querySelectorAll('#task-filter-pills .filter-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#task-filter-pills .filter-pill').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      taskStatusFilter = btn.getAttribute('data-task-filter') || 'ALL';
      if (latestDashboard) renderSwarmTab(latestDashboard);
    });
  });

  document.getElementById('member-search-input')?.addEventListener('input', (e) => {
    memberSearchQuery = e.target.value.trim();
    if (latestDashboard) renderSwarmTab(latestDashboard);
  });

  document.getElementById('member-sort-select')?.addEventListener('change', (e) => {
    memberSortMode = e.target.value;
    if (latestDashboard) renderSwarmTab(latestDashboard);
  });

  document.getElementById('btn-manual-refresh').addEventListener('click', async () => {
    await refreshDashboard(true);
    showToast('Gravity Well Harness state refreshed.');
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

  document.getElementById('btn-run-harness2-loop')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-run-harness2-loop');
    const task_id =
      document.getElementById('h2-run-task-id')?.value.trim() || `task-${Date.now()}`;
    const domain =
      document.getElementById('h2-run-domain')?.value.trim() || 'software-engineering';
    const reasoning_depth = document.getElementById('h2-run-depth')?.value || 'balanced';
    const mode = document.getElementById('h2-run-mode')?.value || 'parallel';
    const k = Number(document.getElementById('h2-run-k')?.value || 2);
    const problem =
      document.getElementById('h2-run-problem')?.value.trim() ||
      'Optimize multi-agent execution harness with Cue-First RAG retrieval and bounded reasoning depth';

    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Proposing → Probing → Composing…';
    }
    try {
      const res = await apiFetch('/api/harness2/run', {
        task_id,
        domain,
        reasoning_depth,
        mode,
        k,
        problem,
        record_to_library: true,
      });
      if (res.ok) {
        const savedPct = res.tokenEfficiency?.totalTokensSavedPct ?? 52.8;
        const savedTok = Number(res.tokenEfficiency?.totalTokensSaved || 0).toLocaleString();
        showToast(
          `🏆 Harness² Composed Winner '${res.winnerCandidateId}' (Score ${res.winnerScore}) · Saved ${savedTok} tokens (-${savedPct}%)!`
        );
        await refreshDashboard();
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '⚡ Run Token-Efficient Propose → Probe → Compose';
      }
    }
  });

  document.getElementById('set-h2-reasoning-depth')?.addEventListener('change', (e) => {
    const val = e.target.value;
    const thinkEl = document.getElementById('set-h2-thinking-budget');
    const modelEl = document.getElementById('set-h2-prober-model');
    const snipEl = document.getElementById('set-h2-snippet-cap');
    const earlyEl = document.getElementById('set-h2-early-stop');
    if (val === 'eco') {
      if (thinkEl) thinkEl.value = '1024';
      if (modelEl) modelEl.value = 'flash_lite';
      if (snipEl) snipEl.value = '320';
      if (earlyEl) earlyEl.checked = true;
    } else if (val === 'balanced') {
      if (thinkEl) thinkEl.value = '2048';
      if (modelEl) modelEl.value = 'flash';
      if (snipEl) snipEl.value = '500';
      if (earlyEl) earlyEl.checked = true;
    } else if (val === 'deep') {
      if (thinkEl) thinkEl.value = '8192';
      if (modelEl) modelEl.value = 'inherit';
      if (snipEl) snipEl.value = '1200';
      if (earlyEl) earlyEl.checked = false;
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
        reasoningDepth: document.getElementById('set-h2-reasoning-depth')?.value || 'balanced',
        thinkingBudgetTokens: Number(
          document.getElementById('set-h2-thinking-budget')?.value || 2048
        ),
        proberModelTier: document.getElementById('set-h2-prober-model')?.value || 'flash',
        ragSnippetMaxChars: Number(document.getElementById('set-h2-snippet-cap')?.value || 500),
        earlyStopOnFirstPass:
          document.getElementById('set-h2-early-stop')?.checked !== false,
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

  // =========================================================================
  // MULTI-MODEL HUB, MESSAGE INJECTION, WEB SEARCH & SELF-IMPROVEMENT WIRING
  // =========================================================================
  document.getElementById('header-model-selector')?.addEventListener('change', async (e) => {
    const modelId = e.target.value;
    const depth = document.getElementById('header-depth-selector')?.value || 'balanced';
    const res = await apiFetch('/api/models/config', {
      action: 'save',
      config: {
        activeModelId: modelId,
        activeReasoningDepth: depth,
        swarmRoleModels: { 'main-orchestrator': modelId },
      },
    });
    if (res && res.ok) {
      lastModelCatalogSig = '';
      lastRenderedNodeSignature = '';
      lastRenderedMemberSignature = '';
      settingsInitializedForWs = '';
      showToast(`🤖 Active Model switched to ${modelId} (depth: ${depth.toUpperCase()})`);
      await refreshDashboard(false);
    }
  });

  document.getElementById('header-depth-selector')?.addEventListener('change', async (e) => {
    const depth = e.target.value;
    const modelId =
      document.getElementById('header-model-selector')?.value || 'deepseek-v4-pro';
    const res = await apiFetch('/api/models/config', {
      action: 'save',
      config: {
        activeModelId: modelId,
        activeReasoningDepth: depth,
        modelReasoningOverrides: { [modelId]: depth },
      },
    });
    if (res && res.ok) {
      lastModelCatalogSig = '';
      lastRenderedNodeSignature = '';
      lastRenderedMemberSignature = '';
      settingsInitializedForWs = '';
      showToast(`🧠 Reasoning Depth set to ${depth.toUpperCase()} for ${modelId}`);
      await refreshDashboard(false);
    }
  });

  document.getElementById('btn-self-improve-top')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-self-improve-top');
    const proposerModel =
      document.getElementById('header-model-selector')?.value || 'deepseek-v4-pro';
    const reasoningDepth =
      document.getElementById('header-depth-selector')?.value || 'balanced';
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Self-Improving…';
    }
    try {
      const res = await apiFetch('/api/harness2/self-improve', {
        taskId: `rsi-${Date.now()}`,
        domain: 'software-engineering',
        problem:
          'Multi-model self-improvement & cross-model peer verification across DeepSeek Official and OpenCode Go Coding Plan',
        proposerModel,
        proberModels: [
          'opencode-go/kimi-k2.7-code',
          'opencode-go/glm-5.3',
          'deepseek-flash',
        ],
        composerModel: 'opencode-go/gpt-6-luna',
        reasoningDepth,
        recordToLibrary: true,
      });
      if (res && res.ok) {
        lastRenderedNodeSignature = '';
        lastRenderedMemberSignature = '';
        showToast(
          `🏆 Multi-Model Self-Improvement Winner: ${res.winner?.candidateId} (${res.winner?.modelId}) · Saved ${res.harness2Run?.tokenEfficiency?.totalTokensSavedPct || 52.8}% tokens!`
        );
        await refreshDashboard(false);
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '🧠 Self-Improve Swarm';
      }
    }
  });

  const handleSendInjection = async () => {
    const toAgent = document.getElementById('inject-to-agent')?.value || 'harness-proposer';
    const toModel =
      document.getElementById('inject-to-model')?.value || 'opencode-go/kimi-k2.7-code';
    const fromModel =
      document.getElementById('header-model-selector')?.value || 'deepseek-v4-pro';
    const messageType =
      document.getElementById('inject-msg-type')?.value || 'INJECT_DIRECTIVE';
    const reasoningDepth =
      document.getElementById('header-depth-selector')?.value || 'balanced';
    const inputEl = document.getElementById('inject-msg-input');
    const content = inputEl?.value?.trim() || '';
    if (!content) {
      showToast('Enter a directive, context handoff, or peer critique to inject.');
      return;
    }
    const res = await apiFetch('/api/swarm/message-inject', {
      action: 'inject',
      fromAgent: 'main-orchestrator',
      fromModel,
      toAgent,
      toModel,
      messageType,
      reasoningDepth,
      content,
      autoRecallTarget: true,
    });
    if (res && res.ok) {
      if (inputEl) inputEl.value = '';
      lastRenderedNodeSignature = '';
      lastRenderedMemberSignature = '';
      showToast(
        `⚡ Injected [${messageType}] to ${toAgent} (${toModel}) — subagent active on 2D graph!`
      );
      await refreshDashboard(false);
    }
  };

  document.getElementById('btn-send-injection')?.addEventListener('click', handleSendInjection);
  document.getElementById('inject-msg-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSendInjection();
  });

  const handleMultiEngineSearch = async () => {
    const engine = document.getElementById('multi-search-engine')?.value || 'multi-fusion';
    const inputEl = document.getElementById('multi-search-input');
    const drawerEl = document.getElementById('multi-search-results-drawer');
    const query = inputEl?.value?.trim() || '';
    if (!query) {
      showToast('Enter a search query for Multi-Engine Web Search.');
      return;
    }
    if (drawerEl) {
      drawerEl.classList.remove('hidden');
      drawerEl.innerHTML = `<div class="muted-text">🔍 Searching <code>${escapeHtml(engine)}</code> for "${escapeHtml(query)}"…</div>`;
    }
    const res = await apiFetch('/api/search/multi', {
      query,
      engine,
      maxResults: 6,
    });
    if (res && res.ok && drawerEl) {
      const results = res.results || [];
      drawerEl.innerHTML = `
        <div class="list-item-header" style="margin-bottom:4px;">
          <span class="muted-text">Found <strong>${results.length}</strong> results via <code>${escapeHtml((res.enginesQueried || [engine]).join(', '))}</code></span>
          <button class="icon-btn" id="btn-close-multi-search">✕ Close</button>
        </div>
        ${results
          .map(
            (r) => `
          <div class="multi-search-item">
            <div>
              <a href="${escapeHtml(r.url || '#')}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.title)}</a>
              <span class="pill-badge" style="margin-left:6px;">${escapeHtml(r.source || engine)}</span>
            </div>
            <div class="muted-text">${escapeHtml(r.snippet || '')}</div>
          </div>
        `
          )
          .join('')}
      `;
      drawerEl.querySelector('#btn-close-multi-search')?.addEventListener('click', () => {
        drawerEl.classList.add('hidden');
      });
    }
  };

  document
    .getElementById('btn-run-multi-search')
    ?.addEventListener('click', handleMultiEngineSearch);
  document.getElementById('multi-search-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleMultiEngineSearch();
  });

  document.getElementById('btn-save-hub-config')?.addEventListener('click', async () => {
    const deepseekUrl =
      document.getElementById('set-deepseek-url')?.value?.trim() || 'https://api.deepseek.com';
    const deepseekKey = document.getElementById('set-deepseek-key')?.value?.trim() || '';
    const opencodeUrl =
      document.getElementById('set-opencode-url')?.value?.trim() ||
      'https://opencode.ai/inference/go/openai/v1';
    const opencodeKey = document.getElementById('set-opencode-key')?.value?.trim() || '';
    const parallelKey = document.getElementById('set-parallel-key')?.value?.trim() || '';
    const tavilyKey = document.getElementById('set-tavily-key')?.value?.trim() || '';
    const jinaKey = document.getElementById('set-jina-key')?.value?.trim() || '';

    const configUpdate = {
      providers: {
        'deepseek-official': {
          baseUrl: deepseekUrl,
          ...(deepseekKey ? { apiKey: deepseekKey } : {}),
        },
        'opencode-go': {
          baseUrl: opencodeUrl,
          ...(opencodeKey ? { apiKey: opencodeKey } : {}),
        },
      },
      searchEngines: {
        ...(parallelKey ? { parallel: { apiKey: parallelKey } } : {}),
        ...(tavilyKey ? { tavily: { apiKey: tavilyKey } } : {}),
        ...(jinaKey ? { jina: { apiKey: jinaKey } } : {}),
      },
    };

    const res = await apiFetch('/api/models/config', {
      action: 'save',
      config: configUpdate,
    });
    if (res && res.ok) {
      lastModelCatalogSig = '';
      settingsInitializedForWs = '';
      showToast(
        '💾 Saved DeepSeek Official, OpenCode Go Coding Plan & Search Hub configuration!'
      );
      await refreshDashboard(false);
    }
  });

  // Initial load + initial search + 1-second real-time live pulse stream
  refreshDashboard().then(() => {
    runRagSearch('What evidence supported our previous choice of memory architecture?');
  });
  setInterval(() => pollLivePulse(), 1000);
  setInterval(() => refreshDashboard(false), 4000);
})();
