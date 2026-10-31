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
const versionSrc = readFileSync(new URL('./versions.ts', import.meta.url), 'utf8');
const declared = new Map([...src.matchAll(/^export const (\w+) = (reducer|spacetimedb\.reducer)\(/gm)].map(([, name, how]) => [name, how]));
const features = [workspaceSrc, serviceAccountSrc, pluginSrc, versionSrc];
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
  for (const [feature, group] of [[pluginSrc, 'pluginFeatures'], [versionSrc, 'versionFeatures']]) {
    assert.match(feature, /const reducer = hooks\.reducer;/, `${group} handlers use the supplied write-budget wrapper`);
    assert.match(src, new RegExp(`${group}\\(spacetimedb, \\{\\s*reducer,`), `${group} receives the same write-budget wrapper`);
  }
  // A procedure is not a reducer: each Versions procedure spends one write in a transaction of its own (charged).
  assert.match(versionSrc, /function charged\([^]*?ctx\.withTx\(\(tx: any\) => \{\s*hooks\.spendWrite\(tx\);/);
  const procedures = [...versionSrc.matchAll(/^ {4}(\w+): db\.procedure\(/gm)].map(([, name]) => name);
  assert.deepEqual(procedures, ['captureBoardVersion', 'restoreBoardVersion']);
  for (const name of procedures) assert.match(versionSrc.slice(versionSrc.indexOf(`    ${name}: `)).split(/\n    \w+: /)[0], /charged\(ctx, '\w+', /, `${name} spends a write`);
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
