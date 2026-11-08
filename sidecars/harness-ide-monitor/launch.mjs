import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = realpathSync(dirname(fileURLToPath(import.meta.url)));

const res = spawnSync(process.execPath, [join(__dirname, 'server.mjs')], {
  cwd: __dirname,
  stdio: 'inherit',
  env: process.env,
});
process.exit(res.status ?? 0);
