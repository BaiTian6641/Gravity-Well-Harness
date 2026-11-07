import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

/**
 * Gravity Well Harness — Argon Context Resilience & Durable Task State Manager
 * Implements Document 04 (`04_Argon_Context_Resilience.md`) requirements & regression cases CTX-01..CTX-12:
 *  - Requirement Ledger (`.harness/tasks/<taskId>/requirements.json`)
 *  - Exact Contract Registry (`.harness/tasks/<taskId>/contracts.json`) with unit & SHA-256 file-digest validation
 *  - Atomic Resumable Checkpoints (`.harness/tasks/<taskId>/checkpoints/rev-<N>.json` + `current.json`)
 *  - Bounded Tool Output Externalization (`CTX-08`)
 *  - Subagent Resume State Restoration (`CTX-04`)
 *  - Provenance vs. Source Conflict Resolution (`CTX-11`)
 *  - Bounded No-Progress Escalation (`CTX-12`)
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

function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}`;
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

export class ContextResilienceManager {
  constructor(workspaceRoot = process.cwd()) {
    this.workspaceRoot = fs.existsSync(workspaceRoot)
      ? fs.realpathSync(workspaceRoot)
      : path.resolve(workspaceRoot);
    this.tasksRoot = path.join(this.workspaceRoot, '.harness', 'tasks');
  }

  _resolveSafeTaskDir(taskId) {
    const cleanId = String(taskId || '').trim();
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(cleanId) || cleanId.includes('..')) {
      throw new Error(`Invalid taskId "${cleanId}": must be alphanumeric/kebab-case without traversal.`);
    }
    const target = path.resolve(this.tasksRoot, cleanId);
    if (!target.startsWith(this.tasksRoot)) {
      throw new Error(`Task path traversal denied for "${cleanId}".`);
    }
    return target;
  }

  _resolveWorkspaceFile(relOrAbsPath) {
    const resolved = path.resolve(this.workspaceRoot, String(relOrAbsPath || ''));
    if (!resolved.startsWith(this.workspaceRoot)) {
      throw new Error(`File "${relOrAbsPath}" escapes workspace root "${this.workspaceRoot}".`);
    }
    return resolved;
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

  upsertRequirementLedger(taskId, { objective, userCorrection, requirements = [] } = {}) {
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

      // CTX-06: A UI control or producer with no backend consumer or missing evidence cannot become verified
      if (targetState === 'verified') {
        if (!Array.isArray(merged.acceptanceChecks) || merged.acceptanceChecks.length === 0) {
          throw new Error(`Requirement ${req.id} cannot transition to "verified" without acceptanceChecks.`);
        }
        if (!Array.isArray(merged.evidenceRefs) || merged.evidenceRefs.length === 0) {
          throw new Error(`Requirement ${req.id} cannot transition to "verified" without observed evidenceRefs.`);
        }
        if (Array.isArray(merged.consumerRefs) && merged.consumerRefs.length === 0 && merged.requiresConsumer !== false) {
          throw new Error(
            `CTX-06 violation for ${req.id}: consumerRefs is empty (unwired control/interface has no runtime consumer).`
          );
        }
        for (const cRef of merged.consumerRefs || []) {
          const full = this._resolveWorkspaceFile(cRef.file || cRef);
          if (!fs.existsSync(full)) {
            throw new Error(`CTX-06 violation for ${req.id}: consumer file "${cRef.file || cRef}" does not exist.`);
          }
          if (cRef.symbol) {
            const content = fs.readFileSync(full, 'utf8');
            if (!content.includes(cRef.symbol)) {
              throw new Error(
                `CTX-06 violation for ${req.id}: consumer file "${cRef.file}" does not reference symbol "${cRef.symbol}".`
              );
            }
          }
        }
      }

      reqMap.set(req.id, merged);
    }

    ledger.requirements = Array.from(reqMap.values());
    ledger.revision += 1;
    ledger.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.getLedgerPath(taskId), ledger);
    return ledger;
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
  }

  /**
   * CTX-02 & CTX-05: Validates all registered contracts against current on-disk files.
   * Marks any contract whose producer or consumer file digest changed as `stale_invalidated`
   * and verifies exact storageKey / symbolName presence in both producer and consumer files.
   */
  validateContracts(taskId) {
    const reg = this.loadContractRegistry(taskId);
    const issues = [];
    let mutated = false;

    for (const c of reg.contracts) {
      if (c.producerFile) {
        const currentProducerDigest = this.getFileDigest(c.producerFile);
        if (c.producerDigest && currentProducerDigest !== c.producerDigest) {
          c.status = 'stale_invalidated';
          mutated = true;
          issues.push({
            code: 'CTX-05_STALE_PRODUCER',
            contractId: c.contractId,
            file: c.producerFile,
            message: `Producer file "${c.producerFile}" changed since contract "${c.contractId}" was recorded; re-read declaration.`,
          });
        }
        const fullProd = this._resolveWorkspaceFile(c.producerFile);
        if (fs.existsSync(fullProd) && c.storageKey) {
          const text = fs.readFileSync(fullProd, 'utf8');
          if (!text.includes(c.storageKey)) {
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
          mutated = true;
          issues.push({
            code: 'CTX-05_STALE_CONSUMER',
            contractId: c.contractId,
            file: c.consumerFile,
            message: `Consumer file "${c.consumerFile}" changed since contract "${c.contractId}" was recorded; re-read declaration.`,
          });
        }
        const fullCons = this._resolveWorkspaceFile(c.consumerFile);
        if (fs.existsSync(fullCons) && c.storageKey) {
          const text = fs.readFileSync(fullCons, 'utf8');
          if (!text.includes(c.storageKey)) {
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

    if (mutated) {
      reg.revision += 1;
      reg.updatedAt = new Date().toISOString();
      writeJsonAtomic(this.getContractsPath(taskId), reg);
    }

    return {
      ok: issues.length === 0,
      taskId,
      contractsCount: reg.contracts.length,
      issues,
      contracts: reg.contracts,
    };
  }

  // =========================================================================
  // 3. ATOMIC RESUMABLE CHECKPOINTS & SUBAGENT RECOVERY (CTX-04, CTX-09, CTX-10)
  // =========================================================================
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
    const taskDir = this._resolveSafeTaskDir(taskId);
    const checkpointsDir = path.join(taskDir, 'checkpoints');
    fs.mkdirSync(checkpointsDir, { recursive: true });

    const currentPointerPath = path.join(checkpointsDir, 'current.json');
    const prevCurrent = readJsonSafe(currentPointerPath, null);
    const nextRev = (prevCurrent?.checkpointRevision || 0) + 1;

    const ledger = this.loadRequirementLedger(taskId);
    const contractCheck = this.validateContracts(taskId);

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
      activeWorkers: activeWorkers.map((w) => ({
        workerId: w.workerId,
        parentId: w.parentId || 'main-orchestrator',
        taskId: w.taskId || taskId,
        executorSessionId: w.executorSessionId || null,
        ownership: w.ownership || [],
        openChecks: w.openChecks || openRequirements,
      })),
      pendingMessages,
      knownFailures,
      contextMetrics: normalizedMetrics,
      nextAction:
        nextAction ||
        (openRequirements.length > 0
          ? `Complete and verify open requirement ${openRequirements[0]}`
          : 'All registered requirements verified.'),
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
  }

  loadLatestCheckpoint(taskId) {
    const taskDir = this._resolveSafeTaskDir(taskId);
    const currentPointerPath = path.join(taskDir, 'checkpoints', 'current.json');
    const current = readJsonSafe(currentPointerPath, null);
    if (!current) return null;
    const contractValidation = this.validateContracts(taskId);
    const ledger = this.loadRequirementLedger(taskId);
    return {
      ...current,
      reconciledAt: new Date().toISOString(),
      currentLedger: ledger,
      contractValidation,
    };
  }

  /**
   * CTX-04: Resumes a subagent after context reduction/compaction, restoring task, parent ID,
   * file ownership, and open acceptance checks from the durable checkpoint.
   */
  restoreSubagentFromCheckpoint(taskId, workerId) {
    const cp = this.loadLatestCheckpoint(taskId);
    if (!cp) {
      return { ok: false, error: 'NO_CHECKPOINT_FOUND' };
    }
    const worker = (cp.activeWorkers || []).find((w) => w.workerId === workerId);
    if (!worker) {
      return { ok: false, error: `Worker "${workerId}" not found in checkpoint rev ${cp.checkpointRevision}` };
    }
    return {
      ok: true,
      taskId: worker.taskId,
      workerId: worker.workerId,
      parentId: worker.parentId,
      ownership: worker.ownership,
      openChecks: worker.openChecks,
      materialUserCorrections: cp.materialUserCorrections,
      staleContractIssues: cp.contractValidation?.issues || [],
    };
  }

  // =========================================================================
  // 4. BOUNDED LOG EXTERNALIZATION, CONFLICT RESOLUTION & ESCALATION (CTX-08, CTX-11, CTX-12)
  // =========================================================================
  /**
   * CTX-08: Stores full large tool output on disk under `.harness/tasks/<taskId>/artifacts/`
   * and returns bounded evidence + an artifact reference for prompt context.
   */
  storeBoundedToolOutput(taskId, toolName, rawOutput, maxContextChars = 600) {
    const text = String(rawOutput ?? '');
    const taskDir = this._resolveSafeTaskDir(taskId);
    const artifactsDir = path.join(taskDir, 'artifacts');
    fs.mkdirSync(artifactsDir, { recursive: true });
    const digest = sha256Text(text).slice(0, 16);
    const artifactFile = path.join(artifactsDir, `${toolName}-${digest}.log`);
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
  }
}
