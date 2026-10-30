#!/usr/bin/env node
// Vendor invisibility (spec §12): no surface we ship names the database
// behind redcrayon. Reads an explicit target list (scripts/vendor-scan.targets,
// or the file given as the first argument); a listed target that is missing
// fails, so a renamed output cannot silently drop out of the scan.
//
//   bundle <path>  a deployable: vendor words, and no .map file or sourceMappingURL comment
//   text <path>    what users and models read: vendor words and internals words
//   tree <path>    every file under a directory, as text
//   private <path> every file under a directory, private words only (a self-host
//                  image's files, which may name the database: RC-608)
//
// Open source (RC-600) adds the PRIVATE words: the auth vendor, our cloud
// account and production hosts. They are checked in every target above and,
// with --public, in every tracked file under scripts/public-paths.json. The
// database line: the public source tree may name the database (module/, deps,
// workflows), so --public checks PRIVATE words only; bundles and what users
// read still name no database vendor.
//
// Prints file:line per hit and exits 1 on any. Source exceptions below never
// apply to bundles, images or user-facing text. --enforce is an explicit alias
// for the default, fail-closed behavior.
// --hosted-plugin permits the public MCP endpoint only in three release slots
// (RC-600's plugin/helper integration exception); it cannot be used with --public.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export const VENDOR = /spacetime|maincloud|bsatn|clockwork|\bstdb\b/i;
export const INTERNALS = /\breducer|wasm|energy budget|SenderError|panic/i;
export const PRIVATE = /clerk|(?:pk|sk)_(?:live|test)_|maincloud|account_id|\b(?:staging\.)?(?:mcp|draw|dash|rt|app)(?:-staging)?\.redcrayon\.ai\b|namespace_id|new_sqlite_classes/i;
// Each exception is source-only, with an exact file and a reason. Never exempt
// an entire integration file: a new import or hosted URL must still fail.
export const SOURCE_ALLOW = [
  [".gitleaks.toml", "regexes = ['''pk_test_ZXhhbXBsZS50ZXN0JA==''']", "exact public-key fixture needed to scan private history; remove at the fresh-history split"],
  [".gitleaks.toml", "regexes = ['''pk_live_Y2xlcmsucmVkY3JheW9uLmFpJA''']", "exact public-key fixture needed to scan private history; remove at the fresh-history split"],
  ["client/src/connect.test.ts", "expect(s).not.toMatch(/spacetime|maincloud|bsatn|clockwork|\\bstdb\\b/i);", "regression assertion that connection errors disclose no backend names"],
  ["mcp/src/scrub.test.ts", "const VENDOR = /spacetime|maincloud|bsatn|clockwork|\\bstdb\\b/i;", "backend-error redaction regression fixture; never shipped in a bundle"],
  ["mcp/src/scrub.test.ts", "['402 energy', new DbError(402, 'the database answered 402 to call/x: out of energy on maincloud'), true, 'UNAVAILABLE: redcrayon is unavailable. Nothing was written.'],", "backend-error redaction regression fixture; never shipped in a bundle"],
  ["mcp/src/scrub.test.ts", "['network error naming the host', new TypeError('fetch failed: getaddrinfo maincloud.spacetimedb.com'), true, 'UNCONFIRMED: redcrayon did not confirm the write within 15 s.'],", "backend-error redaction regression fixture; never shipped in a bundle"],
  ["mcp/src/scrub.test.ts", "expect(DENYLIST.source).toBe('spacetime|stdb|maincloud|clockwork|bsatn|panic|wasm|energy');", "backend-error redaction regression fixture; never shipped in a bundle"],
  ["mcp/src/tools.test.ts", "const VENDOR = /spacetime|maincloud|bsatn|clockwork|\\bstdb\\b/i;", "regression assertion that tool responses disclose no backend names"],
  ["web/src/routes/settings/agent/page.test.ts", "expect(text).not.toMatch(/spacetime|maincloud|bsatn|clockwork|\\bstdb\\b/i);", "regression assertion that settings text discloses no backend names"],
  ["shared/capture.test.ts", "expect(findSecret('export const AKIA = 1;\\nconst key = process.env.API_KEY;\\nconst pk = \"pk_live_abc\";')).toBeUndefined();", "deliberately truncated public-key fixture proves it is not a secret"],
  ["scripts/ci-workflows.test.mjs", "assert.doesNotMatch(text, /\"routes\"|\"route\"|\"account_id\"|\"env\"/, `${dir}/wrangler.jsonc must stay dev-only`);", "regression assertion forbidding hosted account configuration in local files"],
  ['mcp/wrangler.jsonc', /^\{ "tag": "v[123]", "new_sqlite_classes": \["(?:User|Capture|Live)"\] \},?$/, 'local Durable Object migration declarations required by workerd'],
  ['mcp/wrangler.jsonc', /^\{ "name": "(?:CALLS_RL|IP_RL|ANTHROPIC_RL|FACTS_RL)", "namespace_id": "[1-4]", "simple": \{ "limit": (?:60|120|600), "period": 60 \} \},?$/, 'local rate-limit binding identifiers, without hosted account data'],
];
export const HOSTED_PLUGIN_ORIGIN = 'https://mcp.redcrayon.ai';
const helperDefault = `var DEFAULT_ORIGIN = "${HOSTED_PLUGIN_ORIGIN}";`;
// Exact release-only lines in the identified plugin package, never whole files or other hostnames.
export const HOSTED_PLUGIN_ALLOW = [
  ['plugin/.mcp.json', `"draw": { "type": "http", "url": "\${REDCRAYON_MCP_URL:-${HOSTED_PLUGIN_ORIGIN}/mcp}" }`, 'hosted plugin server entry must advertise its public MCP endpoint'],
  ['plugin/README.md', `**Server URL:** \`${HOSTED_PLUGIN_ORIGIN}/mcp\``, 'hosted plugin install instructions must match its server entry'],
  ['plugin/bin/redcrayon.mjs', helperDefault, 'bundled capture helper must use the plugin server by default'],
];
const MAP_COMMENT = /^\s*\/\/[#@] sourceMappingURL=/;
const PRIVATE_HIT = ': private word: ';

function files(path) {
  return statSync(path).isDirectory() ? readdirSync(path, { recursive: true }).map(p => join(path, String(p))).filter(p => statSync(p).isFile()) : [path];
}

function privateWords(file, text, hits, { source = false, hostedPluginPath } = {}) {
  if (text.includes('\0') && !source) return;
  // The policy and its attack fixtures are source evidence; neither may
  // bypass the artifact scan.
  if (source && /^scripts\/vendor-scan(?:\.test)?\.mjs$/.test(file)) return;
  text.split('\n').forEach((line, i) => {
    // This app-owned field is provider-neutral; still scan the rest of its line.
    if (!PRIVATE.test(line.replace(/\bservice_account_id\b/gi, ''))) return;
    const allowed = source
      ? SOURCE_ALLOW.some(([path, pattern]) => file === path && (typeof pattern === 'string' ? pattern === line.trim() : pattern.test(line.trim())))
      : HOSTED_PLUGIN_ALLOW.some(([path, text]) => hostedPluginPath === path && line.trim() === text);
    if (!allowed) {
      hits.push(`${file}:${i + 1}${PRIVATE_HIT}${line.trim().slice(0, 160)}`);
    }
  });
}

export function scan(targetsFile, root = process.cwd(), { hostedPlugin = false } = {}) {
  const hits = [];
  const lines = readFileSync(targetsFile, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  for (const line of lines) {
    const [kind, rel] = line.split(/\s+/, 2);
    const path = resolve(root, rel);
    if (!['bundle', 'text', 'tree', 'private'].includes(kind)) {
      hits.push(`${targetsFile}: unknown target kind '${kind}'`);
      continue;
    }
    if (!existsSync(path)) {
      hits.push(`${rel}: listed target is missing`);
      continue;
    }
    const manifest = hostedPlugin && kind === 'tree' && existsSync(join(path, 'package.json'))
      ? JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) : null;
    const pluginPackage = manifest?.name === '@redcrayonai/draw' && manifest.bin?.redcrayon === 'bin/redcrayon.mjs';
    for (const file of files(path)) {
      if (kind === 'bundle' && file.endsWith('.map')) hits.push(`${file}: source map in a deployable`);
      if (kind === 'bundle') for (const f of readdirSync(dirname(file))) if (f.endsWith('.map')) hits.push(`${join(dirname(file), f)}: source map in a deployable`);
      const body = readFileSync(file, 'utf8');
      if (kind !== 'private') body.split('\n').forEach((text, i) => {
        const at = `${file}:${i + 1}`;
        if (VENDOR.test(text)) hits.push(`${at}: vendor word: ${text.trim().slice(0, 160)}`);
        if (kind !== 'bundle' && INTERNALS.test(text)) hits.push(`${at}: internals word: ${text.trim().slice(0, 160)}`);
        if (kind === 'bundle' && MAP_COMMENT.test(text)) hits.push(`${at}: sourceMappingURL in a deployable`);
      });
      const hostedPluginPath = pluginPackage ? `plugin/${relative(path, file)}` : undefined;
      privateWords(file, body, hits, { hostedPluginPath });
    }
  }
  return [...new Set(hits)];
}

// Every tracked file under the public paths; a listed path with no tracked file fails.
export function scanPublic(root = process.cwd()) {
  const hits = [];
  for (const dir of JSON.parse(readFileSync(join(root, 'scripts/public-paths.json'), 'utf8'))) {
    const tracked = execFileSync('git', ['ls-files', '-z', '--', dir], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean);
    if (!tracked.length) hits.push(`${dir}: listed public path has no tracked files`);
    for (const rel of tracked) {
      const path = join(root, rel);
      if (existsSync(path) && statSync(path).isFile()) privateWords(rel, readFileSync(path, 'utf8'), hits, { source: true });
    }
  }
  return hits;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flags = args.filter(a => a.startsWith('--'));
  const unknown = flags.filter(f => !['--public', '--enforce', '--hosted-plugin'].includes(f));
  if (unknown.length) {
    console.error(`vendor-scan: unknown flag ${unknown.join(' ')} (use --public, --enforce, --hosted-plugin)`);
    process.exit(2);
  }
  if (flags.includes('--public') && flags.includes('--hosted-plugin')) {
    console.error('vendor-scan: --hosted-plugin is for release artifacts only; it cannot be used with --public');
    process.exit(2);
  }
  const hits = flags.includes('--public') ? scanPublic() : scan(
    args.find(a => !a.startsWith('--')) ?? new URL('./vendor-scan.targets', import.meta.url).pathname,
    process.cwd(), { hostedPlugin: flags.includes('--hosted-plugin') }
  );
  const reported = hits.filter(h => h.includes(PRIVATE_HIT));
  for (const h of hits) console.error(h);
  if (reported.length) {
    const byPath = {};
    for (const h of reported) {
      const top = relative(process.cwd(), h.slice(0, h.indexOf(':'))).split('/')[0];
      byPath[top] = (byPath[top] ?? 0) + 1;
    }
    const counts = Object.entries(byPath).sort(([, a], [, b]) => b - a).map(([p, n]) => `${p} ${n}`).join(', ');
    console.error(`vendor-scan: ${reported.length} private word(s): ${counts}`);
  }
  if (hits.length) {
    console.error(`vendor-scan: ${hits.length} hit(s)`);
    process.exit(1);
  }
  console.error('vendor-scan: clean');
}
