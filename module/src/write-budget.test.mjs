// RC-571: every exported reducer either spends from the write budget (declared
// with index.ts's `reducer`) or is on EXEMPT below with its reason. A new
// reducer declared with spacetimedb.reducer fails here until it is listed.
// The budget itself runs against a database: scripts/verify-issuers-local.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const EXEMPT = {
  // presence: rewrites the sender's own row, as often as the pointer moves
  updateCursor: 'presence',
  setSelection: 'presence', // a marquee drag sends up to 10 a second
  openBoards: 'presence', // the boards a connection shows; refusing it blanks the canvas
  joinBoard: 'presence', // the participant row, on every canvas load
  claimMarks: 'presence', // a waiting agent's seat renews its leases every 2 s
  markRepliesRead: 'presence', // the sender's own read pointer, on every view of the replies
  // geometry: a drag or layout_board writes one call per node moved
  moveNode: 'geometry',
  resizeNode: 'geometry',
  // service only (assertService): services have no budget
  seedDemoBoard: 'service',
  resetDemo: 'service',
  backfillBoardStats: 'service',
  backfillBoardSlugs: 'service',
  setArchitectureImportStatus: 'service',
  publishArchitectureSnapshot: 'service',
  setOrgMemberships: 'service',
  dropOrg: 'service',
  ackActivity: 'service',
  linkHostedAgent: 'service',
  grantHostedAgentBoard: 'service',
  migrateLegacyWorkspaces: 'service',
  deactivateWorkspaceIdentity: 'service',
  expireWorkspaceApiKey: 'schedule', // the database expires key grants, never a client
  wipeStoredCode: 'service',
  publishBoardVersion: 'service', // the dashboard server lists a version it stored
};

const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const workspaceSrc = readFileSync(new URL('./workspaces.ts', import.meta.url), 'utf8');
const serviceAccountSrc = readFileSync(new URL('./workspace-service-accounts.ts', import.meta.url), 'utf8');
const pluginSrc = readFileSync(new URL('./plugins.ts', import.meta.url), 'utf8');
function pluginSources(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const file = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, folder);
    return entry.isDirectory() ? pluginSources(file) : entry.name.endsWith('.ts') && !entry.name.includes('.test.') ? [{ file, source: readFileSync(file, 'utf8') }] : [];
  });
}
const pluginModules = readdirSync(new URL('../../plugins/', import.meta.url), { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .flatMap(entry => {
    const folder = new URL(`../../plugins/${entry.name}/module/`, import.meta.url);
    try { return pluginSources(folder); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  });
const versionSrc = pluginModules.find(({ file }) => file.pathname.endsWith('/versions/module/index.ts'))?.source;
assert.ok(versionSrc, 'the Versions module is included in the plugin audit');
const declared = new Map([...src.matchAll(/^export const (\w+) = (reducer|spacetimedb\.reducer)\(/gm)].map(([, name, how]) => [name, how]));
const features = [workspaceSrc, serviceAccountSrc, pluginSrc, ...pluginModules.map(({ source }) => source)];
for (const feature of features) {
  for (const [, name, how] of feature.matchAll(/^ {4}(\w+): (reducer|db\.reducer)\(/gm)) declared.set(name, how === 'reducer' ? how : 'spacetimedb.reducer');
}
const camel = s => s.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
// The generated bindings name every reducer the database exports, however it is declared.
const exported = readdirSync(new URL('../../client/src/module_bindings/', import.meta.url))
  .filter(f => f.endsWith('_reducer.ts'))
  .map(f => camel(f.slice(0, -'_reducer.ts'.length)));

test('every exported reducer has a budgeted or explicitly exempt handler', () => {
  assert.ok(exported.length > 50, 'the bindings list the reducers');
  assert.deepEqual(exported.filter(name => !declared.has(name)), []);
  assert.match(workspaceSrc, /const reducer = hooks\.reducer;/, 'native handlers use the supplied write-budget wrapper');
  assert.match(src, /workspaceFeatures\(spacetimedb, \{\s*reducer,/, 'the native workspace group receives the same write-budget wrapper');
  assert.match(serviceAccountSrc, /const reducer = hooks\.reducer;/, 'service account management uses the supplied write-budget wrapper');
  assert.match(src, /workspaceServiceAccountFeatures\(spacetimedb, \{\s*reducer,/, 'service account management receives the same write-budget wrapper');
  assert.match(pluginSrc, /const reducer = hooks\.reducer;/, 'plugin switches use the supplied write-budget wrapper');
  assert.match(src, /const api: ModuleApi = \{\s*reducer,/, 'the shared plugin API receives the write-budget wrapper');
  assert.match(src, /pluginFeatures\(spacetimedb, api\)/, 'plugin switches receive the shared API');
  assert.match(src, /pluginActions\(PLUGIN_PARTS, spacetimedb, api,/, 'every plugin receives the shared API');
  for (const { file, source } of pluginModules) {
    if (/\breducer\(/.test(source)) assert.match(source, /const reducer = api\.reducer;/, `${file} uses the supplied write-budget wrapper`);
  }
  // A procedure is not a reducer: each Versions procedure spends one write in a transaction of its own (charged).
  assert.match(versionSrc, /function charged\([^]*?ctx\.withTx\(\(tx: any\) => \{\s*api\.spendWrite\(tx\);/);
  const procedures = [...versionSrc.matchAll(/^ {4}(\w+): db\.procedure\(/gm)].map(([, name]) => name);
  assert.deepEqual(procedures, ['captureBoardVersion', 'restoreBoardVersion']);
  for (const name of procedures) assert.match(versionSrc.slice(versionSrc.indexOf(`    ${name}: `)).split(/\n    \w+: /)[0], /charged\(ctx, '\w+', /, `${name} spends a write`);
});

test('plugin switches and generated actions retain the SDK export groups that stabilize bindings', () => {
  assert.match(src, /export const plugins = spacetimedb\.exportGroup\(switches\);/);
  assert.match(src, /export const versions = spacetimedb\.exportGroup\(pluginActions\(PLUGIN_PARTS, spacetimedb, api, Object\.keys\(switches\)\) as Record<string, ModuleExport>\);/);
});

test('every exported procedure spends a write or is explicitly read-only', () => {
  const direct = [...src.matchAll(/^export const (\w+) = spacetimedb\.procedure\(/gm)];
  const pluginProcedures = pluginModules.flatMap(({ source }) => [...source.matchAll(/^ {4}(\w+): db\.procedure\(/gm)].map(match => ({ name: match[1], source, index: match.index })));
  for (const { name, source, index } of pluginProcedures) {
    const body = source.slice(index).split(/\n    \w+: /)[0];
    assert.match(body, /charged\(ctx, '\w+', /, `${name} spends a write`);
    assert.match(source, /function charged\([^]*?ctx\.withTx\(\(tx: any\) => \{\s*api\.spendWrite\(tx\);/, `${name} charges its transaction`);
  }
  const exported = readdirSync(new URL('../../client/src/module_bindings/', import.meta.url))
    .filter(f => f.endsWith('_procedure.ts'))
    .map(f => camel(f.slice(0, -'_procedure.ts'.length)));
  assert.deepEqual([...direct.map(([, name]) => name), ...pluginProcedures.map(({ name }) => name)].sort(), exported.sort(), 'every procedure is covered by the budget contract');
  const readOnly = ['readBoardSnapshot'];
  assert.deepEqual(readOnly.filter(name => !direct.some(([, declared]) => declared === name)), [], 'read-only exemptions still name a procedure');
  for (const match of direct) {
    if (readOnly.includes(match[1])) continue;
    const body = src.slice(match.index).split('\nexport ')[0];
    assert.match(body, /\bspendWrite\(tx\);/, `${match[1]} spends a write in its transaction`);
  }
});

test('a reducer skips the write budget only when EXEMPT names it, and every exemption is still a reducer', () => {
  const unbudgeted = [...declared].filter(([, how]) => how === 'spacetimedb.reducer').map(([name]) => name);
  assert.deepEqual(unbudgeted.filter(name => !(name in EXEMPT)), [], 'budget these with `reducer(`, or list them in EXEMPT with a reason');
  assert.deepEqual(Object.keys(EXEMPT).filter(name => declared.get(name) !== 'spacetimedb.reducer'), [], 'EXEMPT names a budgeted or removed reducer');
});

test('a service-only exemption asserts the service account first', () => {
  for (const [name, why] of Object.entries(EXEMPT)) {
    if (why !== 'service') continue;
    const index = src.indexOf(`export const ${name} = `);
    const feature = features.find(f => f.includes(`    ${name}: `));
    const body = index >= 0 ? src.slice(index).split('\nexport ')[0] : feature.slice(feature.indexOf(`    ${name}: `)).split(/\n    \w+: /)[0];
    assert.match(body, /assertService\(ctx\)/, `${name} is listed as service only`);
  }
});

test('scheduled key expiry is restricted to the database scheduler', () => {
  const body = serviceAccountSrc.slice(serviceAccountSrc.indexOf('    expireWorkspaceApiKey: ')).split(/\n    \w+: /)[0];
  assert.match(body, /ctx\.sender\.isEqual\(ctx\.databaseIdentity\)/);
});
