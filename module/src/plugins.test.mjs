import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'spacetimedb/server') return { url: 'data:text/javascript,' + encodeURIComponent(`
    export class SenderError extends Error {}
    export const table = () => ({});
    const builder = new Proxy(() => builder, { get: () => builder });
    export const t = builder;
  `), shortCircuit: true };
  if (specifier === './workspaces') return { url: 'data:text/javascript,export const membership = () => undefined;', shortCircuit: true };
  try { return next(specifier, context); } catch (e) { if (specifier.startsWith('.')) return next(`${specifier}.ts`, context); throw e; }
} });
const { checkPlugins, pluginActions } = await import('./plugins.ts');
const { PLUGIN_TABLES } = await import('./plugin-meta.generated.ts');
const versionTables = Object.fromEntries(Object.keys(PLUGIN_TABLES).map(name => [name, {}]));

test('plugin tables match the manifest exactly and cannot replace core tables', () => {
  assert.doesNotThrow(() => checkPlugins(['board'], { versions: { tables: versionTables } }));
  assert.throws(() => checkPlugins(['boardVersion'], { versions: { tables: versionTables } }), /plugin rule:.*boardVersion/);
  for (const tables of [{}, { ...versionTables, surprise: {} }, { ...versionTables, constructor: {} }]) {
    assert.throws(() => checkPlugins([], { versions: { tables } }), /plugin rule:/);
  }
  assert.throws(() => checkPlugins([], {}), /plugin rule:.*boardVersion/);
  assert.throws(() => checkPlugins([], { versions: { tables: versionTables }, other: { tables: { boardVersion: {} } } }), /plugin rule:.*boardVersion/);
});

test('plugin actions receive the shared API and merge without losing prototype-named actions', () => {
  const db = {}, api = {}, action = {};
  const parts = { versions: { tables: {}, features(receivedDb, receivedApi) {
    assert.equal(receivedDb, db);
    assert.equal(receivedApi, api);
    return { save: action, constructor: action, ['__proto__']: action };
  } }, empty: { tables: {} } };
  const actions = pluginActions(parts, db, api, []);
  assert.equal(actions.save, action);
  assert.ok(Object.hasOwn(actions, 'constructor'));
  assert.ok(Object.hasOwn(actions, '__proto__'));
});

test('duplicate actions between parts or reserved switch/core actions fail before merging', () => {
  const part = name => ({ tables: {}, features: () => ({ [name]: {} }) });
  for (const name of ['save', 'constructor', '__proto__']) {
    assert.throws(() => pluginActions({ first: part(name), second: part(name) }, {}, {}, []), /plugin rule:/);
    assert.throws(() => pluginActions({ first: part(name) }, {}, {}, [name]), /plugin rule:/);
  }
});
