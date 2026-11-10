#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseRange } from './plugin-lock.mjs';

const PARTS = { module: '@draw/module', server: '@draw/server', web: '@draw/client', client: '@draw/canvas' };
// The canvas's own runtime values (VITE_<name>, docker/prod/canvas-entrypoint.sh): a canvas setting may not reuse one.
export const CORE_CANVAS_SETTINGS = ['AUTH_PROVIDER', 'CANVAS_URL', 'DASHBOARD_URL', 'MCP_URL', 'NAME', 'OIDC_CLIENT_ID', 'OIDC_ISSUER', 'PREVIEW', 'PRIVACY_URL', 'REQUIRE_AUTH', 'SPACETIME_DB', 'SPACETIME_DB_ALLOWED', 'SPACETIME_URI'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const inside = (base, path) => { const rel = relative(base, path); return rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep); };
const rule = message => `plugin rule: ${message}`;

export function readPlugins(root) {
  const errors = [], plugins = [], settings = new Map(), tables = new Map();
  const directory = join(root, 'plugins');
  if (!existsSync(directory)) return plugins;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    // A linked folder counts (builder link); importProblems still keeps its imports inside it.
    if (!statSync(join(directory, entry.name)).isDirectory()) continue;
    const folder = entry.name, file = `plugins/${folder}/plugin.json`;
    const fail = message => errors.push(rule(`${file}: ${message}`));
    let data;
    try { data = JSON.parse(readFileSync(join(root, file), 'utf8')); }
    catch (error) { fail(error.code === 'ENOENT' ? 'missing plugin.json' : `cannot read JSON: ${error.message}`); continue; }
    if (!object(data)) { fail('manifest must be an object'); continue; }
    data = { settings: [], canvasSettings: [], tables: {}, ...data };
    const fields = ['id', 'name', 'description', 'settings', 'canvasSettings', 'tables'];
    for (const key of Object.keys(data)) if (![...fields, 'draw'].includes(key)) fail(`unknown field '${key}'`);
    for (const key of fields) if (!Object.hasOwn(data, key)) fail(`missing field '${key}'`);
    if (typeof data.id !== 'string' || !/^[a-z][a-z0-9]{1,30}$/.test(data.id)) fail('id must match /^[a-z][a-z0-9]{1,30}$/');
    if (data.id !== folder) fail('id must match its folder');
    for (const [key, max] of [['name', 40], ['description', 200]]) {
      if (typeof data[key] !== 'string' || data[key].length < 1 || data[key].length > max) fail(`${key} must have 1..${max} characters`);
    }
    if (Object.hasOwn(data, 'draw')) { try { parseRange(data.draw); } catch (error) { fail(error.message.replace(/^plugin rule: /, '')); } }
    if (!Array.isArray(data.settings)) fail('settings must be an array');
    else for (const setting of data.settings) {
      if (typeof setting !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(setting)) { fail('each setting must match /^[A-Z][A-Z0-9_]*$/'); continue; }
      if (settings.has(setting)) fail(`setting '${setting}' is already owned by ${settings.get(setting)}`);
      else settings.set(setting, folder);
    }
    // Public: the canvas ships these values to every browser. One namespace with settings (plugins.env holds both).
    if (!Array.isArray(data.canvasSettings)) fail('canvasSettings must be an array');
    else for (const setting of data.canvasSettings) {
      if (typeof setting !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(setting)) { fail('each canvas setting must match /^[A-Z][A-Z0-9_]*$/'); continue; }
      if (CORE_CANVAS_SETTINGS.includes(setting)) fail(`canvas setting '${setting}' is one of the canvas's own settings`);
      else if (settings.has(setting)) fail(`setting '${setting}' is already owned by ${settings.get(setting)}`);
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
function tokens(source, inspectTemplateExpressions = true, markup = false) {
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
          else if (source.startsWith('${', i)) {
            i += 2;
            const length = result.length;
            scan(true);
            if (!inspectTemplateExpressions) result.length = length;
          }
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
  if (markup) {
    let tag = false, quote = '', raw, textarea = false;
    while (i < source.length) {
      const char = source[i];
      if (!tag && !textarea && source.startsWith('<!--', i)) {
        const end = source.indexOf('-->', i + 4);
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      if (char === '{') {
        i++;
        // Svelte block/directive prefixes are not part of the JavaScript expression.
        i += source.slice(i).match(/^[#:/@](?:else\s+if|[A-Za-z]+)\b/)?.[0].length ?? 0;
        result.push({ kind: 'punctuation', value: '(' });
        scan(true);
        result.push({ kind: 'punctuation', value: ')' });
        continue;
      }
      if (!tag && char === '<' && (!textarea || /^<\/textarea(?=[\s>])/i.test(source.slice(i)))) {
        tag = true;
        textarea = false;
        raw = source.slice(i).match(/^<(script|style|textarea)(?=[\s/>])/)?.[1];
      } else if (tag && (char === '"' || char === "'")) {
        if (!quote) quote = char;
        else if (quote === char) quote = '';
      } else if (tag && char === '>' && !quote) {
        tag = false;
        if (raw === 'textarea') textarea = source[i - 1] !== '/';
        else if (raw) {
          const end = new RegExp(`</${raw}\\s*>`, 'g');
          end.lastIndex = i + 1;
          const closing = end.exec(source);
          if (raw === 'script') result.push(...tokens(source.slice(i + 1, closing?.index)));
          i = closing ? end.lastIndex : source.length;
          continue;
        }
      }
      i++;
    }
  } else scan();
  return result;
}

export const exportedNames = source => [...exportedKinds(source).keys()].sort();
/** Type-only exports, which `isolatedModules` forces to be written `export type` or as declarations. */
export const exportedTypes = source => [...exportedKinds(source)].filter(([, type]) => type).map(([name]) => name).sort();

function exportedKinds(source) {
  const list = tokens(source, false), names = new Map();
  let depth = 0;
  for (let i = 0; i < list.length; i++) {
    const token = list[i];
    if (token.kind === 'punctuation' && token.value === '{') depth++;
    if (token.kind === 'punctuation' && token.value === '}') depth--;
    if (depth !== 0 || token.kind !== 'word' || token.value !== 'export' || list[i - 1]?.value === '.') continue;
    let j = i + 1;
    const typeOnly = list[j]?.value === 'type' && ['{', '*'].includes(list[j + 1]?.value);
    if (typeOnly) j++;
    if (list[j]?.value === '*') throw new Error(rule('wildcard exports are not allowed in the plugin interface'));
    if (list[j]?.value === '{') {
      j++;
      while (j < list.length && list[j].value !== '}') {
        const typeItem = list[j].value === 'type' && list[j + 1]?.kind === 'word' && list[j + 1].value !== 'as';
        if (typeItem) j++;
        let name = list[j++].value;
        if (list[j]?.value === 'as') { name = list[j + 1].value; j += 2; }
        names.set(name, typeOnly || typeItem);
        if (list[j]?.value === ',') j++;
      }
      i = j;
    } else {
      if (list[j]?.value === 'async') j++;
      if (['const', 'let'].includes(list[j]?.value)) {
        let nesting = 0, angles = 0, binding = true, typePosition = false;
        for (j++; j < list.length; j++) {
          const token = list[j], previous = list[j - 1];
          if (!nesting && !angles && token.kind === 'word' && ['export', 'const', 'let', 'var'].includes(token.value)
            && previous?.value !== '.' && !(token.value === 'const' && previous?.kind === 'word' && previous.value === 'as')) break;
          if (binding) {
            if (['{', '['].includes(token.value)) throw new Error(rule('destructured exports are not supported in the plugin interface; export named bindings'));
            const next = list[j + 1];
            const boundary = !next || (next.kind === 'punctuation' && ['=', ':', ',', ';', '!'].includes(next.value))
              || (next.kind === 'word' && ['export', 'const', 'let', 'var'].includes(next.value));
            if (token.kind !== 'word' || !boundary) throw new Error(rule('unsupported exported variable declaration in the plugin interface'));
            names.set(token.value, false);
            binding = false;
            typePosition = [':', '!'].includes(next?.value);
          } else if (token.kind === 'punctuation') {
            if (typePosition && token.value === '<') angles++;
            if (typePosition && angles && token.value === '>' && previous?.value !== '=') angles--;
            if (!nesting && !angles && token.value === ';') break;
            if (!nesting && !angles && token.value === ',') binding = true;
            if (!nesting && !angles && token.value === '=' && list[j + 1]?.value !== '>') typePosition = false;
            if (['(', '[', '{'].includes(token.value)) nesting++;
            if ([')', ']', '}'].includes(token.value)) nesting--;
          }
        }
        i = j - 1;
      } else {
        const declaration = list[j++]?.value;
        if (declaration === 'function' && list[j]?.value === '*') j++;
        if (!['function', 'class', 'interface', 'type', 'enum'].includes(declaration) || list[j]?.kind !== 'word') throw new Error(rule('unsupported export declaration in the plugin interface; use named exports'));
        names.set(list[j].value, ['interface', 'type'].includes(declaration));
      }
    }
  }
  return names;
}

// Names only, fast and dependency-free; --api-types (plugin-api-types.mjs) compares types.
export function apiProblems(root, ref = 'origin/main') {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = git('rev-parse', '--verify', `${ref}^{commit}`).trim();
  const errors = [];
  for (const file of ['module/src/plugin-api.ts', 'web/src/lib/server/plugin-api.ts', 'web/src/lib/plugin-api.ts', 'client/src/plugin-api.ts']) {
    const current = new Set(exportedNames(existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : ''));
    if (!git('ls-tree', '--name-only', commit, '--', file).trim()) continue;
    for (const name of exportedNames(git('show', `${commit}:${file}`))) {
      if (!current.has(name)) errors.push(`${file}: removes '${name}' from the plugin interface; that needs a major release`);
    }
  }
  return errors;
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
      for (const candidate of [target, ...['ts', 'js', 'tsx', 'jsx', 'mts', 'cts', 'mjs', 'cjs', 'svelte'].map(extension => `${target}.${extension}`)]) {
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
        if (!/\.(?:[cm]?[jt]s|[jt]sx|svelte)$/.test(file) || /\.test\./.test(entry.name)) continue;
        if (!inside(canonical, realpathSync(file))) { fail(file, 'source follows a symlink outside this part'); continue; }
        if (/\.[jt]sx$/.test(file)) { fail(file, 'JSX and TSX sources are not supported; use JavaScript, TypeScript or Svelte'); continue; }
        const text = readFileSync(file, 'utf8');
        {
          const list = tokens(text, true, file.endsWith('.svelte'));
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

// retained: skipped or retired outside plugins, [{ id, tables, source }]; only their tables are compiled,
// from source rendered from the lock (scripts/builder.mjs), which defines `const retained_<id>`.
export function generate(root, plugins, retained = []) {
  const sorted = [...plugins].sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const kept = [...retained].sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const owners = new Map(sorted.flatMap(plugin => Object.keys(plugin.tables).map(name => [name, plugin.id])));
  for (const { id, tables } of kept) {
    if (typeof id !== 'string' || !/^[a-z][a-z0-9]{1,30}$/.test(id)) throw new Error(rule(`retained plugin id '${id}' must match /^[a-z][a-z0-9]{1,30}$/`));
    if (sorted.some(plugin => plugin.id === id) || kept.filter(other => other.id === id).length > 1) throw new Error(rule(`retained plugin '${id}' is also included`));
    for (const name of Object.keys(tables)) {
      if (owners.has(name)) throw new Error(rule(`retained table '${name}' of '${id}' is already owned by ${owners.get(name)}`));
      owners.set(name, id);
    }
  }
  const byId = (a, b) => a.id.localeCompare(b.id, 'en');
  for (const plugin of sorted) for (const part of Object.keys(PARTS)) {
    if (!plugin.parts[part]) continue;
    const entry = join(root, 'plugins', plugin.id, part, 'index.ts');
    if (!existsSync(entry) || !statSync(entry).isFile()) throw new Error(rule(`plugins/${plugin.id}: missing ${part}/index.ts`));
  }
  const tables = Object.fromEntries([...sorted, ...kept].sort(byId).flatMap(plugin => Object.entries(plugin.tables).map(([name, table]) => [name, { plugin: plugin.id, ...table }])));
  const header = '// Generated by scripts/plugin-build.mjs from plugins/*/plugin.json; do not edit.\n';
  const content = header
    + `export const PLUGIN_IDS = ${JSON.stringify(sorted.map(p => p.id), null, 2)} as const;\n`
    + 'export type PluginId = (typeof PLUGIN_IDS)[number];\n'
    + `export const PLUGIN_TABLES = ${JSON.stringify(tables, null, 2)} as const;\n`;
  const modules = sorted.filter(plugin => plugin.parts.module);
  const local = id => (kept.some(plugin => plugin.id === id) ? 'retained_' : 'plugin_') + id;
  const all = [...modules, ...kept].sort(byId);
  const parts = header
    + modules.map(plugin => `import * as plugin_${plugin.id} from '../../plugins/${plugin.id}/module/index';\n`).join('')
    + (kept.length ? "import { table as retainedTable, t as retainedT } from './plugin-api';\n" + kept.map(plugin => plugin.source.trimEnd() + '\n').join('') : '')
    + 'export const pluginTables = {\n' + all.map(plugin => `  ...${local(plugin.id)}.tables,\n`).join('') + '};\n'
    + 'export const PLUGIN_PARTS = {\n' + all.map(plugin => `  ${plugin.id}: ${local(plugin.id)},\n`).join('') + '};\n';
  const servers = sorted.filter(plugin => plugin.parts.server);
  const server = header
    + "import type { ServerPart } from './plugin-api';\n"
    + servers.map(plugin => `import * as plugin_${plugin.id} from '../../../../plugins/${plugin.id}/server/index';\n`).join('')
    + 'export const PLUGIN_LIST: { id: string; name: string; description: string; settings: string[]; canvasSettings: string[]; server?: ServerPart }[] = [\n'
    + sorted.map(({ id, name, description, settings, canvasSettings }) => {
      const metadata = JSON.stringify({ id, name, description, settings, canvasSettings }, null, 2);
      return metadata.slice(0, -2) + (servers.some(plugin => plugin.id === id) ? `,\n  server: plugin_${id}` : '') + '\n},\n';
    }).join('') + '];\n';
  const webs = sorted.filter(plugin => plugin.parts.web);
  const web = header
    + "import type { WebPart } from './plugin-api';\n"
    + webs.map(plugin => `import * as plugin_${plugin.id} from '../../../plugins/${plugin.id}/web/index';\n`).join('')
    + 'export const WEB_PARTS: { id: string; web: WebPart }[] = [\n'
    + webs.map(plugin => `  { id: '${plugin.id}', web: plugin_${plugin.id} },\n`).join('') + '];\n';
  // Canvas settings are read as VITE_<name>: Vite inlines them (placeholders in image builds, see builder.mjs).
  const canvases = sorted.filter(plugin => plugin.parts.client);
  const canvas = header
    + "import type { CanvasPart } from './plugin-api';\n"
    + canvases.map(plugin => `import * as plugin_${plugin.id} from '../../plugins/${plugin.id}/client/index';\n`).join('')
    + 'export const CANVAS_PARTS: { id: string; name: string; settings: Record<string, string>; canvas: CanvasPart }[] = [\n'
    + canvases.map(plugin => `  { id: '${plugin.id}', name: ${JSON.stringify(plugin.name)}, settings: {${plugin.canvasSettings.map(name => ` ${name}: import.meta.env.VITE_${name} ?? ''`).join(',')}${plugin.canvasSettings.length ? ' ' : ''}}, canvas: plugin_${plugin.id} },\n`).join('') + '];\n';
  const configFile = 'docker/prod/dashboard.capnp', config = readFileSync(join(root, configFile), 'utf8');
  const starts = [...config.matchAll(/^    # plugin settings: scripts\/plugin-build\.mjs writes these from plugins\/\*\/plugin\.json$/gm)];
  const ends = [...config.matchAll(/^    # end of plugin settings$/gm)];
  if (starts.length !== 1 || ends.length !== 1 || starts[0].index >= ends[0].index) throw new Error(rule(`${configFile}: require exactly one ordered plugin settings marker pair`));
  const before = config.slice(0, starts[0].index + starts[0][0].length + 1), after = config.slice(ends[0].index);
  const outsideNames = new Set([...`${before}${after}`.replace(/#[^\n]*/g, '').matchAll(/\bname\s*=\s*"([^"]+)"/g)].map(match => match[1]));
  // The dashboard also reads canvas settings: it offers a plugin only when they are set (web/src/lib/server/plugins.ts).
  const settings = sorted.flatMap(plugin => [...plugin.settings, ...plugin.canvasSettings]);
  for (const name of settings) if (outsideNames.has(name)) throw new Error(rule(`${configFile}: setting '${name}' is already bound outside plugin settings`));
  const dashboard = before + settings.map(name => `    (name = "${name}", fromEnvironment = "${name}"),\n`).join('') + after;
  return new Map([['module/src/plugin-meta.generated.ts', content], ['module/src/plugin-parts.generated.ts', parts], ['web/src/lib/server/plugins.generated.ts', server], ['web/src/lib/plugins.generated.ts', web], ['client/src/plugins.generated.ts', canvas], [configFile, dashboard]]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const args = process.argv.slice(2);
    if (args[0] === '--api-types' && args.length === 2) {
      const { apiTypeProblems } = await import('./plugin-api-types.mjs');
      const problems = apiTypeProblems(root, args[1], exportedTypes);
      // A breaking release excuses incompatible changes, never a check that could not run.
      const excused = process.env.PLUGIN_API_MAJOR === 'true' ? problems.filter(p => p.includes('changed incompatibly')) : [];
      if (excused.length) console.error(excused.join('\n'));
      const failing = problems.filter(p => !excused.includes(p));
      if (failing.length) throw new Error(failing.join('\n'));
      process.exit();
    }
    if (args.some(arg => !['--check', '--api'].includes(arg))) throw new Error(rule('usage: node scripts/plugin-build.mjs [--check] [--api] | --api-types module|web|client'));
    const plugins = readPlugins(root), errors = importProblems(root, plugins);
    const outputs = generate(root, plugins);
    if (process.argv.includes('--check')) {
      const stale = [...outputs].filter(([file, content]) => !existsSync(join(root, file)) || readFileSync(join(root, file), 'utf8') !== content);
      errors.push(...stale.map(([file]) => rule(`${file} is stale; run node scripts/plugin-build.mjs`)));
    }
    if (process.argv.includes('--api')) {
      const problems = apiProblems(root).map(rule);
      if (process.env.PLUGIN_API_MAJOR === 'true') { if (problems.length) console.error(problems.join('\n')); }
      else errors.push(...problems);
    }
    if (errors.length) throw new Error(errors.join('\n'));
    if (!process.argv.includes('--check')) for (const [file, content] of outputs) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), content);
    }
  } catch (error) {
    console.error(error.message.startsWith('plugin rule:') ? error.message : rule(error.message));
    process.exitCode = 1;
  }
}
