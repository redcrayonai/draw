import { describe, expect, it } from 'vitest';
import {
  CAPTURE_ID_RE,
  MB,
  blobSha,
  claimCapture,
  findSecret,
  gitShaHolds,
  isSecretFile,
  newCaptureId,
  pathProblem,
  rejectText,
  secretCheck,
  type ClaimBoard,
} from './capture';

const enc = (s: string) => new TextEncoder().encode(s);
const ID = 'cap_AAAAAAAAAAAAAAAAAAAAAA';
const TOP = '/work/repo';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const board: ClaimBoard = { id: 42, name: 'main', repoRoot: TOP, baseSha: BASE };
const common = { v: 1, helper: '1.0.0', toplevel: TOP, objectFormat: 'sha1', head: HEAD };

// text is ASCII here, so btoa takes it as bytes
const wire = async (path: string, text: string, sha?: string) => ({ path, bytes: btoa(text), sha: sha ?? (await blobSha('sha1', enc(text))), citable: true });
const refBody = async (path = 'src/a.ts', text = 'export const a = 1;\n') => ({ ...common, kind: 'ref', asked: path, file: await wire(path, text) });
const checkpointBody = async (over: Record<string, unknown> = {}) => ({
  ...common,
  kind: 'checkpoint',
  base: BASE,
  changed: ['src/a.ts'],
  uncompared: { 'src/a.ts': 'git diff timed out after 10 s' },
  untracked: ['src/new.ts'],
  deleted: ['src/gone.ts'],
  hunks: { 'src/a.ts': [[1, 2]] },
  files: [await wire('src/a.ts', 'export const a = 2;\n'), { path: 'src/gone.ts', missing: true }, { path: 'big.bin', unreadable: true }],
  ...over,
});
const refused = async (body: unknown, call: Parameters<typeof claimCapture>[2] = { tool: 'add_code_ref', path: 'src/a.ts', board }) => {
  const r = await claimCapture(ID, body, call);
  if (r.ok) throw new Error('claimed');
  return r.text;
};

describe('ids, paths and the secret list', () => {
  it('a capture id is cap_ and 22 base62 characters, never repeated', () => {
    const ids = new Set(Array.from({ length: 500 }, newCaptureId));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(CAPTURE_ID_RE);
  });

  it('a path is repo-relative POSIX: no leading /, no . or .. segment, no control character', () => {
    expect(pathProblem('src/a.ts')).toBeUndefined();
    expect(pathProblem('ünï cödé.ts')).toBeUndefined();
    expect(pathProblem('/etc/passwd')).toBe('an absolute path');
    expect(pathProblem('src/../../x')).toBe('an empty, . or .. segment in a path');
    expect(pathProblem('./src/a.ts')).toBe('an empty, . or .. segment in a path');
    expect(pathProblem('src//a.ts')).toBe('an empty, . or .. segment in a path');
    expect(pathProblem('src/a\n.ts')).toBe('a control character in a path');
    expect(pathProblem('')).toBe('an empty path');
    expect(pathProblem(7)).toBe('an empty path');
  });

  it('the secret list matches the last segment, ignoring case', () => {
    for (const p of [
      '.env', '.env.local', 'config/.ENV.production', 'deploy/staging.env', 'docker/app.env', 'certs/server.pem', 'a.key',
      'id_rsa', 'deploy/id_ed25519.pub', 'id_dsa', 'id_ecdsa', 'id_ed25519_sk', 'x.p12', 'x.PFX', '.npmrc', 'home/.netrc',
    ]) {
      expect(isSecretFile(p)).toBe(true);
    }
    for (const p of ['src/env.ts', 'keys.ts', 'src/identity.ts', 'docs/env.md', 'monkey.ts', 'internal/auth/id_token.go', 'src/id_generator.ts', 'x/ID_map.py']) {
      expect(isSecretFile(p)).toBe(false);
    }
  });
});

describe('secrets in snippets and evidence lines', () => {
  // Built at run time so the repository's own secret scanning sees no token.
  const samples: [string, string][] = [
    ['private key', '-----BEGIN ' + 'RSA PRIVATE KEY-----'],
    ['private key', '"private_key": "-----BEGIN ' + 'PRIVATE KEY-----\\nMIIE"'],
    ['AWS access key', `const id = "${'AKIA' + 'IOSFODNN7EXAMPLE'}";`],
    ['Redcrayon API key', `const key = "${'rcak_' + 'a'.repeat(32) + '_' + 'b'.repeat(64)}";`],
    ['GCP API key', `key: '${'AIza' + 'S'.repeat(35)}'`],
    ['GCP OAuth client secret', `secret = ${'GOCSPX-' + 'x'.repeat(28)}`],
    ['GitHub token', `token=${'ghp_' + 'A1'.repeat(18)}`],
    ['GitHub token', `${'github_pat_' + 'A'.repeat(30)}`],
    ['Slack token', `${'xoxb-' + '1234567890-abcdefghij'}`],
    ['Slack webhook', `https://hooks.slack.com/services/${'T0000' + '/B0000/' + 'XXXXXXXX'}`],
    ['Stripe secret key', `stripe(${'sk_' + 'live_' + 'z'.repeat(24)})`],
    ['Anthropic API key', `ANTHROPIC_API_KEY=${'sk-' + 'ant-api03-' + 'Ab1_-'.repeat(8)}`],
    ['OpenAI API key', `OPENAI_API_KEY=${'sk-' + 'proj-' + 'Ab1_-'.repeat(8)}`],
    ['OpenAI API key', `key: "${'sk-' + 'Ab12'.repeat(12)}"`],
    ['GitLab token', `url = https://gitlab.com/acme/api.git?t=${'glpat-' + 'Ab1_-'.repeat(4)}`],
    ['URL with credentials', `url = https://oauth2:${'tok' + 'en'}@gitlab.com/acme/api.git`],
    ['URL with credentials', `DATABASE_URL=postgres://${'redcrayon:redcrayon'}@db:5432/x`],
    ['URL with credentials', `REDIS_URL=redis://:${'pw'}@cache:6379`],
    // a placeholder's default is a literal password, so it is flagged
    ['URL with credentials', `DATABASE_URL=postgres://u:$\{PW:-p@ss}@db/x`],
  ];
  it('names each kind it finds', () => {
    for (const [kind, line] of samples) expect(findSecret(line)).toEqual({ line: 1, kind });
  });

  it('leaves code without secrets alone', () => {
    expect(findSecret('export const AKIA = 1;\nconst key = process.env.API_KEY;\nconst pk = "pk_live_abc";')).toBeUndefined();
    // a URL without a password, or with an interpolated one, is not a secret
    for (const line of [
      'https://github.com/redcrayonai/redcrayon.git',
      'postgres://localhost:5432/redcrayon?sslmode=disable',
      'git@github.com:redcrayonai/redcrayon.git',
      'DATABASE_URL="postgres://postgres:${POSTGRES_PASSWORD}@${POSTGRES_HOST:-postgres}:5432/redcrayon"',
      'const task = "risk-assessment-framework-module";',
    ]) {
      expect(findSecret(line)).toBeUndefined();
    }
  });

  it('scans a 1 MB line in linear time', () => {
    // each ://:${ start once scanned to the line end: about a minute on this line
    const line = '://:${aaaaaaaaaa'.repeat(MB / 16);
    const start = performance.now();
    expect(findSecret(line)).toBeUndefined();
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('refuses with the exact text, numbering lines from the snippet start', () => {
    const text = `function f() {\n  return 1;\n  const k = "${'AKIA' + 'IOSFODNN7EXAMPLE'}";\n}`;
    expect(secretCheck('src/x.ts', text, 10)).toBe('REJECTED: src/x.ts:12 looks like a secret (AWS access key). Nothing was written. Cite lines without secrets.');
    expect(secretCheck('src/x.ts', 'const a = 1;', 3)).toBeUndefined();
  });
});

describe('git blob shas', () => {
  it('match git hash-object for sha1 and sha256 repositories', async () => {
    expect(await blobSha('sha1', enc('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    expect(await blobSha('sha256', enc('hello\n'))).toBe('2cf8d83d9ee29543b34a87727421fdecb7e3f3a183d337639025de576db9ebb4');
  });

  it('hold for the raw bytes or after CRLF→LF, and for nothing else', async () => {
    const lf = '422c2b7ab3b3c668038da977e4e93a5fc623169c'; // git hash-object of "a\nb\n"
    expect(await gitShaHolds('sha1', enc('a\r\nb\r\n'), lf)).toBe(true);
    expect(await gitShaHolds('sha1', enc('a\r\nb\r\n'), await blobSha('sha1', enc('a\r\nb\r\n')))).toBe(true);
    expect(await gitShaHolds('sha256', enc('a\r\nb\r\n'), '55531aae34a8648f19a1cde6a3484432efea398cd705d5e4b201fd0fc1f8ded7')).toBe(true);
    expect(await gitShaHolds('sha1', enc('a\nb\n'), await blobSha('sha1', enc('a\r\nb\r\n')))).toBe(false); // LF→CRLF is not git's clean side
    expect(await gitShaHolds('sha1', enc('a\nb\n'), 'ce013625030ba8dba906f756967f9e9ca394464a')).toBe(false);
  });
});

describe('claimCapture', () => {
  it('claims a ref capture under the path asked or git spelling, with its bytes decoded', async () => {
    const body = { ...(await refBody()), asked: './src//a.ts' };
    for (const path of ['./src//a.ts', 'src/a.ts']) {
      const r = await claimCapture(ID, body, { tool: 'add_code_ref', path, board });
      expect(r.ok).toBe(true);
      if (r.ok && r.capture.kind === 'ref') expect(new TextDecoder().decode(r.capture.file.bytes)).toBe('export const a = 1;\n');
    }
  });

  it('claims a checkpoint for mark_checkpoint and arrive, keeping absent files and the maps', async () => {
    for (const tool of ['mark_checkpoint', 'arrive'] as const) {
      const r = await claimCapture(ID, await checkpointBody(), { tool, board });
      expect(r.ok).toBe(true);
      if (!r.ok || r.capture.kind !== 'checkpoint') continue;
      expect(r.capture.files.map(f => ('bytes' in f ? 'bytes' : 'missing' in f ? 'missing' : 'unreadable'))).toEqual(['bytes', 'missing', 'unreadable']);
      expect(r.capture.uncompared.get('src/a.ts')).toBe('git diff timed out after 10 s');
      expect(r.capture.hunks.get('src/a.ts')).toEqual([[1, 2]]);
    }
  });

  it('claims a start capture with no board, whatever checkout it comes from', async () => {
    const r = await claimCapture(ID, { ...common, toplevel: '/elsewhere', kind: 'start' }, { tool: 'start_session' });
    expect(r).toEqual({ ok: true, capture: { ...common, toplevel: '/elsewhere', kind: 'start' } });
  });

  it('refuses a capture made for another call', async () => {
    const ref = await refBody();
    expect(await refused(ref, { tool: 'create_edge', path: 'src/a.ts', board })).toBe(
      `REJECTED: capture ${ID} was made for add_code_ref src/a.ts, not create_edge. Nothing was written. Run the capture for this call and pass the new id.`
    );
    expect(await refused(ref, { tool: 'add_code_ref', path: 'src/b.ts', board })).toBe(
      `REJECTED: capture ${ID} was made for add_code_ref src/a.ts, not add_code_ref src/b.ts. Nothing was written. Run the capture for this call and pass the new id.`
    );
    expect(await refused({ ...ref, kind: 'cite' }, { tool: 'add_code_ref', path: 'src/a.ts', board })).toMatch(/was made for create_edge src\/a\.ts, not add_code_ref\./);
    expect(await refused(await checkpointBody(), { tool: 'add_code_ref', path: 'src/a.ts', board })).toMatch(/was made for mark_checkpoint, not add_code_ref\./);
    expect(await refused({ ...common, kind: 'start' }, { tool: 'mark_checkpoint', board })).toMatch(/was made for start_session, not mark_checkpoint\./);
  });

  it('refuses a capture from another checkout', async () => {
    expect(await refused({ ...(await refBody()), toplevel: '/work/other' })).toBe(
      'REJECTED: this capture comes from /work/other, but board "main" tracks /work/repo. Nothing was written. Run the agent in /work/repo, or call start_session with a new name.'
    );
  });

  it('refuses a checkpoint against another base', async () => {
    expect(await refused(await checkpointBody({ base: 'c'.repeat(40) }), { tool: 'mark_checkpoint', board })).toBe(
      `REJECTED: this capture compares against ccccccc, but board "main" started at bbbbbbb. Nothing was written. Run \`npx -y @redcrayonai/draw@1 capture checkpoint --board 42 --base ${BASE}\` and pass the new id.`
    );
  });

  it('refuses an older helper', async () => {
    const old = 'REJECTED: this capture comes from an older redcrayon helper (0.9.3). Nothing was written. Update it with /plugin update draw or npx -y @redcrayonai/draw@1, then call again.';
    expect(await refused({ ...(await refBody()), helper: '0.9.3' })).toBe(old);
    expect(await refused({ ...(await refBody()), helper: undefined })).toMatch(/older redcrayon helper \(unknown\)/);
    expect(await refused({ ...(await refBody()), v: 2 })).toMatch(/older redcrayon helper \(1\.0\.0\)/);
  });

  it('refuses one tampered byte, or bytes behind a filter such as LFS', async () => {
    const good = await refBody();
    const tampered = { ...good, file: { ...good.file, bytes: btoa('export const a = 9;\n') } };
    const filtered = 'REJECTED: src/a.ts is stored through a git filter such as LFS, so its bytes cannot be checked. Nothing was written. Cite another file.';
    expect(await refused(tampered)).toBe(filtered);
    const pointer = await wire('src/a.ts', 'raw media bytes\n', await blobSha('sha1', enc('version https://git-lfs.github.com/spec/v1\noid sha256:0\nsize 16\n')));
    expect(await refused({ ...good, file: pointer })).toBe(filtered);
    // a cited file in a checkpoint is checked the same way
    const cp = await checkpointBody();
    expect(await refused({ ...cp, files: [{ ...cp.files[0], bytes: btoa('tampered\n') }] }, { tool: 'mark_checkpoint', board })).toBe(filtered);
  });

  it('accepts a CRLF file whose git sha is of its LF form, and a sha-256 repository', async () => {
    const crlf = await wire('src/a.ts', 'a\r\nb\r\n', '422c2b7ab3b3c668038da977e4e93a5fc623169c');
    expect((await claimCapture(ID, { ...(await refBody()), file: crlf }, { tool: 'add_code_ref', path: 'src/a.ts', board })).ok).toBe(true);
    const sha256 = { ...common, objectFormat: 'sha256', head: 'a'.repeat(64), kind: 'ref', asked: 'src/a.ts', file: { path: 'src/a.ts', bytes: btoa('hello\n'), sha: '2cf8d83d9ee29543b34a87727421fdecb7e3f3a183d337639025de576db9ebb4', citable: true } };
    expect((await claimCapture(ID, sha256, { tool: 'add_code_ref', path: 'src/a.ts', board })).ok).toBe(true);
    expect(await refused({ ...sha256, file: { ...sha256.file, sha: 'ce013625030ba8dba906f756967f9e9ca394464a' } })).toMatch(/src\/a\.ts has no sha/);
  });

  it('refuses a file over 1 MB, and a binary', async () => {
    const big = 'a'.repeat(Math.round(3.2 * MB));
    expect(await refused({ ...(await refBody()), file: await wire('src/big.ts', big) }, { tool: 'add_code_ref', path: 'src/a.ts', board })).toBe(
      'REJECTED: src/big.ts is 3.2 MB; code refs cite files up to 1 MB. Nothing was written. Cite a smaller file.'
    );
    expect(await refused({ ...(await refBody()), file: await wire('src/a.ts', 'a\0b') })).toBe(
      'REJECTED: src/a.ts is a binary file; code refs cite text. Nothing was written. Cite another file.'
    );
  });

  it('refuses a secrets file a hand-made upload holds, and never claims one in a checkpoint', async () => {
    const env = 'DATABASE_URL=postgres://u:pass@host\n';
    for (const call of [{ tool: 'add_code_ref', path: '.env.production', board }, { tool: 'create_edge', path: '.env.production', board }] as const) {
      const body = { ...(await refBody('.env.production', env)), kind: call.tool === 'add_code_ref' ? 'ref' : 'cite' };
      expect(await refused(body, call)).toBe('REJECTED: .env.production looks like a secrets file; code refs never read it. Nothing was written. Cite another file.');
    }
    // asked as a secrets file, spelled otherwise by the upload
    expect(await refused({ ...(await refBody('src/a.ts', env)), asked: 'config/.npmrc' }, { tool: 'add_code_ref', path: 'config/.npmrc', board })).toMatch(/looks like a secrets file/);
    const r = await claimCapture(ID, await checkpointBody({ files: [await wire('.env', env), await wire('src/a.ts', 'export const a = 2;\n')] }), { tool: 'mark_checkpoint', board });
    if (!r.ok || r.capture.kind !== 'checkpoint') throw new Error('not claimed');
    expect(r.capture.files[0]).toEqual({ path: '.env', unreadable: true });
    expect('bytes' in r.capture.files[1]).toBe(true);
  });

  it('refuses a list over 20,000 paths, naming the count', async () => {
    const paths = (n: number) => Array.from({ length: n }, (_, i) => `gen/${i}.ts`);
    expect(await refused(await checkpointBody({ changed: paths(23_410) }), { tool: 'mark_checkpoint', board })).toBe(
      'REJECTED: the checkpoint lists 23,410 changed paths; the limit is 20,000. Nothing was written. Commit or ignore generated output, then call again.'
    );
    expect(await refused(await checkpointBody({ untracked: paths(20_001) }), { tool: 'mark_checkpoint', board })).toMatch(/lists 20,001 untracked paths/);
    expect((await claimCapture(ID, await checkpointBody({ deleted: paths(20_000) }), { tool: 'mark_checkpoint', board })).ok).toBe(true);
  });

  it('reads the optional remote, pushed and dirty fields; a 1.0.x body without them is claimed as before', async () => {
    const cp = { tool: 'mark_checkpoint' as const, board };
    const malformed = (problem: string) => `REJECTED: capture ${ID} is not a capture redcrayon can read (${problem}). Nothing was written. Run the capture again and pass the new id.`;
    const withFields = await claimCapture(ID, await checkpointBody({ remote: 'https://github.com/o/r.git', pushed: true, dirty: ['src/a.ts'] }), cp);
    expect(withFields).toMatchObject({ ok: true, capture: { remote: 'https://github.com/o/r.git', pushed: true, dirty: ['src/a.ts'] } });
    expect((await claimCapture(ID, { ...common, kind: 'start', remote: 'https://github.com/o/r.git' }, { tool: 'start_session' })).ok).toBe(true);
    expect((await claimCapture(ID, await checkpointBody(), cp)).ok).toBe(true);
    expect((await claimCapture(ID, { ...common, kind: 'start' }, { tool: 'start_session' })).ok).toBe(true);

    const start = { tool: 'start_session' as const };
    expect(await refused({ ...common, kind: 'start', remote: 7 }, start)).toBe(malformed('remote is not one line without a user name or token'));
    expect(await refused({ ...common, kind: 'start', remote: 'https://github.com/o\n/r' }, start)).toMatch(/remote is not one line/);
    expect(await refused({ ...common, kind: 'start', remote: 'https://x:tok@github.com/o/r.git' }, start)).toMatch(/remote is not one line/);
    expect(await refused({ ...common, kind: 'start', remote: 'https://github.com/' + 'o'.repeat(2048) }, start)).toMatch(/remote is not one line/);
    expect((await claimCapture(ID, { ...common, kind: 'start', remote: 'https://github.com/' + 'o'.repeat(2029) }, start)).ok).toBe(true);
    expect(await refused(await checkpointBody({ remote: 7 }), cp)).toMatch(/remote is not one line/);
    expect(await refused(await checkpointBody({ pushed: 'yes' }), cp)).toBe(malformed('pushed is not true or false'));
    expect(await refused(await checkpointBody({ dirty: ['../x'] }), cp)).toBe(malformed('an empty, . or .. segment in a path'));
    expect(await refused(await checkpointBody({ dirty: 'src/a.ts' }), cp)).toBe(malformed('dirty is not a list'));
    expect(await refused(await checkpointBody({ dirty: Array.from({ length: 20_001 }, (_, i) => `gen/${i}.ts`) }), cp)).toMatch(/lists 20,001 dirty paths/);
  });

  it('refuses paths that are not repo-relative, and bodies it cannot read', async () => {
    const cp = { tool: 'mark_checkpoint' as const, board };
    expect(await refused(await checkpointBody({ changed: ['../outside.ts'] }), cp)).toBe(
      `REJECTED: capture ${ID} is not a capture redcrayon can read (an empty, . or .. segment in a path). Nothing was written. Run the capture again and pass the new id.`
    );
    expect(await refused(await checkpointBody({ deleted: ['/etc/passwd'] }), cp)).toMatch(/\(an absolute path\)/);
    expect(await refused(await checkpointBody({ hunks: { 'src/a.ts': [[0, 1]] } }), cp)).toMatch(/the hunks of src\/a\.ts are not line ranges/);
    expect(await refused({ ...(await refBody()), file: { ...(await refBody()).file, path: 'a\tb.ts' } })).toMatch(/a control character in a path/);
    expect(await refused({ ...(await refBody()), head: 'HEAD' })).toMatch(/head is not a sha/);
    expect(await refused('nope')).toMatch(/\(not an object\)/);
  });
});

describe('texts the capture path shares', () => {
  it('cited files missing names them and gives the --also command', () => {
    expect(rejectText.citedMissing(['src/a.ts', 'src/b.ts'], '42', BASE)).toBe(
      `REJECTED: the checkpoint needs these cited files: src/a.ts, src/b.ts. Nothing was written. Run \`npx -y @redcrayonai/draw@1 capture checkpoint --board 42 --base ${BASE} --also src/a.ts src/b.ts\` and pass the new id.`
    );
    expect(rejectText.citedMissing(["it's here.ts"], '42', BASE)).toContain(`--also 'it'\\''s here.ts'\``);
  });
});
