// A plugin's database schema, as the lock file records it (PLUGINS.md, decision 9; builder
// spec §5, §7.2–7.4): read from the database's own `describe --json` (V10), compared across
// upgrades, and rendered back into tables-only TypeScript for skipped or retired plugins.
//
// Normalized shape, per plugin: { types, tables, wire }
//   types:  { <TypeName>: Type }  named product/sum types the plugin's columns use
//   tables: { <tsTableKey>: {
//     name:       SQL name ('board_version')
//     public:     boolean
//     columns:    [[snakeName, Type], ...]   in row order
//     keys:       { snakeName: tsKey }       only where the TypeScript key differs (read from index names)
//     primaryKey: [snakeName...]
//     autoInc:    [snakeName...]
//     unique:     [[snakeName...], ...]      sorted
//     indexes:    [{ name, accessor, algorithm: 'btree'|'hash'|'direct', columns: [snakeName...] }]  sorted by name
//   } }
//   wire:   publicWire contracts (scripts/check-wire-compat.mjs) of the plugin's public tables and views
// Type: { U64: [] } and the other primitives, { Product: [[name, Type]] }, { Sum: [[name, Type]] },
// { Array: Type }, { Named: '<TypeName>' }. Column defaults are left out on purpose: a table
// published without them keeps its rows and nothing else changes (spike S1).
import { publicWire } from './check-wire-compat.mjs';

const PRIMITIVES = ['Bool', 'String', 'I8', 'U8', 'I16', 'U16', 'I32', 'U32', 'I64', 'U64', 'I128', 'U128', 'I256', 'U256', 'F32', 'F64'];
// One-element products the SDK builds for its special types.
const SPECIAL = { __identity__: 'identity', __connection_id__: 'connectionId', __timestamp_micros_since_unix_epoch__: 'timestamp', __time_duration_micros__: 'timeDuration', __uuid__: 'uuid' };
const tag = value => Object.keys(value)[0];
const some = value => value?.some;
const sections = describe => Object.fromEntries(describe.sections.map(section => [tag(section), section[tag(section)]]));

/** The plugin's part of a describe: tables named in the manifest, their types, and public names core lacks. */
export function pluginSchema(describe, coreDescribe, manifestTables) {
  const s = sections(describe), core = sections(coreDescribe), problems = [];
  const types = s.Typespace.types, names = new Map((s.Types ?? []).map(entry => [entry.ty, entry.source_name.source_name]));
  const sqlName = key => (s.ExplicitNames?.entries ?? []).find(entry => entry.Table?.source_name === key)?.Table.canonical_name ?? key;
  const coreTables = new Set(core.Tables.map(table => table.source_name));
  const out = { types: {}, tables: {}, wire: {} };
  const convert = (type, where, seen = new Set()) => {
    const kind = tag(type), value = type[kind];
    if (kind === 'Ref') {
      if (seen.has(value)) { problems.push(`${where} uses a recursive type, which a retired plugin cannot rebuild`); return { Named: '?' }; }
      const name = names.get(value), inner = convert(types[value], where, new Set([...seen, value]));
      if (!name) return inner;
      out.types[name] = inner;
      return { Named: name };
    }
    if (kind === 'Array') return { Array: convert(value, where, seen) };
    if (kind === 'Product') return { Product: value.elements.map(e => [some(e.name), convert(e.algebraic_type, where, seen)]) };
    if (kind === 'Sum') return { Sum: value.variants.map(v => [some(v.name), convert(v.algebraic_type, where, seen)]) };
    if (!PRIMITIVES.includes(kind)) problems.push(`${where} uses type ${kind}, which a retired plugin cannot rebuild`);
    return { [kind]: [] };
  };
  for (const table of s.Tables) {
    const key = table.source_name;
    if (coreTables.has(key)) continue;
    if (!Object.hasOwn(manifestTables, key)) { problems.push(`table '${key}' is not declared in plugin.json`); continue; }
    const where = `table '${key}'`;
    const row = convert({ Ref: table.product_type_ref }, where);
    const productRow = row.Named ? out.types[row.Named] : row;
    if (row.Named) delete out.types[row.Named]; // the row type is the table itself, not a column type
    const columns = productRow.Product;
    const col = i => columns[i][0];
    for (const [name, type] of columns) if (!renderable(type, out.types)) problems.push(`${where} column '${name}' has a type a retired plugin cannot rebuild`);
    if (tag(table.table_type) !== 'User' || table.is_event) problems.push(`${where} is not a plain table`);
    if ((s.Schedules ?? []).some(schedule => schedule.table_name === sqlName(key))) problems.push(`${where} is scheduled; plugins outside this repo cannot have scheduled tables`);
    for (const seq of table.sequences) if (seq.increment !== 1 || [seq.start, seq.min_value, seq.max_value].some(v => v?.some !== undefined)) problems.push(`${where} has a custom sequence`);
    if (columns.some(([name]) => name === 'board_id') && manifestTables[key]?.board !== 'outlives') problems.push(`${where} has a board_id column; declare "board": "outlives" in plugin.json`);
    const keys = {}, indexes = [];
    for (const index of table.indexes) {
      const algorithm = { BTree: 'btree', Hash: 'hash', Direct: 'direct' }[tag(index.algorithm)];
      const cols = [index.algorithm[tag(index.algorithm)]].flat().map(col);
      const name = some(index.source_name), accessor = some(index.accessor_name);
      // The SDK names an index `<table>_<keys joined by _>_idx_<algorithm>`, with TypeScript keys.
      const middle = name.slice(key.length + 1, -`_idx_${algorithm}`.length).split('_');
      if (!name.startsWith(`${key}_`) || middle.length !== cols.length) problems.push(`${where} index '${name}' cannot be rebuilt (column keys are ambiguous)`);
      else cols.forEach((c, i) => { if (middle[i] !== c) keys[c] = middle[i]; });
      indexes.push({ name, accessor, algorithm, columns: cols });
    }
    out.tables[key] = {
      name: sqlName(key),
      public: tag(table.table_access) === 'Public',
      columns,
      keys,
      primaryKey: table.primary_key.map(col),
      autoInc: table.sequences.map(seq => col(seq.column)),
      unique: table.constraints.map(c => c.data.Unique.columns.map(col)).sort((a, b) => a.join().localeCompare(b.join())),
      indexes: indexes.sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
  for (const key of Object.keys(manifestTables)) if (!out.tables[key]) problems.push(`table '${key}' is declared in plugin.json but missing from the database`);
  const coreWire = publicWire(coreDescribe);
  for (const [name, contract] of Object.entries(publicWire(describe))) if (!Object.hasOwn(coreWire, name)) out.wire[name] = contract;
  return { schema: out, problems };
}

const renderable = (type, types) => {
  const kind = tag(type), value = type[kind];
  if (kind === 'Named') return Object.hasOwn(types, value) && (types[value].Product || types[value].Sum)
    && (types[value].Product ?? types[value].Sum).every(([, t]) => renderable(t, types));
  if (kind === 'Array') return renderable(value, types);
  if (kind === 'Product') return (value.length === 1 && SPECIAL[value[0][0]]) || value.length === 0;
  if (kind === 'Sum') return value.length === 2 && value[0][0] === 'some' && value[1][0] === 'none' && renderable(value[0][1], types);
  return PRIMITIVES.includes(kind);
};

const describeType = type => {
  const kind = tag(type);
  if (kind === 'Named') return type.Named;
  if (kind === 'Array') return `Array<${describeType(type.Array)}>`;
  if (kind === 'Product' && type.Product.length === 1 && SPECIAL[type.Product[0][0]]) return SPECIAL[type.Product[0][0]];
  if (kind === 'Sum' && type.Sum[0]?.[0] === 'some') return `Option<${describeType(type.Sum[0][1])}>`;
  return PRIMITIVES.includes(kind) ? kind : JSON.stringify(type);
};
// Key order does not count: the lock file stores keys sorted.
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
// Structural: type names do not matter to the database (spike S1).
const resolved = (type, types) => {
  const kind = tag(type), value = type[kind];
  if (kind === 'Named') return resolved(types[value] ?? { Missing: [] }, types);
  if (kind === 'Array') return { Array: resolved(value, types) };
  if (kind === 'Product' || kind === 'Sum') return { [kind]: value.map(([n, t]) => [n, resolved(t, types)]) };
  return type;
};

/** Static upgrade rules (spec §7.3): plugins may only add tables, add indexes and append columns to private tables. */
export function schemaProblems(locked, next, id) {
  const problems = [], say = message => problems.push(`plugin rule: ${id}: ${message}`);
  const rules = 'Plugin database changes may only add tables, add indexes and append columns to private tables.';
  for (const [key, old] of Object.entries(locked.tables)) {
    const now = next.tables[key];
    if (!now) { say(`removes table ${old.name}. ${rules} Keep the table; retiring the plugin keeps its data.`); continue; }
    const table = `table ${old.name}`;
    if (now.name !== old.name) say(`renames ${table} to ${now.name}. ${rules}`);
    if (now.public !== old.public) say(`makes ${table} ${now.public ? 'public' : 'private'}. ${rules}`);
    old.columns.every(([name, type], i) => {
      const [nowName, nowType] = now.columns[i] ?? [];
      if (nowName === undefined) say(`removes column '${name}' from ${table}. ${rules} Keep the old column.`);
      else if (nowName !== name) {
        say(`changes ${table}: column ${i + 1} was '${name}', is now '${nowName}'. ${rules} Keep the old columns in order and add new ones at the end.`);
        return false; // later positions all shift
      }
      else if (!same(resolved(type, locked.types), resolved(nowType, next.types))) say(`changes ${table}: column '${name}' was ${describeType(type)}, is now ${describeType(nowType)}. ${rules} Keep the old column and add a new one.`);
      return true;
    });
    if (old.public && now.columns.length > old.columns.length) say(`appends columns to public ${table}; its rows are read by older dashboards as they are. ${rules}`);
    if (!same(now.primaryKey, old.primaryKey)) say(`changes the primary key of ${table}. ${rules}`);
    if (!same(now.autoInc, old.autoInc)) say(`changes the auto-increment columns of ${table}. ${rules}`);
    if (!same(now.unique, old.unique)) say(`changes the unique columns of ${table}. ${rules}`);
    for (const index of old.indexes) {
      const match = now.indexes.find(i => i.name === index.name);
      if (!match) say(`removes or renames index ${index.name} on ${table}. ${rules}`);
      else if (!same(match, index)) say(`changes index ${index.name} on ${table}. ${rules}`);
    }
  }
  for (const [name, contract] of Object.entries(locked.wire)) {
    if (!Object.hasOwn(next.wire, name)) say(`removes public ${contract.kind} ${name}; older dashboards still read it.`);
    else if (!same(next.wire[name], contract)) say(`changes public ${contract.kind} ${name} (ordered fields, types, parameters or primary key); older dashboards still read it. Add a new view instead.`);
  }
  return problems;
}

const builder = (type, types) => {
  const kind = tag(type), value = type[kind];
  if (kind === 'Named') {
    const def = types[value];
    return def.Product
      ? `retainedT.object(${JSON.stringify(value)}, { ${def.Product.map(([n, t]) => `${n}: ${builder(t, types)}`).join(', ')} })`
      : `retainedT.enum(${JSON.stringify(value)}, { ${def.Sum.map(([n, t]) => `${n}: ${builder(t, types)}`).join(', ')} })`;
  }
  if (kind === 'Array') return `retainedT.array(${builder(value, types)})`;
  if (kind === 'Product') return value.length ? `retainedT.${SPECIAL[value[0][0]]}()` : 'retainedT.unit()';
  if (kind === 'Sum') return `retainedT.option(${builder(value[0][1], types)})`;
  return `retainedT.${kind.toLowerCase()}()`;
};

/** Tables-only TypeScript for a skipped or retired plugin (spec §7.4); `retainedTable`/`retainedT` are imported by the caller. */
export function renderRetained(id, schema) {
  const tables = Object.entries(schema.tables).map(([key, table]) => {
    const tsKey = name => table.keys[name] ?? name;
    const single = (name, kind) => table.indexes.find(i => i.columns.length === 1 && i.columns[0] === name && i.algorithm === 'btree' && i.accessor === tsKey(name)
      && i.name === `${key}_${tsKey(name)}_idx_btree`) && kind;
    const isUnique = name => table.unique.some(u => u.length === 1 && u[0] === name);
    const implied = new Set();
    const columns = table.columns.map(([name, type]) => {
      let text = builder(type, schema.types);
      const indexed = single(name, true);
      if (table.primaryKey.length === 1 && table.primaryKey[0] === name) text += '.primaryKey()';
      else if (isUnique(name)) text += '.unique()';
      else if (indexed) text += ".index('btree')";
      if (indexed) implied.add(`${key}_${tsKey(name)}_idx_btree`);
      if (table.autoInc.includes(name)) text += '.autoInc()';
      return `      ${tsKey(name)}: ${text},`;
    });
    const indexes = table.indexes.filter(i => !implied.has(i.name)).map(i => i.algorithm === 'direct'
      ? `{ accessor: ${JSON.stringify(i.accessor)}, algorithm: 'direct', column: ${JSON.stringify(tsKey(i.columns[0]))} }`
      : `{ accessor: ${JSON.stringify(i.accessor)}, algorithm: '${i.algorithm}', columns: [${i.columns.map(c => JSON.stringify(tsKey(c))).join(', ')}] }`);
    const options = [
      table.name !== snake(key) && `name: ${JSON.stringify(table.name)}`,
      table.public && 'public: true',
      indexes.length && `indexes: [${indexes.join(', ')}]`,
    ].filter(Boolean).join(', ');
    return `    ${key}: retainedTable({${options ? ` ${options} ` : ''}}, {\n${columns.join('\n')}\n    }),`;
  });
  return `const retained_${id} = {\n  tables: {\n${tables.join('\n')}\n  },\n};\n`;
}

// shortcut: the SDK's default SQL name for a table key, letters only; a key with digits renders an explicit `name`, which is equivalent.
const snake = key => /\d/.test(key) ? null : key.replace(/([A-Z])/g, '_$1').toLowerCase();
