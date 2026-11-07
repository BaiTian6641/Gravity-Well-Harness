---
docid: EXP-SOFT-TASK-004-REALTIM
title: "Real-Time 1s Telemetry Streaming, Token Auth Fallback & Zero-Downtime Sidecar Hot-Reload"
collection: experiment-knowledge
domain: software-engineering
task_id: task-004-realtime-telemetry-and-hot-reload
status: active
repo: Harness2-RAG-antigravity
git_revision: 818ae1b
created_at: "2026-11-07T03:03:31.034Z"
cue: "When Auxiliary Pane sidecar statistics appear frozen or fail to update after setup.mjs, ensure apiFetch injects X-Sidecar-Token from script src token fallback, format compact tokens with 3 decimals (>=5M) and seconds on multi-hour durations, advance all RUNNING nodes and context analytics via a 1s wall-clock ticker, and use a zero-downtime /api/reload + launcher retry loop."
tags: [sidecar, realtime-telemetry, token-dna, hot-reload, gravity-well-harness]
evidence_links:
  - ".harness/library/software-engineering/harnesses/task-004-realtime-telemetry-and-hot-reload/harness/manifest.json"
  - "sidecars/harness-ide-monitor/server.mjs"
  - "sidecars/harness-ide-monitor/ui/app.js"
  - "sidecars/harness-ide-monitor/launch.mjs"
  - "setup.mjs"
---

# Real-Time 1s Telemetry Streaming, Token Auth Fallback & Zero-Downtime Sidecar Hot-Reload

## 1. What Task or Problem Produced This Lesson?
- **Task ID**: `task-004-realtime-telemetry-and-hot-reload`
- **Problem**: Make all times, token counts, costs, steps, context window percentages, latency donuts, and throughput statistics update in real time every second in the Gravity Well Harness Auxiliary Pane UI Sidecar.

## 2. Which Repository and Revision Did It Apply To?
- **Repository**: `Harness2-RAG-antigravity`
- **Git Revision**: `818ae1b`
- **Domain**: `software-engineering`

## 3. What Was Actually Observed?
Resolved two root causes of frozen statistics in the Auxiliary Pane UI Sidecar: (1) sidecar_sdk requires X-Sidecar-Token on POST API requests while iframe location.search may omit ?token=, so apiFetch now extracts the token from script/link asset query strings and server.mjs registers both GET and POST handlers; (2) compact number formatting at >=5M now uses 3 decimal places (e.g. 25.544M -> 25.565M) and multi-hour durations include seconds (46h06m32s -> 46h06m36s) while packFormation and gatherContextAnalytics tick every 1s via getLiveWallSec(). Also added zero-downtime /api/reload and launcher retry loop in launch.mjs + setup.mjs.

## 4. Which Evidence Supports the Conclusion?
- `.harness/library/software-engineering/harnesses/task-004-realtime-telemetry-and-hot-reload/harness/manifest.json`
- `sidecars/harness-ide-monitor/server.mjs`
- `sidecars/harness-ide-monitor/ui/app.js`
- `sidecars/harness-ide-monitor/launch.mjs`
- `setup.mjs`

## 5. Is the Conclusion Still Current?
- **Status**: `active`
- **Recorded At**: `2026-11-07T03:03:31.034Z`
