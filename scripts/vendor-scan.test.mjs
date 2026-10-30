import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scan, scanPublic } from './vendor-scan.mjs';

function tree(files, targets) {
  const root = mkdtempSync(join(tmpdir(), 'vendor-scan-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  writeFileSync(join(root, 'targets'), targets);
  return options => scan(join(root, 'targets'), root, options);
}

test('a clean tree passes', () => {
  assert.deepEqual(tree({ 'dist/w.js': 'export default 1;\n', 'surface.txt': 'REJECTED: board 1 not found.\n' }, 'bundle dist/w.js\ntext surface.txt\n')(), []);
});

test('a planted vendor word fails each target kind, with file and line', () => {
  for (const kind of ['bundle', 'text', 'tree']) {
    const path = kind === 'tree' ? 'plugin' : 'x.txt';
    const files = kind === 'tree' ? { 'plugin/README.md': 'ok\nruns on SpacetimeDB\n' } : { 'x.txt': 'ok\nwss://maincloud.example\n' };
    const hits = tree(files, `${kind} ${path}\n`)().filter(h => !h.includes('private word'));
    assert.equal(hits.length, 1, kind);
    assert.match(hits[0], /:2: vendor word/);
  }
});

test('a sourceMappingURL comment or a .map file fails a bundle', () => {
  assert.match(tree({ 'd/w.js': 'x\n//# sourceMappingURL=w.js.map\n' }, 'bundle d/w.js\n')()[0], /sourceMappingURL/);
  assert.match(tree({ 'd/w.js': 'x\n', 'd/w.js.map': '{}' }, 'bundle d/w.js\n')()[0], /source map/);
  // an identifier that merely contains the word is fine
  assert.deepEqual(tree({ 'd/w.js': 'tryGetSourceMappingURL()\n' }, 'bundle d/w.js\n')(), []);
});

test('internals words fail text surfaces only', () => {
  assert.match(tree({ 's.txt': 'REJECTED: reducer failed\n' }, 'text s.txt\n')()[0], /internals word/);
  assert.deepEqual(tree({ 'w.js': 'function reducer() {}\n' }, 'bundle w.js\n')(), []);
});

test('a private target reports private words only', () => {
  const hits = tree({ 'img/app/a.js': 'spacetime publish\n', 'img/app/b.ts': 'ok\nhttps://clerk.example\n' }, 'private img\n')();
  assert.equal(hits.length, 1);
  assert.match(hits[0], /b\.ts:2: private word: /);
});

test('a listed target that is missing fails', () => {
  assert.match(tree({}, 'bundle gone.js\n')()[0], /listed target is missing/);
});

const cli = (root, ...args) => spawnSync(process.execPath, [fileURLToPath(new URL('./vendor-scan.mjs', import.meta.url)), ...args], { cwd: root, encoding: 'utf8' });

function publicTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'vendor-scan-public-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  return root;
}

test('--public fails on private words, with or without the explicit --enforce flag', () => {
  const root = publicTree({
    'scripts/public-paths.json': '["client", "mcp", "module"]\n',
    'client/auth.ts': "import '@clerk/backend';\n",
    'mcp/db.ts': "const host = 'ok';\nconst url = 'wss://maincloud.spacetimedb.com';\n",
    'module/src/lib.rs': '// the source tree may name SpacetimeDB\n',
    'client/CHANGELOG.md': 'Moved sign-in off Clerk.\n',
    'cloud/auth.ts': "import '@clerk/backend';\n",
  });
  assert.deepEqual(scanPublic(root), [
    'client/CHANGELOG.md:1: private word: Moved sign-in off Clerk.',
    "client/auth.ts:1: private word: import '@clerk/backend';",
    "mcp/db.ts:2: private word: const url = 'wss://maincloud.spacetimedb.com';",
  ]);
  const report = cli(root, '--public');
  assert.equal(report.status, 1, report.stderr);
  assert.match(report.stderr, /3 private word\(s\): client 2, mcp 1/);
  const enforced = cli(root, '--public', '--enforce');
  assert.equal(enforced.status, 1, enforced.stderr);
  assert.match(enforced.stderr, /vendor-scan: 3 hit\(s\)/);
});

test('a public path with no tracked files fails without --enforce', () => {
  const root = publicTree({ 'scripts/public-paths.json': '["client", "gone"]\n', 'client/a.ts': 'export {};\n' });
  assert.deepEqual(scanPublic(root), ['gone: listed public path has no tracked files']);
  assert.equal(cli(root, '--public').status, 1);
});

test('artifact scans never inherit source exceptions; an unknown flag fails', () => {
  const run = tree({ 'd/w.js': 'fetch("https://mcp.redcrayon.ai/mcp");\n', 'plugin/.mcp.json': '{ "url": "https://mcp.redcrayon.ai/mcp" }\n' }, 'bundle d/w.js\ntree plugin\n');
  assert.equal(run().length, 2);
  assert.match(run()[1], /plugin\/\.mcp\.json:1: private word/);
  assert.equal(cli(tmpdir(), '--enfrce').status, 2);
});

const hostedPluginFiles = {
  'plugin/package.json': JSON.stringify({ name: '@redcrayonai/draw', bin: { redcrayon: 'bin/redcrayon.mjs' } }),
  'plugin/.mcp.json': '"draw": { "type": "http", "url": "${REDCRAYON_MCP_URL:-https://mcp.redcrayon.ai/mcp}" }\n',
  'plugin/README.md': '**Server URL:** `https://mcp.redcrayon.ai/mcp`\n',
  'plugin/bin/redcrayon.mjs': 'var DEFAULT_ORIGIN = "https://mcp.redcrayon.ai";\n',
  'pack/package/package.json': JSON.stringify({ name: '@redcrayonai/draw', bin: { redcrayon: 'bin/redcrayon.mjs' } }),
  'pack/package/.mcp.json': '"draw": { "type": "http", "url": "${REDCRAYON_MCP_URL:-https://mcp.redcrayon.ai/mcp}" }\n',
  'pack/package/README.md': '**Server URL:** `https://mcp.redcrayon.ai/mcp`\n',
  'pack/package/bin/redcrayon.mjs': 'var DEFAULT_ORIGIN = "https://mcp.redcrayon.ai";\n',
};
const hostedPluginTargets = 'tree plugin\ntree pack/package\n';

test('only explicit hosted-plugin scans allow three endpoint slots in the plugin and its npm package', () => {
  const run = tree(hostedPluginFiles, hostedPluginTargets);
  assert.equal(run().length, 6);
  assert.deepEqual(run({ hostedPlugin: true }), []);
  const incompatible = cli(tmpdir(), '--public', '--hosted-plugin');
  assert.equal(incompatible.status, 2);
  assert.match(incompatible.stderr, /release artifacts only/);
});

test('hosted-plugin exceptions reject extra private content, other hosts and other files', () => {
  for (const [file, text] of [
    ['plugin/.mcp.json', `${hostedPluginFiles['plugin/.mcp.json'].trim()} // @clerk/backend\n`],
    ['plugin/README.md', `${hostedPluginFiles['plugin/README.md']}import "@clerk/backend";\n`],
    ['plugin/README.md', hostedPluginFiles['plugin/README.md'].replace('mcp.redcrayon.ai', 'dash.redcrayon.ai')],
    ['plugin/extra.md', hostedPluginFiles['plugin/README.md']],
    ['plugin/bin/extra.mjs', hostedPluginFiles['plugin/bin/redcrayon.mjs']],
    ['pack/package/bin/extra.mjs', hostedPluginFiles['pack/package/bin/redcrayon.mjs']],
    ['pack/package/README.md', `${hostedPluginFiles['pack/package/README.md']}import "@clerk/backend";\n`],
    ['plugin/bin/redcrayon.mjs', `${hostedPluginFiles['plugin/bin/redcrayon.mjs']}const key = "sk_live_forbidden";\n`],
  ]) {
    assert.ok(tree({ ...hostedPluginFiles, [file]: text }, hostedPluginTargets)({ hostedPlugin: true }).length > 0, file);
  }
});

test('hosted-plugin mode leaves app, image and text scans strict', () => {
  for (const target of ['bundle plugin/bin/redcrayon.mjs', 'private plugin', 'text plugin/README.md']) {
    assert.ok(tree(hostedPluginFiles, `${target}\n`)({ hostedPlugin: true }).length > 0, target);
  }
  for (const manifest of [{ name: 'other', bin: { redcrayon: 'bin/redcrayon.mjs' } }, { name: '@redcrayonai/draw', bin: { redcrayon: 'other.mjs' } }]) {
    for (const directory of ['plugin', 'pack/package']) {
      const run = tree({ ...hostedPluginFiles, [`${directory}/package.json`]: JSON.stringify(manifest) }, `tree ${directory}\n`);
      assert.equal(run({ hostedPlugin: true }).length, 3, `${directory}: ${JSON.stringify(manifest)}`);
    }
  }
  const helper = tree({
    'helper/package.json': JSON.stringify({ name: 'redcrayon', bin: { redcrayon: 'dist/redcrayon.mjs' } }),
    'helper/dist/redcrayon.mjs': hostedPluginFiles['plugin/bin/redcrayon.mjs'],
  }, 'tree helper\n');
  assert.equal(helper({ hostedPlugin: true }).length, 1, 'the private helper build is not a released package');
});

test('a source exception permits only its documented integration line', () => {
  const root = publicTree({
    'scripts/public-paths.json': '["mcp"]\n',
    'mcp/wrangler.jsonc': '{ "tag": "v1", "new_sqlite_classes": ["User"] },\nimport "@clerk/backend";\n',
  });
  assert.deepEqual(scanPublic(root), ['mcp/wrangler.jsonc:2: private word: import "@clerk/backend";']);
});

test('staging production hosts and secret-key prefixes fail the public scan', () => {
  for (const word of ['staging.mcp.redcrayon.ai', 'staging.draw.redcrayon.ai', 'staging.dash.redcrayon.ai', 'sk_test_fixture']) {
    const root = publicTree({ 'scripts/public-paths.json': '["client"]\n', 'client/a.ts': word });
    assert.equal(scanPublic(root).length, 1, word);
  }
});

test('a raw NUL cannot hide a private word in public source', () => {
  const root = publicTree({
    'scripts/public-paths.json': '["client"]\n',
    'client/a.ts': 'import "@clerk/backend";\0\n',
  });
  assert.equal(scanPublic(root).length, 1);
});

test('provider-neutral service account identifiers pass public source and artifact scans', () => {
  const source = 'serviceAccountId: __t.u64().name("service_account_id"),\n';
  const root = publicTree({
    'scripts/public-paths.json': '["client"]\n',
    'client/module_bindings/keys.ts': source,
  });
  assert.deepEqual(scanPublic(root), []);
  for (const kind of ['bundle', 'text', 'tree', 'private']) {
    assert.deepEqual(tree({ 'app/keys.js': source }, `${kind} app\n`)(), [], kind);
  }
});

test('service account identifiers cannot hide cloud configuration or other private words on the same line', () => {
  const privateWords = [
    'account_id', 'ACCOUNT_ID', 'CF_ACCOUNT_ID', 'account_id_suffix',
    'prefix_service_account_id', 'service_account_id_suffix',
    '@clerk/backend', 'pk_live_fixture', 'pk_test_fixture', 'sk_live_fixture', 'sk_test_fixture',
    'maincloud', 'mcp.redcrayon.ai', 'staging.draw.redcrayon.ai', 'dash-staging.redcrayon.ai',
    'namespace_id', 'new_sqlite_classes',
  ];
  for (const word of privateWords) {
    const source = `const config = { service_account_id: 1, "${word}": "private" };\n`;
    const root = publicTree({
      'scripts/public-paths.json': '["client"]\n',
      'client/config.ts': source,
    });
    assert.equal(scanPublic(root).length, 1, `public: ${word}`);
    for (const kind of ['bundle', 'text', 'tree', 'private']) {
      const hits = tree({ 'app/keys.js': source }, `${kind} app\n`)().filter(hit => hit.includes('private word:'));
      assert.equal(hits.length, 1, `${kind}: ${word}`);
    }
  }
});

// Source files must remain valid UTF-8 text without raw NUL bytes.
test('no tracked public text file holds a raw NUL byte', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  const isText = bytes => {
    try {
      return utf8.decode(bytes) !== undefined;
    } catch {
      return false; // not UTF-8: a real binary
    }
  };
  const hidden = JSON.parse(readFileSync(join(root, 'scripts/public-paths.json'), 'utf8')).flatMap(dir =>
    execFileSync('git', ['ls-files', '-z', '--', dir], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
      .split('\0')
      .filter(rel => {
        const path = join(root, rel);
        if (!rel || !existsSync(path) || !statSync(path).isFile()) return false;
        const bytes = readFileSync(path);
        return bytes.includes(0) && isText(bytes);
      })
  );
  assert.deepEqual(hidden, []);
});
