import { execFileSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync('pnpm', ['-C', 'client', 'build'], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, ['build.mjs'], { cwd: fileURLToPath(new URL('./', import.meta.url)), stdio: 'inherit' });
const destination = new URL('./dist/local-assets', import.meta.url);
rmSync(destination, { recursive: true, force: true });
cpSync(new URL('../client/dist', import.meta.url), destination, { recursive: true });
