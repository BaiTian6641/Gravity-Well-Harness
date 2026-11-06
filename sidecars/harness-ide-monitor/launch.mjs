import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSidecarLauncher } from 'antigravity-sidecar-kit/launcher';

const __dirname = realpathSync(dirname(fileURLToPath(import.meta.url)));

await runSidecarLauncher({
  targetPath: join(__dirname, 'server.mjs'),
  sidecarName: 'Harness² Swarm & RAG Monitor',
  repoRoot: __dirname,
});
