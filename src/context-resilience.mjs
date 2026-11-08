import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

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
 * Strips single-line (`//`, `#`) and multi-line (`/* ... *\/`, `<!-- ... -->`) comments
 * so comment-only mentions of a symbol cannot satisfy `consumerRefs` verification.
 */
export function stripCodeComments(sourceText) {
  const text = String(sourceText ?? '');
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1 ')
    .replace(/^\s*#.*$/gm, ' ');
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

  // Walk up to find deepest existing ancestor and resolve symlinks via realpathSync
  let cur = absCandidate;
  const tailSegments = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tailSegments.unshift(path.basename(cur));
    cur = parent;
  }

  const realAncestor = fs.existsSync(cur) ? fs.realpathSync(cur) : cur;
  const realFull =
    tailSegments.length > 0 ? path.join(realAncestor, ...tailSegments) : realAncestor;

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
    return path.join(this._resolveSafeTaskDir(taskId), 'requirements.json');
  }

  loadRequirementLedger(taskId) {
    const file = this.getLedgerPath(taskId);
    const existing = readJsonSafe(file, null);
    if (existing) return existing;
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

  _verifyEvidenceRefExists(evRef) {
    const refStr = typeof evRef === 'string' ? evRef.trim() : String(evRef?.file || evRef?.receiptId || '').trim();
    if (!refStr) return false;
    if (/^RCPT-[A-Z0-9-]+$/i.test(refStr)) {
      const receiptPath = this._resolveWorkspaceFile(path.join('.harness', 'receipts', `${refStr}.json`));
      return fs.existsSync(receiptPath) && fs.statSync(receiptPath).isFile();
    }
    const cleanFile = refStr.split('#')[0].trim();
    const full = this._resolveWorkspaceFile(cleanFile);
    return fs.existsSync(full) && fs.statSync(full).isFile() && fs.statSync(full).size > 0;
  }

  upsertRequirementLedger(taskId, { objective, userCorrection, requirements = [] } = {}) {
    return this._withTaskLock(taskId, () => {
      const ledger = this.loadRequirementLedger(taskId);
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
          for (const evRef of merged.evidenceRefs) {
            if (!this._verifyEvidenceRefExists(evRef)) {
              throw new Error(
                `CTX-06 violation for ${req.id}: evidence reference "${typeof evRef === 'string' ? evRef : JSON.stringify(evRef)}" does not exist on disk.`
              );
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
              const codeWithoutComments = stripCodeComments(rawContent);
              if (!codeWithoutComments.includes(parsedRef.symbol)) {
                throw new Error(
                  `CTX-06 violation for ${req.id}: consumer file "${parsedRef.file}" does not reference symbol "${parsedRef.symbol}" in executable code (comments excluded).`
                );
              }
            }
            consumerDigests[parsedRef.file] = sha256Text(rawContent);
          }
          merged.verifiedConsumerDigests = consumerDigests;
          merged.invalidatedByContractDrift = false;
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
    return path.join(this._resolveSafeTaskDir(taskId), 'contracts.json');
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
   * Marks any contract whose producer or consumer file digest changed as `stale_invalidated`,
   * verifies exact storageKey / symbolName presence in non-comment code, AND automatically
   * invalidates (`implemented_unverified`) any verified requirements affected by drift.
   */
  validateContracts(taskId) {
    return this._withTaskLock(taskId, () => {
      const reg = this.loadContractRegistry(taskId);
      const issues = [];
      let mutated = false;
      const driftedFiles = new Set();
      const driftedSymbols = new Set();

      for (const c of reg.contracts) {
        let contractValid = true;
        if (c.producerFile) {
          const currentProducerDigest = this.getFileDigest(c.producerFile);
          if (c.producerDigest && currentProducerDigest !== c.producerDigest) {
            c.status = 'stale_invalidated';
            contractValid = false;
            mutated = true;
            driftedFiles.add(c.producerFile);
            driftedSymbols.add(c.symbolName);
            issues.push({
              code: 'CTX-05_STALE_PRODUCER',
              contractId: c.contractId,
              file: c.producerFile,
              message: `Producer file "${c.producerFile}" changed since contract "${c.contractId}" was recorded; re-read declaration.`,
            });
          }
          const fullProd = this._resolveWorkspaceFile(c.producerFile);
          if (fs.existsSync(fullProd) && c.storageKey) {
            const text = stripCodeComments(fs.readFileSync(fullProd, 'utf8'));
            if (!text.includes(c.storageKey)) {
              c.status = 'key_drift_invalidated';
              contractValid = false;
              mutated = true;
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

        if (c.consumerFile) {
          const currentConsumerDigest = this.getFileDigest(c.consumerFile);
          if (c.consumerDigest && currentConsumerDigest !== c.consumerDigest) {
            c.status = 'stale_invalidated';
            contractValid = false;
            mutated = true;
            driftedFiles.add(c.consumerFile);
            driftedSymbols.add(c.symbolName);
            issues.push({
              code: 'CTX-05_STALE_CONSUMER',
              contractId: c.contractId,
              file: c.consumerFile,
              message: `Consumer file "${c.consumerFile}" changed since contract "${c.contractId}" was recorded; re-read declaration.`,
            });
          }
          const fullCons = this._resolveWorkspaceFile(c.consumerFile);
          if (fs.existsSync(fullCons) && c.storageKey) {
            const text = stripCodeComments(fs.readFileSync(fullCons, 'utf8'));
            if (!text.includes(c.storageKey)) {
              c.status = 'key_drift_invalidated';
              contractValid = false;
              mutated = true;
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

        if (contractValid && c.status !== 'valid') {
          c.status = 'valid';
          mutated = true;
        }
      }

      if (mutated) {
        reg.revision += 1;
        reg.updatedAt = new Date().toISOString();
        writeJsonAtomic(this.getContractsPath(taskId), reg);
      }

      // If any contract drifted or failed validation, invalidate affected verified requirements in the ledger
      const invalidatedRequirements = [];
      if (issues.length > 0) {
        const ledgerPath = this.getLedgerPath(taskId);
        const ledger = readJsonSafe(ledgerPath, null);
        if (ledger && Array.isArray(ledger.requirements)) {
          let ledgerMutated = false;
          for (const req of ledger.requirements) {
            if (req.state !== 'verified') continue;
            const cRefs = (req.consumerRefs || []).map((r) => this._parseConsumerRef(r));
            const matchesDriftedFileOrSymbol =
              cRefs.some(
                (r) =>
                  driftedFiles.has(r.file) ||
                  (r.symbol && driftedSymbols.has(r.symbol)) ||
                  (req.verifiedConsumerDigests?.[r.file] &&
                    this.getFileDigest(r.file) !== req.verifiedConsumerDigests[r.file])
              ) || issues.some((i) => i.code.startsWith('CTX-02_') || i.code.startsWith('CTX-05_'));

            if (matchesDriftedFileOrSymbol) {
              req.state = 'implemented_unverified';
              req.invalidatedByContractDrift = true;
              req.invalidatedReason = issues.map((i) => `${i.code}:${i.contractId}`).join(', ');
              invalidatedRequirements.push(req.id);
              ledgerMutated = true;
            }
          }
          if (ledgerMutated) {
            ledger.revision = (ledger.revision || 0) + 1;
            ledger.updatedAt = new Date().toISOString();
            writeJsonAtomic(ledgerPath, ledger);
          }
        }
      }

      return {
        ok: issues.length === 0,
        taskId,
        contractsCount: reg.contracts.length,
        issues,
        invalidatedRequirements,
        contracts: reg.contracts,
      };
    });
  }

  // =========================================================================
  // 3. ATOMIC RESUMABLE CHECKPOINTS & SUBAGENT RECOVERY (CTX-04, CTX-09, CTX-10)
  // =========================================================================
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
      const checkpointsDir = path.join(taskDir, 'checkpoints');
      fs.mkdirSync(checkpointsDir, { recursive: true });

      const currentPointerPath = path.join(checkpointsDir, 'current.json');
      const prevCurrent = readJsonSafe(currentPointerPath, null);
      const nextRev = this._allocateNextCheckpointRevision(checkpointsDir, prevCurrent);

      // Validate contracts FIRST so any drift demotes affected verified requirements before reading ledger
      const contractCheck = this.validateContracts(taskId);
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
        contractRegistryRevision: contractCheck.contracts.length,
        staleContractIssues: contractCheck.issues,
        allRequirementsVerified: openRequirements.length === 0 && !hasContractDrift,
        activeWorkers: activeWorkers.map((w) => ({
          workerId: w.workerId,
          parentId: w.parentId || 'main-orchestrator',
          taskId: w.taskId || taskId,
          executorSessionId: w.executorSessionId || null,
          ownership: w.ownership || [],
          openChecks: Array.from(new Set([...(w.openChecks || []), ...openRequirements])),
        })),
        pendingMessages,
        knownFailures,
        contextMetrics: normalizedMetrics,
        nextAction: computedNextAction,
        createdAt: new Date().toISOString(),
      };

      const revFile = path.join(checkpointsDir, `rev-${nextRev}.json`);
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
      const currentPointerPath = path.join(taskDir, 'checkpoints', 'current.json');
      const current = readJsonSafe(currentPointerPath, null);
      if (!current) return null;
      const contractValidation = this.validateContracts(taskId);
      const ledger = this.loadRequirementLedger(taskId);
      const liveOpenRequirements = (ledger.requirements || [])
        .filter((r) => r.state !== 'verified')
        .map((r) => r.id);
      return {
        ...current,
        openRequirements: liveOpenRequirements,
        materialUserCorrections: ledger.userCorrections || [],
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
        null;

      const recoveryToken = `REC-${taskId}-${workerId}-L${liveLedger.revision}-C${cp.checkpointRevision}`;
      const acksFile = path.join(this._resolveSafeTaskDir(taskId), 'recovery-acks.json');
      const acksState = readJsonSafe(acksFile, { taskId, workers: {} });
      acksState.workers[workerId] = {
        workerId,
        executorSessionId: resolvedSessionId,
        recoveryToken,
        checkpointRevision: cp.checkpointRevision,
        ledgerRevision: liveLedger.revision,
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
        checkpointRevision: cp.checkpointRevision,
        ownership: worker.ownership,
        openChecks: mergedOpenChecks,
        openRequirements: liveOpenRequirements,
        invalidatedRequirements,
        materialUserCorrections: liveCorrections,
        staleContractIssues,
        contractValidation: cp.contractValidation,
        recoveryToken,
        recoveryStatus: 'pending_acknowledgment',
      };
    });
  }

  /**
   * Confirms that a resumed worker received and acknowledged its authoritative recovery packet.
   */
  acknowledgeRecoveryPacket(taskId, workerId, recoveryTokenOrOptions = null) {
    return this._withTaskLock(taskId, () => {
      const acksFile = path.join(this._resolveSafeTaskDir(taskId), 'recovery-acks.json');
      const acksState = readJsonSafe(acksFile, { taskId, workers: {} });
      const entry = acksState.workers?.[workerId];
      if (!entry) {
        return {
          ok: false,
          acknowledged: false,
          error: `No pending recovery packet found for worker "${workerId}".`,
        };
      }
      const suppliedToken =
        typeof recoveryTokenOrOptions === 'string'
          ? recoveryTokenOrOptions
          : recoveryTokenOrOptions?.recoveryToken || recoveryTokenOrOptions?.recovery_token || null;
      if (suppliedToken && entry.recoveryToken !== suppliedToken) {
        return {
          ok: false,
          acknowledged: false,
          error: 'RECOVERY_TOKEN_MISMATCH',
          expectedToken: entry.recoveryToken,
        };
      }
      if (
        recoveryTokenOrOptions &&
        typeof recoveryTokenOrOptions === 'object' &&
        recoveryTokenOrOptions.executorSessionId &&
        entry.executorSessionId &&
        entry.executorSessionId !== recoveryTokenOrOptions.executorSessionId
      ) {
        return {
          ok: false,
          acknowledged: false,
          error: 'EXECUTOR_SESSION_ID_MISMATCH',
        };
      }
      entry.status = 'acknowledged';
      entry.acknowledgedAt = new Date().toISOString();
      writeJsonAtomic(acksFile, acksState);
      return {
        ok: true,
        acknowledged: true,
        taskId,
        workerId,
        executorSessionId: entry.executorSessionId || null,
        recoveryToken: entry.recoveryToken,
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
   */
  storeBoundedToolOutput(taskId, toolName, rawOutput, maxContextChars = 600) {
    const cleanTool = String(toolName || 'tool').replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!cleanTool || cleanTool.includes('..')) {
      throw new Error(`Invalid toolName "${toolName}"`);
    }
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

    const truncated = text.length > maxContextChars;
    const boundedExcerpt = truncated
      ? `${text.slice(0, maxContextChars)}… [Bounded: ${text.length} chars stored at ${relRef}]`
      : text;

    return {
      stored: true,
      fullLength: text.length,
      truncated,
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
      const statePath = path.join(taskDir, 'progress-guard.json');
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
      state.updatedAt = new Date().toISOString();
      writeJsonAtomic(statePath, state);

      return {
        ...state,
        shouldStopRetryLoop: state.stagnantAttempts >= maxStagnantAttempts,
        recommendedAction:
          state.stagnantAttempts >= maxStagnantAttempts
            ? 'Stop expanding prompt; rotate to a focused worker from durable checkpoint or escalate to user.'
            : 'Continue next requirement.',
      };
    });
  }

  /**
   * Lists active tasks in `.harness/tasks/` and builds a compact, bounded context-resilience
   * injection summary for `PreInvocation` hooks so active tasks automatically survive compaction.
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
        if (ledger.objective) parts.push(`Objective: ${ledger.objective}`);
        if (openReqs.length > 0) {
          parts.push(`Open Reqs: ${openReqs.map((r) => `${r.id}(${r.state})`).join(', ')}`);
        }
        if (issues.length > 0) {
          parts.push(`Stale Contracts: ${issues.map((i) => `${i.code}:${i.contractId}`).join(', ')}`);
        }
        if (corrections.length > 0) {
          const latestCorr = corrections[corrections.length - 1];
          parts.push(`Latest Correction: "${latestCorr.correction}"`);
        }
        summaries.push(parts.join(' | '));
      } catch {}
    }

    if (summaries.length === 0) return null;
    const joined = `[Gravity Well Context Resilience] ${summaries.join(' ; ')}`;
    return joined.length > maxChars ? `${joined.slice(0, maxChars - 3)}...` : joined;
  }
}
