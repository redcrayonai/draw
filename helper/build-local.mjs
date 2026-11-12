import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync('pnpm', ['-C', 'client', 'build'], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, ['build.mjs'], { cwd: fileURLToPath(new URL('./', import.meta.url)), stdio: 'inherit' });
const destination = new URL('./dist/local-assets', import.meta.url);
rmSync(destination, { recursive: true, force: true });
cpSync(new URL('../client/dist', import.meta.url), destination, { recursive: true });
cpSync(new URL('../plugin/local/', import.meta.url), new URL('./dist/', import.meta.url), { recursive: true });
await build({ absWorkingDir: fileURLToPath(new URL('./', import.meta.url)), entryPoints: ['src/local-pi-extension.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: 'dist/local-pi-extension.mjs' });
// Codex caches installed plugin versions; rebuilding must produce a fresh cache key.
const hash = createHash('sha256');
for (const file of ['redcrayon.mjs', 'local-pi-extension.mjs', 'local-assets/local.html', 'skills/local/SKILL.md', 'mcp.json', 'plugin.json', '.codex-plugin/plugin.json']) hash.update(readFileSync(new URL(`./dist/${file}`, import.meta.url)));
const fingerprint = hash.digest('hex').slice(0, 12);
for (const file of ['plugin.json', '.codex-plugin/plugin.json']) {
  const path = new URL(`./dist/${file}`, import.meta.url), manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.version += `+local.${fingerprint}`;
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
}
