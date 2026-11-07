#!/usr/bin/env node
/**
 * Reproducible One-Command Installer for Harness² + Local RAG Antigravity IDE (`harness-ide`).
 *
 * Installs:
 * 1. Global Antigravity Plugin: `~/.gemini/config/plugins/harness-ide`
 * 2. Global Auxiliary Pane UI Sidecar: `~/.gemini/config/sidecars/harness-ide-monitor`
 * 3. Local `.harness/` Knowledge Collections & Hybrid RAG Index
 * 4. Enables both plugin and sidecar via Antigravity Language Server RPC & config.json
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_JSON_PATH,
  GLOBAL_CONFIG_DIR,
  GLOBAL_SIDECARS_DIR,
  readJsonSafe,
  updateAgySidecarConfig,
  writeJsonNoBom,
} from 'antigravity-sidecar-kit/config';
import {
  callLsRpc,
  findListeningPids,
  getSidecars,
  isNodeProcess,
  killPidAndWait,
  killSidecarProcessByPortOrPid,
  manageSidecar,
} from 'antigravity-sidecar-kit/rpc';
import { HarnessKnowledgeEngine } from './src/rag-engine.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.dirname(__filename);

const PLUGIN_ID = 'harness-ide';
const SIDECAR_ID = 'harness-ide-monitor';

const SOURCE_PLUGIN_DIR = path.join(REPO_ROOT, 'plugin', PLUGIN_ID);
const TARGET_PLUGIN_DIR = path.join(GLOBAL_CONFIG_DIR, 'plugins', PLUGIN_ID);

const SOURCE_SIDECAR_DIR = path.join(REPO_ROOT, 'sidecars', SIDECAR_ID);
const TARGET_SIDECAR_DIR = path.join(GLOBAL_SIDECARS_DIR, SIDECAR_ID);

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function enablePluginLive(pluginDirName, enabled = true) {
  // 1. Try Language Server RPC (JetboxWriteState) per plugin skill guidelines
  try {
    await callLsRpc('JetboxWriteState', {
      userConfig: {
        plugins: {
          [pluginDirName]: { enabled },
        },
      },
    });
    return { method: 'LanguageServerRPC (JetboxWriteState)', ok: true };
  } catch {
    // 2. Fallback to atomic BOM-safe config.json update
    try {
      const cfg = readJsonSafe(CONFIG_JSON_PATH, {});
      cfg.plugins = cfg.plugins || {};
      cfg.plugins[pluginDirName] = { ...(cfg.plugins[pluginDirName] || {}), enabled };
      writeJsonNoBom(CONFIG_JSON_PATH, cfg);
      return { method: 'config.json (atomic)', ok: true };
    } catch (err) {
      return { method: 'none', ok: false, error: err?.message };
    }
  }
}

async function uninstallAll() {
  console.log('[harness-ide] Uninstalling plugin and UI sidecar...');
  await enablePluginLive(PLUGIN_ID, false);
  updateAgySidecarConfig(SIDECAR_ID, false);

  try {
    await manageSidecar(SIDECAR_ID, 'SIDECAR_ACTION_DISABLE');
  } catch {}

  if (fs.existsSync(TARGET_PLUGIN_DIR)) {
    fs.rmSync(TARGET_PLUGIN_DIR, { recursive: true, force: true });
    console.log(`  - Removed plugin directory: ${TARGET_PLUGIN_DIR}`);
  }
  if (fs.existsSync(TARGET_SIDECAR_DIR)) {
    fs.rmSync(TARGET_SIDECAR_DIR, { recursive: true, force: true });
    console.log(`  - Removed sidecar directory: ${TARGET_SIDECAR_DIR}`);
  }
  console.log('[harness-ide] Uninstall complete.');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--uninstall')) {
    await uninstallAll();
    return;
  }

  console.log('================================================================');
  console.log('  Harness² + Local RAG Antigravity IDE Installer (harness-ide)');
  console.log('================================================================');

  // 1. Sync latest rag-engine.mjs into plugin and sidecar
  const masterEnginePath = path.join(REPO_ROOT, 'src', 'rag-engine.mjs');
  fs.copyFileSync(masterEnginePath, path.join(SOURCE_PLUGIN_DIR, 'scripts', 'rag-engine.mjs'));
  fs.copyFileSync(masterEnginePath, path.join(SOURCE_SIDECAR_DIR, 'rag-engine.mjs'));

  // 2. Build/verify local RAG index in workspace
  const engine = new HarnessKnowledgeEngine(REPO_ROOT);
  const index = engine.buildIndex({ runQmdSync: true });
  const settings = engine.loadConfig();
  engine.saveConfig(settings, true);
  console.log(
    `[1/4] Local Hybrid RAG Index ready (${index.totalDocuments} documents indexed across 3 collections, Git rev: ${index.gitRevision}).`
  );

  // 3. Install/Update Plugin in ~/.gemini/config/plugins/harness-ide (in-place copy avoids Windows EPERM when watched)
  copyDirRecursive(SOURCE_PLUGIN_DIR, TARGET_PLUGIN_DIR);
  const pluginEnableRes = await enablePluginLive(PLUGIN_ID, true);
  console.log(
    `[2/4] Installed Antigravity Plugin to: ${TARGET_PLUGIN_DIR} (Enabled via ${pluginEnableRes.method}).`
  );

  // 4. Install/Update Auxiliary Pane UI Sidecar in ~/.gemini/config/sidecars/harness-ide-monitor
  copyDirRecursive(SOURCE_SIDECAR_DIR, TARGET_SIDECAR_DIR);
  const kitSrc = path.join(REPO_ROOT, 'node_modules', 'antigravity-sidecar-kit');
  const kitDest = path.join(TARGET_SIDECAR_DIR, 'node_modules', 'antigravity-sidecar-kit');
  if (fs.existsSync(kitSrc)) {
    copyDirRecursive(kitSrc, kitDest);
  }

  updateAgySidecarConfig(SIDECAR_ID, true);
  let sidecarReloadMethod = 'config.json';
  try {
    let hotReloaded = false;
    try {
      const scList = await getSidecars();
      const existing = (scList?.sidecars || []).find(
        (s) => (s.sidecarId || s.config?.id || s.id) === SIDECAR_ID
      );
      const livePort = Number(existing?.webPort || 0);
      const token = existing?.baseUrl
        ? new URL(existing.baseUrl).searchParams.get('token') || ''
        : '';

      if (livePort > 0) {
        // 1. Try clean zero-exit reload endpoint if supported
        try {
          const r = await fetch(`http://127.0.0.1:${livePort}/api/reload`, {
            method: 'GET',
            headers: token ? { 'X-Sidecar-Token': token } : {},
          });
          if (r.ok) {
            hotReloaded = true;
            await new Promise((res) => setTimeout(res, 350));
          }
        } catch {}

        // 2. If old process didn't have /api/reload, terminate child and trigger launcher retry
        if (!hotReloaded) {
          try {
            killSidecarProcessByPortOrPid(SIDECAR_ID);
          } catch {}
          await new Promise((res) => setTimeout(res, 250));
        }

        // 3. Always ensure launcher is not parked on diagnostic retry screen
        try {
          await fetch(
            `http://127.0.0.1:${livePort}/__launcher/retry?token=${encodeURIComponent(token)}`,
            {
              method: 'POST',
              headers: { Origin: `http://127.0.0.1:${livePort}` },
            }
          );
          hotReloaded = true;
          await new Promise((res) => setTimeout(res, 400));
        } catch {}
      }
    } catch {}

    await manageSidecar(SIDECAR_ID, 'SIDECAR_ACTION_ENABLE');
    sidecarReloadMethod = hotReloaded
      ? 'LanguageServerRPC (Zero-Downtime Hot-Reload + ManageSidecar)'
      : 'LanguageServerRPC (ManageSidecar)';
  } catch {
    // Will start on next Antigravity poll/restart
  }
  console.log(
    `[3/4] Installed Auxiliary Pane UI Sidecar to: ${TARGET_SIDECAR_DIR} (Activated via ${sidecarReloadMethod}).`
  );

  // 5. Seed initial telemetry in global sidecar_data so UI sidecar immediately resolves this workspace
  try {
    const globalTelDir = path.join(
      os.homedir(),
      '.gemini',
      'antigravity',
      'sidecar_data',
      SIDECAR_ID
    );
    fs.mkdirSync(globalTelDir, { recursive: true });
    const seedTelemetry = {
      sessions: {
        [process.env.ANTIGRAVITY_CONVERSATION_ID || 'initial-setup']: {
          conversationId: process.env.ANTIGRAVITY_CONVERSATION_ID || 'initial-setup',
          workspaceRoot: REPO_ROOT,
          modelName: 'Gemini 4 Argon (High)',
          startedAt: new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
          subagents: [],
          toolCallCount: 1,
        },
      },
      recentEvents: [
        {
          timestamp: new Date().toISOString(),
          conversationId: process.env.ANTIGRAVITY_CONVERSATION_ID || 'initial-setup',
          stepIdx: 1,
          toolName: 'setup.mjs',
          summary: 'Installed harness-ide plugin & harness-ide-monitor sidecar',
          error: null,
        },
      ],
    };
    fs.writeFileSync(
      path.join(globalTelDir, 'telemetry.json'),
      JSON.stringify(seedTelemetry, null, 2),
      'utf8'
    );
    fs.writeFileSync(
      path.join(REPO_ROOT, '.harness', 'runtime', 'telemetry.json'),
      JSON.stringify(seedTelemetry, null, 2),
      'utf8'
    );
  } catch {}

  console.log('[4/4] Verification & Links:');
  console.log('  - Manage Plugin: [harness-ide](customization://harness-ide)');
  console.log('  - Open Sidecar UI: [Harness² Swarm & RAG Monitor](sidecar://harness-ide-monitor/)');
  console.log('  - Note: Restart Antigravity once so the newly created plugin directory is discovered by startup scan.');
  console.log('================================================================');
}

main().catch((err) => {
  console.error('[harness-ide] Setup failed:', err);
  process.exit(1);
});
