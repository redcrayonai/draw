#!/usr/bin/env node
// Compare pinned CLI `spacetime describe --json` (V10) output before publish.
// Private storage may grow. Existing public row contracts must remain exact:
// BSATN clients decode ordered fields, so even a defaulted append is breaking.
// Add a new optional/versioned view instead of changing an existing view.
// Usage: node scripts/check-wire-compat.mjs baseline.json candidate.json
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SECTIONS = new Set(['Typespace', 'Types', 'Tables', 'Reducers', 'Procedures', 'Views', 'Schedules', 'LifeCycleReducers', 'RowLevelSecurity', 'CaseConversionPolicy', 'ExplicitNames', 'HttpHandlers', 'HttpRoutes', 'ViewPrimaryKeys', 'Submodules']);
const PRIMITIVES = new Set(['String', 'Bool', 'I8', 'U8', 'I16', 'U16', 'I32', 'U32', 'I64', 'U64', 'I128', 'U128', 'I256', 'U256', 'F32', 'F64']);
const fail = message => { throw new Error(message); };
const array = (value, label) => Array.isArray(value) ? value : fail(`${label}: expected an array`);
const name = (value, label) => typeof value === 'string' && value.length ? value : fail(`${label}: missing name`);
const bool = (value, label) => typeof value === 'boolean' ? value : fail(`${label}: expected a boolean`);
const tag = (value, label) => value && typeof value === 'object' && Object.keys(value).length === 1 ? Object.keys(value)[0] : fail(`${label}: expected one tagged value`);
const snake = value => value.replace(/([A-Z])/g, '_$1').replace(/[-\s]+/g, '_').toLowerCase();

/** Public table/view names and their fully resolved, ordered wire contracts. */
export function publicWire(describe) {
  const sections = new Map();
  for (const section of array(describe.sections, 'V10 sections')) {
    const key = tag(section, 'section');
    if (!SECTIONS.has(key) || sections.has(key)) fail(`unsupported or duplicate schema section: ${key}`);
    sections.set(key, section[key]);
  }
  const types = array(sections.get('Typespace')?.types, 'Typespace.types');
  const tables = array(sections.get('Tables'), 'Tables');
  const views = array(sections.get('Views'), 'Views');
  if (sections.has('Submodules') && array(sections.get('Submodules'), 'Submodules').length) fail('submodule wire contracts are not supported');
  const policy = sections.has('CaseConversionPolicy') ? tag(sections.get('CaseConversionPolicy'), 'case conversion') : 'SnakeCase';
  if (policy !== 'SnakeCase' && policy !== 'None') fail(`unsupported case conversion: ${policy}`);
  const names = new Map();
  for (const entry of array(sections.get('ExplicitNames')?.entries ?? [], 'ExplicitNames.entries')) {
    const kind = tag(entry, 'explicit name');
    if (!['Table', 'Function', 'Index', 'Namespace'].includes(kind)) fail(`unsupported name mapping: ${kind}`);
    const mapping = entry[kind];
    const key = `${kind}:${name(mapping.source_name, 'source')}`;
    if (names.has(key)) fail(`duplicate name mapping: ${key}`);
    names.set(key, name(mapping.canonical_name, 'canonical'));
  }
  const canonical = (kind, source) => names.get(`${kind}:${name(source, 'source')}`) ?? (policy === 'SnakeCase' ? snake(source) : source);
  const elementName = value => {
    const kind = tag(value, 'element name');
    if (kind === 'some') return name(value.some, 'element');
    if (kind === 'none' && array(value.none, 'unnamed element').length === 0) return null;
    return fail('unsupported element name');
  };
  const expand = (type, seen = new Set()) => {
    const kind = tag(type, 'algebraic type');
    const value = type[kind];
    if (kind === 'Ref') {
      if (!Number.isInteger(value) || value < 0 || value >= types.length) fail(`unresolved type Ref ${value}`);
      if (seen.has(value)) fail(`recursive type Ref ${value} is not supported`);
      return expand(types[value], new Set([...seen, value]));
    }
    if (kind === 'Array') return { Array: expand(value, seen) };
    if (kind === 'Product' || kind === 'Sum') {
      const elements = array(value[kind === 'Product' ? 'elements' : 'variants'], kind);
      return { [kind]: elements.map(element => [elementName(element.name), expand(element.algebraic_type, seen)]) };
    }
    if (!PRIMITIVES.has(kind) || array(value, kind).length !== 0) fail(`unsupported algebraic type: ${kind}`);
    return { [kind]: [] };
  };
  const primaryKeys = new Map();
  for (const key of array(sections.get('ViewPrimaryKeys') ?? [], 'ViewPrimaryKeys')) {
    const source = name(key.view_source_name, 'view primary key');
    if (primaryKeys.has(source)) fail(`duplicate view primary key: ${source}`);
    primaryKeys.set(source, array(key.columns, 'view primary key columns').map(column => name(column, 'primary key column')));
  }
  const out = {};
  const add = (key, contract) => {
    if (Object.hasOwn(out, key)) fail(`duplicate public name: ${key}`);
    Object.defineProperty(out, key, { value: contract, enumerable: true });
  };
  for (const table of tables) {
    const access = tag(table.table_access, 'table access');
    if (!['Public', 'Private'].includes(access)) fail(`unsupported table access: ${access}`);
    if (access === 'Private') continue;
    const row = expand({ Ref: table.product_type_ref });
    if (!row.Product) fail('public table row must be a Product');
    const primaryKey = array(table.primary_key, 'table primary key');
    if (primaryKey.some(index => !Number.isInteger(index) || index < 0 || index >= row.Product.length)) fail('invalid table primary key');
    add(canonical('Table', table.source_name), { kind: 'table', row, primaryKey, event: bool(table.is_event, 'table is_event') });
  }
  for (const view of views) {
    if (!bool(view.is_public, 'view is_public')) continue;
    add(canonical('Function', view.source_name), {
      kind: 'view', row: expand(view.return_type), params: expand({ Product: view.params }),
      primaryKey: primaryKeys.get(view.source_name) ?? [], anonymous: bool(view.is_anonymous, 'view is_anonymous'),
    });
  }
  return out;
}

/** Existing public contracts may not disappear or change; new names are safe. */
export function wireDifferences(baseline, candidate) {
  const before = publicWire(baseline);
  const after = publicWire(candidate);
  if (!Object.keys(before).length) fail('baseline has no public table/view contracts');
  return Object.entries(before).flatMap(([key, contract]) => {
    if (!Object.hasOwn(after, key)) return [`${key}: existing public ${contract.kind} removed or made private`];
    return JSON.stringify(contract) === JSON.stringify(after[key]) ? [] : [`${key}: existing public ${contract.kind} wire contract changed (ordered fields/types, parameters or primary key)`];
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [baseline, candidate, ...extra] = process.argv.slice(2);
  if (!baseline || !candidate || extra.length) {
    console.error('usage: node scripts/check-wire-compat.mjs <baseline-describe.json> <candidate-describe.json>');
    process.exit(2);
  }
  try {
    const before = JSON.parse(readFileSync(baseline, 'utf8'));
    const after = JSON.parse(readFileSync(candidate, 'utf8'));
    const differences = wireDifferences(before, after);
    if (differences.length) throw new Error(`${differences.join('\n')}\nPreserve existing public row shapes; expose new fields through a new optional/versioned view.`);
    console.log(`wire compatibility: ${Object.keys(publicWire(before)).length} existing public contracts preserved`);
  } catch (error) {
    console.error(`wire compatibility rejected: ${error.message}`);
    process.exit(1);
  }
}
