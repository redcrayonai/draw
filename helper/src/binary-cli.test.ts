import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { claimCapture } from '../../shared/capture';

const helper = join(dirname(fileURLToPath(import.meta.url)), '..');
let directory: string, bundle: string, preload: string;

beforeAll(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'draw-binary-cli-')));
  bundle = join(directory, 'draw.mjs'); preload = join(directory, 'preload.mjs');
  // Match production's two build stages: the version define is applied after the helper is bundled.
  const cli = join(directory, 'redcrayon.mjs');
  await build({
    entryPoints: [join(helper, 'src/cli.ts')], outfile: cli,
    bundle: true, platform: 'node', format: 'esm', target: 'node20',
    plugins: [{ name: 'preview', setup(builder) {
      builder.onLoad({ filter: /\/src\/capture\.ts$/ }, args => args.path === join(helper, 'src/capture.ts') ? {
        contents: readFileSync(args.path, 'utf8').replace(/^export const HELPER_VERSION = '[^']+';$/m, "export const HELPER_VERSION = '1.3.0-rc.1';"), loader: 'ts',
      } : undefined);
    } }],
  });
  await build({
    entryPoints: [join(helper, 'src/binary-cli.ts')], outfile: bundle,
    bundle: true, platform: 'node', format: 'esm', target: 'node20',
    define: { __DRAW_VERSION__: '"1.3.0-rc.1"' },
    banner: { js: 'import {createRequire} from "node:module"; const require = createRequire(import.meta.url);' },
    plugins: [{ name: 'bundled-helper', setup(builder) {
      builder.onResolve({ filter: /\/dist\/redcrayon\.mjs$/ }, () => ({ path: cli }));
    } }],
  });
  writeFileSync(preload, `
    import os from 'node:os';
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { existsSync, writeFileSync } from 'node:fs';
    os.homedir = () => ${JSON.stringify(directory)};
    cp.execFile = (file, args, callback) => {
      writeFileSync(${JSON.stringify(join(directory, 'opened'))}, args[0]); callback(null);
    };
    syncBuiltinESMExports();
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    Object.defineProperty(process.stderr, 'isTTY', { value: true });
    delete process.env.CI; delete process.env.DRAW_NO_UPDATE_CHECK;
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith('https://registry.npmjs.org/')) {
        await new Promise(resolve => setTimeout(resolve, 250));
        if (!existsSync(${JSON.stringify(join(directory, 'opened'))})) throw new Error('Board must open before update completes');
        return Response.json({ name: '@redcrayonai/draw', version: '2.0.0', drawRuntime: { protocol: 1 },
          optionalDependencies: { ['@redcrayonai/draw-' + process.platform + '-' + process.arch]: '2.0.0' } });
      }
      if (String(url).endsWith('/facts')) {
        writeFileSync(${JSON.stringify(join(directory, 'capture.json'))}, options.body);
        return Response.json({ capture: 'cap_abcdefghijklmnopqrstuv' });
      }
      return Response.json([]);
    };
  `);
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function run(args: string[], cwd = directory) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, ['--import', preload, bundle, ...args], { cwd, timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message)); else resolve({ stdout, stderr });
    });
  });
}

it('preview captures are accepted by the existing hosted validator while the CLI keeps its full version', async () => {
  const repo = join(directory, 'repo'); mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: repo });
  const { stdout } = await run(['capture', 'start'], repo);
  const body = JSON.parse(readFileSync(join(directory, 'capture.json'), 'utf8'));
  expect((await claimCapture(stdout.trim(), body, { tool: 'start_session' })).ok).toBe(true);
  expect(body.helper).toBe('1.3.0');
  expect((await run(['--version'])).stdout).toContain('1.3.0-rc.1');
});

it('reopening a board completes and caches the update check before exiting', async () => {
  const store = join(directory, 'store'); mkdirSync(store);
  writeFileSync(join(store, 'endpoint.json'), JSON.stringify({ origin: 'http://127.0.0.1:12345', token: 'a'.repeat(64), repo: directory }));
  const { stderr } = await run(['--repo', directory, '--store', store]);
  expect(stderr).toContain('Draw: http://127.0.0.1:12345/');
  expect(stderr).toContain('Draw 2.0.0 is available');
  expect(JSON.parse(readFileSync(join(directory, '.redcrayon/updates', `${process.platform}-${process.arch}-stable.json`), 'utf8'))).toMatchObject({ state: 'available', version: '2.0.0' });
});
