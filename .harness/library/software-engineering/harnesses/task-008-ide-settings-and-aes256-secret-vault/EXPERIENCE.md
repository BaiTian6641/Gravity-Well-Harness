---
docid: EXP-SOFT-TASK-008-IDE-SET
title: "Antigravity IDE Settings Integration (antigravity.harness.*), Pure Monitor Sidecar & AES-256-GCM Secret Vault"
collection: experiment-knowledge
domain: software-engineering
task_id: task-008-ide-settings-and-aes256-secret-vault
status: active
repo: Harness2-RAG-antigravity
git_revision: f3321e5
created_at: "2026-11-07T06:06:02.602Z"
cue: "When integrating model/harness configuration and API keys in Antigravity IDE, keep the Auxiliary Pane sidecar strictly as a 4-tab Monitor UI, place non-secret configuration in Antigravity IDE Settings (.vscode/settings.json + contributes.configuration), and encrypt API keys in ~/.gemini/config/.secrets.vault.enc (AES-256-GCM, mode 0600) or ~/.env so keys never leak to git, chat, or HTTP responses."
tags: [harness2, experience]
evidence_links:
  - ".harness/library/software-engineering/harnesses/task-008-ide-settings-and-aes256-secret-vault/harness/manifest.json"
  - "src/secret-vault.mjs"
  - "scripts/manage-secrets.mjs"
  - ".vscode/settings.json"
  - "schemas/antigravity-settings.schema.json"
  - "vscode-extension/package.json"
  - "sidecars/harness-ide-monitor/ui/index.html"
  - "test/harness-ide.test.mjs"
---

# Antigravity IDE Settings Integration (antigravity.harness.*), Pure Monitor Sidecar & AES-256-GCM Secret Vault

## 1. What Task or Problem Produced This Lesson?
- **Task ID**: `task-008-ide-settings-and-aes256-secret-vault`
- **Problem**: Configuration and API key inputs were previously rendered inside a 5th Settings tab in the sidecar page, risking separation-of-concerns confusion and potential API key exposure in JSON files or HTTP payloads.

## 2. Which Repository and Revision Did It Apply To?
- **Repository**: `Harness2-RAG-antigravity`
- **Git Revision**: `f3321e5`
- **Domain**: `software-engineering`

## 3. What Was Actually Observed?
Moved all non-secret harness, model, reasoning depth/effort, RAG, and search configuration into Antigravity IDE Settings (.vscode/settings.json, schemas/antigravity-settings.schema.json, and vscode-extension/package.json contributes.configuration), stripped Tab 5 (Settings) and all password inputs from the sidecar UI so it is purely a 4-tab Monitor, and implemented src/secret-vault.mjs (AES-256-GCM encrypted vault at ~/.gemini/config/.secrets.vault.enc + ~/.env fallback + scripts/manage-secrets.mjs hidden-stdin CLI). All 8/8 automated tests pass with zero secret leakage.

## 4. Which Evidence Supports the Conclusion?
- `.harness/library/software-engineering/harnesses/task-008-ide-settings-and-aes256-secret-vault/harness/manifest.json`
- `src/secret-vault.mjs`
- `scripts/manage-secrets.mjs`
- `.vscode/settings.json`
- `schemas/antigravity-settings.schema.json`
- `vscode-extension/package.json`
- `sidecars/harness-ide-monitor/ui/index.html`
- `test/harness-ide.test.mjs`

## 5. Is the Conclusion Still Current?
- **Status**: `active`
- **Recorded At**: `2026-11-07T06:06:02.602Z`
