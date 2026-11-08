#!/usr/bin/env node
/**
 * Reproducible One-Command Installer for Harness² + Local RAG Antigravity IDE (`harness-ide`).
 *
 * Self-contained project-owned installer with clean-package preflight verification.
 * Uses only Node.js built-in modules and documented configuration surfaces.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessKnowledgeEngine } from './src/rag-engine.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.dirname(__filename);

export const GLOBAL_CONFIG_DIR = path.join(os.homedir(), '.gemini', 'config');
export const GLOBAL_SIDECARS_DIR = path.join(GLOBAL_CONFIG_DIR, 'sidecars');
export const CONFIG_JSON_PATH = path.join(GLOBAL_CONFIG_DIR, 'config.json');

const PLUGIN_ID = 'harness-ide';
const SIDECAR_ID = 'harness-ide-monitor';

const SOURCE_PLUGIN_DIR = path.join(REPO_ROOT, 'plugin', PLUGIN_ID);
const TARGET_PLUGIN_DIR = path.join(GLOBAL_CONFIG_DIR, 'plugins', PLUGIN_ID);

const SOURCE_SIDECAR_DIR = path.join(REPO_ROOT, 'sidecars', SIDECAR_ID);
const TARGET_SIDECAR_DIR = path.join(GLOBAL_SIDECARS_DIR, SIDECAR_ID);

export function readJsonSafe(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function writeJsonNoBom(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  const serialized = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(tmpPath, serialized, { encoding: 'utf8' });
  fs.renameSync(tmpPath, filePath);
}

export function updateAgySidecarConfig(
  sidecarId = SIDECAR_ID,
  enabled = true,
  configPath = CONFIG_JSON_PATH
) {
  try {
    const cfg = readJsonSafe(configPath, {});
    cfg.sidecars = cfg.sidecars && typeof cfg.sidecars === 'object' ? cfg.sidecars : {};
    cfg.sidecars[sidecarId] = {
      ...(cfg.sidecars[sidecarId] && typeof cfg.sidecars[sidecarId] === 'object'
        ? cfg.sidecars[sidecarId]
        : {}),
      enabled: Boolean(enabled),
      surface: 'app_optional',
      updatedAt: new Date().toISOString(),
    };
    writeJsonNoBom(configPath, cfg);
    return {
      ok: true,
      method: 'config.json (optional App sidecar config)',
      sidecarId,
      enabled: Boolean(enabled),
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      method: 'none',
      sidecarId,
      enabled: false,
      error: err?.message || String(err),
    };
  }
}

export async function enablePluginLive(
  pluginDirName = PLUGIN_ID,
  enabled = true,
  configPath = CONFIG_JSON_PATH
) {
  let configOk = false;
  let configError = null;
  try {
    const cfg = readJsonSafe(configPath, {});
    cfg.plugins = cfg.plugins && typeof cfg.plugins === 'object' ? cfg.plugins : {};
    cfg.plugins[pluginDirName] = {
      ...(cfg.plugins[pluginDirName] && typeof cfg.plugins[pluginDirName] === 'object'
        ? cfg.plugins[pluginDirName]
        : {}),
      enabled: Boolean(enabled),
      updatedAt: new Date().toISOString(),
    };
    writeJsonNoBom(configPath, cfg);
    configOk = true;
  } catch (err) {
    configError = err?.message || String(err);
  }

  return {
    method: configOk ? 'config.json (public atomic)' : 'none',
    ok: configOk,
    stages: {
      registered: configOk,
      enabled: configOk && Boolean(enabled),
      liveRpcNotified: false,
    },
    error: configError,
  };
}

export const SHIPPED_ENTRYPOINTS = [
  'setup.mjs',
  'package.json',
  'src/rag-engine.mjs',
  'src/model-hub.mjs',
  'src/context-resilience.mjs',
  'src/secret-vault.mjs',
  'mcp/harness-rag-server.mjs',
  'plugin/harness-ide/plugin.json',
  'plugin/harness-ide/rules/AGENTS.md',
  'plugin/harness-ide/rules/gravity-well-default.md',
  'plugin/harness-ide/scripts/mcp-entry.mjs',
  'plugin/harness-ide/scripts/hooks/session-start.mjs',
  'plugin/harness-ide/scripts/hooks/pre-invocation.mjs',
  'plugin/harness-ide/scripts/hooks/post-tool-use.mjs',
  'plugin/harness-ide/hooks.json',
  'sidecars/harness-ide-monitor/package.json',
  'sidecars/harness-ide-monitor/launch.mjs',
  'sidecars/harness-ide-monitor/server.mjs',
];

const FORBIDDEN_REMOVED_PATTERNS = [
  ['antigravity', 'sidecar', 'kit'].join('-'),
  ['Jetbox', 'WriteState'].join(''),
  ['GetAllCascade', 'Trajectories'].join(''),
  ['manage', 'Sidecar'].join(''),
  ['get', 'Sidecars'].join(''),
  ['killSidecarProcess', 'ByPortOrPid'].join(''),
  ['/__launcher', '/retry'].join(''),
];

export function verifyCleanPackagePreflight(repoRoot = REPO_ROOT) {
  const missingFiles = [];
  const forbiddenReferences = [];
  const nonEmptyDependencies = [];

  for (const relPath of SHIPPED_ENTRYPOINTS) {
    const absPath = path.join(repoRoot, relPath);
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      missingFiles.push(relPath);
      continue;
    }
    const content = fs.readFileSync(absPath, 'utf8');
    for (const token of FORBIDDEN_REMOVED_PATTERNS) {
      // Avoid matching the constant array definition inside setup.mjs itself
      if (relPath === 'setup.mjs') {
        const stripped = content.replace(
          /const FORBIDDEN_REMOVED_PATTERNS = \[[\s\S]*?\];/,
          ''
        );
        if (stripped.includes(token)) {
          forbiddenReferences.push({ file: relPath, token });
        }
      } else if (content.includes(token)) {
        forbiddenReferences.push({ file: relPath, token });
      }
    }
  }

  for (const manifestRel of ['package.json', 'sidecars/harness-ide-monitor/package.json']) {
    const manifestAbs = path.join(repoRoot, manifestRel);
    if (fs.existsSync(manifestAbs)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(manifestAbs, 'utf8'));
        const deps = Object.keys(pkg.dependencies || {});
        if (deps.length > 0) {
          nonEmptyDependencies.push({ file: manifestRel, dependencies: deps });
        }
      } catch (err) {
        missingFiles.push(`${manifestRel} (invalid JSON: ${err?.message})`);
      }
    }
  }

  const ok =
    missingFiles.length === 0 &&
    forbiddenReferences.length === 0 &&
    nonEmptyDependencies.length === 0;

  return {
    ok,
    stage: 'preflight',
    checkedFiles: SHIPPED_ENTRYPOINTS.length,
    missingFiles,
    forbiddenReferences,
    nonEmptyDependencies,
  };
}

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

export function syncRepoMirrors(repoRoot = REPO_ROOT) {
  const srcPluginDir = path.join(repoRoot, 'plugin', PLUGIN_ID);
  const srcSidecarDir = path.join(repoRoot, 'sidecars', SIDECAR_ID);
  fs.mkdirSync(path.join(srcPluginDir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(srcPluginDir, 'rules'), { recursive: true });

  for (const modName of [
    'secret-vault.mjs',
    'rag-engine.mjs',
    'model-hub.mjs',
    'context-resilience.mjs',
  ]) {
    const masterPath = path.join(repoRoot, 'src', modName);
    if (fs.existsSync(masterPath)) {
      fs.copyFileSync(masterPath, path.join(srcPluginDir, 'scripts', modName));
      fs.copyFileSync(masterPath, path.join(srcSidecarDir, modName));
    }
  }

  const canonicalMcpPath = path.join(repoRoot, 'mcp', 'harness-rag-server.mjs');
  if (fs.existsSync(canonicalMcpPath)) {
    fs.copyFileSync(canonicalMcpPath, path.join(srcPluginDir, 'scripts', 'mcp-entry.mjs'));
  }

  const masterContractRulePath = path.join(repoRoot, '.agents', 'rules', 'gravity-well-default.md');
  if (fs.existsSync(masterContractRulePath)) {
    fs.copyFileSync(
      masterContractRulePath,
      path.join(srcPluginDir, 'rules', 'gravity-well-default.md')
    );
  }
}

async function uninstallAll(configPath = CONFIG_JSON_PATH) {
  console.log('[harness-ide] Uninstalling plugin and UI sidecar...');
  await enablePluginLive(PLUGIN_ID, false, configPath);
  updateAgySidecarConfig(SIDECAR_ID, false, configPath);

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

export async function runInstaller({
  repoRoot = REPO_ROOT,
  preflightOnly = false,
  configPath = CONFIG_JSON_PATH,
  targetPluginDir = TARGET_PLUGIN_DIR,
  targetSidecarDir = TARGET_SIDECAR_DIR,
  quiet = false,
} = {}) {
  const log = (...args) => {
    if (!quiet) console.log(...args);
  };

  syncRepoMirrors(repoRoot);
  const preflight = verifyCleanPackagePreflight(repoRoot);
  if (!preflight.ok) {
    const err = new Error(
      `Clean-package preflight failed: missing=${JSON.stringify(preflight.missingFiles)} forbidden=${JSON.stringify(preflight.forbiddenReferences)} deps=${JSON.stringify(preflight.nonEmptyDependencies)}`
    );
    err.code = 'CLEAN_PACKAGE_PREFLIGHT_FAILED';
    err.preflight = preflight;
    throw err;
  }

  if (preflightOnly) {
    return {
      ok: true,
      preflightOnly: true,
      stages: { preflight },
    };
  }

  log('================================================================');
  log('  Harness² + Local RAG Antigravity IDE Installer (harness-ide)');
  log('================================================================');

  const engine = new HarnessKnowledgeEngine(repoRoot);
  const index = engine.buildIndex({ runQmdSync: true });
  const settings = engine.loadConfig();
  engine.saveConfig(settings, true);
  log(
    `[1/4] Local Hybrid RAG Index ready (${index.totalDocuments} documents indexed across 3 collections, Git rev: ${index.gitRevision}).`
  );

  const srcPluginDir = path.join(repoRoot, 'plugin', PLUGIN_ID);
  const srcSidecarDir = path.join(repoRoot, 'sidecars', SIDECAR_ID);
  copyDirRecursive(srcPluginDir, targetPluginDir);

  const pluginEnableRes = await enablePluginLive(PLUGIN_ID, true, configPath);
  if (!pluginEnableRes.ok) {
    throw new Error(
      `Plugin installation succeeded at ${targetPluginDir}, but enabling in ${configPath} failed: ${pluginEnableRes.error}`
    );
  }
  log(
    `[2/4] Installed Antigravity Plugin to: ${targetPluginDir} (Enabled via ${pluginEnableRes.method}).`
  );

  copyDirRecursive(srcSidecarDir, targetSidecarDir);
  const sidecarEnableRes = updateAgySidecarConfig(SIDECAR_ID, true, configPath);
  if (!sidecarEnableRes.ok) {
    throw new Error(
      `Sidecar installation succeeded at ${targetSidecarDir}, but updating ${configPath} failed: ${sidecarEnableRes.error}`
    );
  }
  log(
    `[3/4] Installed Auxiliary Pane UI Sidecar to: ${targetSidecarDir} (Activated via config.json).`
  );

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
          workspaceRoot: repoRoot,
          modelName: null,
          startedAt: new Date().toISOString(),
          lastUpdatedAt: new Date().toISOString(),
          subagents: [],
          toolCallCount: 0,
        },
      },
      recentEvents: [],
    };
    const globalTelPath = path.join(globalTelDir, 'telemetry.json');
    if (!fs.existsSync(globalTelPath)) {
      fs.writeFileSync(globalTelPath, JSON.stringify(seedTelemetry, null, 2), 'utf8');
    }
    const localTelPath = path.join(repoRoot, '.harness', 'runtime', 'telemetry.json');
    if (!fs.existsSync(localTelPath)) {
      fs.mkdirSync(path.dirname(localTelPath), { recursive: true });
      fs.writeFileSync(localTelPath, JSON.stringify(seedTelemetry, null, 2), 'utf8');
    }
  } catch {}

  log('[4/4] Verification & Links:');
  log('  - Manage Plugin: [harness-ide](customization://harness-ide)');
  log('  - Open Sidecar UI (Optional App Surface): [Harness² Swarm & RAG Monitor](sidecar://harness-ide-monitor/)');
  log('  - Standalone Monitor: node sidecars/harness-ide-monitor/server.mjs');
  log('  - Note: Restart Antigravity once so the newly created plugin directory is discovered by startup scan.');
  log('================================================================');

  return {
    ok: true,
    stages: {
      preflight,
      index: { ok: true, totalDocuments: index.totalDocuments, gitRevision: index.gitRevision },
      pluginInstall: { ok: true, targetDir: targetPluginDir },
      pluginEnable: pluginEnableRes,
      sidecarInstall: { ok: true, targetDir: targetSidecarDir },
      sidecarEnable: sidecarEnableRes,
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--uninstall')) {
    await uninstallAll();
    return;
  }
  const preflightOnly = args.includes('--preflight') || args.includes('--preflight-only');
  const res = await runInstaller({ preflightOnly });
  if (preflightOnly) {
    console.log(JSON.stringify(res.stages.preflight, null, 2));
  }
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isMainModule) {
  main().catch((err) => {
    console.error('[harness-ide] Setup failed:', err?.message || err);
    process.exit(1);
  });
}
