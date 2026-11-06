---
docid: CONSTRAINTS-001
title: "System & Cross-Platform Constraints (IDE, Subagent Swarm, Frontend & Backend)"
collection: project-knowledge
domain: system-constraints
status: active
repo: Harness2-RAG-antigravity
git_revision: HEAD
created_at: "2026-11-07T02:55:30Z"
tags: [constraints, antigravity, sidecar, android, linux, windows, security]
---

# System & Cross-Platform Constraints

## 1. Local-First Knowledge & Privacy Constraint
- All project architecture decisions, experiment logs, and Harness² experience libraries **MUST** be stored locally in `.harness/` as human-readable Markdown and JSON files.
- Derived search indices (`.harness/index/`) and runtime telemetry (`.harness/runtime/`) are generated locally on-device and excluded from Git via `.gitignore`.

## 2. Antigravity Auxiliary Pane UI & Loopback Security
- The UI Extension Sidecar (`harness-ide-monitor`) **MUST** bind exclusively to `127.0.0.1` (loopback) and authenticate UI asset requests with `ANTIGRAVITY_SIDECAR_UI_TOKEN` via `sidecar_sdk` and `antigravity-sidecar-kit`.
- On Windows, quitting Antigravity may terminate `language_server.exe` without stopping child processes; sidecars must monitor the Language Server health (`exitWithLanguageServer`) to prevent orphaned background processes.

## 3. Cross-Stack Engineering Constraints (Android Frontend & Linux/Node Backend)
- When developing multi-surface engineering projects (e.g., Android client frontend + Linux/Node backend services):
  - Keep API schemas and protocol contracts explicitly documented in `.harness/knowledge/project/`.
  - Enable **Google Developer Knowledge MCP** in the Harness IDE Settings when working on Android SDK, Jetpack, Firebase, or Google Cloud components.
  - Use **Context7 MCP** to verify exact library versions before introducing new dependencies.

## 4. Harness² Comparison Consistency (Snapshot Isolation)
- During any `Propose -> Probe -> Compose` comparison of $K$ candidate harnesses, all $K$ candidates **MUST** read from the same frozen knowledge snapshot (`snapshot_id`).
- Candidate probes must never write directly to `status: active` in `.harness/library/`; only the post-comparison `Compose / Reflect` step promotes winning lessons to the active library.
