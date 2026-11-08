#!/usr/bin/env node
/**
 * Reproducible One-Command Installer for Harness² + Local RAG Antigravity IDE (`harness-ide`).
 *
 * Installs:
 * 1. Global Antigravity Plugin: `~/.gemini/config/plugins/harness-ide`
 * 2. Global Auxiliary Pane UI Sidecar: `~/.gemini/config/sidecars/harness-ide-monitor`
 * 3. Local `.harness/` Knowledge Collections & Hybrid RAG Index
 * 4. Enables both plugin and sidecar via public `~/.gemini/config/config.json`
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
  let configOk = false;
  let configError = null;
  try {
    const cfg = readJsonSafe(CONFIG_JSON_PATH, {});
    cfg.plugins = cfg.plugins || {};
    cfg.plugins[pluginDirName] = { ...(cfg.plugins[pluginDirName] || {}), enabled };
    writeJsonNoBom(CONFIG_JSON_PATH, cfg);
    configOk = true;
  } catch (err) {
    configError = err?.message;
  }

  return {
    method: configOk ? 'config.json (public atomic)' : 'none',
    ok: configOk,
    stages: {
      registered: configOk,
      enabled: configOk,
      liveRpcNotified: false,
    },
    error: configError,
  };
}

async function uninstallAll() {
  console.log('[harness-ide] Uninstalling plugin and UI sidecar...');
  await enablePluginLive(PLUGIN_ID, false);
  updateAgySidecarConfig(SIDECAR_ID, false);

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

  // 1. Sync latest runtime modules, canonical 16-tool MCP entrypoint, and default operating contract into plugin and sidecar
  fs.mkdirSync(path.join(SOURCE_PLUGIN_DIR, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(SOURCE_PLUGIN_DIR, 'rules'), { recursive: true });

  const masterVaultPath = path.join(REPO_ROOT, 'src', 'secret-vault.mjs');
  fs.copyFileSync(masterVaultPath, path.join(SOURCE_PLUGIN_DIR, 'scripts', 'secret-vault.mjs'));
  fs.copyFileSync(masterVaultPath, path.join(SOURCE_SIDECAR_DIR, 'secret-vault.mjs'));

  const masterEnginePath = path.join(REPO_ROOT, 'src', 'rag-engine.mjs');
  fs.copyFileSync(masterEnginePath, path.join(SOURCE_PLUGIN_DIR, 'scripts', 'rag-engine.mjs'));
  fs.copyFileSync(masterEnginePath, path.join(SOURCE_SIDECAR_DIR, 'rag-engine.mjs'));

  const masterHubPath = path.join(REPO_ROOT, 'src', 'model-hub.mjs');
  fs.copyFileSync(masterHubPath, path.join(SOURCE_PLUGIN_DIR, 'scripts', 'model-hub.mjs'));
  fs.copyFileSync(masterHubPath, path.join(SOURCE_SIDECAR_DIR, 'model-hub.mjs'));

  const masterResiliencePath = path.join(REPO_ROOT, 'src', 'context-resilience.mjs');
  if (fs.existsSync(masterResiliencePath)) {
    fs.copyFileSync(masterResiliencePath, path.join(SOURCE_PLUGIN_DIR, 'scripts', 'context-resilience.mjs'));
    fs.copyFileSync(masterResiliencePath, path.join(SOURCE_SIDECAR_DIR, 'context-resilience.mjs'));
  }

  const canonicalMcpPath = path.join(REPO_ROOT, 'mcp', 'harness-rag-server.mjs');
  if (fs.existsSync(canonicalMcpPath)) {
    fs.copyFileSync(canonicalMcpPath, path.join(SOURCE_PLUGIN_DIR, 'scripts', 'mcp-entry.mjs'));
  }

  const masterContractRulePath = path.join(REPO_ROOT, '.agents', 'rules', 'gravity-well-default.md');
  if (fs.existsSync(masterContractRulePath)) {
    fs.copyFileSync(masterContractRulePath, path.join(SOURCE_PLUGIN_DIR, 'rules', 'gravity-well-default.md'));
  }

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
  if (fs.existsSync(canonicalMcpPath)) {
    fs.mkdirSync(path.join(TARGET_PLUGIN_DIR, 'scripts'), { recursive: true });
    fs.copyFileSync(canonicalMcpPath, path.join(TARGET_PLUGIN_DIR, 'scripts', 'mcp-entry.mjs'));
  }
  if (fs.existsSync(masterContractRulePath)) {
    fs.mkdirSync(path.join(TARGET_PLUGIN_DIR, 'rules'), { recursive: true });
    fs.copyFileSync(masterContractRulePath, path.join(TARGET_PLUGIN_DIR, 'rules', 'gravity-well-default.md'));
  }
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
  console.log(
    `[3/4] Installed Auxiliary Pane UI Sidecar to: ${TARGET_SIDECAR_DIR} (Activated via config.json).`
  );

  // 5. Seed initial telemetry in global sidecar_data if not already present so UI sidecar immediately resolves this workspace
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
    const globalTelPath = path.join(globalTelDir, 'telemetry.json');
    if (!fs.existsSync(globalTelPath)) {
      fs.writeFileSync(globalTelPath, JSON.stringify(seedTelemetry, null, 2), 'utf8');
    }
    const localTelPath = path.join(REPO_ROOT, '.harness', 'runtime', 'telemetry.json');
    if (!fs.existsSync(localTelPath)) {
      fs.mkdirSync(path.dirname(localTelPath), { recursive: true });
      fs.writeFileSync(localTelPath, JSON.stringify(seedTelemetry, null, 2), 'utf8');
    }
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
