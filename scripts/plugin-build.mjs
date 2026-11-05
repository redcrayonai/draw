#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PARTS = { module: '@draw/module', server: '@draw/server', web: '@draw/client' };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const inside = (base, path) => { const rel = relative(base, path); return rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep); };
const rule = message => `plugin rule: ${message}`;

export function readPlugins(root) {
  const errors = [], plugins = [], settings = new Map(), tables = new Map();
  const directory = join(root, 'plugins');
  if (!existsSync(directory)) return plugins;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (!entry.isDirectory()) continue;
    const folder = entry.name, file = `plugins/${folder}/plugin.json`;
    const fail = message => errors.push(rule(`${file}: ${message}`));
    let data;
    try { data = JSON.parse(readFileSync(join(root, file), 'utf8')); }
    catch (error) { fail(error.code === 'ENOENT' ? 'missing plugin.json' : `cannot read JSON: ${error.message}`); continue; }
    if (!object(data)) { fail('manifest must be an object'); continue; }
    data = { settings: [], tables: {}, ...data };
    const fields = ['id', 'name', 'description', 'settings', 'tables'];
    for (const key of Object.keys(data)) if (!fields.includes(key)) fail(`unknown field '${key}'`);
    for (const key of fields) if (!Object.hasOwn(data, key)) fail(`missing field '${key}'`);
    if (typeof data.id !== 'string' || !/^[a-z][a-z0-9]{1,30}$/.test(data.id)) fail('id must match /^[a-z][a-z0-9]{1,30}$/');
    if (data.id !== folder) fail('id must match its folder');
    for (const [key, max] of [['name', 40], ['description', 200]]) {
      if (typeof data[key] !== 'string' || data[key].length < 1 || data[key].length > max) fail(`${key} must have 1..${max} characters`);
    }
    if (!Array.isArray(data.settings)) fail('settings must be an array');
    else for (const setting of data.settings) {
      if (typeof setting !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(setting)) { fail('each setting must match /^[A-Z][A-Z0-9_]*$/'); continue; }
      if (settings.has(setting)) fail(`setting '${setting}' is already owned by ${settings.get(setting)}`);
      else settings.set(setting, folder);
    }
    if (!object(data.tables)) fail('tables must be an object');
    else for (const [name, table] of Object.entries(data.tables)) {
      if (!/^[a-z][A-Za-z0-9]*$/.test(name)) fail(`table '${name}' must match /^[a-z][A-Za-z0-9]*$/`);
      if (tables.has(name)) fail(`table '${name}' is already owned by ${tables.get(name)}`);
      else tables.set(name, folder);
      if (!object(table)) { fail(`table '${name}' must be an object`); continue; }
      for (const key of Object.keys(table)) if (!['why', 'board'].includes(key)) fail(`table '${name}' has unknown field '${key}'`);
      if (typeof table.why !== 'string' || table.why.length < 1 || table.why.length > 80) fail(`table '${name}'.why must have 1..80 characters`);
      if (Object.hasOwn(table, 'board') && table.board !== 'outlives') fail(`table '${name}'.board must be 'outlives'; board: 'part' is deferred`);
    }
    plugins.push({ ...data, parts: Object.fromEntries(Object.keys(PARTS).map(part => [part, existsSync(join(root, 'plugins', folder, part)) && statSync(join(root, 'plugins', folder, part)).isDirectory()])) });
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return plugins.sort((a, b) => a.id.localeCompare(b.id, 'en'));
}

// Keep literal tokens for imports, skipping comments and text while inspecting template expressions.
function tokens(source) {
  const result = [];
  let i = 0;
  const scan = (expression = false) => {
    let braces = 0;
    const conditions = [];
    while (i < source.length) {
      const char = source[i], at = i;
      if (/\s/.test(char)) { i++; continue; }
      if (source.startsWith('//', i)) { i = source.indexOf('\n', i); if (i < 0) i = source.length; continue; }
      if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue; }
      if (char === '"' || char === "'") {
        i++;
        while (i < source.length && source[i] !== char) { if (source[i] === '\\') i++; i++; }
        result.push({ kind: 'string', value: source.slice(at + 1, i) });
        i++;
        continue;
      }
      if (char === '`') {
        result.push({ kind: 'template', value: '`' });
        i++;
        while (i < source.length && source[i] !== '`') {
          if (source[i] === '\\') i += 2;
          else if (source.startsWith('${', i)) { i += 2; scan(true); }
          else i++;
        }
        i++;
        continue;
      }
      if (char === '/' && (!result.length || result.at(-1).closesCondition || /^(?:[=(\[,:;!?{>]|return|throw|case)$/.test(result.at(-1).value))) {
        i++;
        let bracket = false;
        while (i < source.length) {
          if (source[i] === '\\') { i += 2; continue; }
          if (source[i] === '[') bracket = true;
          if (source[i] === ']') bracket = false;
          if (source[i++] === '/' && !bracket) break;
        }
        while (/[a-z]/i.test(source[i] ?? '') && i < source.length) i++;
        result.push({ kind: 'regex', value: '/' });
        continue;
      }
      if (expression && char === '}' && braces === 0) { i++; return; }
      if (char === '{') braces++;
      if (char === '}') braces--;
      if (char === '(') conditions.push(result.at(-2)?.value !== '.' && /^(?:if|while|for|with|switch|catch)$/.test(result.at(-1)?.value));
      const word = source.slice(i).match(/^[A-Za-z_$][\w$]*/)?.[0];
      result.push({ kind: word ? 'word' : 'punctuation', value: word ?? char, closesCondition: char === ')' && conditions.pop() === true });
      i += word?.length ?? 1;
    }
  };
  scan();
  return result;
}

export function importProblems(root, plugins) {
  const errors = [];
  for (const plugin of plugins) for (const [part, alias] of Object.entries(PARTS)) {
    if (!plugin.parts[part]) continue;
    const base = resolve(root, 'plugins', plugin.id, part);
    const fail = (file, message) => errors.push(rule(`${relative(root, file)}: ${message}`));
    if (lstatSync(base).isSymbolicLink()) { fail(base, 'part folder must not be a symlink'); continue; }
    const canonical = realpathSync(base), seen = new Set();
    const check = (file, token) => {
      const specifier = token.value;
      if (specifier === alias) return;
      if (token.kind !== 'string' || !/^\.\.?\//.test(specifier) || /[\\\0]/.test(specifier)) { fail(file, `import '${specifier}' must use ${alias} or a file in this part`); return; }
      let target;
      try { target = fileURLToPath(new URL(specifier, pathToFileURL(file))); }
      catch { fail(file, `invalid import '${specifier}'`); return; }
      if (!inside(base, target)) { fail(file, `import '${specifier}' leaves this part`); return; }
      // Extensionless imports can resolve through a linked directory or linked source file.
      for (const candidate of [target, ...['ts', 'js', 'mts', 'cts', 'mjs', 'cjs', 'svelte'].map(extension => `${target}.${extension}`)]) {
        let ancestor = candidate;
        while (!existsSync(ancestor)) ancestor = dirname(ancestor);
        if (!inside(canonical, realpathSync(ancestor))) { fail(file, `import '${specifier}' follows a symlink outside this part`); return; }
      }
    };
    const walk = folder => {
      const real = realpathSync(folder);
      if (!inside(canonical, real)) { fail(folder, 'source follows a symlink outside this part'); return; }
      if (seen.has(real)) return;
      seen.add(real);
      for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        const file = join(folder, entry.name);
        if (statSync(file).isDirectory()) { walk(file); continue; }
        if (!/\.(?:[cm]?[jt]s|svelte)$/.test(file) || /\.test\./.test(entry.name)) continue;
        if (!inside(canonical, realpathSync(file))) { fail(file, 'source follows a symlink outside this part'); continue; }
        const text = readFileSync(file, 'utf8');
        const sources = file.endsWith('.svelte') ? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]) : [text];
        for (const source of sources) {
          const list = tokens(source);
          for (let i = 0; i < list.length; i++) {
            const token = list[i];
            if (token.kind !== 'word' || !['import', 'export', 'require'].includes(token.value)) continue;
            if (list[i - 1]?.value === '.' && token.value !== 'require') continue;
            const next = list[i + 1];
            if (next?.value === '(') {
              if (list[i + 2]?.kind !== 'string' || list[i + 3]?.value !== ')') fail(file, `${token.value}() must use one literal import path`);
              else check(file, list[i + 2]);
            } else if (token.value === 'import' && next?.kind === 'string') check(file, next);
            else if (token.value !== 'require' && next?.value !== '.' && (token.value === 'import' || ['{', '*', 'type'].includes(next?.value))) {
              for (let j = i + 1; j < list.length && list[j].value !== ';'; j++) {
                if (list[j].value === 'from' && list[j + 1]?.kind === 'string') { check(file, list[j + 1]); break; }
                if (j > i + 1 && ['import', 'export'].includes(list[j].value)) break;
              }
            }
          }
        }
      }
    };
    walk(base);
  }
  return errors;
}

export function generate(root, plugins) {
  const sorted = [...plugins].sort((a, b) => a.id.localeCompare(b.id, 'en'));
  for (const plugin of sorted) for (const part of Object.keys(PARTS)) {
    if (!plugin.parts[part]) continue;
    const entry = join(root, 'plugins', plugin.id, part, 'index.ts');
    if (!existsSync(entry) || !statSync(entry).isFile()) throw new Error(rule(`plugins/${plugin.id}: missing ${part}/index.ts`));
  }
  const tables = Object.fromEntries(sorted.flatMap(plugin => Object.entries(plugin.tables).map(([name, table]) => [name, { plugin: plugin.id, ...table }])));
  const header = '// Generated by scripts/plugin-build.mjs from plugins/*/plugin.json; do not edit.\n';
  const content = header
    + `export const PLUGIN_IDS = ${JSON.stringify(sorted.map(p => p.id), null, 2)} as const;\n`
    + 'export type PluginId = (typeof PLUGIN_IDS)[number];\n'
    + `export const PLUGIN_TABLES = ${JSON.stringify(tables, null, 2)} as const;\n`;
  const modules = sorted.filter(plugin => plugin.parts.module);
  const parts = header
    + modules.map(plugin => `import * as plugin_${plugin.id} from '../../plugins/${plugin.id}/module/index';\n`).join('')
    + 'export const pluginTables = {\n' + modules.map(plugin => `  ...plugin_${plugin.id}.tables,\n`).join('') + '};\n'
    + 'export const PLUGIN_PARTS = {\n' + modules.map(plugin => `  ${plugin.id}: plugin_${plugin.id},\n`).join('') + '};\n';
  const servers = sorted.filter(plugin => plugin.parts.server);
  const server = header
    + "import type { ServerPart } from './plugin-api';\n"
    + servers.map(plugin => `import * as plugin_${plugin.id} from '../../../../plugins/${plugin.id}/server/index';\n`).join('')
    + 'export const PLUGIN_LIST: { id: string; name: string; description: string; settings: string[]; server?: ServerPart }[] = [\n'
    + sorted.map(({ id, name, description, settings }) => {
      const metadata = JSON.stringify({ id, name, description, settings }, null, 2);
      return metadata.slice(0, -2) + (servers.some(plugin => plugin.id === id) ? `,\n  server: plugin_${id}` : '') + '\n},\n';
    }).join('') + '];\n';
  return new Map([['module/src/plugin-meta.generated.ts', content], ['module/src/plugin-parts.generated.ts', parts], ['web/src/lib/server/plugins.generated.ts', server]]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const root = fileURLToPath(new URL('..', import.meta.url));
    if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error(rule('usage: node scripts/plugin-build.mjs [--check]'));
    const plugins = readPlugins(root), errors = importProblems(root, plugins);
    if (errors.length) throw new Error(errors.join('\n'));
    const outputs = generate(root, plugins);
    if (process.argv.includes('--check')) {
      const stale = [...outputs].filter(([file, content]) => !existsSync(join(root, file)) || readFileSync(join(root, file), 'utf8') !== content);
      if (stale.length) throw new Error(stale.map(([file]) => rule(`${file} is stale; run node scripts/plugin-build.mjs`)).join('\n'));
    } else for (const [file, content] of outputs) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), content);
    }
  } catch (error) {
    console.error(error.message.startsWith('plugin rule:') ? error.message : rule(error.message));
    process.exitCode = 1;
  }
}
