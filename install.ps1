# PowerShell One-Step Installer for Harness2 + Local RAG Antigravity IDE
$ErrorActionPreference = "Stop"
Write-Host "Installing dependencies and activating Harness2 + Local RAG IDE for Antigravity..." -ForegroundColor Cyan
npm install --no-package-lock
node setup.mjs
npm test
