// The plugin tree (RC-560, spec §7 and §12 Plugin and skill): the manifests,
// the server entry and the hooks match the spec, the skill names only tools
// the hosted server registers and none of the banned words, and the README
// carries the exact disclosures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOSTED_PLUGIN_ORIGIN, INTERNALS, VENDOR, scan } from './vendor-scan.mjs';
import { PLACEHOLDER, configure, domainOf, hostedUrl } from './plugin-config.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFileSync(join(root, rel), 'utf8');
const json = rel => JSON.parse(read(rel));

const MATCHER = '^mcp__(plugin_draw_)?(?:draw|redcrayon)(-dev)?__(start_session|add_code_ref|mark_checkpoint|create_edge|arrive)$';
const COMMAND = `sh -c 'command -v node >/dev/null || exit 0; exec node "\${CLAUDE_PLUGIN_ROOT}/bin/redcrayon.mjs" hook'`;
const DISCLOSURE = 'To check code refs, redcrayon uploads each file your agent cites and deletes it within 10 minutes. It keeps paths, line numbers, git hashes, hashes of the cited lines and the GitHub repo address. It keeps the cited lines themselves only if you turn on storing code.';
const PREFLIGHT = 'The draw server is not connected. Run /mcp, choose draw, and sign in.';

// The hosted tools: the keys of TOOLS in mcp/src/tools.ts, each with its source block.
const toolsTs = read('mcp/src/tools.ts');
const toolsBody = toolsTs.slice(toolsTs.indexOf('export const TOOLS'), toolsTs.indexOf('export const TOOL_NAMES'));
const blocks = toolsBody.split(/^ {2}(?=\w+: \{$)/m).slice(1);
const TOOL_NAMES = blocks.map(b => b.match(/^(\w+):/)[1]);
const takesCapture = blocks.filter(b => /^\s+capture,$|, capture \}/m.test(b)).map(b => b.match(/^(\w+):/)[1]);

test('tools.ts parses into the hosted tool list', () => {
  assert.equal(TOOL_NAMES.length, 39);
  for (const t of ['start_session', 'get_board', 'add_code_ref', 'mark_checkpoint', 'arrive', 'describe_charts', 'add_threat', 'update_threat', 'remove_threat', 'create_branch', 'submit_branch', 'wait_for_marks', 'watch_marks', 'reply_to_mark', 'list_marks']) assert.ok(TOOL_NAMES.includes(t), t);
  assert.ok(!TOOL_NAMES.includes('link_dashboard'));
});

test('plugin.json: name draw, a semver version, Apache-2.0', () => {
  const p = json('plugin/.claude-plugin/plugin.json');
  assert.equal(p.name, 'draw');
  assert.match(p.version, /^\d+\.\d+\.\d+$/);
  assert.equal(p.license, 'Apache-2.0');
});

test('package.json: @redcrayonai/draw ships the plugin and runs the helper as bin redcrayon, one version everywhere', () => {
  const p = json('plugin/package.json');
  assert.equal(p.name, '@redcrayonai/draw');
  assert.equal(p.license, 'Apache-2.0');
  assert.deepEqual(p.bin, { redcrayon: 'bin/redcrayon.mjs' });
  for (const f of ['.claude-plugin', '.mcp.json', 'hooks', 'skills', 'references', 'bin/redcrayon.mjs', 'README.md', 'LICENSE']) assert.ok(p.files.includes(f), f);
  assert.equal(p.publishConfig?.access, 'public');
  assert.equal(p.private, undefined);
  assert.equal(p.version, json('plugin/.claude-plugin/plugin.json').version);
  assert.equal(p.version, json('helper/package.json').version);
  assert.equal(json('helper/package.json').private, true, 'only plugin/ publishes');
});

test('marketplace.json: marketplace redcrayonai lists plugin draw from npm, major 1, unversioned', () => {
  const m = json('.claude-plugin/marketplace.json');
  assert.equal(m.name, 'redcrayonai');
  assert.ok(m.owner?.name);
  assert.equal(m.plugins.length, 1);
  assert.equal(m.plugins[0].name, json('plugin/.claude-plugin/plugin.json').name);
  assert.deepEqual(m.plugins[0].source, { source: 'npm', package: json('plugin/package.json').name, version: '^1.0.0' });
  assert.equal(m.plugins[0].version, undefined, 'plugin.json holds the one version');
});

test('.mcp.json: one http server named draw with an overridable local or configured deployment URL', () => {
  const { mcpServers } = json('plugin/.mcp.json');
  assert.deepEqual(Object.keys(mcpServers), ['draw']);
  assert.deepEqual(Object.keys(mcpServers.draw).sort(), ['type', 'url']);
  assert.equal(mcpServers.draw.type, 'http');
  assert.match(mcpServers.draw.url, /^\$\{REDCRAYON_MCP_URL:-(?:http:\/\/localhost:8788|https:\/\/mcp\.[a-z0-9.-]+)\/mcp\}$/);
});

test('hooks.json: PreToolUse and PostToolUse run the bundled helper on the capture tools', () => {
  const { hooks } = json('plugin/hooks/hooks.json');
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PreToolUse']);
  for (const event of ['PreToolUse', 'PostToolUse']) {
    assert.equal(hooks[event].length, 1, event);
    assert.equal(hooks[event][0].matcher, MATCHER, event);
    assert.deepEqual(hooks[event][0].hooks, [{ type: 'command', command: COMMAND, timeout: 45 }], event);
  }
});

test('hook matcher: every tool that takes a capture, under all three prefixes, and nothing else', () => {
  const re = new RegExp(MATCHER);
  assert.deepEqual(takesCapture.sort(), ['add_code_ref', 'arrive', 'create_edge', 'mark_checkpoint', 'start_session']);
  for (const prefix of ['mcp__plugin_draw_draw__', 'mcp__draw__', 'mcp__draw-dev__', 'mcp__plugin_draw_redcrayon__', 'mcp__redcrayon__', 'mcp__redcrayon-dev__']) {
    for (const tool of TOOL_NAMES) assert.equal(re.test(prefix + tool), takesCapture.includes(tool), prefix + tool);
  }
  for (const other of ['mcp__redcrayon-live__start_session', 'mcp__plugin_other_redcrayon__add_code_ref', 'mcp__plugin_redcrayon_redcrayon__add_code_ref', 'mcp__redcrayon__add_code_ref_x']) {
    assert.equal(re.test(other), false, other);
  }
  // The bundled helper re-runs the matcher to pick the tool: the two must not drift.
  assert.ok(read('helper/src/capture.ts').includes(`export const HOOK_MATCHER = '${MATCHER}';`));
});

// ---- the navigate skill ----

const skillMd = read('plugin/skills/navigate/SKILL.md');
// The skill's modules, in the order SKILL.md links them; every module is linked.
const modules = [...new Set([...skillMd.matchAll(/\]\(\.\.\/\.\.\/references\/([\w-]+\.md)\)/g)].map(m => m[1]))];
const skill = [skillMd, ...modules.map(f => read(`plugin/references/${f}`))].join('\n');
const flat = skill.replace(/\s+/g, ' ');
const front = skillMd.match(/^---\n([^]*?)\n---\n/)[1];

test('skill modules: SKILL.md links every file in plugin/references', () => {
  assert.deepEqual([...modules].sort(), readdirSync(join(root, 'plugin/references')).sort());
});

test('skill frontmatter: navigate, with the spec allowed-tools', () => {
  assert.match(front, /^name: navigate$/m);
  // npx stays unapproved: Claude Code would run whatever npm serves under that name, unprompted.
  assert.match(front, /^allowed-tools: mcp__draw__\*, mcp__plugin_draw_draw__\*, Bash\(git:\*\), Read$/m);
});

test('skill text: no vendor, internals or retired words', () => {
  assert.doesNotMatch(skill, VENDOR);
  assert.doesNotMatch(skill, INTERNALS);
  assert.doesNotMatch(skill, /\bAlan\b/);
  assert.doesNotMatch(skill, /\bforce\b/);
  assert.doesNotMatch(skill, /(?<!\.)\btsx\b/, 'the .tsx extension is fine; the tsx runner is gone');
  assert.doesNotMatch(skill, /spacetime start|active board|link_dashboard/);
});

test('skill text: no command but git and the helper capture', () => {
  for (const line of skill.split('\n').filter(l => /\bnpx\b/.test(l))) assert.match(line, /npx -y @redcrayonai\/draw@1 capture/, line);
  const other = skill.match(/\b(?:pnpm|yarn|wrangler|npm)\s+[a-z-]+/);
  assert.equal(other, null, `SKILL.md runs ${other}`);
});

test('skill names only tools the hosted server registers', () => {
  const words = new Set(skill.replace(/mcp__[\w-]*?__/g, ' ').match(/\b[a-z]+(?:_[a-z]+)+\b/g));
  words.delete('module_bindings'); // the exclude example's glob
  words.delete('run_in_background'); // Claude Code's Bash parameter for the marks watcher
  assert.ok(words.size >= 15);
  for (const w of words) assert.ok(TOOL_NAMES.includes(w), `SKILL.md names ${w}, which mcp/src/tools.ts does not register`);
});

test('skill: preflight, link and name handling (Decision 19)', () => {
  assert.ok(skill.includes(PREFLIGHT));
  const start = flat.slice(flat.indexOf('## Start'), flat.indexOf('## Modules'));
  assert.match(start, /`\{ "link": "<the word>" \}`/);
  assert.ok(read('mcp/src/copy.ts').includes('`REJECTED: no board at ${link}. Nothing was written.'));
  assert.match(start, /`REJECTED: no board at <link>\. …`, relay that text to the user word for word and stop/);
  assert.match(start, /[Nn]ever open a different board/);
  assert.match(start, /git rev-parse --abbrev-ref HEAD/);
  assert.match(start, /detached HEAD[^.]*\. Ask the user/);
  assert.match(start, /`\{ "name": "<name>" \}`/);
  assert.match(start, /before your first file edit, draw them: one `create_node` with a `doc` \(\[editorial\.md\]\(\.\.\/\.\.\/references\/editorial\.md\)\) per component, all in one message/);
});

test('skill: independent writes go out together, so the board fills in without a turn per call', () => {
  const draw = flat.slice(flat.indexOf('# Draw'), flat.indexOf('**Naming TypeScript'));
  assert.match(draw, /every `create_node` of step 2 together, then every `create_edge` and `add_code_ref` of steps 3 and 4 together/);
  assert.match(draw, /Never send one write per message when several are ready/);
  assert.match(read('mcp/src/tools.ts'), /Send writes that do not need each other's results in one message/);
});

test('skill: start_session result and board ids match the hosted server', () => {
  const result = '{ board, id, url, seat, session, checkpoint?, repoRoot?, baseSha?, note?, dashboard?, dashboardNote? }';
  assert.ok(toolsTs.includes(`Returns JSON ${result}`));
  assert.ok(flat.includes(`The result is \`${result}\``));
  assert.ok(toolsTs.includes('relay dashboard with dashboardNote whenever they are there'));
  assert.ok(flat.includes('When `dashboard` and `dashboardNote` are present, relay both to the user verbatim'));
  assert.ok(toolsTs.includes("const boardArg = z.string().regex(/^\\d+$/).describe('the board id start_session returned');"));
  assert.ok(flat.includes('Every tool except `start_session` and `describe_charts` takes `board`'));
  for (const name of TOOL_NAMES) {
    const block = blocks.find(b => b.startsWith(`${name}:`));
    const takesBoard = /board: boardArg/.test(block);
    assert.equal(takesBoard, !['start_session', 'describe_charts'].includes(name), name);
  }
});

test('skill: the three failure rules match the server copy (Decision 25)', () => {
  const copy = read('mcp/src/copy.ts');
  for (const p of ['REJECTED: ', 'UNAVAILABLE: ', 'UNCONFIRMED: ']) assert.ok(copy.includes('`' + p), p);
  assert.ok(copy.includes('Call get_board before you retry.'));
  assert.match(flat, /`REJECTED: …` — a rule refused the call\. Read the sentence/);
  assert.match(flat, /`UNAVAILABLE: …` — redcrayon could not do the call\. Wait the time the text states/);
  assert.match(flat, /`UNCONFIRMED: …` — the write may have landed\. Call `get_board` before any retry/);
  assert.ok(copy.includes('export const sameCall = (seconds: number) => ` (same call ${seconds} s ago; nothing new written)`;'));
  assert.ok(flat.includes('`(same call <n> s ago; nothing new written)`'));
});

test('skill: captures — the plugin fills them; otherwise the command the text names', () => {
  const copy = read('mcp/src/copy.ts');
  assert.ok(copy.includes('`REJECTED: ${tool} needs a capture of your local ${'));
  assert.ok(flat.includes('`REJECTED: <tool> needs a capture of your local file. …`'));
  assert.ok(flat.includes('Leave `capture` empty: the redcrayon plugin fills it in'));
  assert.ok(flat.includes('Run the `npx -y @redcrayonai/draw@1 capture …` command the text names'));
});

// ---- the README ----

const readme = read('plugin/README.md');

test('README: What leaves your machine opens with the disclosure, then the upload table', () => {
  const section = readme.slice(readme.indexOf('## What leaves your machine'), readme.indexOf('## Boards and links'));
  const paragraphs = section.split(/\n\n+/);
  assert.equal(paragraphs[1], DISCLOSURE);
  assert.match(section, /\| kind \| Uploads \| Claimed by \|/);
  for (const kind of ['start', 'ref', 'cite', 'checkpoint']) assert.match(section, new RegExp(`^\\| ${kind} \\|`, 'm'), kind);
});

test('README: boards are private, the install commands, Remove everything, the support address', () => {
  assert.ok(readme.includes('Boards your agent opens are private to your account until you share them from your dashboard.'));
  assert.doesNotMatch(readme, /Boards are open/);
  assert.ok(readme.includes('claude plugin marketplace add redcrayonai/draw && claude plugin install draw@redcrayonai'));
  assert.ok(readme.includes('`/plugin marketplace add redcrayonai/draw`'));
  assert.ok(readme.includes('`/plugin install draw@redcrayonai`'));
  for (const client of ['### Claude Code', '### Cursor', '### Codex', '### claude.ai', '### Other clients']) assert.ok(readme.includes(client), client);
  const remove = readme.slice(readme.indexOf('## Remove everything'), readme.indexOf('## Windows'));
  for (const step of ['claude plugin uninstall draw@redcrayonai', '--git-common-dir)/redcrayon', '~/.npm/_npx/', 'Disconnect draw']) assert.ok(remove.includes(step), step);
  assert.match(readme, /support@[a-z0-9.-]+\.[a-z]+/);
  assert.ok(readme.includes('`redcrayon: Windows is not supported yet.`'));
});

test('README: the server URL appears once, the same as .mcp.json', () => {
  const url = hostedUrl(json('plugin/.mcp.json'));
  assert.equal(readme.split(url).length - 1, 1);
});

test('vendor scan: the plugin tree is clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-scan-'));
  writeFileSync(join(dir, 'targets'), 'tree plugin\n');
  assert.deepEqual(scan(join(dir, 'targets'), root, { hostedPlugin: process.env.PLUGIN_RELEASE_SCAN === '1' }), []);
  assert.match(read('scripts/vendor-scan.targets'), /^tree plugin$/m);
});

// ---- choosing the domain ----

test('plugin-config: one command moves every URL, the helper origin and the support address, and can run again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-config-'));
  mkdirSync(join(dir, 'plugin'));
  for (const f of ['.mcp.json', 'README.md']) cpSync(join(root, 'plugin', f), join(dir, 'plugin', f));
  // The source defaults to a local server; a configured release starts at its chosen domain.
  const currentOrigin = new URL(hostedUrl(json('plugin/.mcp.json'))).origin;
  const current = currentOrigin === 'http://localhost:8788' ? 'localhost:8788' : domainOf(currentOrigin);
  // without helper/ checked out, the plugin files alone
  assert.deepEqual(configure(dir, 'https://mcp.example.com'), { from: current, to: 'example.com', changed: ['plugin/.mcp.json', 'plugin/README.md'] });
  const mcp = JSON.parse(readFileSync(join(dir, 'plugin/.mcp.json'), 'utf8'));
  assert.equal(mcp.mcpServers.draw.url, '${REDCRAYON_MCP_URL:-https://mcp.example.com/mcp}');
  const after = readFileSync(join(dir, 'plugin/README.md'), 'utf8');
  assert.ok(!after.includes(PLACEHOLDER) && !after.includes(currentOrigin));
  assert.ok(after.includes('`https://mcp.example.com/mcp`'));
  assert.ok(after.includes('support@example.com'));
  // run again, now with the helper's hardcoded origin
  mkdirSync(join(dir, 'helper/src'), { recursive: true });
  const helper = read('helper/src/capture.ts').replaceAll(currentOrigin, 'https://mcp.example.com');
  writeFileSync(join(dir, 'helper/src/capture.ts'), helper);
  assert.deepEqual(configure(dir, 'https://mcp.other.dev'), { from: 'example.com', to: 'other.dev', changed: ['plugin/.mcp.json', 'plugin/README.md', 'helper/src/capture.ts'] });
  assert.ok(readFileSync(join(dir, 'plugin/README.md'), 'utf8').includes('support@other.dev'));
  assert.equal(readFileSync(join(dir, 'helper/src/capture.ts'), 'utf8'), helper.replaceAll('mcp.example.com', 'mcp.other.dev'));
});

test('plugin-config: refuses anything but https://mcp.<domain>', () => {
  for (const bad of ['', 'mcp.example.com', 'http://mcp.example.com', 'https://app.example.com', 'https://mcp.example.com/mcp', 'https://mcp.example.com:8443']) {
    assert.throws(() => domainOf(bad), /https:\/\/mcp\./, bad);
  }
  assert.equal(domainOf('https://mcp.example.com/'), 'example.com');
});

test('release-plugin: runs on a plugin-v tag or by hand on main or a tag, never from another branch', async () => {
  const { spawnSync } = await import('node:child_process');
  const workflow = read('.github/workflows/release-plugin.yml');
  assert.match(workflow, /^  workflow_dispatch:$/m);
  const guard = workflow.match(/case "\$GITHUB_REF" in\n[\s\S]*?esac/)[0].replace(/^ {10}/gm, '');
  const pick = (ref, name) => spawnSync('bash', ['-c', `package=1.2.3\n${guard}\necho "$tag"`], { env: { GITHUB_REF: ref, GITHUB_REF_NAME: name } });
  assert.equal(pick('refs/tags/plugin-v1.2.3', 'plugin-v1.2.3').stdout.toString().trim(), '1.2.3');
  assert.equal(pick('refs/heads/main', 'main').stdout.toString().trim(), '1.2.3');
  assert.equal(pick('refs/heads/feature', 'feature').status, 1);
});

test('plugin release requires the helper default to match its explicit deployment', () => {
  const block = read('.github/workflows/release-plugin.yml').match(/- name: Require an explicit deployment URL\n        run: \|\n((?:          .*\n)+)/)?.[1];
  assert.ok(block, 'missing deployment URL preflight');
  const script = block.replace(/^          /gm, '');
  const dir = mkdtempSync(join(tmpdir(), 'plugin-release-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'plugin'));
    mkdirSync(join(dir, 'helper/src'), { recursive: true });
    cpSync(join(root, 'scripts/plugin-config.mjs'), join(dir, 'scripts/plugin-config.mjs'));
    for (const [url, helperOrigin, status] of [
      ['http://localhost:8788/mcp', 'http://localhost:8788', 1],
      ['https://mcp.example.com/mcp', 'http://localhost:8788', 1],
      ['https://mcp.example.com/mcp', 'https://mcp.other.dev', 1],
      ['https://mcp.example.com/mcp', 'http://mcp.example.com', 1],
      ['https://mcp.example.com/mcp', 'https://mcp.example.com', 0],
    ]) {
      writeFileSync(join(dir, 'plugin/.mcp.json'), JSON.stringify({ mcpServers: { draw: { url: `\${REDCRAYON_MCP_URL:-${url}}` } } }));
      writeFileSync(join(dir, 'helper/src/capture.ts'), `export const DEFAULT_ORIGIN = '${helperOrigin}';\n`);
      assert.equal(spawnSync('bash', ['-eu', '-c', script], { cwd: dir }).status, status, `${url}, helper ${helperOrigin}`);
    }
    rmSync(join(dir, 'helper/src/capture.ts'));
    assert.equal(spawnSync('bash', ['-eu', '-c', script], { cwd: dir }).status, 1, 'missing helper source');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hosted plugin release configures and scans the packed plugin and marketplace', () => {
  const workflow = read('.github/workflows/release-plugin.yml');
  const stepScript = name => {
    const step = workflow.split(`- name: ${name}\n`)[1]?.split('\n      - ')[0];
    const body = step?.match(/        run: \|\n((?:          .*\n)+)/)?.[1];
    assert.ok(body, `missing ${name} workflow script`);
    return body.replace(/^          /gm, '');
  };
  const configuration = stepScript('Configure the release endpoint');
  const preflight = stepScript('Require an explicit deployment URL');
  const dir = mkdtempSync(join(tmpdir(), 'hosted-plugin-release-'));
  const run = (command, args, cwd = dir, env = process.env) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${command}: ${result.stderr || result.error || result.stdout}`);
    return result.stdout;
  };
  try {
    for (const name of ['plugin', '.claude-plugin', 'helper/src', 'helper/build.mjs', 'helper/package.json', 'agent/src', 'shared']) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      cpSync(join(root, name), join(dir, name), {
        recursive: true,
        filter: source => !['node_modules', 'dist', '.wrangler'].includes(basename(source)),
      });
    }
    symlinkSync(join(root, 'helper/node_modules'), join(dir, 'helper/node_modules'), 'dir');
    mkdirSync(join(dir, 'scripts'));
    cpSync(join(root, 'scripts/plugin-config.mjs'), join(dir, 'scripts/plugin-config.mjs'));
    for (const origin of ['', 'http://localhost:8788']) {
      const rejected = spawnSync('bash', ['-eu', '-c', configuration], {
        cwd: dir, env: { ...process.env, PLUGIN_MCP_ORIGIN: origin }, encoding: 'utf8',
      });
      assert.notEqual(rejected.status, 0, `configuration accepted ${origin || 'a missing origin'}`);
    }
    run('bash', ['-eu', '-c', configuration], dir, { ...process.env, PLUGIN_MCP_ORIGIN: HOSTED_PLUGIN_ORIGIN });
    run('bash', ['-eu', '-c', preflight]);
    assert.equal(hostedUrl(JSON.parse(readFileSync(join(dir, 'plugin/.mcp.json'), 'utf8'))), `${HOSTED_PLUGIN_ORIGIN}/mcp`);
    run(process.execPath, ['build.mjs'], join(dir, 'helper'));
    cpSync(join(dir, 'helper/dist/redcrayon.mjs'), join(dir, 'plugin/bin/redcrayon.mjs'));
    const pack = join(dir, 'pack');
    mkdirSync(pack);
    const [{ filename }] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', pack], join(dir, 'plugin')));
    run('tar', ['-xzf', join(pack, filename), '-C', pack]);
    const targets = join(dir, 'release.targets');
    writeFileSync(targets, `tree ${join(pack, 'package')}\ntree .claude-plugin\n`);
    const strict = scan(targets, dir);
    assert.equal(strict.length, 3, strict.join('\n'));
    for (const file of ['pack/package/.mcp.json', 'pack/package/README.md', 'pack/package/bin/redcrayon.mjs']) {
      assert.ok(strict.some(hit => hit.startsWith(`${join(dir, file)}:`) && hit.includes(': private word: ')), file);
    }
    assert.deepEqual(scan(targets, dir, { hostedPlugin: true }), []);
    const scanner = join(root, 'scripts/vendor-scan.mjs');
    const strictCli = spawnSync(process.execPath, [scanner, targets], { cwd: dir, encoding: 'utf8' });
    assert.equal(strictCli.status, 1, strictCli.stderr);
    run(process.execPath, [scanner, targets, '--hosted-plugin']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
