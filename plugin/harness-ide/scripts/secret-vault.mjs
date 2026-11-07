import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/**
 * Supported secret credential keys across DeepSeek Official, OpenCode Go,
 * Multi-Engine Search, and Context7.
 */
export const SUPPORTED_SECRET_KEYS = [
  'DEEPSEEK_API_KEY',
  'OPENCODE_API_KEY',
  'OPENCODE_GO_API_KEY',
  'PARALLEL_API_KEY',
  'TAVILY_API_KEY',
  'JINA_API_KEY',
  'CONTEXT7_API_KEY',
];

function getGlobalConfigDir() {
  return path.join(os.homedir(), '.gemini', 'config');
}

function getVaultFilePath() {
  return path.join(getGlobalConfigDir(), '.secrets.vault.enc');
}

function getVaultKeyFilePath() {
  return path.join(getGlobalConfigDir(), '.vault.key');
}

function getHomeEnvFilePath() {
  return path.join(os.homedir(), '.env');
}

/**
 * Loads or generates a 256-bit machine-local master key (mode 0600) outside any git repository.
 */
function getOrCreateMasterKey() {
  const dir = getGlobalConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const keyFile = getVaultKeyFilePath();
  if (fs.existsSync(keyFile)) {
    const raw = fs.readFileSync(keyFile, 'utf8').trim();
    if (raw.length === 64) {
      return Buffer.from(raw, 'hex');
    }
  }
  const newKey = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, newKey.toString('hex'), { encoding: 'utf8', mode: 0o600 });
  return newKey;
}

/**
 * Encrypts a JSON object with AES-256-GCM and writes it to `~/.gemini/config/.secrets.vault.enc` (mode 0600).
 */
export function writeEncryptedVault(secretsMap = {}) {
  const key = getOrCreateMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify(secretsMap);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const payload = {
    version: 1,
    cipher: 'aes-256-gcm',
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext: encrypted.toString('hex'),
    updatedAt: new Date().toISOString(),
  };

  const vaultFile = getVaultFilePath();
  fs.writeFileSync(vaultFile, JSON.stringify(payload, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  return { vaultPath: vaultFile, updatedAt: payload.updatedAt };
}

/**
 * Reads and decrypts `~/.gemini/config/.secrets.vault.enc` in memory.
 * Never logs or prints secret values.
 */
export function readEncryptedVault() {
  const vaultFile = getVaultFilePath();
  if (!fs.existsSync(vaultFile)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(vaultFile, 'utf8'));
    const key = getOrCreateMasterKey();
    const iv = Buffer.from(raw.iv, 'hex');
    const authTag = Buffer.from(raw.authTag, 'hex');
    const ciphertext = Buffer.from(raw.ciphertext, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      'utf8'
    );
    const parsed = JSON.parse(decrypted);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Parses `~/.env` silently in memory (following Antigravity's Safe Credentials Protocol).
 */
function parseHomeDotEnv() {
  const envFile = getHomeEnvFilePath();
  if (!fs.existsSync(envFile)) return {};
  const result = {};
  try {
    const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) continue;
      const k = trimmed.slice(0, eqIdx).trim();
      let v = trimmed.slice(eqIdx + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (k && v) {
        result[k] = v;
      }
    }
  } catch {
    // ignore read errors
  }
  return result;
}

/**
 * Saves a single secret into the AES-256-GCM Encrypted Vault (`~/.gemini/config/.secrets.vault.enc`).
 */
export function setSecretInVault(secretName, secretValue) {
  if (!secretName) throw new Error('secretName is required');
  const current = readEncryptedVault();
  const cleanVal = String(secretValue || '').trim();
  if (cleanVal) {
    current[secretName] = cleanVal;
  } else {
    delete current[secretName];
  }
  return writeEncryptedVault(current);
}

/**
 * Resolves a secret credential in priority order:
 * 1. AES-256-GCM Encrypted Vault (`~/.gemini/config/.secrets.vault.enc`)
 * 2. Home `~/.env` file (Antigravity Safe Credentials Protocol)
 * 3. Process environment variable (`process.env[name]`)
 *
 * Returns `{ value, hasKey, source }` where `value` is ONLY used for outbound
 * Authorization headers and NEVER serialized into UI or disk JSON.
 */
export function resolveSecretCredential(names) {
  const nameList = Array.isArray(names) ? names : [names];
  const vault = readEncryptedVault();
  const homeEnv = parseHomeDotEnv();

  for (const name of nameList) {
    if (vault[name] && String(vault[name]).trim()) {
      return {
        value: String(vault[name]).trim(),
        hasKey: true,
        source: 'aes-256-gcm-vault (~/.gemini/config/.secrets.vault.enc)',
      };
    }
    if (homeEnv[name] && String(homeEnv[name]).trim()) {
      return {
        value: String(homeEnv[name]).trim(),
        hasKey: true,
        source: 'home-dotenv (~/.env)',
      };
    }
    if (process.env[name] && String(process.env[name]).trim()) {
      return {
        value: String(process.env[name]).trim(),
        hasKey: true,
        source: `process.env.${name}`,
      };
    }
  }

  return {
    value: '',
    hasKey: false,
    source: 'not-set',
  };
}

/**
 * Returns a safe, leak-free status summary of all supported credentials (no values or substrings exposed).
 */
export function getSecretVaultStatusSummary() {
  const status = {};
  for (const keyName of SUPPORTED_SECRET_KEYS) {
    const res = resolveSecretCredential(keyName);
    status[keyName] = {
      configured: res.hasKey,
      source: res.source,
      badge: res.hasKey ? '🔒 Stored Secretly' : 'Not Configured',
    };
  }
  return {
    vaultPath: '~/.gemini/config/.secrets.vault.enc',
    dotenvPath: '~/.env',
    cipher: 'AES-256-GCM (mode 0600)',
    credentials: status,
    keys: status,
  };
}

/**
 * Redacts any accidental API key patterns (`sk-...`, `oc_sk_...`, `tvly-...`) from strings
 * before logging or displaying.
 */
export function redactSecrets(inputStr) {
  let s = String(inputStr ?? '');
  if (!s) return s;
  s = s.replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED_API_KEY]');
  s = s.replace(/\b(oc_sk_[A-Za-z0-9_-]{10,})\b/g, '[REDACTED_OPENCODE_KEY]');
  s = s.replace(/\b(tvly-[A-Za-z0-9_-]{10,})\b/g, '[REDACTED_TAVILY_KEY]');
  s = s.replace(/\b(jina_[A-Za-z0-9_-]{10,})\b/g, '[REDACTED_JINA_KEY]');
  return s;
}
