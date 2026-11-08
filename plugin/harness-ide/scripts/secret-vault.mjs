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

/**
 * Trusted HTTPS origin allowlist per secret credential (F05).
 * Global credentials must never be attached to requests targeting origins outside this map.
 */
export const TRUSTED_CREDENTIAL_ORIGINS = {
  DEEPSEEK_API_KEY: ['https://api.deepseek.com'],
  OPENCODE_API_KEY: ['https://opencode.ai', 'https://models.opencode.ai'],
  OPENCODE_GO_API_KEY: ['https://opencode.ai', 'https://models.opencode.ai'],
  TAVILY_API_KEY: ['https://api.tavily.com', 'https://mcp.tavily.com'],
  PARALLEL_API_KEY: ['https://api.parallel.ai', 'https://search.parallel.ai'],
  JINA_API_KEY: ['https://s.jina.ai', 'https://r.jina.ai'],
  CONTEXT7_API_KEY: ['https://mcp.context7.com'],
};

/**
 * Validates that a target URL is a valid HTTPS URL whose origin (`${protocol}//${host}`)
 * is explicitly registered in `TRUSTED_CREDENTIAL_ORIGINS` for `secretName`.
 */
export function validateCredentialOrigin(secretName, targetUrl) {
  let url;
  try {
    url = new URL(String(targetUrl || ''));
  } catch {
    return {
      ok: false,
      allowed: false,
      origin: '',
      reason: `Invalid target URL for credential ${secretName}: ${String(targetUrl || '')}`,
    };
  }

  const origin = `${url.protocol}//${url.host}`.toLowerCase();

  if (url.protocol !== 'https:') {
    return {
      ok: false,
      allowed: false,
      origin,
      reason: `Insecure protocol '${url.protocol}' is not allowed for credential ${secretName}; HTTPS is required`,
    };
  }

  if (url.username || url.password) {
    return {
      ok: false,
      allowed: false,
      origin,
      reason: `Embedded URL userinfo is not allowed for credential ${secretName}`,
    };
  }

  const allowedOrigins = TRUSTED_CREDENTIAL_ORIGINS[secretName];
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    return {
      ok: false,
      allowed: false,
      origin,
      reason: `No trusted origins registered for credential ${secretName}`,
    };
  }

  const normalizedAllowed = allowedOrigins.map((o) => String(o).toLowerCase());
  if (!normalizedAllowed.includes(origin)) {
    return {
      ok: false,
      allowed: false,
      origin,
      reason: `Origin '${origin}' is not in the trusted allowlist for ${secretName} (${allowedOrigins.join(', ')})`,
    };
  }

  return {
    ok: true,
    allowed: true,
    origin,
  };
}

function getGlobalConfigDir() {
  return path.join(os.homedir(), '.gemini', 'config');
}

function getVaultFilePath() {
  return path.join(getGlobalConfigDir(), '.secrets.vault.enc');
}

function getVaultKeyFilePath() {
  return path.join(getGlobalConfigDir(), '.vault.key');
}

export function getVaultLockFilePath() {
  return path.join(getGlobalConfigDir(), '.vault.lock');
}

function getHomeEnvFilePath() {
  return path.join(os.homedir(), '.env');
}

const VAULT_SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));
function sleepSyncMs(ms) {
  const waitMs = Math.max(1, Math.floor(Number(ms) || 1));
  try {
    Atomics.wait(VAULT_SLEEP_ARRAY, 0, 0, waitMs);
  } catch {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      // spin fallback
    }
  }
}

function isProcessAlive(pid) {
  const numPid = Number(pid);
  if (!Number.isInteger(numPid) || numPid <= 0) return false;
  try {
    process.kill(numPid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'ESRCH') {
      return false;
    }
    return true;
  }
}

function renameFileAtomicWithRetry(tmpFile, targetFile) {
  for (let i = 0; i < 6; i += 1) {
    try {
      fs.renameSync(tmpFile, targetFile);
      return;
    } catch (err) {
      if (i < 5 && err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY')) {
        sleepSyncMs(5 * (i + 1));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Executes `fn` while holding an exclusive file lock at `~/.gemini/config/.vault.lock`.
 * Retries with short backoff; only breaks an existing lock if its holder PID is dead (`ESRCH`)
 * AND its age exceeds 10,000ms.
 * Fails closed by throwing `err.code = 'VAULT_LOCK_TIMEOUT'` if the lock cannot be acquired
 * within `timeoutMs` — never executes `fn` unlocked.
 */
export function withVaultLock(fn, timeoutMs = 5000) {
  const dir = getGlobalConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const lockPath = getVaultLockFilePath();
  const effectiveTimeoutMs = Math.max(1, Number(timeoutMs ?? 5000));
  const deadline = Date.now() + effectiveTimeoutMs;
  const ownerToken = `${process.pid}:${Date.now()}:${crypto.randomBytes(4).toString('hex')}`;
  let acquired = false;

  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        const lockPayload = JSON.stringify({
          pid: process.pid,
          acquiredAt: Date.now(),
          token: ownerToken,
        });
        fs.writeFileSync(fd, lockPayload, 'utf8');
      } finally {
        try {
          fs.closeSync(fd);
        } catch {}
      }
      acquired = true;
      break;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        try {
          const stat = fs.statSync(lockPath);
          let lockPid = null;
          let acquiredAt = stat.mtimeMs;
          try {
            const raw = fs.readFileSync(lockPath, 'utf8').trim();
            if (raw.startsWith('{')) {
              const parsed = JSON.parse(raw);
              if (parsed && typeof parsed === 'object') {
                if (parsed.pid !== undefined) lockPid = Number(parsed.pid);
                if (Number.isFinite(Number(parsed.acquiredAt)) && Number(parsed.acquiredAt) > 0) {
                  acquiredAt = Number(parsed.acquiredAt);
                }
              }
            } else if (raw.includes(':')) {
              const [pidPart, tsPart] = raw.split(':');
              lockPid = Number(pidPart);
              if (Number.isFinite(Number(tsPart)) && Number(tsPart) > 0) {
                acquiredAt = Number(tsPart);
              }
            }
          } catch {}

          const ageMs = Date.now() - acquiredAt;
          const pidDead = lockPid ? !isProcessAlive(lockPid) : false;
          if (ageMs > 10_000 && pidDead) {
            try {
              fs.unlinkSync(lockPath);
              continue;
            } catch {}
          }
        } catch {}

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          break;
        }
        sleepSyncMs(Math.min(8, Math.max(1, remaining)));
        continue;
      }

      if (Date.now() >= deadline) {
        break;
      }
      sleepSyncMs(4);
    }
  }

  if (!acquired) {
    const err = new Error(
      `Timed out after ${effectiveTimeoutMs}ms waiting for exclusive secret vault lock (${lockPath}).`
    );
    err.code = 'VAULT_LOCK_TIMEOUT';
    throw err;
  }

  const releaseLock = () => {
    try {
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
    } catch {}
  };

  let isAsync = false;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      isAsync = true;
      return result.finally(releaseLock);
    }
    return result;
  } finally {
    if (!isAsync) {
      releaseLock();
    }
  }
}

/**
 * Loads or generates a 256-bit machine-local master key (mode 0600) outside any git repository.
 * Refuses to generate a replacement random key if `.secrets.vault.enc` already exists on disk
 * while `.vault.key` is missing or invalid (F13).
 */
export function getOrCreateMasterKey({ allowCreate = true } = {}) {
  const dir = getGlobalConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const keyFile = getVaultKeyFilePath();
  const vaultFile = getVaultFilePath();

  if (fs.existsSync(keyFile)) {
    const raw = fs.readFileSync(keyFile, 'utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      return Buffer.from(raw, 'hex');
    }
  }

  if (fs.existsSync(vaultFile) || !allowCreate) {
    const err = new Error(
      'Master key (.vault.key) is missing or invalid while encrypted vault (.secrets.vault.enc) already exists on disk.'
    );
    err.code = 'VAULT_KEY_MISSING_FOR_EXISTING_VAULT';
    throw err;
  }

  const newKey = crypto.randomBytes(32);
  const tmpKeyFile = `${keyFile}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmpKeyFile, newKey.toString('hex'), { encoding: 'utf8', mode: 0o600 });
  renameFileAtomicWithRetry(tmpKeyFile, keyFile);
  return newKey;
}

/**
 * Encrypts a JSON object with AES-256-GCM and writes it atomically to
 * `~/.gemini/config/.secrets.vault.enc` (mode 0600).
 */
export function writeEncryptedVault(secretsMap = {}) {
  const key = getOrCreateMasterKey({ allowCreate: true });
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
  fs.mkdirSync(path.dirname(vaultFile), { recursive: true });
  const tmpFile = `${vaultFile}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  renameFileAtomicWithRetry(tmpFile, vaultFile);
  return { vaultPath: vaultFile, updatedAt: payload.updatedAt };
}

/**
 * Reads and decrypts `~/.gemini/config/.secrets.vault.enc` in memory.
 * Never logs or prints secret values.
 * When `throwOnCorrupt` is true (default), throws an Error with
 * `err.code = 'VAULT_CORRUPT_OR_KEY_MISMATCH'` (or `'VAULT_KEY_MISSING_FOR_EXISTING_VAULT'`)
 * instead of silently returning `{}` so callers never overwrite an existing vault on failure.
 */
export function readEncryptedVault({ throwOnCorrupt = true } = {}) {
  const vaultFile = getVaultFilePath();
  if (!fs.existsSync(vaultFile)) return {};
  try {
    const rawText = fs.readFileSync(vaultFile, 'utf8');
    const raw = JSON.parse(rawText);
    if (
      !raw ||
      typeof raw !== 'object' ||
      typeof raw.iv !== 'string' ||
      typeof raw.authTag !== 'string' ||
      typeof raw.ciphertext !== 'string' ||
      raw.iv.length === 0 ||
      raw.authTag.length === 0
    ) {
      const formatErr = new Error('Encrypted vault file is missing required AES-256-GCM fields.');
      formatErr.code = 'VAULT_CORRUPT_OR_KEY_MISMATCH';
      throw formatErr;
    }
    const key = getOrCreateMasterKey({ allowCreate: false });
    const iv = Buffer.from(raw.iv, 'hex');
    const authTag = Buffer.from(raw.authTag, 'hex');
    const ciphertext = Buffer.from(raw.ciphertext, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      'utf8'
    );
    const parsed = JSON.parse(decrypted);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const payloadErr = new Error('Decrypted vault payload is not a valid JSON object.');
      payloadErr.code = 'VAULT_CORRUPT_OR_KEY_MISMATCH';
      throw payloadErr;
    }
    return parsed;
  } catch (err) {
    if (!throwOnCorrupt) {
      return {};
    }
    if (err && err.code === 'VAULT_KEY_MISSING_FOR_EXISTING_VAULT') {
      throw err;
    }
    const corruptErr = new Error(
      `Failed to read or decrypt secret vault (.secrets.vault.enc): ${err?.message || String(err)}`
    );
    corruptErr.code = 'VAULT_CORRUPT_OR_KEY_MISMATCH';
    corruptErr.cause = err;
    throw corruptErr;
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
 * Saves a single secret into the AES-256-GCM Encrypted Vault (`~/.gemini/config/.secrets.vault.enc`)
 * under an exclusive file lock (`withVaultLock`) so concurrent updates across processes never overwrite keys.
 * Throws if an existing vault is corrupt or its master key is missing/mismatched so existing
 * secrets are never overwritten with `{}`.
 */
export function setSecretInVault(secretName, secretValue, { timeoutMs = 5000 } = {}) {
  if (!secretName) throw new Error('secretName is required');
  return withVaultLock(() => {
    const current = readEncryptedVault({ throwOnCorrupt: true });
    const cleanVal = String(secretValue || '').trim();
    if (cleanVal) {
      current[secretName] = cleanVal;
    } else {
      delete current[secretName];
    }
    return writeEncryptedVault(current);
  }, timeoutMs);
}

/**
 * Atomically updates multiple secrets in the AES-256-GCM Encrypted Vault inside a single
 * exclusive `withVaultLock` transaction.
 */
export function setSecretsInVaultBatch(entriesObj = {}, { timeoutMs = 5000 } = {}) {
  if (!entriesObj || typeof entriesObj !== 'object' || Array.isArray(entriesObj)) {
    throw new Error('entriesObj must be a plain object mapping secret names to values');
  }
  return withVaultLock(() => {
    const current = readEncryptedVault({ throwOnCorrupt: true });
    for (const [secretName, secretValue] of Object.entries(entriesObj)) {
      if (!secretName) continue;
      const cleanVal = String(secretValue ?? '').trim();
      if (cleanVal) {
        current[secretName] = cleanVal;
      } else {
        delete current[secretName];
      }
    }
    return writeEncryptedVault(current);
  }, timeoutMs);
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
  const vault = readEncryptedVault({ throwOnCorrupt: false });
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
  let vaultHealthy = true;
  const vaultFile = getVaultFilePath();
  if (fs.existsSync(vaultFile)) {
    try {
      readEncryptedVault({ throwOnCorrupt: true });
    } catch {
      vaultHealthy = false;
    }
  }

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
    vaultHealthy,
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
