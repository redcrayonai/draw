#!/usr/bin/env node
// The live drift check (spec §9 steps 4 and 9, §12 Drift): after a publish,
// every reducer the mcp Worker calls must exist on the published database
// with the arguments mcp/src/reducers.gen.ts says, in the same order, with
// the same types and optionality. The offline half is mcp's gen.test.ts.
//
//   spacetime describe --json --server <server> <db> > describe.json
//   node scripts/live-drift.mjs describe.json [reducers.gen.ts]     (- reads stdin)
//
// Exits 1 with one line per difference. Reducers the Worker does not call are
// ignored: the module may have more.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** REDUCER_ARGS from reducers.gen.ts's text: { name: [[arg, type, optional], ...] }. */
export function parseReducerArgs(text) {
  const out = {};
  for (const [, name, list] of text.matchAll(/^ {2}(\w+): \[(.*)\],$/gm)) {
    out[name] = [...list.matchAll(/\['(\w+)', '(\w+)', (true|false)\]/g)].map(([, arg, type, optional]) => [arg, type, optional === 'true']);
  }
  if (Object.keys(out).length === 0) throw new Error('no REDUCER_ARGS rows found');
  return out;
}

// The bindings generator's names (`__t.<name>(`) for the describe output's algebraic types.
const SPECIAL = { __identity__: 'identity', __connection_id__: 'connectionId', __timestamp_micros_since_unix_epoch__: 'timestamp', __time_duration_micros__: 'timeDuration' };

/** [type, optional] for one algebraic type of `spacetime describe --json`. */
export function typeOf(t) {
  const [kind] = Object.keys(t);
  if (kind === 'Sum') {
    const v = t.Sum.variants;
    if (v.length === 2 && v[0].name?.some === 'some' && v[1].name?.some === 'none') return [typeOf(v[0].algebraic_type)[0], true];
    return ['enum', false];
  }
  if (kind === 'Product') {
    const els = t.Product.elements;
    return [(els.length === 1 && SPECIAL[els[0].name?.some]) || 'object', false];
  }
  // shortcut: a Ref (a named type) stays 'ref'; resolve it through the Typespace when a reducer the Worker calls takes one.
  return [kind.toLowerCase(), false];
}

const camelToSnake = s => s.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);

/** The database's reducers by their HTTP name: { name: [[arg, type, optional], ...] }. */
export function liveReducers(describe) {
  const section = key => describe.sections.find(s => s[key])?.[key];
  const reducers = section('Reducers');
  if (!reducers) throw new Error('the describe output has no Reducers section');
  const canonical = new Map((section('ExplicitNames')?.entries ?? []).flatMap(e => (e.Function ? [[e.Function.source_name, e.Function.canonical_name]] : [])));
  const out = {};
  for (const r of reducers) {
    out[canonical.get(r.source_name) ?? camelToSnake(r.source_name)] = r.params.elements.map(p => [p.name?.some ?? '', ...typeOf(p.algebraic_type)]);
  }
  return out;
}

const show = args => `(${args.map(([a, t, o]) => `${a}${o ? '?' : ''}: ${t}`).join(', ')})`;
// Calls are positional, so a name differing only in case style is no drift: since 2026-10-30
// the hosted describe reports snake_case parameter names (board_id) for the module's boardId.
const same = (a, b) => show(a.map(([n, ...r]) => [camelToSnake(n), ...r])) === show(b.map(([n, ...r]) => [camelToSnake(n), ...r]));

/** One line per reducer whose live signature differs from the expected one. */
export function drift(expected, live) {
  const lines = [];
  for (const [name, want] of Object.entries(expected)) {
    const got = live[name];
    if (!got) lines.push(`${name}: missing on the database; the Worker calls it ${show(want)}`);
    else if (!same(got, want)) lines.push(`${name}: the Worker calls ${show(want)}\n${' '.repeat(name.length + 2)}the database has ${show(got)}`);
  }
  return lines;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, gen = new URL('../mcp/src/reducers.gen.ts', import.meta.url)] = process.argv.slice(2);
  if (!file) {
    console.error('usage: node scripts/live-drift.mjs <describe.json|-> [reducers.gen.ts]');
    process.exit(2);
  }
  const expected = parseReducerArgs(readFileSync(gen, 'utf8'));
  const lines = drift(expected, liveReducers(JSON.parse(readFileSync(file === '-' ? 0 : file, 'utf8'))));
  if (lines.length) {
    console.error(`live drift: ${lines.length} of ${Object.keys(expected).length} reducers differ from mcp/src/reducers.gen.ts:\n${lines.join('\n')}`);
    console.error('Regenerate the bindings and run `pnpm -C mcp run gen` with the module that was published, or publish the module the Worker was built for.');
    process.exit(1);
  }
  console.log(`live drift: none (${Object.keys(expected).length} reducers match)`);
}
