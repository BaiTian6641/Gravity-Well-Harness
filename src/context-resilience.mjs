import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { HarnessKnowledgeEngine } from './rag-engine.mjs';

/**
 * Gravity Well Harness — Argon Context Resilience & Durable Task State Manager
 * Implements Document 04 (`04_Argon_Context_Resilience.md`) and Work Packages 3, 5, 7 & 8:
 *  - Symlink-safe realpath containment on all task/evidence/log paths
 *  - Exclusive per-task file locks (`.task.lock`) with dead-PID recovery & fail-closed timeout
 *  - Requirement Ledger (`requirements.json`) with real evidence file checks & comment-stripped symbol verification
 *  - Exact Contract Registry (`contracts.json`) that automatically invalidates verified requirements on drift
 *  - Monotonic, non-overwriting Atomic Resumable Checkpoints (`checkpoints/rev-<N>.json` + `current.json`)
 *  - Live Authoritative Subagent Recovery (`restoreSubagentFromCheckpoint`) + Worker Acknowledgment (`acknowledgeRecoveryPacket`)
 *  - Bounded Tool Output Externalization (`CTX-08`), Conflict Resolution (`CTX-11`), and Escalation (`CTX-12`)
 */

const VALID_REQUIREMENT_STATES = new Set([
  'planned',
  'implemented',
  'verified',
  'implemented_unverified',
  'blocked',
]);

function sha256Text(content) {
  return crypto.createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex');
}

function sleepSync(ms) {
  try {
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    Atomics.wait(view, 0, 0, Math.max(1, Math.min(250, ms)));
  } catch {
    const end = Date.now() + Math.max(1, Math.min(250, ms));
    while (Date.now() < end) {
      // busy wait fallback
    }
  }
}

function isPidAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Single-pass lexical scanner that strips comments (and optionally string/template literals)
 * while respecting JavaScript regex literals (`/pattern/flags`) so quotes or `//` inside
 * regexes never corrupt subsequent executable code.
 */
function scanAndStripSource(sourceText, { stripStrings = false } = {}) {
  const src = String(sourceText ?? '');
  const len = src.length;
  let out = '';
  let i = 0;
  let lastSignificantChar = '';

  const isRegexAllowedAfter = (ch) => {
    if (!ch) return true;
    return '=(,[!&|:?;+-*%^~<>{\n\r'.includes(ch);
  };

  while (i < len) {
    const ch = src[i];
    const next = i + 1 < len ? src[i + 1] : '';

    // 1. HTML comment <!-- ... -->
    if (ch === '<' && src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      if (end === -1) break;
      out += ' ';
      i = end + 3;
      continue;
    }

    // 2. Multi-line comment /* ... */
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) break;
      out += ' ';
      i = end + 2;
      continue;
    }

    // 3. Single-line comment // ...
    if (ch === '/' && next === '/') {
      const end = src.indexOf('\n', i + 2);
      if (end === -1) break;
      out += '\n';
      i = end + 1;
      lastSignificantChar = '\n';
      continue;
    }

    // 4. Python/shell line-start # comment
    if (ch === '#' && (i === 0 || src[i - 1] === '\n' || src[i - 1] === '\r')) {
      const end = src.indexOf('\n', i + 1);
      if (end === -1) break;
      out += '\n';
      i = end + 1;
      lastSignificantChar = '\n';
      continue;
    }

    // 5. Regex literal /.../flags when in regex position
    if (ch === '/' && next !== '/' && next !== '*' && isRegexAllowedAfter(lastSignificantChar)) {
      let j = i + 1;
      let inCharClass = false;
      let validRegex = false;
      while (j < len) {
        const c = src[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '[') inCharClass = true;
        else if (c === ']') inCharClass = false;
        else if (c === '/' && !inCharClass) {
          validRegex = true;
          j += 1;
          while (j < len && /[a-zA-Z]/.test(src[j])) j += 1;
          break;
        } else if ((c === '\n' || c === '\r') && !inCharClass) {
          break;
        }
        j += 1;
      }
      if (validRegex) {
        out += stripStrings ? ' / / ' : src.slice(i, j);
        i = j;
        lastSignificantChar = '/';
        continue;
      }
    }

    // 6. Single- or double-quoted string literal
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < len) {
        const c = src[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === quote || c === '\n' || c === '\r') {
          if (c === quote) j += 1;
          break;
        }
        j += 1;
      }
      out += stripStrings ? `${quote}${quote}` : src.slice(i, j);
      i = j;
      lastSignificantChar = quote;
      continue;
    }

    // 7. Template literal `...`
    if (ch === '`') {
      let j = i + 1;
      while (j < len) {
        const c = src[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '`') {
          j += 1;
          break;
        }
        j += 1;
      }
      out += stripStrings ? '""' : src.slice(i, j);
      i = j;
      lastSignificantChar = '`';
      continue;
    }

    out += ch;
    if (!/\s/.test(ch)) {
      lastSignificantChar = ch;
    }
    i += 1;
  }

  return out;
}

/**
 * Strips single-line (`//`, `#`) and multi-line (`/* ... *\/`, `<!-- ... -->`) comments
 * so comment-only mentions of a symbol cannot satisfy `consumerRefs` verification.
 */
export function stripCodeComments(sourceText) {
  return scanAndStripSource(sourceText, { stripStrings: false });
}

/**
 * Strips both comments and string literals (`'...'`, `"..."`, `` `...` ``) so symbols
 * that appear only inside comments or string literals cannot satisfy `consumerRefs` symbol checks.
 */
export function stripCommentsAndStringLiterals(sourceText) {
  return scanAndStripSource(sourceText, { stripStrings: true });
}

function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  const serialized = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(tmpPath, serialized, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

function readJsonSafe(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Resolves a candidate path against `workspaceRoot` using `fs.realpathSync` on the
 * deepest existing ancestor directory so symlinked parent directories cannot escape the root.
 */
export function resolveContainedRealPath(workspaceRoot, relOrAbsPath) {
  const wsReal = fs.existsSync(workspaceRoot)
    ? fs.realpathSync(workspaceRoot)
    : path.resolve(workspaceRoot);
  const rawStr = String(relOrAbsPath || '').trim();
  if (!rawStr) {
    throw new Error('Path must be non-empty.');
  }
  const absCandidate = path.resolve(wsReal, rawStr);

  // Walk up to find deepest existing ancestor (including dangling symlinks via lstatSync)
  let cur = absCandidate;
  const tailSegments = [];
  while (true) {
    let lstat = null;
    try {
      lstat = fs.lstatSync(cur);
    } catch {
      lstat = null;
    }
    if (lstat) {
      if (lstat.isSymbolicLink()) {
        try {
          cur = fs.realpathSync(cur);
        } catch {
          const linkTarget = fs.readlinkSync(cur);
          const resolvedLink = path.resolve(path.dirname(cur), linkTarget);
          cur = resolveContainedRealPath(wsReal, resolvedLink);
        }
      } else {
        try {
          cur = fs.realpathSync(cur);
        } catch {}
      }
      break;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tailSegments.unshift(path.basename(cur));
    cur = parent;
  }

  const realFull =
    tailSegments.length > 0 ? path.join(cur, ...tailSegments) : cur;

  const normRoot = process.platform === 'win32' ? wsReal.toLowerCase() : wsReal;
  const normTarget = process.platform === 'win32' ? realFull.toLowerCase() : realFull;

  if (normTarget !== normRoot && !normTarget.startsWith(normRoot + path.sep)) {
    const err = new Error(
      `Path containment violation: "${relOrAbsPath}" resolves to "${realFull}" outside workspace "${wsReal}".`
    );
    err.code = 'PATH_CONTAINMENT_VIOLATION';
    throw err;
  }

  return realFull;
}

export class ContextResilienceManager {
  constructor(workspaceRoot = process.cwd()) {
    this.workspaceRoot = fs.existsSync(workspaceRoot)
      ? fs.realpathSync(workspaceRoot)
      : path.resolve(workspaceRoot);
    this.tasksRoot = resolveContainedRealPath(this.workspaceRoot, path.join('.harness', 'tasks'));
    this._heldTaskLocks = new Set();
  }

  _resolveSafeTaskDir(taskId) {
    const cleanId = String(taskId || '').trim();
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(cleanId) || cleanId.includes('..')) {
      throw new Error(
        `Invalid taskId "${cleanId}": must be alphanumeric/kebab-case without traversal.`
      );
    }
    const candidate = path.join(this.tasksRoot, cleanId);
    return resolveContainedRealPath(this.workspaceRoot, candidate);
  }

  getTaskDir(taskId) {
    return this._resolveSafeTaskDir(taskId);
  }

  _resolveWorkspaceFile(relOrAbsPath) {
    return resolveContainedRealPath(this.workspaceRoot, relOrAbsPath);
  }

  /**
   * Acquires an exclusive per-task file lock (`.harness/tasks/<taskId>/.task.lock`)
   * around read-modify-write transactions. Fails closed if the lock cannot be acquired.
   */
  _withTaskLock(taskId, fn, timeoutMs = 5000) {
    const taskDir = this._resolveSafeTaskDir(taskId);
    const lockPath = path.join(taskDir, '.task.lock');
    if (this._heldTaskLocks.has(lockPath)) {
      return fn();
    }

    fs.mkdirSync(taskDir, { recursive: true });
    const deadline = Date.now() + Math.max(200, Number(timeoutMs || 5000));
    let fd = null;

    while (Date.now() <= deadline) {
      try {
        fd = fs.openSync(lockPath, 'wx', 0o600);
        fs.writeFileSync(
          fd,
          JSON.stringify({ pid: process.pid, taskId, acquiredAt: Date.now() }),
          'utf8'
        );
        break;
      } catch (err) {
        if (err?.code !== 'EEXIST') {
          throw err;
        }
        try {
          const stat = fs.statSync(lockPath);
          const raw = readJsonSafe(lockPath, null);
          const ageMs = Date.now() - stat.mtimeMs;
          const holderAlive = raw?.pid ? isPidAlive(raw.pid) : ageMs < 2000;
          if (!holderAlive && ageMs > 1500) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {}
        sleepSync(15 + Math.floor(Math.random() * 20));
      }
    }

    if (fd === null) {
      const err = new Error(`Failed to acquire task lock for "${taskId}" within ${timeoutMs}ms.`);
      err.code = 'TASK_LOCK_TIMEOUT';
      throw err;
    }

    this._heldTaskLocks.add(lockPath);
    try {
      return fn();
    } finally {
      this._heldTaskLocks.delete(lockPath);
      try {
        fs.closeSync(fd);
      } catch {}
      try {
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
      } catch {}
    }
  }

  getFileDigest(relOrAbsPath) {
    try {
      const full = this._resolveWorkspaceFile(relOrAbsPath);
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
      return sha256Text(fs.readFileSync(full, 'utf8'));
    } catch {
      return null;
    }
  }

  getGitCommit() {
    try {
      const res = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: this.workspaceRoot,
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true,
      });
      if (res.status === 0 && res.stdout) return res.stdout.trim();
    } catch {}
    return 'unavailable';
  }

  // =========================================================================
  // 1. REQUIREMENT LEDGER (CTX-03, CTX-06, CTX-07)
  // =========================================================================
  getLedgerPath(taskId) {
    return resolveContainedRealPath(
      this.workspaceRoot,
      path.join(this._resolveSafeTaskDir(taskId), 'requirements.json')
    );
  }

  createAuthenticatedVerdict(options = {}) {
    const engine = new HarnessKnowledgeEngine(this.workspaceRoot);
    return engine.createSignedVerdict(options);
  }

  writeAuthenticatedVerdict(targetPath, options = {}) {
    const absPath = resolveContainedRealPath(this.workspaceRoot, path.resolve(this.workspaceRoot, String(targetPath)));
    const signed = this.createAuthenticatedVerdict(options);
    writeJsonAtomic(absPath, signed);
    return signed;
  }

  _revalidateVerifiedRequirements(taskId, ledger, driftedFiles = new Set(), driftedSymbols = new Set(), issues = []) {
    if (!ledger || !Array.isArray(ledger.requirements)) {
      return { mutated: false, invalidatedRequirements: [] };
    }
    let mutated = false;
    const invalidatedRequirements = [];

    for (const req of ledger.requirements) {
      if (!req || req.state !== 'verified') continue;
      const reasons = [];
      const cRefs = (req.consumerRefs || []).map((r) => this._parseConsumerRef(r));

      for (const r of cRefs) {
        if (!r.file) continue;
        if (driftedFiles.has(r.file) || (r.symbol && driftedSymbols.has(r.symbol))) {
          reasons.push(`contract_drift:${r.file}${r.symbol ? `#${r.symbol}` : ''}`);
          continue;
        }
        const currentDigest = this.getFileDigest(r.file);
        if (!currentDigest) {
          reasons.push(`missing_consumer_file:${r.file}`);
          continue;
        }
        if (
          req.verifiedConsumerDigests &&
          req.verifiedConsumerDigests[r.file] &&
          currentDigest !== req.verifiedConsumerDigests[r.file]
        ) {
          reasons.push(`consumer_file_modified:${r.file}`);
          continue;
        }
        if (r.symbol) {
          try {
            const full = this._resolveWorkspaceFile(r.file);
            const rawContent = fs.readFileSync(full, 'utf8');
            const codeOnly = stripCommentsAndStringLiterals(rawContent);
            if (!codeOnly.includes(r.symbol)) {
              reasons.push(`missing_consumer_symbol:${r.file}#${r.symbol}`);
            }
          } catch {
            reasons.push(`unreadable_consumer_file:${r.file}`);
          }
        }
      }

      for (const evRef of req.evidenceRefs || []) {
        const refKey =
          typeof evRef === 'string'
            ? evRef.trim()
            : String(evRef?.file || evRef?.receiptId || '').trim();
        const evCheck = this._inspectEvidenceRef(evRef, {
          expectedTaskId: taskId,
          expectedReqId: req.id,
          expectedRequirementRevision: req.requirementRevision ?? null,
          requiredAcceptanceChecks: req.acceptanceChecks,
        });
        if (!evCheck.exists || !evCheck.validVerdict) {
          reasons.push(`invalid_or_missing_evidence:${refKey}`);
          continue;
        }
        if (
          req.verifiedEvidenceDigests &&
          req.verifiedEvidenceDigests[refKey] &&
          evCheck.digest &&
          evCheck.digest !== req.verifiedEvidenceDigests[refKey]
        ) {
          reasons.push(`evidence_modified:${refKey}`);
        }
      }

      if (
        reasons.length === 0 &&
        issues.some((i) => i.code.startsWith('CTX-02_') || i.code.startsWith('CTX-05_')) &&
        cRefs.some(
          (r) =>
            driftedFiles.has(r.file) || (r.symbol && driftedSymbols.has(r.symbol))
        )
      ) {
        reasons.push(issues.map((i) => `${i.code}:${i.contractId}`).join(', '));
      }

      if (reasons.length > 0) {
        req.state = 'implemented_unverified';
        req.invalidatedByContractDrift = true;
        req.invalidatedReason = reasons.join(', ');
        req.demotionReason = reasons.join(', ');
        invalidatedRequirements.push(req.id);
        mutated = true;
      }
    }

    return { mutated, invalidatedRequirements };
  }

  loadRequirementLedger(taskId, { skipRevalidate = false } = {}) {
    const file = this.getLedgerPath(taskId);
    const existing = readJsonSafe(file, null);
    if (existing) {
      if (!skipRevalidate) {
        const reval = this._revalidateVerifiedRequirements(taskId, existing);
        if (reval.mutated) {
          existing.revision = (existing.revision || 0) + 1;
          existing.updatedAt = new Date().toISOString();
          writeJsonAtomic(file, existing);
        }
      }
      return existing;
    }
    return {
      schemaVersion: 1,
      taskId,
      revision: 0,
      objective: '',
      userCorrections: [],
      requirements: [],
      updatedAt: null,
    };
  }

  _parseConsumerRef(cRef) {
    if (typeof cRef === 'string') {
      const hashIdx = cRef.indexOf('#');
      if (hashIdx >= 0) {
        return {
          file: cRef.slice(0, hashIdx).trim(),
          symbol: cRef.slice(hashIdx + 1).trim(),
        };
      }
      return { file: cRef.trim(), symbol: null };
    }
    if (cRef && typeof cRef === 'object') {
      return {
        file: String(cRef.file || '').trim(),
        symbol: cRef.symbol ? String(cRef.symbol).trim() : null,
      };
    }
    return { file: '', symbol: null };
  }

  _inspectEvidenceRef(
    evRef,
    {
      expectedTaskId = null,
      expectedReqId = null,
      expectedRequirementRevision = null,
      requiredAcceptanceChecks = null,
    } = {}
  ) {
    const refStr =
      typeof evRef === 'string'
        ? evRef.trim()
        : String(evRef?.file || evRef?.receiptId || '').trim();
    if (!refStr) {
      return { exists: false, validVerdict: false, digest: null, reason: 'Empty evidence reference' };
    }
    const engine = new HarnessKnowledgeEngine(this.workspaceRoot);

    if (/^RCPT-[A-Z0-9_-]+$/i.test(refStr)) {
      const receiptPath = this._resolveWorkspaceFile(
        path.join('.harness', 'receipts', `${refStr}.json`)
      );
      if (!fs.existsSync(receiptPath) || !fs.statSync(receiptPath).isFile()) {
        return {
          exists: false,
          validVerdict: false,
          digest: null,
          reason: 'Receipt file does not exist on disk',
        };
      }
      const rawText = fs.readFileSync(receiptPath, 'utf8');
      const rcptCheck = engine.verifyEvaluationReceipt(refStr, {
        expectedTaskId,
        expectedReqId,
        expectedRequirementRevision,
        requiredAcceptanceChecks,
        mode: 'current_workspace',
      });
      return {
        exists: true,
        validVerdict: rcptCheck.valid === true,
        digest: sha256Text(rawText),
        reason: rcptCheck.valid
          ? 'Valid cryptographic evaluation receipt'
          : `Receipt failed cryptographic verification (${rcptCheck.error || 'INVALID_RECEIPT'})`,
      };
    }

    const cleanFile = refStr.split('#')[0].trim();
    const full = this._resolveWorkspaceFile(cleanFile);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile() || fs.statSync(full).size === 0) {
      return {
        exists: false,
        validVerdict: false,
        digest: null,
        reason: 'Evidence file does not exist on disk',
      };
    }
    if (!cleanFile.toLowerCase().endsWith('.json')) {
      return {
        exists: true,
        validVerdict: false,
        digest: null,
        reason:
          'Evidence reference must be a passing evaluation receipt (RCPT-*) or HMAC-authenticated JSON verification verdict (.json), not a source or prose file',
      };
    }
    const rawText = fs.readFileSync(full, 'utf8');
    const fileDigest = sha256Text(rawText);
    const parsed = readJsonSafe(full, null);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        exists: true,
        validVerdict: false,
        digest: fileDigest,
        reason: 'Evidence JSON is malformed or not an object',
      };
    }

    // If the JSON file is a stored evaluation receipt, verify its receipt HMAC & artifacts
    if (typeof parsed.receiptId === 'string' && /^RCPT-[A-Z0-9_-]+$/i.test(parsed.receiptId)) {
      const rcptCheck = engine.verifyEvaluationReceipt(parsed.receiptId, {
        expectedTaskId,
        expectedReqId,
        expectedRequirementRevision,
        requiredAcceptanceChecks,
        mode: 'current_workspace',
      });
      return {
        exists: true,
        validVerdict: rcptCheck.valid === true,
        digest: fileDigest,
        reason: rcptCheck.valid
          ? 'Valid evaluation receipt file'
          : `Receipt file failed cryptographic verification (${rcptCheck.error || 'INVALID_RECEIPT'})`,
      };
    }

    // Otherwise require an HMAC-authenticated verifier verdict (reject unsigned caller-authored JSON)
    const vCheck = engine.verifySignedVerdict(parsed, {
      expectedTaskId,
      expectedReqId,
      expectedRequirementRevision,
      requiredAcceptanceChecks,
    });
    return {
      exists: true,
      validVerdict: vCheck.valid === true,
      digest: fileDigest,
      reason: vCheck.valid
        ? 'Valid HMAC-authenticated JSON verification verdict'
        : `Evidence JSON is not an authenticated passing verification verdict (${vCheck.error || 'UNSIGNED_VERDICT_EVIDENCE'})`,
    };
  }

  _verifyEvidenceRefExists(evRef, expectedOpts = {}) {
    const check = this._inspectEvidenceRef(evRef, expectedOpts);
    return check.exists && check.validVerdict;
  }

  upsertRequirementLedger(taskId, { objective, userCorrection, requirements = [] } = {}) {
    return this._withTaskLock(taskId, () => {
      const ledger = this.loadRequirementLedger(taskId, { skipRevalidate: true });
      if (objective !== undefined) ledger.objective = String(objective);
      if (userCorrection) {
        ledger.userCorrections = ledger.userCorrections || [];
        ledger.userCorrections.push({
          correction: String(userCorrection),
          recordedAt: new Date().toISOString(),
          revision: ledger.revision + 1,
        });
      }

      const reqMap = new Map((ledger.requirements || []).map((r) => [r.id, r]));
      for (const req of requirements) {
        if (!req || !req.id) continue;
        const prev = reqMap.get(req.id) || {
          id: req.id,
          behavior: '',
          state: 'planned',
          implementationRefs: [],
          consumerRefs: [],
          acceptanceChecks: [],
          evidenceRefs: [],
          requiresProviderCredentials: false,
          providerCredentialAvailable: true,
          blockedBy: null,
        };
        const merged = {
          ...prev,
          ...req,
        };

        const targetState = merged.state || 'planned';
        if (!VALID_REQUIREMENT_STATES.has(targetState)) {
          throw new Error(`Invalid requirement state "${targetState}" for ${req.id}`);
        }

        // CTX-07: Missing required provider credentials cannot become verified/succeeded
        if (merged.requiresProviderCredentials && merged.providerCredentialAvailable === false) {
          if (targetState === 'verified') {
            throw new Error(
              `CTX-07 violation for ${req.id}: required provider credentials are unavailable; state must be blocked or implemented_unverified, never verified.`
            );
          }
        }

        // CTX-06: A UI control or producer with no backend consumer or missing/nonexistent evidence cannot become verified
        if (targetState === 'verified') {
          if (!Array.isArray(merged.acceptanceChecks) || merged.acceptanceChecks.length === 0) {
            throw new Error(
              `Requirement ${req.id} cannot transition to "verified" without acceptanceChecks.`
            );
          }
          if (!Array.isArray(merged.evidenceRefs) || merged.evidenceRefs.length === 0) {
            throw new Error(
              `Requirement ${req.id} cannot transition to "verified" without observed evidenceRefs.`
            );
          }
          const evidenceDigests = {};
          for (const evRef of merged.evidenceRefs) {
            const evCheck = this._inspectEvidenceRef(evRef, {
              expectedTaskId: taskId,
              expectedReqId: req.id,
              expectedRequirementRevision: merged.requirementRevision ?? null,
              requiredAcceptanceChecks: merged.acceptanceChecks,
            });
            const evLabel =
              typeof evRef === 'string'
                ? evRef.trim()
                : String(evRef?.file || evRef?.receiptId || JSON.stringify(evRef)).trim();
            if (!evCheck.exists) {
              throw new Error(
                `CTX-06 violation for ${req.id}: evidence reference "${evLabel}" does not exist on disk.`
              );
            }
            if (!evCheck.validVerdict) {
              throw new Error(
                `CTX-06 violation for ${req.id}: evidence reference "${evLabel}" is not a valid passing verification verdict (${evCheck.reason}).`
              );
            }
            if (evCheck.digest) {
              evidenceDigests[evLabel] = evCheck.digest;
            }
          }
          if (
            Array.isArray(merged.consumerRefs) &&
            merged.consumerRefs.length === 0 &&
            merged.requiresConsumer !== false
          ) {
            throw new Error(
              `CTX-06 violation for ${req.id}: consumerRefs is empty (unwired control/interface has no runtime consumer).`
            );
          }
          const consumerDigests = {};
          for (const cRef of merged.consumerRefs || []) {
            const parsedRef = this._parseConsumerRef(cRef);
            if (!parsedRef.file) {
              throw new Error(`CTX-06 violation for ${req.id}: consumer reference is missing file path.`);
            }
            const full = this._resolveWorkspaceFile(parsedRef.file);
            if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
              throw new Error(
                `CTX-06 violation for ${req.id}: consumer file "${parsedRef.file}" does not exist.`
              );
            }
            const rawContent = fs.readFileSync(full, 'utf8');
            if (parsedRef.symbol) {
              const codeWithoutCommentsAndStrings = stripCommentsAndStringLiterals(rawContent);
              if (!codeWithoutCommentsAndStrings.includes(parsedRef.symbol)) {
                throw new Error(
                  `CTX-06 violation for ${req.id}: consumer file "${parsedRef.file}" does not reference symbol "${parsedRef.symbol}" in executable code (comments and string literals excluded).`
                );
              }
            }
            consumerDigests[parsedRef.file] = sha256Text(rawContent);
          }
          merged.verifiedConsumerDigests = consumerDigests;
          merged.verifiedEvidenceDigests = evidenceDigests;
          merged.invalidatedByContractDrift = false;
          merged.invalidatedReason = null;
        }

        reqMap.set(req.id, merged);
      }

      ledger.requirements = Array.from(reqMap.values());
      ledger.revision += 1;
      ledger.updatedAt = new Date().toISOString();
      writeJsonAtomic(this.getLedgerPath(taskId), ledger);
      return ledger;
    });
  }

  // =========================================================================
  // 2. EXACT CONTRACT REGISTRY (CTX-01, CTX-02, CTX-05)
  // =========================================================================
  getContractsPath(taskId) {
    return resolveContainedRealPath(
      this.workspaceRoot,
      path.join(this._resolveSafeTaskDir(taskId), 'contracts.json')
    );
  }

  loadContractRegistry(taskId) {
    const file = this.getContractsPath(taskId);
    return (
      readJsonSafe(file, null) || {
        schemaVersion: 1,
        taskId,
        revision: 0,
        contracts: [],
        updatedAt: null,
      }
    );
  }

  registerContract(
    taskId,
    {
      contractId,
      symbolName,
      storageKey,
      unit,
      consumerUnit,
      producerFile,
      consumerFile,
      numericRange = null,
      nullable = false,
      defaultValue = null,
    } = {}
  ) {
    return this._withTaskLock(taskId, () => {
      if (!contractId || !symbolName) {
        throw new Error('contractId and symbolName are required');
      }
      // CTX-01: Catch unit mismatches across producer and consumer before completion
      if (unit && consumerUnit && String(unit).trim() !== String(consumerUnit).trim()) {
        throw new Error(
          `CTX-01 Unit mismatch for contract "${contractId}" (${symbolName}): producer uses "${unit}" but consumer expects "${consumerUnit}".`
        );
      }

      const reg = this.loadContractRegistry(taskId);
      const producerDigest = producerFile ? this.getFileDigest(producerFile) : null;
      const consumerDigest = consumerFile ? this.getFileDigest(consumerFile) : null;

      const entry = {
        contractId,
        symbolName,
        storageKey: storageKey || symbolName,
        unit: unit || 'unitless',
        consumerUnit: consumerUnit || unit || 'unitless',
        producerFile: producerFile || null,
        producerDigest,
        consumerFile: consumerFile || null,
        consumerDigest,
        numericRange,
        nullable: Boolean(nullable),
        defaultValue,
        status: 'valid',
        updatedAt: new Date().toISOString(),
      };

      const existingIdx = reg.contracts.findIndex((c) => c.contractId === contractId);
      if (existingIdx >= 0) {
        reg.contracts[existingIdx] = entry;
      } else {
        reg.contracts.push(entry);
      }
      reg.revision += 1;
      reg.updatedAt = new Date().toISOString();
      writeJsonAtomic(this.getContractsPath(taskId), reg);
      return entry;
    });
  }

  /**
   * CTX-02 & CTX-05: Validates all registered contracts against current on-disk files.
   * Marks any contract whose producer or consumer file digest changed or is missing as `stale_invalidated`,
   * verifies exact storageKey / symbolName presence in non-comment code, AND unconditionally
   * revalidates (`implemented_unverified`) any verified requirements affected by consumer or evidence drift.
   */
  validateContracts(taskId) {
    return this._withTaskLock(taskId, () => {
      const reg = this.loadContractRegistry(taskId);
      const issues = [];
      let mutated = false;
      const driftedFiles = new Set();
      const driftedSymbols = new Set();

      for (const c of reg.contracts) {
        const prevStatus = c.status;
        let contractValid = true;
        if (c.producerFile) {
          const fullProd = this._resolveWorkspaceFile(c.producerFile);
          if (!fs.existsSync(fullProd) || !fs.statSync(fullProd).isFile()) {
            c.status = 'stale_invalidated';
            contractValid = false;
            driftedFiles.add(c.producerFile);
            driftedSymbols.add(c.symbolName);
            issues.push({
              code: 'CTX-05_MISSING_PRODUCER_FILE',
              contractId: c.contractId,
              file: c.producerFile,
              message: `Producer file "${c.producerFile}" for contract "${c.contractId}" does not exist on disk.`,
            });
          } else {
            const currentProducerDigest = this.getFileDigest(c.producerFile);
            if (c.producerDigest && currentProducerDigest !== c.producerDigest) {
              c.status = 'stale_invalidated';
              contractValid = false;
              driftedFiles.add(c.producerFile);
              driftedSymbols.add(c.symbolName);
              issues.push({
                code: 'CTX-05_STALE_PRODUCER',
                contractId: c.contractId,
                file: c.producerFile,
                message: `Producer file "${c.producerFile}" changed since contract "${c.contractId}" was recorded; re-read declaration.`,
              });
            }
            if (c.storageKey) {
              const text = stripCodeComments(fs.readFileSync(fullProd, 'utf8'));
              if (!text.includes(c.storageKey)) {
                c.status = 'key_drift_invalidated';
                contractValid = false;
                driftedFiles.add(c.producerFile);
                driftedSymbols.add(c.symbolName);
                issues.push({
                  code: 'CTX-02_KEY_DRIFT_PRODUCER',
                  contractId: c.contractId,
                  storageKey: c.storageKey,
                  file: c.producerFile,
                  message: `Exact storage key "${c.storageKey}" missing in producer "${c.producerFile}".`,
                });
              }
            }
          }
        }

        if (c.consumerFile) {
          const fullCons = this._resolveWorkspaceFile(c.consumerFile);
          if (!fs.existsSync(fullCons) || !fs.statSync(fullCons).isFile()) {
            c.status = 'stale_invalidated';
            contractValid = false;
            driftedFiles.add(c.consumerFile);
            driftedSymbols.add(c.symbolName);
            issues.push({
              code: 'CTX-05_MISSING_CONSUMER_FILE',
              contractId: c.contractId,
              file: c.consumerFile,
              message: `Consumer file "${c.consumerFile}" for contract "${c.contractId}" does not exist on disk.`,
            });
          } else {
            const currentConsumerDigest = this.getFileDigest(c.consumerFile);
            if (c.consumerDigest && currentConsumerDigest !== c.consumerDigest) {
              c.status = 'stale_invalidated';
              contractValid = false;
              driftedFiles.add(c.consumerFile);
              driftedSymbols.add(c.symbolName);
              issues.push({
                code: 'CTX-05_STALE_CONSUMER',
                contractId: c.contractId,
                file: c.consumerFile,
                message: `Consumer file "${c.consumerFile}" changed since contract "${c.contractId}" was recorded; re-read declaration.`,
              });
            }
            if (c.storageKey) {
              const text = stripCodeComments(fs.readFileSync(fullCons, 'utf8'));
              if (!text.includes(c.storageKey)) {
                c.status = 'key_drift_invalidated';
                contractValid = false;
                driftedFiles.add(c.consumerFile);
                driftedSymbols.add(c.symbolName);
                issues.push({
                  code: 'CTX-02_KEY_DRIFT_CONSUMER',
                  contractId: c.contractId,
                  storageKey: c.storageKey,
                  file: c.consumerFile,
                  message: `Exact storage key "${c.storageKey}" missing in consumer "${c.consumerFile}".`,
                });
              }
            }
          }
        }

        if (contractValid && c.status !== 'valid') {
          c.status = 'valid';
        }
        if (c.status !== prevStatus) {
          mutated = true;
        }
      }

      if (mutated) {
        reg.revision += 1;
        reg.updatedAt = new Date().toISOString();
        writeJsonAtomic(this.getContractsPath(taskId), reg);
      }

      // Unconditionally revalidate all verified requirements in the ledger (even when reg.contracts is empty!)
      let invalidatedRequirements = [];
      const ledgerPath = this.getLedgerPath(taskId);
      const ledger = readJsonSafe(ledgerPath, null);
      if (ledger && Array.isArray(ledger.requirements)) {
        const reval = this._revalidateVerifiedRequirements(
          taskId,
          ledger,
          driftedFiles,
          driftedSymbols,
          issues
        );
        invalidatedRequirements = reval.invalidatedRequirements;
        if (reval.mutated) {
          ledger.revision = (ledger.revision || 0) + 1;
          ledger.updatedAt = new Date().toISOString();
          writeJsonAtomic(ledgerPath, ledger);
        }
        for (const req of ledger.requirements) {
          if (req.invalidatedByContractDrift) {
            if (!invalidatedRequirements.includes(req.id)) {
              invalidatedRequirements.push(req.id);
            }
            if (
              !issues.some(
                (i) =>
                  i.code === 'CTX-05_VERIFIED_REQUIREMENT_REGRESSED' && i.requirementId === req.id
              )
            ) {
              issues.push({
                code: 'CTX-05_VERIFIED_REQUIREMENT_REGRESSED',
                type: 'CTX-05_VERIFIED_REQUIREMENT_REGRESSED',
                requirementId: req.id,
                message: req.invalidatedReason || 'Verified requirement invalidated by evidence or consumer drift.',
              });
            }
          }
        }
      }

      for (const issue of issues) {
        if (!issue.type) issue.type = issue.code;
      }

      return {
        ok: issues.length === 0 && invalidatedRequirements.length === 0,
        taskId,
        contractsCount: reg.contracts.length,
        issues,
        mismatches: issues,
        invalidatedRequirements,
        contracts: reg.contracts,
      };
    });
  }

  // =========================================================================
  // 3. ATOMIC RESUMABLE CHECKPOINTS, CONTROLLER-OWNED SESSIONS & SUBAGENT RECOVERY (CTX-04, CTX-09, CTX-10)
  // =========================================================================
  getExecutorSessionsPath(taskId) {
    return resolveContainedRealPath(
      this.workspaceRoot,
      path.join(this._resolveSafeTaskDir(taskId), 'executor-sessions.json')
    );
  }

  loadExecutorSessions(taskId) {
    const file = this.getExecutorSessionsPath(taskId);
    return (
      readJsonSafe(file, null) || {
        schemaVersion: 1,
        taskId,
        sessions: {},
        updatedAt: null,
      }
    );
  }

  /**
   * WP7 / F07: Registers a controller-owned executor session for a worker (`subagent | sdk | cli | mcp | local_process`).
   * Only sessions registered in `executor-sessions.json` can receive or acknowledge recovery packets.
   */
  registerExecutorSession(taskId, workerIdOrOptions = {}, maybeOptions = {}) {
    return this._withTaskLock(taskId, () => {
      const opts =
        typeof workerIdOrOptions === 'string'
          ? { ...(maybeOptions || {}), workerId: workerIdOrOptions }
          : workerIdOrOptions || {};
      const {
        workerId,
        executorSessionId,
        executor_session_id,
        transport = 'subagent',
        pid = null,
        conversationId = null,
        metadata = {},
      } = opts;
      const cleanWorkerId = String(workerId || '').trim();
      const cleanSessionId = String(executorSessionId ?? executor_session_id ?? '').trim();
      if (!cleanWorkerId || !cleanSessionId) {
        return {
          ok: false,
          error: 'WORKER_ID_AND_EXECUTOR_SESSION_ID_REQUIRED',
        };
      }
      const allowedTransports = new Set([
        'subagent',
        'sdk',
        'cli',
        'mcp',
        'local_process',
        'in_process',
      ]);
      const cleanTransport = String(transport || 'subagent').toLowerCase();
      if (!allowedTransports.has(cleanTransport)) {
        return {
          ok: false,
          error: 'UNSUPPORTED_SESSION_TRANSPORT',
          transport: cleanTransport,
        };
      }
      const state = this.loadExecutorSessions(taskId);
      state.sessions = state.sessions || {};
      const existing = state.sessions[cleanSessionId];
      const nowIso = new Date().toISOString();
      state.sessions[cleanSessionId] = {
        sessionId: cleanSessionId,
        executorSessionId: cleanSessionId,
        workerId: cleanWorkerId,
        taskId,
        transport: cleanTransport,
        pid: pid ?? existing?.pid ?? null,
        conversationId: conversationId ?? existing?.conversationId ?? null,
        metadata: { ...(existing?.metadata || {}), ...(metadata || {}) },
        status: 'ACTIVE',
        registeredAt: existing?.registeredAt || nowIso,
        updatedAt: nowIso,
        deliveredPackets: existing?.deliveredPackets || {},
        acknowledgedPackets: existing?.acknowledgedPackets || {},
        cancelRequestedAt: null,
        stoppedAt: null,
      };
      state.updatedAt = nowIso;
      writeJsonAtomic(this.getExecutorSessionsPath(taskId), state);
      return {
        ok: true,
        taskId,
        workerId: cleanWorkerId,
        executorSessionId: cleanSessionId,
        transport: cleanTransport,
        status: 'ACTIVE',
        registeredAt: state.sessions[cleanSessionId].registeredAt,
      };
    });
  }

  /**
   * WP7 / F07: Records controller-verified transport delivery of a recovery packet to a registered executor session.
   */
  deliverRecoveryPacket(
    taskId,
    workerId,
    {
      executorSessionId,
      executor_session_id,
      recoveryToken,
      recovery_token,
      packetDigest,
      packet_digest,
      checkpointRevision,
      checkpoint_revision,
      ledgerRevision,
      ledger_revision,
      contractRevision,
      contract_revision,
      deliveredVia = 'controller_transport',
    } = {}
  ) {
    return this._withTaskLock(taskId, () => {
      const cleanWorkerId = String(workerId || '').trim();
      const acksFile = resolveContainedRealPath(
        this.workspaceRoot,
        path.join(this._resolveSafeTaskDir(taskId), 'recovery-acks.json')
      );
      const acksState = readJsonSafe(acksFile, { taskId, workers: {} });
      const entry = acksState.workers?.[cleanWorkerId];
      if (!entry) {
        return {
          ok: false,
          delivered: false,
          error: 'NO_PENDING_RECOVERY_PACKET',
        };
      }
      const cleanSessionId = String(
        executorSessionId ?? executor_session_id ?? entry.executorSessionId ?? ''
      ).trim();
      if (!cleanSessionId) {
        return {
          ok: false,
          delivered: false,
          error: 'EXECUTOR_SESSION_ID_REQUIRED',
        };
      }
      if (entry.executorSessionId && entry.executorSessionId !== cleanSessionId) {
        return {
          ok: false,
          delivered: false,
          error: 'EXECUTOR_SESSION_ID_MISMATCH',
        };
      }

      const sessionsState = this.loadExecutorSessions(taskId);
      const regSession = sessionsState.sessions?.[cleanSessionId];
      if (!regSession || regSession.workerId !== cleanWorkerId) {
        return {
          ok: false,
          delivered: false,
          status: 'RECOVERY_PENDING',
          error: 'NO_REGISTERED_EXECUTOR_SESSION',
        };
      }
      if (
        regSession.status === 'CANCELLED' ||
        regSession.status === 'STOPPED' ||
        regSession.status === 'CANCEL_REQUESTED'
      ) {
        return {
          ok: false,
          delivered: false,
          status: regSession.status,
          error: 'EXECUTOR_SESSION_NOT_ACTIVE',
        };
      }

      const suppliedTok = String(
        recoveryToken ?? recovery_token ?? entry.recoveryToken ?? ''
      ).trim();
      if (suppliedTok !== entry.recoveryToken) {
        return {
          ok: false,
          delivered: false,
          error: 'RECOVERY_TOKEN_MISMATCH',
        };
      }
      const suppliedDigest = packetDigest ?? packet_digest;
      if (suppliedDigest && String(suppliedDigest) !== String(entry.packetDigest)) {
        return {
          ok: false,
          delivered: false,
          error: 'PACKET_DIGEST_MISMATCH',
        };
      }

      const nowIso = new Date().toISOString();
      regSession.deliveredPackets = regSession.deliveredPackets || {};
      regSession.deliveredPackets[entry.recoveryToken] = {
        recoveryToken: entry.recoveryToken,
        packetDigest: entry.packetDigest,
        checkpointRevision: checkpointRevision ?? checkpoint_revision ?? entry.checkpointRevision,
        ledgerRevision: ledgerRevision ?? ledger_revision ?? entry.ledgerRevision,
        contractRevision: contractRevision ?? contract_revision ?? entry.contractRevision ?? 0,
        deliveredVia: String(deliveredVia || 'controller_transport'),
        deliveredAt: nowIso,
      };
      regSession.updatedAt = nowIso;
      sessionsState.updatedAt = nowIso;
      writeJsonAtomic(this.getExecutorSessionsPath(taskId), sessionsState);

      entry.executorSessionId = cleanSessionId;
      entry.delivered = true;
      entry.deliveredAt = nowIso;
      entry.deliveredVia = String(deliveredVia || 'controller_transport');
      entry.status = 'packet_delivered';
      writeJsonAtomic(acksFile, acksState);

      return {
        ok: true,
        delivered: true,
        status: 'PACKET_DELIVERED',
        taskId,
        workerId: cleanWorkerId,
        executorSessionId: cleanSessionId,
        recoveryToken: entry.recoveryToken,
        packetDigest: entry.packetDigest,
        deliveredAt: nowIso,
      };
    });
  }

  /**
   * WP7 / F07: Requests cancellation of a registered executor session.
   * Rejects nonexistent/unregistered sessions (`UNKNOWN_EXECUTOR_SESSION`) and transitions to
   * `CANCEL_REQUESTED` until actual termination is observed via `observeSessionStopped`.
   */
  requestSessionCancel(
    taskId,
    { workerId = null, executorSessionId = null, executor_session_id = null, reason = 'user_requested' } = {}
  ) {
    return this._withTaskLock(taskId, () => {
      const sessionsState = this.loadExecutorSessions(taskId);
      const cleanSessionId = String(executorSessionId ?? executor_session_id ?? '').trim();
      const cleanWorkerId = String(workerId ?? '').trim();
      let target = cleanSessionId ? sessionsState.sessions?.[cleanSessionId] : null;
      if (!target && cleanWorkerId) {
        target = Object.values(sessionsState.sessions || {}).find(
          (s) => s && s.workerId === cleanWorkerId
        );
      }
      if (!target) {
        return {
          ok: false,
          error: 'UNKNOWN_EXECUTOR_SESSION',
          status: 'UNKNOWN',
        };
      }
      const nowIso = new Date().toISOString();
      if (target.status !== 'CANCELLED' && target.status !== 'STOPPED') {
        target.status = 'CANCEL_REQUESTED';
        target.cancelRequestedAt = nowIso;
        target.cancelReason = String(reason || 'user_requested');
        target.updatedAt = nowIso;
        sessionsState.updatedAt = nowIso;
        writeJsonAtomic(this.getExecutorSessionsPath(taskId), sessionsState);
      }
      return {
        ok: true,
        taskId,
        workerId: target.workerId,
        executorSessionId: target.sessionId,
        status: target.status,
        cancelRequestedAt: target.cancelRequestedAt,
      };
    });
  }

  /**
   * WP7 / F07: Records observed termination of a registered executor session, transitioning
   * `CANCEL_REQUESTED` -> `CANCELLED` (or `ACTIVE` -> `STOPPED`).
   */
  observeSessionStopped(
    taskId,
    { workerId = null, executorSessionId = null, executor_session_id = null, exitCode = null, signal = null } = {}
  ) {
    return this._withTaskLock(taskId, () => {
      const sessionsState = this.loadExecutorSessions(taskId);
      const cleanSessionId = String(executorSessionId ?? executor_session_id ?? '').trim();
      const cleanWorkerId = String(workerId ?? '').trim();
      let target = cleanSessionId ? sessionsState.sessions?.[cleanSessionId] : null;
      if (!target && cleanWorkerId) {
        target = Object.values(sessionsState.sessions || {}).find(
          (s) => s && s.workerId === cleanWorkerId
        );
      }
      if (!target) {
        return {
          ok: false,
          error: 'UNKNOWN_EXECUTOR_SESSION',
        };
      }
      const nowIso = new Date().toISOString();
      target.status = target.status === 'CANCEL_REQUESTED' ? 'CANCELLED' : 'STOPPED';
      target.stoppedAt = nowIso;
      target.exitCode = exitCode;
      target.signal = signal;
      target.updatedAt = nowIso;
      sessionsState.updatedAt = nowIso;
      writeJsonAtomic(this.getExecutorSessionsPath(taskId), sessionsState);
      return {
        ok: true,
        taskId,
        workerId: target.workerId,
        executorSessionId: target.sessionId,
        status: target.status,
        stoppedAt: nowIso,
      };
    });
  }

  _allocateNextCheckpointRevision(checkpointsDir, prevCurrent) {
    let maxRev = Number(prevCurrent?.checkpointRevision || 0);
    if (fs.existsSync(checkpointsDir)) {
      for (const entry of fs.readdirSync(checkpointsDir)) {
        const m = entry.match(/^rev-(\d+)\.json$/);
        if (m) {
          const revNum = Number(m[1]);
          if (Number.isInteger(revNum) && revNum > maxRev) {
            maxRev = revNum;
          }
        }
      }
    }
    return maxRev + 1;
  }

  _computeContractDigest(contractReg) {
    const normalized = (contractReg?.contracts || []).map((c) => {
      if (!c || typeof c !== 'object') return c;
      const { lastValidatedAt, ...rest } = c;
      return rest;
    });
    return sha256Text(JSON.stringify(normalized));
  }

  writeCheckpoint(
    taskId,
    {
      activeWorkers = [],
      pendingMessages = [],
      knownFailures = [],
      nextAction = '',
      contextMetrics = null,
      simulateCrashBeforePointerSwap = false,
    } = {}
  ) {
    return this._withTaskLock(taskId, () => {
      const taskDir = this._resolveSafeTaskDir(taskId);
      const checkpointsDir = resolveContainedRealPath(
        this.workspaceRoot,
        path.join(taskDir, 'checkpoints')
      );
      fs.mkdirSync(checkpointsDir, { recursive: true });

      const currentPointerPath = resolveContainedRealPath(
        this.workspaceRoot,
        path.join(checkpointsDir, 'current.json')
      );
      const prevCurrent = readJsonSafe(currentPointerPath, null);
      const nextRev = this._allocateNextCheckpointRevision(checkpointsDir, prevCurrent);

      // Validate contracts FIRST so any drift demotes affected verified requirements before reading ledger
      const contractCheck = this.validateContracts(taskId);
      const contractReg = this.loadContractRegistry(taskId);
      const contractRevision = Number(contractReg.revision || 0);
      const contractDigest = this._computeContractDigest(contractReg);
      const ledger = this.loadRequirementLedger(taskId);

      const openRequirements = (ledger.requirements || [])
        .filter((r) => r.state !== 'verified')
        .map((r) => r.id);
      const completedEvidenceRefs = (ledger.requirements || [])
        .filter((r) => r.state === 'verified')
        .flatMap((r) => r.evidenceRefs || []);

      // CTX-10: When context metrics are unavailable, explicitly mark `unavailable` rather than fabricating numbers
      const normalizedMetrics =
        contextMetrics && typeof contextMetrics.usedTokens === 'number'
          ? {
              usedTokens: contextMetrics.usedTokens,
              quality: contextMetrics.quality || 'observed',
            }
          : {
              usedTokens: null,
              quality: 'unavailable',
            };

      const hasContractDrift = contractCheck.issues.length > 0;
      const computedNextAction =
        nextAction ||
        (hasContractDrift
          ? `Resolve contract/key drift (${contractCheck.issues.map((i) => i.code).join(', ')}) and re-verify affected requirements`
          : openRequirements.length > 0
            ? `Complete and verify open requirement ${openRequirements[0]}`
            : 'All registered requirements verified.');

      const checkpointPayload = {
        schemaVersion: 1,
        taskId,
        checkpointRevision: nextRev,
        baseCommit: this.getGitCommit(),
        requirementLedgerRevision: ledger.revision,
        openRequirements,
        completedEvidenceRefs,
        materialUserCorrections: ledger.userCorrections || [],
        contractRevision,
        contractDigest,
        contractRegistryRevision: contractRevision || contractCheck.contracts.length,
        staleContractIssues: contractCheck.issues,
        allRequirementsVerified: openRequirements.length === 0 && !hasContractDrift,
        activeWorkers: activeWorkers.map((w) => ({
          workerId: w.workerId,
          parentId: w.parentId || 'main-orchestrator',
          taskId: w.taskId || taskId,
          executorSessionId: w.executorSessionId || w.executor_session_id || null,
          ownership: w.ownership || [],
          openChecks: Array.from(new Set([...(w.openChecks || []), ...openRequirements])),
        })),
        pendingMessages,
        knownFailures,
        contextMetrics: normalizedMetrics,
        nextAction: computedNextAction,
        createdAt: new Date().toISOString(),
      };

      const revFile = resolveContainedRealPath(
        this.workspaceRoot,
        path.join(checkpointsDir, `rev-${nextRev}.json`)
      );
      writeJsonAtomic(revFile, checkpointPayload);

      // CTX-09: If interrupted before updating the current pointer, the preceding complete checkpoint remains intact
      if (simulateCrashBeforePointerSwap) {
        throw new Error('CTX-09 simulated interruption before current pointer update');
      }

      writeJsonAtomic(currentPointerPath, checkpointPayload);
      return checkpointPayload;
    });
  }

  loadLatestCheckpoint(taskId) {
    return this._withTaskLock(taskId, () => {
      const taskDir = this._resolveSafeTaskDir(taskId);
      const checkpointsDir = resolveContainedRealPath(
        this.workspaceRoot,
        path.join(taskDir, 'checkpoints')
      );
      const currentPointerPath = resolveContainedRealPath(
        this.workspaceRoot,
        path.join(checkpointsDir, 'current.json')
      );
      const current = readJsonSafe(currentPointerPath, null);
      if (!current) return null;
      const contractValidation = this.validateContracts(taskId);
      const contractReg = this.loadContractRegistry(taskId);
      const contractRevision = Number(contractReg.revision || 0);
      const contractDigest = this._computeContractDigest(contractReg);
      const ledger = this.loadRequirementLedger(taskId);
      const liveOpenRequirements = (ledger.requirements || [])
        .filter((r) => r.state !== 'verified')
        .map((r) => r.id);
      return {
        ...current,
        openRequirements: liveOpenRequirements,
        materialUserCorrections: ledger.userCorrections || [],
        contractRevision,
        contractDigest,
        staleContractIssues: contractValidation.issues,
        allRequirementsVerified:
          liveOpenRequirements.length === 0 && contractValidation.issues.length === 0,
        reconciledAt: new Date().toISOString(),
        currentLedger: ledger,
        contractValidation,
      };
    });
  }

  /**
   * CTX-04: Resumes a subagent after context reduction/compaction, constructing the recovery packet
   * from CURRENT authoritative requirements, user corrections, contract state, and stored worker
   * identity (`executorSessionId`, `parentId`, `ownership`), and recording a pending acknowledgment.
   */
  restoreSubagentFromCheckpoint(taskId, workerId, options = {}) {
    return this._withTaskLock(taskId, () => {
      const cp = this.loadLatestCheckpoint(taskId);
      if (!cp) {
        return { ok: false, error: 'NO_CHECKPOINT_FOUND' };
      }
      const worker = (cp.activeWorkers || []).find((w) => w.workerId === workerId);
      if (!worker) {
        return {
          ok: false,
          error: `Worker "${workerId}" not found in checkpoint rev ${cp.checkpointRevision}`,
        };
      }

      const liveLedger = cp.currentLedger || this.loadRequirementLedger(taskId);
      const liveOpenRequirements = (liveLedger.requirements || [])
        .filter((r) => r.state !== 'verified')
        .map((r) => r.id);
      const invalidatedRequirements = Array.from(
        new Set([
          ...(cp.contractValidation?.invalidatedRequirements || []),
          ...(liveLedger.requirements || [])
            .filter((r) => r.invalidatedByContractDrift || r.state === 'implemented_unverified')
            .map((r) => r.id),
        ])
      );
      const mergedOpenChecks = Array.from(
        new Set([...(worker.openChecks || []), ...liveOpenRequirements])
      );
      const liveCorrections = liveLedger.userCorrections || [];
      const staleContractIssues = cp.contractValidation?.issues || [];
      const resolvedSessionId =
        options?.executorSessionId ||
        options?.executor_session_id ||
        worker.executorSessionId ||
        worker.executor_session_id ||
        null;

      const contractRevision = Number(cp.contractRevision ?? 0);
      const contractDigest = cp.contractDigest || null;
      const recoveryToken = `REC-${taskId}-${workerId}-L${liveLedger.revision}-C${cp.checkpointRevision}`;
      const packetDigest = sha256Text(
        JSON.stringify({
          taskId,
          workerId,
          checkpointRevision: cp.checkpointRevision,
          ledgerRevision: liveLedger.revision,
          contractRevision,
          contractDigest,
          openRequirements: liveOpenRequirements,
          invalidatedRequirements,
          materialUserCorrections: liveCorrections,
        })
      );
      const acksFile = resolveContainedRealPath(
        this.workspaceRoot,
        path.join(this._resolveSafeTaskDir(taskId), 'recovery-acks.json')
      );
      const acksState = readJsonSafe(acksFile, { taskId, workers: {} });
      acksState.workers[workerId] = {
        workerId,
        executorSessionId: resolvedSessionId,
        recoveryToken,
        packetDigest,
        checkpointRevision: cp.checkpointRevision,
        ledgerRevision: liveLedger.revision,
        contractRevision,
        contractDigest,
        delivered: false,
        deliveredAt: null,
        status: 'pending_acknowledgment',
        issuedAt: new Date().toISOString(),
        acknowledgedAt: null,
      };
      writeJsonAtomic(acksFile, acksState);

      return {
        ok: true,
        taskId: worker.taskId || taskId,
        workerId: worker.workerId,
        parentId: worker.parentId,
        executorSessionId: resolvedSessionId,
        executor_session_id: resolvedSessionId,
        checkpointRevision: cp.checkpointRevision,
        checkpoint_revision: cp.checkpointRevision,
        ledgerRevision: liveLedger.revision,
        ledger_revision: liveLedger.revision,
        contractRevision,
        contract_revision: contractRevision,
        contractDigest,
        contract_digest: contractDigest,
        packetDigest,
        packet_digest: packetDigest,
        ownership: worker.ownership,
        openChecks: mergedOpenChecks,
        openRequirements: liveOpenRequirements,
        invalidatedRequirements,
        materialUserCorrections: liveCorrections,
        staleContractIssues,
        contractValidation: cp.contractValidation,
        recoveryToken,
        recovery_token: recoveryToken,
        recoveryStatus: 'pending_acknowledgment',
      };
    });
  }

  /**
   * Confirms that a resumed worker received and acknowledged its authoritative recovery packet.
   * Requires a matching `recoveryToken`, a controller-registered `executorSessionId`, confirmed packet
   * delivery (`deliverRecoveryPacket`), and verifies that the live ledger, contracts, and checkpoint
   * have not advanced past the issued packet (`STALE_RECOVERY_PACKET`).
   */
  acknowledgeRecoveryPacket(taskId, workerId, recoveryTokenOrOptions = null) {
    return this._withTaskLock(taskId, () => {
      const acksFile = resolveContainedRealPath(
        this.workspaceRoot,
        path.join(this._resolveSafeTaskDir(taskId), 'recovery-acks.json')
      );
      const acksState = readJsonSafe(acksFile, { taskId, workers: {} });
      const entry = acksState.workers?.[workerId];
      if (!entry) {
        return {
          ok: false,
          acknowledged: false,
          status: 'RECOVERY_PENDING',
          error: `No pending recovery packet found for worker "${workerId}".`,
        };
      }
      const opts =
        recoveryTokenOrOptions && typeof recoveryTokenOrOptions === 'object'
          ? recoveryTokenOrOptions
          : {};
      const suppliedToken =
        typeof recoveryTokenOrOptions === 'string'
          ? recoveryTokenOrOptions.trim()
          : String(opts.recoveryToken ?? opts.recovery_token ?? '').trim();
      if (!suppliedToken) {
        return {
          ok: false,
          acknowledged: false,
          status: 'RECOVERY_PENDING',
          error: 'RECOVERY_TOKEN_REQUIRED',
          expectedToken: entry.recoveryToken,
        };
      }
      if (entry.recoveryToken !== suppliedToken) {
        return {
          ok: false,
          acknowledged: false,
          status: 'RECOVERY_PENDING',
          error: 'RECOVERY_TOKEN_MISMATCH',
          expectedToken: entry.recoveryToken,
        };
      }

      const suppliedCpRev = opts.checkpointRevision ?? opts.checkpoint_revision;
      if (
        suppliedCpRev !== undefined &&
        suppliedCpRev !== null &&
        Number(suppliedCpRev) !== Number(entry.checkpointRevision)
      ) {
        return {
          ok: false,
          acknowledged: false,
          status: 'RECOVERY_PENDING',
          error: 'CHECKPOINT_REVISION_MISMATCH',
        };
      }

      const suppliedLedgerRev = opts.ledgerRevision ?? opts.ledger_revision;
      if (
        suppliedLedgerRev !== undefined &&
        suppliedLedgerRev !== null &&
        Number(suppliedLedgerRev) !== Number(entry.ledgerRevision)
      ) {
        return {
          ok: false,
          acknowledged: false,
          status: 'RECOVERY_PENDING',
          error: 'LEDGER_REVISION_MISMATCH',
        };
      }

      const suppliedPacketDigest = opts.packetDigest ?? opts.packet_digest;
      if (
        suppliedPacketDigest !== undefined &&
        suppliedPacketDigest !== null &&
        String(suppliedPacketDigest).trim() !== '' &&
        String(suppliedPacketDigest) !== String(entry.packetDigest)
      ) {
        return {
          ok: false,
          acknowledged: false,
          status: 'RECOVERY_PENDING',
          error: 'PACKET_DIGEST_MISMATCH',
        };
      }

      const suppliedSessionId = opts.executorSessionId ?? opts.executor_session_id;
      if (!entry.executorSessionId || !suppliedSessionId || !String(suppliedSessionId).trim()) {
        return {
          ok: false,
          acknowledged: false,
          status: 'RECOVERY_PENDING',
          error: 'EXECUTOR_SESSION_REQUIRED_FOR_ACKNOWLEDGMENT',
        };
      }
      const cleanSessionId = String(suppliedSessionId).trim();
      if (cleanSessionId !== String(entry.executorSessionId).trim()) {
        return {
          ok: false,
          acknowledged: false,
          status: 'RECOVERY_PENDING',
          error: 'EXECUTOR_SESSION_ID_MISMATCH',
        };
      }

      // F07 / WP7: Verify controller-registered executor session & transport-backed packet delivery
      const sessionsState = this.loadExecutorSessions(taskId);
      const regSession = sessionsState.sessions?.[cleanSessionId];
      if (!regSession || regSession.workerId !== workerId) {
        return {
          ok: false,
          acknowledged: false,
          status: 'RECOVERY_PENDING',
          error: 'NO_REGISTERED_EXECUTOR_SESSION',
        };
      }
      if (
        regSession.status === 'CANCELLED' ||
        regSession.status === 'STOPPED' ||
        regSession.status === 'CANCEL_REQUESTED'
      ) {
        return {
          ok: false,
          acknowledged: false,
          status: regSession.status,
          error: 'EXECUTOR_SESSION_NOT_ACTIVE',
        };
      }
      const deliveryRecord = regSession.deliveredPackets?.[entry.recoveryToken];
      if (!entry.delivered && !deliveryRecord) {
        return {
          ok: false,
          acknowledged: false,
          status: 'RECOVERY_PENDING',
          error: 'RECOVERY_PACKET_DELIVERY_UNCONFIRMED',
        };
      }

      // Verify that neither the requirement ledger, contracts, nor checkpoint has advanced since the recovery packet was issued
      const contractValidation = this.validateContracts(taskId);
      const contractReg = this.loadContractRegistry(taskId);
      const liveContractRev = Number(contractReg.revision || 0);
      const liveContractDigest = this._computeContractDigest(contractReg);
      const liveLedger = this.loadRequirementLedger(taskId);
      const currentPointerPath = resolveContainedRealPath(
        this.workspaceRoot,
        path.join(this._resolveSafeTaskDir(taskId), 'checkpoints', 'current.json')
      );
      const latestCp = readJsonSafe(currentPointerPath, null);
      if (
        Number(liveLedger.revision) !== Number(entry.ledgerRevision) ||
        (latestCp && Number(latestCp.checkpointRevision) !== Number(entry.checkpointRevision)) ||
        (entry.contractRevision !== undefined &&
          Number(liveContractRev) !== Number(entry.contractRevision)) ||
        (entry.contractDigest && liveContractDigest !== entry.contractDigest)
      ) {
        return {
          ok: false,
          acknowledged: false,
          status: 'RECOVERY_PENDING',
          error: 'STALE_RECOVERY_PACKET',
          packetLedgerRevision: entry.ledgerRevision,
          currentLedgerRevision: liveLedger.revision,
          packetCheckpointRevision: entry.checkpointRevision,
          currentCheckpointRevision: latestCp?.checkpointRevision ?? null,
          packetContractRevision: entry.contractRevision ?? 0,
          currentContractRevision: liveContractRev,
          contractIssuesCount: contractValidation.issues.length,
        };
      }

      const nowIso = new Date().toISOString();
      entry.status = 'acknowledged';
      entry.acknowledgedAt = nowIso;
      writeJsonAtomic(acksFile, acksState);

      regSession.acknowledgedPackets = regSession.acknowledgedPackets || {};
      regSession.acknowledgedPackets[entry.recoveryToken] = nowIso;
      regSession.updatedAt = nowIso;
      sessionsState.updatedAt = nowIso;
      writeJsonAtomic(this.getExecutorSessionsPath(taskId), sessionsState);

      return {
        ok: true,
        acknowledged: true,
        status: 'RUNNING',
        workerStatus: 'acknowledged',
        taskId,
        workerId,
        executorSessionId: entry.executorSessionId || null,
        recoveryToken: entry.recoveryToken,
        checkpointRevision: entry.checkpointRevision,
        ledgerRevision: entry.ledgerRevision,
        contractRevision: entry.contractRevision ?? 0,
        packetDigest: entry.packetDigest,
        acknowledgedAt: entry.acknowledgedAt,
      };
    });
  }

  // =========================================================================
  // 4. BOUNDED LOG EXTERNALIZATION, CONFLICT RESOLUTION & ESCALATION (CTX-08, CTX-11, CTX-12)
  // =========================================================================
  /**
   * CTX-08: Stores full large tool output on disk under `.harness/tasks/<taskId>/artifacts/`
   * with symlink-safe containment and returns bounded evidence + an artifact reference.
   * Strictly enforces that `maxContextChars` is a finite positive integer and that
   * `boundedExcerpt.length <= maxContextChars` (including the artifact reference suffix).
   */
  storeBoundedToolOutput(taskId, toolName, rawOutput, maxContextCharsOrOpts = 600) {
    const cleanTool = String(toolName || 'tool').replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!cleanTool || cleanTool.includes('..')) {
      throw new Error(`Invalid toolName "${toolName}"`);
    }
    const maxContextChars =
      maxContextCharsOrOpts &&
      typeof maxContextCharsOrOpts === 'object' &&
      !Array.isArray(maxContextCharsOrOpts)
        ? (maxContextCharsOrOpts.maxContextChars ?? maxContextCharsOrOpts.max_context_chars)
        : maxContextCharsOrOpts;
    if (
      typeof maxContextChars !== 'number' ||
      !Number.isFinite(maxContextChars) ||
      !Number.isInteger(maxContextChars) ||
      maxContextChars <= 0
    ) {
      throw new Error(
        `CTX-08 invalid maxContextChars "${maxContextChars}": maxContextChars must be a finite positive integer.`
      );
    }
    const effectiveMax = Math.min(4000, maxContextChars);
    const text = String(rawOutput ?? '');
    const taskDir = this._resolveSafeTaskDir(taskId);
    const artifactsDir = resolveContainedRealPath(
      this.workspaceRoot,
      path.join(taskDir, 'artifacts')
    );
    fs.mkdirSync(artifactsDir, { recursive: true });
    const digest = sha256Text(text).slice(0, 16);
    const artifactFile = resolveContainedRealPath(
      this.workspaceRoot,
      path.join(artifactsDir, `${cleanTool}-${digest}.log`)
    );
    fs.writeFileSync(artifactFile, text, { encoding: 'utf8', mode: 0o600 });
    const relRef = path.relative(this.workspaceRoot, artifactFile).replace(/\\/g, '/');

    const truncated = text.length > effectiveMax;
    let boundedExcerpt = text;
    if (truncated) {
      const suffix = `… [Bounded: ${text.length} chars stored at ${relRef}]`;
      if (effectiveMax <= suffix.length) {
        boundedExcerpt = suffix.slice(0, effectiveMax);
      } else {
        const bodyBudget = effectiveMax - suffix.length;
        boundedExcerpt = `${text.slice(0, bodyBudget)}${suffix}`;
      }
    }

    return {
      stored: true,
      fullLength: text.length,
      truncated,
      maxContextChars: effectiveMax,
      artifactRef: relRef,
      digest,
      boundedExcerpt,
    };
  }

  /**
   * CTX-11: Resolves conflicts between a retrieved RAG note, on-disk source code, and approved requirements.
   * Present contracts come from on-disk source unless an approved requirement explicitly mandates changing that source.
   */
  resolveNoteVsSourceConflict({ retrievedNote, sourceFile, approvedRequirement = null } = {}) {
    const fullSource = sourceFile ? this._resolveWorkspaceFile(sourceFile) : null;
    const sourceExists = fullSource && fs.existsSync(fullSource);
    const sourceDigest = sourceExists ? this.getFileDigest(sourceFile) : null;

    if (approvedRequirement && approvedRequirement.intentionallyChangesSource) {
      return {
        authority: 'approved_requirement',
        reason: `Approved requirement ${approvedRequirement.id} intentionally modifies "${sourceFile}".`,
        sourceDigest,
        reReadSourceRequired: true,
      };
    }

    if (sourceExists) {
      return {
        authority: 'present_source_code',
        reason: `Source file "${sourceFile}" (digest ${sourceDigest?.slice(0, 8)}) takes precedence over retrieved note "${retrievedNote?.docid || 'unknown'}" for exact present contracts.`,
        sourceDigest,
        reReadSourceRequired: true,
      };
    }

    return {
      authority: 'retrieved_note_navigation_only',
      reason: 'Source file not found; treat retrieved note as navigation hint only.',
      sourceDigest: null,
      reReadSourceRequired: false,
    };
  }

  /**
   * CTX-12: Tracks consecutive attempts without requirement progress and triggers bounded escalation
   * or focused worker rotation instead of endless retries.
   */
  recordAttemptProgress(taskId, { madeProgress = false, maxStagnantAttempts = 3 } = {}) {
    return this._withTaskLock(taskId, () => {
      const taskDir = this._resolveSafeTaskDir(taskId);
      const statePath = resolveContainedRealPath(
        this.workspaceRoot,
        path.join(taskDir, 'progress-guard.json')
      );
      const aliasStatePath = resolveContainedRealPath(
        this.workspaceRoot,
        path.join(taskDir, 'state.json')
      );
      const state = readJsonSafe(statePath, {
        taskId,
        stagnantAttempts: 0,
        totalAttempts: 0,
        status: 'active',
      });

      state.totalAttempts += 1;
      if (madeProgress) {
        state.stagnantAttempts = 0;
        state.status = 'active';
      } else {
        state.stagnantAttempts += 1;
        if (state.stagnantAttempts >= maxStagnantAttempts) {
          state.status = 'escalated_focused_restart';
        }
      }
      state.shouldStopRetryLoop = state.stagnantAttempts >= maxStagnantAttempts;
      state.updatedAt = new Date().toISOString();
      writeJsonAtomic(statePath, state);
      writeJsonAtomic(aliasStatePath, state);

      return {
        ...state,
        shouldStopRetryLoop: state.shouldStopRetryLoop,
        recommendedAction:
          state.shouldStopRetryLoop
            ? 'Stop expanding prompt; rotate to a focused worker from durable checkpoint or escalate to user.'
            : 'Continue next requirement.',
      };
    });
  }

  /**
   * Lists active tasks in `.harness/tasks/` and builds a compact, bounded context-resilience
   * injection summary for `PreInvocation` hooks so active tasks automatically survive compaction.
   * Prioritizes task ID/ledger revision, Latest Correction, Open Requirements, and Stale Contracts
   * BEFORE the truncated Objective so critical recovery signals are never truncated away.
   */
  buildActiveTasksHookPacket(maxChars = 900) {
    if (!fs.existsSync(this.tasksRoot)) return null;
    const entries = fs.readdirSync(this.tasksRoot, { withFileTypes: true });
    const summaries = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const taskId = entry.name;
      try {
        const contractCheck = this.validateContracts(taskId);
        const ledger = this.loadRequirementLedger(taskId);
        const openReqs = (ledger.requirements || []).filter((r) => r.state !== 'verified');
        const corrections = ledger.userCorrections || [];
        const issues = contractCheck.issues || [];
        if (openReqs.length === 0 && issues.length === 0 && corrections.length === 0) {
          continue;
        }
        const parts = [`[Task ${taskId} (rev ${ledger.revision})]`];
        if (corrections.length > 0) {
          const latestCorr = corrections[corrections.length - 1];
          parts.push(`Latest Correction: "${String(latestCorr.correction || '').slice(0, 220)}"`);
        }
        if (openReqs.length > 0) {
          parts.push(`Open Reqs: ${openReqs.map((r) => `${r.id}(${r.state})`).join(', ')}`);
        }
        if (issues.length > 0) {
          parts.push(`Stale Contracts: ${issues.map((i) => `${i.code}:${i.contractId}`).join(', ')}`);
        }
        if (ledger.objective) {
          const cleanObj = String(ledger.objective).trim();
          parts.push(
            `Objective: ${cleanObj.length > 140 ? `${cleanObj.slice(0, 137)}...` : cleanObj}`
          );
        }
        summaries.push(parts.join(' | '));
      } catch {}
    }

    if (summaries.length === 0) return null;
    const joined = `[Gravity Well Context Resilience] ${summaries.join(' ; ')}`;
    return joined.length > maxChars ? `${joined.slice(0, maxChars - 3)}...` : joined;
  }
}
