#!/usr/bin/env bash
set -euo pipefail
echo "Installing dependencies and activating Harness2 + Local RAG IDE for Antigravity..."
npm install --no-package-lock
node setup.mjs
npm test
