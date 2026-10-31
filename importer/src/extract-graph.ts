import { execFile } from 'node:child_process';
import { builtinModules } from 'node:module';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, basename, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import ts from 'typescript';

const exec = promisify(execFile);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sourcePattern = /\.(?:[cm]?[jt]sx?)$/i;
const testPattern = /(?:^|\/)(?:__tests__|tests?)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i;
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));

export interface GraphNode { key: string; label: string; sublabel: string; kind: 'service' | 'external' }
export interface GraphEdge { from: string; to: string; label: string; relation: 'imports'; evidence: 'import' | 'test-import' }
export interface Graph { nodes: GraphNode[]; edges: GraphEdge[]; files: string[] }
export interface ExtractionOptions { signal?: AbortSignal; env?: NodeJS.ProcessEnv; goOnly?: boolean }

export function finalizeGraph(graph: Graph): Graph {
  if (graph.nodes.length > 5000) throw new Error('Graph exceeds limit of 5000 nodes');
  if (graph.edges.length > 20000) throw new Error('Graph exceeds limit of 20000 edges');
  return {
    nodes: [...graph.nodes].sort((a, b) => compare(a.key, b.key)),
    edges: [...graph.edges].sort((a, b) => compare(`${a.from}\0${a.to}\0${a.relation}`, `${b.from}\0${b.to}\0${b.relation}`)),
    files: [...new Set(graph.files)].sort(compare),
  };
}

interface GoPackage {
  ImportPath: string;
  Standard?: boolean;
  DepOnly?: boolean;
  ForTest?: string;
  Dir?: string;
  GoFiles?: string[];
  CgoFiles?: string[];
  TestGoFiles?: string[];
  XTestGoFiles?: string[];
  Imports?: string[];
  TestImports?: string[];
  XTestImports?: string[];
  Module?: { Path: string; Main?: boolean };
}

/** go list emits concatenated objects; quoted braces do not delimit objects. */
export function parseGoListStream(raw: string): GoPackage[] {
  const packages: GoPackage[] = [];
  let depth = 0;
  let start = -1;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (char === '"') {
      while (++index < raw.length && raw[index] !== '"') if (raw[index] === '\\') index++;
    } else if (char === '{') {
      if (depth++ === 0) start = index;
    } else if (char === '}') {
      if (--depth === 0) packages.push(JSON.parse(raw.slice(start, index + 1)) as GoPackage);
      if (depth < 0) throw new Error('Invalid go list JSON stream');
    } else if (depth === 0 && !/\s/.test(char)) throw new Error('Invalid go list JSON stream');
  }
  if (depth !== 0) throw new Error('Incomplete go list JSON stream');
  return packages;
}

/** No runner credentials or host Git/Go authentication reach repository tools. */
export function repositoryEnvironment(scratch: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    ...(process.env.GOROOT ? { GOROOT: process.env.GOROOT } : {}),
    HOME: scratch,
    TMPDIR: scratch,
    GOCACHE: join(scratch, 'go-cache'),
    GOPATH: join(scratch, 'go-path'),
    GOPROXY: 'https://proxy.golang.org',
    GOSUMDB: 'sum.golang.org',
    GOENV: 'off',
    GOWORK: 'off',
    GOTOOLCHAIN: 'local',
    GOOS: 'linux',
    GOARCH: 'amd64',
    CGO_ENABLED: '0',
    GOFLAGS: '',
    GOAUTH: 'off',
    GOVCS: '*:off',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
}

export async function extractGraph(repository: string, options: ExtractionOptions = {}): Promise<Graph> {
  const root = realpathSync(repository);
  const scratch = mkdtempSync(join(tmpdir(), 'architecture-extract-'));
  const env = options.env ?? repositoryEnvironment(scratch);
  try {
    const { stdout } = await exec('git', ['ls-files', '-z'], { cwd: root, env, signal: options.signal, timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
    const files = stdout.split('\0').filter(Boolean).sort(compare);
    if (!files.length) throw new Error('Repository contains no tracked files');
    const tracked = new Set(files);
    const fullPath = (file: string) => resolve(root, file);
    const repoPath = (file: string) => relative(root, file).split(sep).join('/');
    for (const file of files) {
      const info = lstatSync(fullPath(file));
      if (info.isSymbolicLink()) throw new Error(`Tracked symlink is unsupported: ${file}`);
      if (!info.isFile()) throw new Error(`Tracked submodule or non-file is unsupported: ${file}`);
    }
    const projectFiles = files.filter(file => !file.split('/').some(part => part === 'vendor' || part === 'node_modules'));
    const nestedModule = projectFiles.find(file => file !== 'go.mod' && basename(file) === 'go.mod');
    if (nestedModule) throw new Error(`Nested Go module ${nestedModule} is unsupported; only the root Go module is supported`);
    if (!tracked.has('go.mod') && projectFiles.some(file => file.endsWith('.go'))) {
      throw new Error('Go extraction requires a tracked root go.mod; only the root Go module is supported');
    }
    const read = (file: string): string => {
      const absolute = fullPath(file);
      if (!tracked.has(repoPath(absolute))) throw new Error(`File is not tracked: ${file}`);
      const actual = realpathSync(absolute);
      if (actual !== root && !actual.startsWith(root + sep)) throw new Error(`Tracked file escapes repository: ${file}`);
      if (statSync(actual).size > 8 * 1024 * 1024) throw new Error(`Source file exceeds 8 MiB: ${file}`);
      return readFileSync(actual, 'utf8');
    };
    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const addNode = (key: string, path: string, external = false) => {
      if (!nodes.has(key)) nodes.set(key, { key, label: basename(path), sublabel: path, kind: external ? 'external' : 'service' });
      if (nodes.size > 5000) throw new Error('Graph exceeds limit of 5000 nodes');
    };
    const addEdge = (from: string, to: string, evidence: GraphEdge['evidence']) => {
      if (from === to) return;
      const key = `${from}\0${to}`;
      if (!edges.has(key) || evidence === 'import') edges.set(key, { from, to, label: '', relation: 'imports', evidence });
      if (edges.size > 20000) throw new Error('Graph exceeds limit of 20000 edges');
    };

    if (tracked.has('go.mod')) {
      read('go.mod');
      const { stdout: goJson } = await exec('go', ['list', '-mod=readonly', '-deps', '-test', '-json', './...'], {
        cwd: root, env, signal: options.signal, timeout: 180000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 * 1024,
      });
      const all = parseGoListStream(goJson);
      const internal = all.filter(pkg => pkg.Module?.Main && !pkg.DepOnly && !pkg.ForTest && !pkg.ImportPath.includes(' [') && !pkg.ImportPath.endsWith('.test') && pkg.Dir &&
        [...(pkg.GoFiles ?? []), ...(pkg.CgoFiles ?? []), ...(pkg.TestGoFiles ?? []), ...(pkg.XTestGoFiles ?? [])].some(file => tracked.has(repoPath(join(pkg.Dir!, file)))));
      const internalPaths = new Set(internal.map(pkg => pkg.ImportPath));
      const byPath = new Map(all.map(pkg => [pkg.ImportPath, pkg]));
      for (const pkg of internal) addNode(`go:${pkg.ImportPath}`, pkg.ImportPath);
      for (const pkg of internal) {
        const connect = (importPath: string, evidence: GraphEdge['evidence']) => {
          if (importPath === 'C') return;
          const dependency = byPath.get(importPath);
          if (dependency?.Standard) return;
          if (internalPaths.has(importPath)) addEdge(`go:${pkg.ImportPath}`, `go:${importPath}`, evidence);
          else if (dependency?.Module && !dependency.Module.Main) {
            const key = `go-module:${dependency.Module.Path}`;
            addNode(key, dependency.Module.Path, true);
            addEdge(`go:${pkg.ImportPath}`, key, evidence);
          } else throw new Error(`Unresolved Go import ${importPath} in ${pkg.ImportPath}`);
        };
        for (const path of pkg.Imports ?? []) connect(path, 'import');
        for (const path of [...(pkg.TestImports ?? []), ...(pkg.XTestImports ?? [])]) connect(path, 'test-import');
      }
    } else if (options.goOnly) throw new Error('Go import requires a tracked root go.mod');

    if (!options.goOnly) {
      const sources = files.filter(file => sourcePattern.test(file) && !file.split('/').includes('node_modules') && !file.split('/').includes('vendor'));
      const fileExists = (file: string) => tracked.has(repoPath(resolve(file)));
      const host: ts.ModuleResolutionHost = { fileExists, readFile: file => fileExists(file) ? read(repoPath(file)) : undefined };
      const compilerOptions = new Map<string, ts.CompilerOptions>();
      for (const configFile of files.filter(file => basename(file) === 'tsconfig.json' || basename(file) === 'jsconfig.json')) {
        const parsed = ts.readConfigFile(fullPath(configFile), file => host.readFile!(file));
        if (parsed.error) throw new Error(`Cannot parse ${configFile}: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, ' ')}`);
        const config = ts.parseJsonConfigFileContent(parsed.config, {
          useCaseSensitiveFileNames: true, fileExists, readFile: file => host.readFile!(file), readDirectory: () => [],
        }, dirname(fullPath(configFile)));
        const errors = config.errors.filter(error => error.code !== 18003 && error.code !== 18002);
        if (errors.length) throw new Error(`Cannot resolve ${configFile}: ${errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, ' ')).join('; ')}`);
        compilerOptions.set(dirname(fullPath(configFile)), { allowJs: true, moduleResolution: ts.ModuleResolutionKind.Bundler, ...config.options });
      }
      const optionsFor = (file: string) => {
        let directory = dirname(fullPath(file));
        while (directory === root || directory.startsWith(root + sep)) {
          const config = compilerOptions.get(directory);
          if (config) return config;
          directory = dirname(directory);
        }
        return { allowJs: true, moduleResolution: ts.ModuleResolutionKind.Bundler };
      };
      const localFile = (candidate: string): string | undefined => {
        const paths = [candidate];
        if (/\.[cm]?jsx?$/.test(candidate)) paths.push(candidate.replace(/\.[cm]?jsx?$/, '.ts'), candidate.replace(/\.[cm]?jsx?$/, '.tsx'), candidate.replace(/\.mjs$/, '.mts'), candidate.replace(/\.cjs$/, '.cts'));
        if (!/\.[^/]+$/.test(candidate)) for (const extension of ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json']) paths.push(candidate + extension, join(candidate, 'index' + extension));
        return paths.find(fileExists);
      };
      const workspaces = new Map<string, { directory: string; manifest: Record<string, unknown> }>();
      for (const manifestFile of files.filter(file => basename(file) === 'package.json' && !file.split('/').includes('node_modules'))) {
        const manifest = JSON.parse(read(manifestFile)) as Record<string, unknown>;
        if (typeof manifest.name === 'string') {
          if (workspaces.has(manifest.name)) throw new Error(`Ambiguous local package name ${manifest.name}`);
          workspaces.set(manifest.name, { directory: dirname(fullPath(manifestFile)), manifest });
        }
      }
      const selectExport = (value: unknown): string | undefined => {
        if (typeof value === 'string') return value;
        if (Array.isArray(value)) return value.map(selectExport).find(Boolean);
        if (value && typeof value === 'object') {
          const conditions = value as Record<string, unknown>;
          for (const condition of ['import', 'default', 'require', 'types']) {
            const entry = selectExport(conditions[condition]);
            if (entry) return entry;
          }
        }
        return undefined;
      };
      for (const file of sources) {
        options.signal?.throwIfAborted();
        addNode(`js:${file}`, file);
        const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
        const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
        if (diagnostics.length) throw new Error(`Cannot parse ${file}: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, ' ')}`);
        const imports = new Set<string>();
        const visit = (node: ts.Node) => {
          if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) imports.add(node.moduleSpecifier.text);
          if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) imports.add(node.moduleReference.expression.text);
          if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require') && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) imports.add(node.arguments[0].text);
          ts.forEachChild(node, visit);
        };
        visit(source);
        const compiler = optionsFor(file);
        for (const specifier of [...imports].sort(compare)) {
          if (builtins.has(specifier) || specifier.startsWith('node:')) continue;
          const resolved = ts.resolveModuleName(specifier, fullPath(file), compiler, host).resolvedModule;
          let target = resolved && fileExists(resolved.resolvedFileName) ? resolved.resolvedFileName : undefined;
          const relativeImport = specifier.startsWith('.') || specifier.startsWith('/');
          let localImport = relativeImport;
          if (!target && relativeImport) target = localFile(resolve(dirname(fullPath(file)), specifier));
          for (const [alias, replacements] of Object.entries(compiler.paths ?? {})) {
            const star = alias.indexOf('*');
            const matches = star < 0 ? specifier === alias : specifier.startsWith(alias.slice(0, star)) && specifier.endsWith(alias.slice(star + 1));
            if (!matches) continue;
            localImport = true;
            const matched = star < 0 ? '' : specifier.slice(star, specifier.length - (alias.length - star - 1));
            for (const replacement of replacements) target ??= localFile(resolve(compiler.baseUrl ?? root, replacement.replace('*', matched)));
          }
          const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
          const workspace = workspaces.get(packageName);
          if (!target && workspace) {
            localImport = true;
            const subpath = specifier.slice(packageName.length).replace(/^\//, '');
            const exports = workspace.manifest.exports;
            let entry: string | undefined;
            if (exports && typeof exports === 'object' && !Array.isArray(exports) && Object.keys(exports).some(key => key.startsWith('.'))) {
              const map = exports as Record<string, unknown>;
              entry = selectExport(map[subpath ? `./${subpath}` : '.']);
              if (!entry) for (const [pattern, value] of Object.entries(map)) {
                const star = pattern.indexOf('*');
                const requested = `./${subpath}`;
                if (star >= 0 && requested.startsWith(pattern.slice(0, star)) && requested.endsWith(pattern.slice(star + 1))) entry = selectExport(value)?.replace('*', requested.slice(star, requested.length - pattern.length + star + 1));
              }
            } else if (!subpath) entry = selectExport(exports);
            entry ??= subpath || selectExport(workspace.manifest.source) || selectExport(workspace.manifest.module) || selectExport(workspace.manifest.main) || 'index';
            target = localFile(resolve(workspace.directory, entry));
          }
          if (target) {
            const path = repoPath(target);
            addNode(`js:${path}`, path);
            addEdge(`js:${file}`, `js:${path}`, testPattern.test(file) ? 'test-import' : 'import');
          } else if (localImport) throw new Error(`Unresolved local import ${specifier} in ${file}`);
          else {
            if (!/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(packageName)) throw new Error(`Unsupported import ${specifier} in ${file}`);
            addNode(`npm:${packageName}`, packageName, true);
            addEdge(`js:${file}`, `npm:${packageName}`, testPattern.test(file) ? 'test-import' : 'import');
          }
        }
      }
    }
    if (!nodes.size) throw new Error('Repository contains no supported Go, JavaScript, or TypeScript sources');
    return finalizeGraph({ nodes: [...nodes.values()], edges: [...edges.values()], files });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
