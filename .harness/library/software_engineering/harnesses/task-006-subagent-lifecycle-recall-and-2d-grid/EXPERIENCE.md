---
docid: EXP-SOFT-TASK-006-SUBAGEN
title: "Accurate Subagent Completion Status Check, Hide Inactive First + Recall to Rejoin Network Graph, and 2D Multi-Column Grid Layout"
collection: experiment-knowledge
domain: software_engineering
task_id: task-006-subagent-lifecycle-recall-and-2d-grid
status: active
repo: Harness2-RAG-antigravity
git_revision: 4a860d5
created_at: "2026-11-07T04:53:00.385Z"
cue: "When encountering tasks matching 'task-006-subagent-lifecycle-recall-and-2d-grid' in domain 'software_engineering', apply the verified harness configuration."
tags: [harness2, experience]
evidence_links:
  - ".harness/library/software_engineering/harnesses/task-006-subagent-lifecycle-recall-and-2d-grid/harness/manifest.json"
  - "plugin/harness-ide/scripts/hooks/post-tool-use.mjs"
  - "sidecars/harness-ide-monitor/server.mjs"
  - "sidecars/harness-ide-monitor/ui/app.js"
  - "sidecars/harness-ide-monitor/ui/styles.css"
  - "test/harness-ide.test.mjs"
---

# Accurate Subagent Completion Status Check, Hide Inactive First + Recall to Rejoin Network Graph, and 2D Multi-Column Grid Layout

## 1. What Task or Problem Produced This Lesson?
- **Task ID**: `task-006-subagent-lifecycle-recall-and-2d-grid`
- **Problem**: Completed subagents were remaining shown as RUNNING when no probe lock was active or after earlier turns finished; displaying all subagents under one parent node in a 1D horizontal straight line wasted horizontal space; and inactive subagents needed to be hidden first until recalled.

## 2. Which Repository and Revision Did It Apply To?
- **Repository**: `Harness2-RAG-antigravity`
- **Git Revision**: `4a860d5`
- **Domain**: `software_engineering`

## 3. What Was Actually Observed?
Refining post-tool-use.mjs, scanRecentBrainTranscripts, and buildSwarmFormations to transition subagents to COMPLETED on subsequent turns, manage_subagents kills, system stop notices, or inactive probe locks accurately marks finished subagents as COMPLETED. Hiding inactive subagents first (hideInactiveSubagents = true) with an #inactive-subagents-dock tray and /api/swarm/recall (plus automatic recall on send_message / invoke_subagent) lets recalled subagents rejoin the active graph with nearest-visible-ancestor edge bridging. Grouping children by parent into a 2D CSS Grid (.subagent-cards-grid, 2x2 / 3x2 / 3x3 / 4xM) fits large subagent teams cleanly under each parent node.

## 4. Which Evidence Supports the Conclusion?
- `.harness/library/software_engineering/harnesses/task-006-subagent-lifecycle-recall-and-2d-grid/harness/manifest.json`
- `plugin/harness-ide/scripts/hooks/post-tool-use.mjs`
- `sidecars/harness-ide-monitor/server.mjs`
- `sidecars/harness-ide-monitor/ui/app.js`
- `sidecars/harness-ide-monitor/ui/styles.css`
- `test/harness-ide.test.mjs`

## 5. Is the Conclusion Still Current?
- **Status**: `active`
- **Recorded At**: `2026-11-07T04:53:00.385Z`
