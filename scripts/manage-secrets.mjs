#!/usr/bin/env node
import fs from 'node:fs';
import {
  SUPPORTED_SECRET_KEYS,
  getSecretVaultStatusSummary,
  setSecretInVault,
} from '../src/secret-vault.mjs';

const args = process.argv.slice(2);
const cmd = (args[0] || 'status').toLowerCase();

if (cmd === 'status') {
  const summary = getSecretVaultStatusSummary();
  console.log('================================================================');
  console.log('  Gravity Well Harness — Secret Credential Vault Status');
  console.log(`  Encrypted Vault: ${summary.vaultPath} (${summary.cipher})`);
  console.log(`  Safe DotEnv Fallback: ${summary.dotenvPath}`);
  console.log('================================================================');
  for (const [keyName, info] of Object.entries(summary.credentials)) {
    console.log(`  ${keyName.padEnd(22)} : ${info.badge} (${info.source})`);
  }
  console.log('================================================================');
  console.log('To store a key with hidden terminal input (zero command-history leak):');
  console.log(
    '  PowerShell : $s = Read-Host "Enter DEEPSEEK_API_KEY" -AsSecureString; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)) | node scripts/manage-secrets.mjs set-stdin DEEPSEEK_API_KEY'
  );
  console.log(
    '  Bash/Zsh   : printf "Enter DEEPSEEK_API_KEY (typing hidden): " && read -s val && echo && printf "%s" "$val" | node scripts/manage-secrets.mjs set-stdin DEEPSEEK_API_KEY'
  );
  process.exit(0);
}

if (cmd === 'set-stdin') {
  const keyName = (args[1] || '').trim();
  if (!SUPPORTED_SECRET_KEYS.includes(keyName)) {
    console.error(
      `Unsupported key '${keyName}'. Supported keys: ${SUPPORTED_SECRET_KEYS.join(', ')}`
    );
    process.exit(1);
  }
  const secretValue = fs.readFileSync(0, 'utf8').trim();
  const res = setSecretInVault(keyName, secretValue);
  console.log(
    `🔒 Stored '${keyName}' encrypted in ${res.vaultPath} (AES-256-GCM, mode 0600). Value was never echoed or logged.`
  );
  process.exit(0);
}
