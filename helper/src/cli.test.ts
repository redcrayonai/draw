// The built helper (build.mjs output), run as an agent runs it: from a
// project directory, git on PATH, the network only through REDCRAYON_ORIGIN,
// here a local server that counts requests.
import { execFile, execFileSync } from 'node:child_process';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CAPTURE_ID_RE, MB, MIN_HELPER_VERSION, claimCapture, newCaptureId, type CaptureBody, type CheckpointBody, type FileBody } from '../../shared/capture';
import { HELPER_VERSION, HOOK_MATCHER, PRIVACY, buildCapture, githubRemote } from './capture';

const HELPER = join(dirname(new URL(import.meta.url).pathname), '..');
let dir: string;
let bundle: string;
let origin: string;
// The helper keeps its state per server: <git-common-dir>/redcrayon/<host>/.
const stateHost = () => new URL(origin).host.replace(/[^A-Za-z0-9.-]/g, '_');
let server: ReturnType<typeof createServer>;
let requests: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[] = [];
let responseDelayMs = 0;
let activeUploads = 0;
let peakUploads = 0;

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'rc-helper-')));
  bundle = join(dir, 'redcrayon.mjs');
  execFileSync(process.execPath, ['build.mjs', bundle], { cwd: HELPER });
  server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      peakUploads = Math.max(peakUploads, ++activeUploads);
      res.setHeader('content-type', 'application/json');
      const timer = setTimeout(() => res.end(req.url === '/facts' ? JSON.stringify({ capture: newCaptureId() }) : '{}'), responseDelayMs);
      res.once('close', () => { clearTimeout(timer); activeUploads--; });
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  requests = [];
  responseDelayMs = 0;
  activeUploads = 0;
  peakUploads = 0;
});

type Run = { code: number; stdout: string; stderr: string };
function run(args: string[], opts: { cwd: string; input?: string; env?: Record<string, string>; node?: string[] }): Promise<Run> {
  return new Promise(done => {
    const child = execFile(
      process.execPath,
      [...(opts.node ?? []), bundle, ...args],
      { cwd: opts.cwd, env: { ...process.env, ...GIT_ENV, REDCRAYON_ORIGIN: origin, ...opts.env } },
      (err, stdout, stderr) => done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr })
    );
    child.stdin!.end(opts.input ?? '');
  });
}

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' }).trim();
let n = 0;
function repo(files: Record<string, string | Buffer> = {}, init: string[] = []): string {
  const root = join(dir, `repo-${n++}`);
  mkdirSync(root);
  sh(root, 'init', '-q', '-b', 'main', ...init);
  for (const [rel, text] of Object.entries({ 'src/a.ts': 'export const a = 1;\n', ...files })) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'base');
  return root;
}
const bodies = () => requests.filter(r => r.url === '/facts').map(r => JSON.parse(r.body) as CaptureBody);
const status = (root: string) => sh(root, 'status', '--porcelain', '--untracked-files=all', '--ignored');

/** One capture command that worked: one cap_ line on stdout, one upload. */
async function captured(args: string[], cwd: string): Promise<CaptureBody> {
  const before = requests.length;
  const r = await run(['capture', ...args], { cwd });
  expect(r).toMatchObject({ code: 0 });
  expect(r.stdout).toMatch(/^cap_[A-Za-z0-9]{22}\n$/);
  expect(CAPTURE_ID_RE.test(r.stdout.trim())).toBe(true);
  expect(requests.length).toBe(before + 1);
  return bodies().at(-1)!;
}

/** One refusal: exit 1, the exact line on stderr, nothing on stdout, no request. */
async function refusal(args: string[], cwd: string, opts: { env?: Record<string, string> } = {}): Promise<string> {
  const r = await run(args, { cwd, ...opts });
  expect(r.code).toBe(1);
  expect(r.stdout).toBe('');
  expect(r.stderr.endsWith('\n') && r.stderr.split('\n').length).toBe(2);
  expect(requests).toEqual([]);
  return r.stderr.trimEnd();
}

describe('the bundle', () => {
  it('imports Node built-ins only, and carries the package version', () => {
    const text = readFileSync(bundle, 'utf8');
    const imports = [...text.matchAll(/^import .* from "([^"]+)";$/gm)].map(m => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter(p => !p.startsWith('node:'))).toEqual([]);
    expect(JSON.parse(readFileSync(join(HELPER, 'package.json'), 'utf8')).version).toBe(HELPER_VERSION);
    const [a, b] = [HELPER_VERSION, MIN_HELPER_VERSION].map(v => v.split('.').map(Number));
    expect(a[0] * 1e6 + a[1] * 1e3 + a[2]).toBeGreaterThanOrEqual(b[0] * 1e6 + b[1] * 1e3 + b[2]);
  });
});

describe('capture commands', () => {
  it('capture start uploads the top level, HEAD and object format, and prints the privacy line once', async () => {
    const root = repo();
    const first = await run(['capture', 'start'], { cwd: join(root, 'src') });
    expect(first.code).toBe(0);
    expect(first.stdout).toMatch(/^cap_[A-Za-z0-9]{22}\n$/);
    expect(first.stderr).toBe(`${PRIVACY}\n`);
    expect(bodies()).toEqual([{ v: 1, helper: HELPER_VERSION, kind: 'start', toplevel: root, objectFormat: 'sha1', head: sh(root, 'rev-parse', 'HEAD') }]);
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/facts', headers: { 'content-type': 'application/json' } });
    expect(requests[0].headers.origin).toBeUndefined();
    const second = await run(['capture', 'start'], { cwd: root });
    expect(second).toMatchObject({ code: 0, stderr: '' });
  });

  it('capture ref and cite upload one file in git spelling, record it for the board, and leave git status as it was', async () => {
    const root = repo({ 'README.md': '# R\n', 'notes.txt': 'n\n' });
    writeFileSync(join(root, 'src/new.ts'), 'export const fresh = 1;\n'); // untracked, not ignored: citable
    const before = status(root);
    const ref = (await captured(['ref', './src//a.ts', '--board', '7'], root)) as FileBody;
    expect(ref).toMatchObject({ kind: 'ref', asked: './src//a.ts', file: { path: 'src/a.ts', citable: true, sha: sh(root, 'hash-object', 'src/a.ts') } });
    expect(Buffer.from(ref.file.bytes, 'base64').toString()).toBe('export const a = 1;\n');
    expect((await captured(['cite', 'README.md', '--board', '7'], root)).kind).toBe('cite');
    expect((await captured(['cite', 'src/new.ts', '--board', '7'], root)).kind).toBe('cite');
    await captured(['ref', 'notes.txt'], root); // no --board: nothing recorded
    expect(JSON.parse(readFileSync(join(root, '.git/redcrayon', stateHost(), 'cited/7'), 'utf8'))).toEqual(['src/a.ts', 'README.md', 'src/new.ts']);
    expect(status(root)).toBe(before);
    const claimed = await claimCapture(newCaptureId(), ref, { tool: 'add_code_ref', path: './src//a.ts', board: { id: 7, name: 'main', repoRoot: root, baseSha: ref.head } });
    expect(claimed.ok).toBe(true);
  });

  it('refuses locally, with no request: the secret list, ignored files, symlinks, binaries and files over 1 MB', async () => {
    const outside = join(dir, 'outside.ts');
    writeFileSync(outside, 'export const x = 1;\n');
    const root = repo({ '.gitignore': 'dist/\n', '.env.local': 'K=v\n', 'config/server.pem': 'pem\n', 'id_rsa': 'k\n', 'logo.dat': Buffer.from([1, 0, 2]) });
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist/out.js'), 'x\n');
    writeFileSync(join(root, 'big.ts'), 'a'.repeat(Math.round(3.2 * MB)));
    symlinkSync(outside, join(root, 'link.ts'));
    const secret = (p: string) => `redcrayon: ${p} is ignored by git or looks like a secrets file; code refs never read it. Cite another file.`;
    for (const p of ['.env.local', 'config/server.pem', 'id_rsa', 'dist/out.js']) expect(await refusal(['capture', 'ref', p, '--board', '1'], root)).toBe(secret(p));
    expect(await refusal(['capture', 'cite', 'logo.dat'], root)).toBe('redcrayon: logo.dat is a binary file; code refs read text. Cite another file.');
    expect(await refusal(['capture', 'ref', 'big.ts'], root)).toBe('redcrayon: big.ts is 3.2 MB; code refs read files up to 1 MB. Cite a smaller file.');
    expect(await refusal(['capture', 'ref', 'link.ts'], root)).toBe("redcrayon: path 'link.ts' is a symlink; cite the target file instead.");
    expect(await refusal(['capture', 'ref', '../outside.ts'], root)).toBe("redcrayon: path '../outside.ts' escapes the repo root.");
    expect(await refusal(['capture', 'ref', 'src/none.ts'], root)).toBe("redcrayon: no such file in repo: 'src/none.ts'.");
    expect(existsSync(join(root, '.git/redcrayon', stateHost(), 'cited/1'))).toBe(false);
  });

  it('refuses outside a repository, and without git', async () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    const notRepo = `redcrayon: ${plain} is not inside a git repository. Code refs and checkpoints need a git checkout: start the agent in your project.`;
    expect(await refusal(['capture', 'start'], plain)).toBe(notRepo);
    expect(await refusal(['capture', 'ref', 'a.ts', '--board', '1'], plain)).toBe(notRepo);
    expect(await refusal(['capture', 'start'], repo(), { env: { PATH: join(dir, 'no-bin') } })).toBe(
      'redcrayon: code refs need git on PATH, and git was not found. Install git, then call again.'
    );
  });

  it('says so when the origin cannot be reached', async () => {
    const r = await run(['capture', 'start'], { cwd: repo(), env: { REDCRAYON_ORIGIN: 'http://127.0.0.1:9' } });
    expect(r).toEqual({
      code: 1,
      stdout: '',
      stderr: 'redcrayon: could not reach 127.0.0.1:9. Nothing was uploaded. Check the network (in a sandboxed agent, allow network access for this command), then call again.\n',
    });
  });

  it('a checkpoint uploads the lists, the hunks as numbers and the bytes of the board\'s cited files only', async () => {
    const root = repo({ 'src/b.ts': 'export const b = 1;\n', 'src/c.ts': 'export const c = 1;\n', 'logo.dat': 'not yet binary\n' });
    const base = sh(root, 'rev-parse', 'HEAD');
    for (const p of ['src/a.ts', 'src/b.ts', 'logo.dat']) await captured(['ref', p, '--board', '3'], root);
    await captured(['ref', 'src/c.ts', '--board', '4'], root); // another board's
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 1;\nexport const a2 = 2;\n');
    unlinkSync(join(root, 'src/b.ts'));
    writeFileSync(join(root, 'logo.dat'), Buffer.from([0, 1]));
    writeFileSync(join(root, 'src/new.ts'), 'export const fresh = 1;\n');
    writeFileSync(join(root, 'docs.md'), 'more\n');
    const before = status(root);
    const body = (await captured(['checkpoint', '--board', '3', '--base', base, '--also', 'docs.md'], root)) as CheckpointBody;
    expect(status(root)).toBe(before);
    expect(body).toMatchObject({ kind: 'checkpoint', base, head: base, changed: ['logo.dat', 'src/a.ts'], uncompared: {}, deleted: ['src/b.ts'] });
    expect(body.hunks).toEqual({ 'src/a.ts': [[2, 2]], 'logo.dat': [] }); // a binary diff has no line ranges
    expect(body.untracked.sort()).toEqual(['docs.md', 'src/new.ts']);
    expect(body.files.map(f => ('bytes' in f ? `${f.path} bytes` : 'missing' in f ? `${f.path} missing` : `${f.path} unreadable`))).toEqual([
      'src/a.ts bytes',
      'src/b.ts missing',
      'logo.dat unreadable',
      'docs.md bytes',
    ]);
    const claimed = await claimCapture(newCaptureId(), body, { tool: 'arrive', board: { id: 3, name: 'main', repoRoot: root, baseSha: base } });
    expect(claimed.ok).toBe(true);
  });

  describe('remote, pushed and dirty (RC-690)', () => {
    // Only a github.com remote leaves the machine, as https without a user name or token; anything else is not sent.
    const GITHUB: [string, string][] = [
      ['https://github.com/o/r.git', 'https://github.com/o/r.git'],
      ['https://github.com/o/r', 'https://github.com/o/r'],
      ['https://user:tok@github.com/o/r.git', 'https://github.com/o/r.git'],
      ['https://tok@github.com/o/r', 'https://github.com/o/r'],
      ['http://GitHub.com/o/r.git/', 'https://github.com/o/r.git'],
      ['https://github.com:443/o/r.git', 'https://github.com/o/r.git'],
      ['git@github.com:o/r.git', 'https://github.com/o/r.git'],
      ['git@github.com:o/r', 'https://github.com/o/r'],
      ['github.com:o/r.git', 'https://github.com/o/r.git'],
      ['ssh://git@github.com/o/r.git', 'https://github.com/o/r.git'],
      ['ssh://git@github.com:22/o/r.git', 'https://github.com/o/r.git'],
      ['git://github.com/o/r.git', 'https://github.com/o/r.git'],
    ];
    const OTHER = [
      'https://gitlab.com/o/r.git',
      'git@gitlab.com:o/r.git',
      'https://github.com.evil.example/o/r.git',
      'https://evil.example/github.com/o/r.git',
      'https://github.com@evil.example/o/r.git',
      'git@github.com.evil.example:o/r.git',
      'git@github.com:../r',
      'https://github.com/o',
      'https://github.com/o/r/extra',
      'file:///home/alan/github.com/o/r',
      '/home/alan/github.com/o/r',
      '../r',
      'ssh://git@github.com.evil.example/o/r',
      `https://github.com/o/${'r'.repeat(2100)}`,
      '',
    ];

    it('githubRemote turns every github.com form into https without credentials, and sends nothing else', () => {
      for (const [raw, sent] of GITHUB) expect(githubRemote(raw), raw).toBe(sent);
      for (const raw of OTHER) expect(githubRemote(raw), raw).toBeUndefined();
      expect(githubRemote(undefined)).toBeUndefined();
    });

    it('capture start carries origin as githubRemote reads it; no origin, or one that is not github.com, sends no remote at all', async () => {
      const root = repo();
      expect(await captured(['start'], root)).not.toHaveProperty('remote');
      for (const [raw, sent] of GITHUB) {
        sh(root, 'config', 'remote.origin.url', raw);
        expect(await captured(['start'], root), raw).toMatchObject({ kind: 'start', remote: sent });
      }
      for (const raw of OTHER.filter(r => r !== '')) {
        sh(root, 'config', 'remote.origin.url', raw);
        const body = await captured(['start'], root);
        expect(body, raw).not.toHaveProperty('remote');
        expect(JSON.stringify(body), raw).not.toContain('evil.example');
      }
      sh(root, 'config', 'remote.origin.url', 'https://user:SECRETTOKEN@github.com/o/r.git');
      expect(await captured(['ref', 'src/a.ts'], root)).toMatchObject({ kind: 'ref', remote: 'https://github.com/o/r.git' }); // ref and cite carry it too
      expect(requests.at(-1)!.body).not.toContain('SECRETTOKEN'); // the token is never uploaded
    });

    it('a checkpoint says whether HEAD is pushed, and which cited files differ from HEAD', async () => {
      const root = repo({ 'src/b.ts': 'export const b = 1;\n' });
      const bare = join(dir, `bare-${n++}.git`);
      sh(dir, 'init', '-q', '--bare', '-b', 'main', bare);
      sh(root, 'remote', 'add', 'origin', bare);
      const base = sh(root, 'rev-parse', 'HEAD');
      for (const p of ['src/a.ts', 'src/b.ts']) await captured(['ref', p, '--board', '8'], root);
      const checkpoint = async () => (await captured(['checkpoint', '--board', '8', '--base', base], root)) as CheckpointBody;

      // no upstream yet: not pushed; the local path of the bare remote is not sent
      expect(await checkpoint()).toMatchObject({ pushed: false, dirty: [] });
      expect(await checkpoint()).not.toHaveProperty('remote');

      sh(root, 'push', '-q', '-u', 'origin', 'main');
      expect(await checkpoint()).toMatchObject({ pushed: true, dirty: [] });

      // an uncommitted edit to a cited file, and to a file nobody cited
      writeFileSync(join(root, 'src/a.ts'), 'export const a = 2;\n');
      writeFileSync(join(root, 'README.md'), 'not cited\n');
      expect(await checkpoint()).toMatchObject({ pushed: true, dirty: ['src/a.ts'] });

      // a staged edit still differs from HEAD; a deleted cited file does too
      sh(root, 'add', 'src/a.ts');
      unlinkSync(join(root, 'src/b.ts'));
      expect(((await checkpoint()).dirty ?? []).sort()).toEqual(['src/a.ts', 'src/b.ts']);

      // committed but not pushed: clean, and ahead of its upstream
      sh(root, 'checkout', '-q', 'src/b.ts');
      sh(root, 'commit', '-q', '-am', 'edit');
      expect(await checkpoint()).toMatchObject({ pushed: false, dirty: [] });
      sh(root, 'push', '-q');
      expect(await checkpoint()).toMatchObject({ pushed: true, dirty: [] });

      // an untracked cited file is dirty
      writeFileSync(join(root, 'src/new.ts'), 'export const fresh = 1;\n');
      await captured(['ref', 'src/new.ts', '--board', '8'], root);
      expect(await checkpoint()).toMatchObject({ dirty: ['src/new.ts'] });

      // a detached HEAD has no upstream
      sh(root, 'checkout', '-q', '--detach');
      expect(await checkpoint()).toMatchObject({ pushed: false });
    });

    it('a checkpoint with a github.com origin carries remote, pushed and dirty, and the claim accepts it', async () => {
      const root = repo();
      const base = sh(root, 'rev-parse', 'HEAD');
      sh(root, 'remote', 'add', 'origin', 'git@github.com:o/r.git');
      await captured(['ref', 'src/a.ts', '--board', '9'], root);
      const body = (await captured(['checkpoint', '--board', '9', '--base', base], root)) as CheckpointBody;
      expect(body).toMatchObject({ remote: 'https://github.com/o/r.git', pushed: false, dirty: [] });
      expect((await claimCapture(newCaptureId(), body, { tool: 'mark_checkpoint', board: { id: 9, name: 'm', repoRoot: root, baseSha: base } })).ok).toBe(true);
    });
  });

  it('refuses a checkpoint capture over 8 MB, with no request', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 7; i++) files[`gen/${i}.ts`] = `// ${i}\n${'x'.repeat(MB - 10)}\n`;
    const root = repo(files);
    mkdirSync(join(root, '.git/redcrayon', stateHost(), 'cited'), { recursive: true });
    writeFileSync(join(root, '.git/redcrayon', stateHost(), 'cited/5'), JSON.stringify(Object.keys(files)));
    expect(await refusal(['capture', 'checkpoint', '--board', '5', '--base', sh(root, 'rev-parse', 'HEAD')], root)).toMatch(
      /^redcrayon: the checkpoint capture is 9\.\d MB; the limit is 8 MB\. Nothing was uploaded\. Remove code refs to large files, then call again\.$/
    );
  });

  it('a worktree shares the repository\'s state dir, keyed by board: its checkpoint holds none of another board\'s cited files', async () => {
    const root = repo({ 'src/b.ts': 'export const b = 1;\n' });
    const wt = join(dir, `wt-${n++}`);
    sh(root, 'worktree', 'add', '-q', '-b', 'other', wt);
    expect(readFileSync(join(wt, '.git'), 'utf8')).toMatch(/^gitdir: /); // a .git file, not a directory
    await captured(['ref', 'src/a.ts', '--board', '1'], root);
    const ref = (await captured(['ref', 'src/b.ts', '--board', '2'], wt)) as FileBody;
    expect(ref.toplevel).toBe(realpathSync(wt));
    expect(JSON.parse(readFileSync(join(root, '.git/redcrayon', stateHost(), 'cited/2'), 'utf8'))).toEqual(['src/b.ts']);
    const body = (await captured(['checkpoint', '--board', '2', '--base', sh(wt, 'rev-parse', 'HEAD')], wt)) as CheckpointBody;
    expect(body.files.map(f => f.path)).toEqual(['src/b.ts']);
  });

  it('a CRLF file carries git\'s LF sha, which the claim accepts for its raw bytes', async () => {
    const root = repo({ '.gitattributes': '* text=auto\n', 'win.txt': 'a\r\nb\r\n' });
    const body = (await captured(['ref', 'win.txt'], root)) as FileBody;
    expect(Buffer.from(body.file.bytes, 'base64').toString()).toBe('a\r\nb\r\n');
    expect(body.file.sha).toBe('422c2b7ab3b3c668038da977e4e93a5fc623169c'); // the blob of "a\nb\n"
    const claimed = await claimCapture(newCaptureId(), body, { tool: 'add_code_ref', path: 'win.txt', board: { id: 1, name: 'm', repoRoot: root, baseSha: body.head } });
    expect(claimed.ok).toBe(true);
  });

  it('a sha-256 repository says so, and its shas hold', async () => {
    const root = repo({}, ['--object-format=sha256']);
    const body = (await captured(['ref', 'src/a.ts'], root)) as FileBody;
    expect(body).toMatchObject({ objectFormat: 'sha256', head: expect.stringMatching(/^[0-9a-f]{64}$/), file: { sha: sh(root, 'hash-object', 'src/a.ts') } });
    const claimed = await claimCapture(newCaptureId(), body, { tool: 'add_code_ref', path: 'src/a.ts', board: { id: 1, name: 'm', repoRoot: root, baseSha: body.head } });
    expect(claimed.ok).toBe(true);
  });

  it('a file behind a clean filter (LFS-style) uploads, and the claim refuses it', async () => {
    const root = join(dir, `repo-${n++}`);
    mkdirSync(root);
    sh(root, 'init', '-q', '-b', 'main');
    sh(root, 'config', 'filter.lfs.clean', "printf 'version https://git-lfs.github.com/spec/v1\\n'");
    writeFileSync(join(root, '.gitattributes'), 'media.txt filter=lfs\n');
    writeFileSync(join(root, 'media.txt'), 'the real bytes\n');
    sh(root, 'add', '-A');
    sh(root, 'commit', '-q', '-m', 'base');
    const body = (await captured(['cite', 'media.txt'], root)) as FileBody;
    const claimed = await claimCapture(newCaptureId(), body, { tool: 'create_edge', path: 'media.txt', board: { id: 1, name: 'm', repoRoot: root, baseSha: body.head } });
    expect(claimed).toEqual({
      ok: false,
      text: 'REJECTED: media.txt is stored through a git filter such as LFS, so its bytes cannot be checked. Nothing was written. Cite another file.',
    });
  });

  it.runIf(process.platform === 'darwin')('another case and Unicode form of a path come back in git spelling (APFS)', async () => {
    const nfc = 'src/Café.ts'.normalize('NFC');
    const root = repo({ [nfc]: 'export const c = 1;\n' });
    const asked = 'src/café.ts'.normalize('NFD');
    const body = (await captured(['ref', asked], root)) as FileBody;
    expect(body.asked).toBe(asked);
    expect(body.file.path).toBe(nfc);
  });
});

describe('hook mode', () => {
  const pre = (tool: string, args: Record<string, unknown>, cwd: string) =>
    run(['hook'], { cwd, input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: args, cwd }) });
  const post = (tool: string, args: Record<string, unknown>, response: unknown, cwd: string) =>
    run(['hook'], { cwd, input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: tool, tool_input: args, tool_response: response, cwd }) });
  const updated = (r: Run) => (JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; updatedInput: Record<string, unknown> } }).hookSpecificOutput;

  it('matches the tools under every prefix, and nothing else', () => {
    const re = new RegExp(HOOK_MATCHER);
    for (const prefix of ['mcp__plugin_draw_draw__', 'mcp__draw__', 'mcp__draw-dev__', 'mcp__plugin_draw_redcrayon__', 'mcp__redcrayon__', 'mcp__redcrayon-dev__']) {
      for (const tool of ['start_session', 'add_code_ref', 'mark_checkpoint', 'create_edge', 'arrive', 'apply_board']) expect(re.exec(prefix + tool)?.[3]).toBe(tool);
    }
    for (const name of ['mcp__draw-live__add_code_ref', 'mcp__plugin_other_draw__add_code_ref', 'mcp__draw__create_node', 'mcp__other__add_code_ref', 'mcp__draw__add_code_ref_x', 'Bash']) expect(re.test(name)).toBe(false);
  });

  it('PreToolUse fills an empty capture, echoing every argument', async () => {
    const root = repo();
    const args = { board: 7, targetKind: 'node', targetId: 3, path: 'src/a.ts', symbol: 'a', capture: '' };
    const r = await pre('mcp__plugin_draw_draw__add_code_ref', args, root);
    expect(r.code).toBe(0);
    expect(updated(r)).toEqual({ hookEventName: 'PreToolUse', updatedInput: { ...args, capture: expect.stringMatching(CAPTURE_ID_RE) } });
    expect(bodies().map(b => b.kind)).toEqual(['ref']);
    expect(JSON.parse(readFileSync(join(root, '.git/redcrayon', stateHost(), 'cited/7'), 'utf8'))).toEqual(['src/a.ts']);
  });

  it('PreToolUse leaves a given capture, drawing and unknown tools alone', async () => {
    const root = repo();
    const quiet = { code: 0, stdout: '', stderr: '' };
    expect(await pre('mcp__draw__add_code_ref', { board: 7, path: 'src/a.ts', capture: 'cap_AAAAAAAAAAAAAAAAAAAAAA' }, root)).toEqual(quiet);
    expect(await pre('mcp__draw__create_edge', { board: 7, fromNode: 1, toNode: 2, label: 'x', evidence: 'import' }, root)).toEqual(quiet);
    expect(await pre('mcp__draw__create_node', { board: 7, label: 'x' }, root)).toEqual(quiet);
    expect(await pre('mcp__other__add_code_ref', { board: 7, path: 'src/a.ts' }, root)).toEqual(quiet);
    expect(await run(['hook'], { cwd: root, input: 'not json' })).toEqual(quiet);
    expect(requests).toEqual([]);
  });

  it('fills a separate capture for every source edge in a batch, preserving the rest', async () => {
    const root = repo();
    const supplied = 'cap_AAAAAAAAAAAAAAAAAAAAAA';
    const args = { board: '7', nodes: [{ key: 'api', label: 'API' }], layout: true, edges: [
      { fromNode: '$api', toNode: '2', label: 'calls', evidence: 'source:src/a.ts:1' },
      { fromNode: '$api', toNode: '3', label: 'calls', evidence: 'source:src/a.ts:1' },
      { fromNode: '2', toNode: '3', label: 'calls', evidence: 'source:src/a.ts:1', capture: supplied },
      { fromNode: '2', toNode: '3', label: 'scenario', evidence: 'agent:user described the topology' },
    ] };
    const r = await pre('mcp__draw__apply_board', args, root);
    expect(r.code).toBe(0);
    const input = updated(r).updatedInput;
    expect(input).toEqual({ ...args, edges: [
      { ...args.edges[0], capture: expect.stringMatching(CAPTURE_ID_RE) },
      { ...args.edges[1], capture: expect.stringMatching(CAPTURE_ID_RE) },
      args.edges[2], args.edges[3],
    ] });
    const edges = input.edges as { capture?: string }[];
    expect(edges[0].capture).not.toBe(edges[1].capture);
    expect(bodies().map(b => b.kind)).toEqual(['cite', 'cite']);
    expect(await pre('mcp__draw__apply_board', { board: '7', nodes: [] }, root)).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('blocks the whole batch if a source edge cites a secrets file', async () => {
    const root = repo({ '.env': 'K=v\n' });
    const r = await pre('mcp__draw__apply_board', { board: '7', edges: [{ evidence: 'source:.env:1' }] }, root);
    expect(r).toMatchObject({ code: 2, stdout: '', stderr: expect.stringContaining('looks like a secrets file') });
    expect(requests).toEqual([]);
  });

  it('uploads no captures when nodes plus edges plus layout exceed the batch limit', async () => {
    const root = repo();
    const r = await pre('mcp__draw__apply_board', { board: '7', nodes: Array.from({ length: 15 }, () => ({})), edges: [{ evidence: 'source:src/a.ts:1' }], layout: true }, root);
    expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(requests).toEqual([]);
  });

  it('uploads batch captures concurrently, at most three at once, without reordering edges', async () => {
    const root = repo();
    responseDelayMs = 150;
    const edges = Array.from({ length: 7 }, (_, i) => ({ fromNode: '1', toNode: '2', label: `edge-${i}`, evidence: 'source:src/a.ts:1' }));
    const r = await pre('mcp__draw__apply_board', { board: '7', edges }, root);
    expect(r.code).toBe(0);
    expect(peakUploads).toBe(3);
    const filled = updated(r).updatedInput.edges as { label: string; capture: string }[];
    expect(filled.map(e => e.label)).toEqual(edges.map(e => e.label));
    expect(new Set(filled.map(e => e.capture)).size).toBe(7);
  });

  it('stops slow batch captures within one shared deadline and asks for smaller batches', async () => {
    const root = repo();
    responseDelayMs = 300;
    const node = ['--import', 'data:text/javascript,const timeout=AbortSignal.timeout.bind(AbortSignal);AbortSignal.timeout=ms=>timeout(ms===35000?500:ms)'];
    const edges = Array.from({ length: 7 }, () => ({ fromNode: '1', toNode: '2', label: 'calls', evidence: 'source:src/a.ts:1' }));
    const r = await run(['hook'], { cwd: root, node, input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'mcp__draw__apply_board', tool_input: { board: '7', edges }, cwd: root }) });
    expect(r).toMatchObject({ code: 2, stdout: '', stderr: expect.stringContaining('Split apply_board') });
    expect(requests.length).toBeLessThan(edges.length);
  });

  it('checks elapsed time after synchronous capture building, before uploading or building more', async () => {
    const root = repo();
    const preload = 'import cp from "node:child_process";import {syncBuiltinESMExports} from "node:module";let offset=0;const now=Date.now.bind(Date);Date.now=()=>now()+offset;const exec=cp.execFileSync;cp.execFileSync=(file,args,opts)=>{const result=exec(file,args,opts);if(file==="git"&&args.includes("hash-object"))offset+=35001;return result};syncBuiltinESMExports();';
    const edges = Array.from({ length: 4 }, () => ({ fromNode: '1', toNode: '2', label: 'calls', evidence: 'source:src/a.ts:1' }));
    const r = await run(['hook'], { cwd: root, node: ['--import', `data:text/javascript,${encodeURIComponent(preload)}`], input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'mcp__draw__apply_board', tool_input: { board: '7', edges }, cwd: root }) });
    expect(r).toMatchObject({ code: 2, stdout: '', stderr: expect.stringContaining('Split apply_board') });
    expect(requests).toEqual([]);
  });

  it('limits a synchronous Git clean filter by the capture deadline', () => {
    const root = repo();
    sh(root, 'config', 'filter.slow.clean', 'sleep 0.2; cat');
    writeFileSync(join(root, '.gitattributes'), '*.ts filter=slow\n');
    expect(() => buildCapture('cite', { cwd: root, path: 'src/a.ts', board: '7' }, Date.now() + 100)).toThrow(/timed out/);
  });

  it('PreToolUse blocks a call that needs a capture the helper refuses (exit 2, the helper line), and never start_session', async () => {
    const root = repo({ '.env': 'K=v\n' });
    const r = await pre('mcp__draw__create_edge', { board: 7, fromNode: 1, toNode: 2, label: 'x', evidence: 'source:.env:1' }, root);
    expect(r).toEqual({ code: 2, stdout: '', stderr: 'redcrayon: .env is ignored by git or looks like a secrets file; code refs never read it. Cite another file.\n' });
    const plain = join(dir, `plain-${n++}`);
    mkdirSync(plain);
    expect(await pre('mcp__draw__start_session', { name: 'main' }, plain)).toEqual({ code: 0, stdout: '', stderr: '' });
    const notRepo = await pre('mcp__draw__mark_checkpoint', { board: 7 }, plain);
    expect(notRepo).toMatchObject({ code: 2, stdout: '', stderr: expect.stringMatching(/^redcrayon: .* is not inside a git repository\./) });
    expect(requests).toEqual([]);
  });

  it('PostToolUse records start_session\'s base; checkpoints and arrivals then capture against it and take citedPaths', async () => {
    const root = repo({ 'src/b.ts': 'export const b = 1;\n' });
    const base = sh(root, 'rev-parse', 'HEAD');
    expect(await pre('mcp__draw-dev__mark_checkpoint', { board: 9 }, root)).toEqual({ code: 0, stdout: '', stderr: '' }); // no base yet: the server's text names it
    const start = await pre('mcp__draw__start_session', { name: 'main' }, root);
    expect(updated(start).updatedInput).toEqual({ name: 'main', capture: expect.stringMatching(CAPTURE_ID_RE) });
    const result = { board: 'main', id: 9, url: 'https://app.example/#b=c4bb879c7355360696d9', session: true, checkpoint: 0, repoRoot: root, baseSha: base };
    expect(await post('mcp__draw__start_session', { name: 'main' }, [{ type: 'text', text: JSON.stringify(result) }], root)).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(JSON.parse(readFileSync(join(root, '.git/redcrayon', stateHost(), 'boards.json'), 'utf8'))).toEqual({ 9: base });
    await pre('mcp__draw__add_code_ref', { board: 9, path: 'src/a.ts', symbol: 'a' }, root);
    for (const tool of ['mcp__draw-dev__mark_checkpoint', 'mcp__draw__arrive']) {
      const r = await pre(tool, { board: 9, nodeId: 4 }, root);
      expect(updated(r).updatedInput).toEqual({ board: 9, nodeId: 4, capture: expect.stringMatching(CAPTURE_ID_RE) });
      expect(bodies().at(-1)).toMatchObject({ kind: 'checkpoint', base, files: [{ path: 'src/a.ts' }] });
    }
    await post('mcp__draw__mark_checkpoint', { board: 9 }, { content: [{ type: 'text', text: JSON.stringify({ board: 'main', checkpoint: 1, citedPaths: ['src/b.ts', '../x'] }) }] }, root);
    expect(JSON.parse(readFileSync(join(root, '.git/redcrayon', stateHost(), 'cited/9'), 'utf8'))).toEqual(['src/b.ts']);
  });

  it('on Windows the hook does nothing and the CLI says it is not supported', async () => {
    const win = ['--import', 'data:text/javascript,Object.defineProperty(process,"platform",{value:"win32"})'];
    const root = repo();
    const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'mcp__draw__add_code_ref', tool_input: { board: 1, path: 'src/a.ts' }, cwd: root });
    expect(await run(['hook'], { cwd: root, input, node: win })).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(await run(['capture', 'start'], { cwd: root, node: win })).toEqual({ code: 1, stdout: '', stderr: 'redcrayon: Windows is not supported yet.\n' });
    expect(requests).toEqual([]);
  });
});

describe('doctor', () => {
  it('prints one line per check and exits 0 when all pass, 1 otherwise', async () => {
    const ok = await run(['doctor'], { cwd: repo() });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toBe('');
    expect(ok.stderr.trimEnd().split('\n').map(l => l.split(':')[0] + ':' + l.split(' ')[1])).toEqual(['node:ok', 'git:ok', 'repo:ok', 'network:ok']);
    const plain = join(dir, `plain-${n++}`);
    mkdirSync(plain);
    const bad = await run(['doctor'], { cwd: plain, env: { REDCRAYON_ORIGIN: 'http://127.0.0.1:9' } });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/^repo: FAIL \(.* is not inside a git repository\./m);
    expect(bad.stderr).toMatch(/^network: FAIL \(could not reach 127\.0\.0\.1:9\)$/m);
  });

  it('reaches the server REDCRAYON_MCP_URL names when REDCRAYON_ORIGIN is unset', async () => {
    const r = await run(['doctor'], { cwd: repo(), env: { REDCRAYON_ORIGIN: '', REDCRAYON_MCP_URL: `${origin}/mcp` } });
    expect(r.stderr).toMatch(new RegExp(`^network: ok \\(${new URL(origin).host} answered`, 'm'));
    expect(requests.map(q => q.url)).toEqual(['/health']);
  });
});
