import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSymbol, enclosingDeclaration, declarationsTouching, symbolNeedle, RESOLVABLE_EXTENSIONS } from './resolver';
import { sliceLines } from './snippet';
import { readSource } from './local-deps';

// Line numbers are load-bearing; the array index + 1 is the line.
const SRC = [
  /* 1 */ "import x from 'y';",
  /* 2 */ '',
  /* 3 */ '/** doc for snapshot */',
  /* 4 */ 'function snapshot(): string {',
  /* 5 */ "  return 'a';",
  /* 6 */ '}',
  /* 7 */ '',
  /* 8 */ 'export async function callReducer(name: string): Promise<void> {',
  /* 9 */ '  await name;',
  /* 10 */ '}',
  /* 11 */ '',
  /* 12 */ '/**',
  /* 13 */ ' * multi',
  /* 14 */ ' * line',
  /* 15 */ ' */',
  /* 16 */ 'function helper() {',
  /* 17 */ '  return 1;',
  /* 18 */ '}',
  /* 19 */ '',
  /* 20 */ 'export const startSession = spacetimedb.reducer(',
  /* 21 */ '  { name: t.string() },',
  /* 22 */ '  (ctx, { name }) => {}',
  /* 23 */ ');',
  /* 24 */ '',
  /* 25 */ 'export class Editor {',
  /* 26 */ '  get handles(): number {',
  /* 27 */ '    return 1;',
  /* 28 */ '  }',
  /* 29 */ '  toggleCodeOverlay(): void {',
  /* 30 */ '    this.x = 1;',
  /* 31 */ '  }',
  /* 32 */ '}',
  /* 33 */ '',
  /* 34 */ 'function dup() {}',
  /* 35 */ 'class Thing { dup() {} }',
  /* 36 */ 'interface Shape { dup(): void }',
].join('\n');

const r = (symbol: string, file = '/repo/a.ts', src = SRC) => resolveSymbol(file, src, symbol);

describe('symbolNeedle — the one symbol rule (module, agent, eval)', () => {
  it('is the last dotted segment, the whole symbol when undotted, and the whole symbol when the dot is trailing', () => {
    expect(symbolNeedle('Limiter.allow')).toBe('allow');
    expect(symbolNeedle('Editor.handles')).toBe('handles');
    expect(symbolNeedle('gitHead')).toBe('gitHead');
    expect(symbolNeedle('a.b.c')).toBe('c');
    expect(symbolNeedle('Weird.')).toBe('Weird.');
  });
});

describe('resolveSymbol — the eight probe shapes', () => {
  it('function declaration with a one-line JSDoc: range excludes the doc', () => {
    expect(r('snapshot')).toEqual({ ok: true, startLine: 4, endLine: 6, kind: 'function', name: 'snapshot' });
  });
  it('exported async function', () => {
    expect(r('callReducer')).toEqual({ ok: true, startLine: 8, endLine: 10, kind: 'function', name: 'callReducer' });
  });
  it('non-exported function under a multi-line JSDoc block: range starts at the declaration', () => {
    expect(r('helper')).toEqual({ ok: true, startLine: 16, endLine: 18, kind: 'function', name: 'helper' });
  });
  it('export const x = call(...) resolves to the whole variable statement', () => {
    expect(r('startSession')).toEqual({ ok: true, startLine: 20, endLine: 23, kind: 'const', name: 'startSession' });
  });
  it('class getter as Class.member', () => {
    expect(r('Editor.handles')).toEqual({ ok: true, startLine: 26, endLine: 28, kind: 'getter', name: 'Editor.handles' });
  });
  it('class method as Class.member', () => {
    expect(r('Editor.toggleCodeOverlay')).toEqual({ ok: true, startLine: 29, endLine: 31, kind: 'method', name: 'Editor.toggleCodeOverlay' });
  });
  it('an exact top-level name beats same-named class and interface members', () => {
    expect(r('dup')).toEqual({ ok: true, startLine: 34, endLine: 34, kind: 'function', name: 'dup' });
    expect(r('Thing.dup')).toMatchObject({ ok: true, startLine: 35, endLine: 35, kind: 'method' });
    expect(r('Shape.dup')).toMatchObject({ ok: true, startLine: 36, endLine: 36, kind: 'method' });
  });
  it('overload signatures resolve together with their implementation as one span (F1)', () => {
    const src = 'function ov(a: string): void;\nfunction ov(a: number): void;\nfunction ov(a: unknown) {}\n';
    expect(r('ov', '/repo/c.ts', src)).toEqual({ ok: true, startLine: 1, endLine: 3, kind: 'function', name: 'ov' });
    const cls = 'class K {\n  m(a: string): void;\n  m(a: unknown) {}\n  other() {}\n}\n';
    expect(r('K.m', '/repo/k.ts', cls)).toEqual({ ok: true, startLine: 2, endLine: 3, kind: 'method', name: 'K.m' });
    const iface = 'interface I {\n  f(a: string): void;\n  f(a: number): void;\n}\n';
    expect(r('I.f', '/repo/i.ts', iface)).toEqual({ ok: true, startLine: 2, endLine: 3, kind: 'method', name: 'I.f' });
  });
  it('a getter/setter pair resolves as one Class.member span (F1)', () => {
    const src = 'class C {\n  get x() { return 1 }\n  set x(v) {}\n}\n';
    expect(r('C.x', '/repo/g.ts', src)).toEqual({ ok: true, startLine: 2, endLine: 3, kind: 'accessor', name: 'C.x' });
    expect(r('C.x', '/repo/g.ts', 'class C { get x(){} set x(v){} }')).toEqual({ ok: true, startLine: 1, endLine: 1, kind: 'accessor', name: 'C.x' });
  });
  it('two same-named declarations with bodies (JS redeclaration) stay ambiguous with all candidates', () => {
    const src = 'function ov() { return 1 }\nfunction ov() { return 2 }\n';
    expect(r('ov', '/repo/c.js', src)).toEqual({
      ok: false,
      reason: 'ambiguous',
      candidates: [
        { name: 'ov', kind: 'function', startLine: 1, endLine: 1 },
        { name: 'ov', kind: 'function', startLine: 2, endLine: 2 },
      ],
    });
  });
  it('not found returns substring suggestions (case-insensitive, by symbolNeedle)', () => {
    expect(r('Editor.handle')).toEqual({ ok: false, reason: 'not_found', suggestions: ['Editor.handles'] });
    expect(r('nope')).toEqual({ ok: false, reason: 'not_found', suggestions: [] });
  });
  it('bare member names are not addressable without the class prefix, but are suggested', () => {
    expect(r('toggleCodeOverlay')).toEqual({ ok: false, reason: 'not_found', suggestions: ['Editor.toggleCodeOverlay'] });
  });
  it('unsupported extension is refused before parsing (the TS parser would "succeed" on Go)', () => {
    expect(r('main', '/repo/main.go', 'package main\nfunc main() {}\n')).toEqual({ ok: false, reason: 'unsupported_language', ext: '.go' });
    expect(RESOLVABLE_EXTENSIONS).toEqual(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
  });
  it('parse diagnostics reject the file with the first diagnostic and its position', () => {
    expect(r('f', '/repo/b.ts', 'function f( {')).toEqual({ ok: false, reason: 'parse_error', message: "1:14 '}' expected." });
  });
  it('picks the script kind from the extension (.tsx and .js parse)', () => {
    expect(r('App', '/repo/e.tsx', 'export const App = () => <div/>;\n')).toMatchObject({ ok: true, startLine: 1, endLine: 1, kind: 'const' });
    expect(r('go', '/repo/f.js', 'function go() { return 1 }\n')).toMatchObject({ ok: true, startLine: 1, endLine: 1, kind: 'function' });
  });
});

describe('enclosingDeclaration — what to cite instead of a range (F1)', () => {
  it('names the innermost addressable declaration containing the range', () => {
    expect(enclosingDeclaration('/repo/a.ts', SRC, 27, 27)).toEqual({ name: 'Editor.handles', startLine: 26, endLine: 28 });
    expect(enclosingDeclaration('/repo/a.ts', SRC, 27, 30)).toEqual({ name: 'Editor', startLine: 25, endLine: 32 });
    expect(enclosingDeclaration('/repo/a.ts', SRC, 21, 22)).toEqual({ name: 'startSession', startLine: 20, endLine: 23 });
  });
  it('is undefined outside every declaration, for unparseable files, and for other extensions', () => {
    expect(enclosingDeclaration('/repo/a.ts', SRC, 1, 2)).toBeUndefined();
    expect(enclosingDeclaration('/repo/b.ts', 'function f( {', 1, 1)).toBeUndefined();
    expect(enclosingDeclaration('/repo/m.go', 'func main() {}', 1, 1)).toBeUndefined();
  });
});

describe('line numbers count LF only, like readSource, git and the client (G16)', () => {
  // U+2028 / U+2029 and a lone CR are line terminators to the TS scanner but not
  // to readSource's /\r?\n/ split; the resolver must count the way the snippet does.
  const cases: [string, string][] = [
    ['U+2028 in a string', "const s = 'a b';\n"],
    ['U+2029 in a comment', '// para graph\n'],
    ['a lone CR in a // comment', '// old\rmac\n'],
  ];
  it.each(cases)('%s before a mid-file declaration', (_label, before) => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-g16-'));
    const text = `${before}\nexport function retry() {\n  return 1;\n}\n`;
    writeFileSync(join(dir, 'r.ts'), text);
    const src = readSource(dir, 'r.ts');
    const res = resolveSymbol(src.abs, src.text, 'retry');
    expect(res).toMatchObject({ ok: true, startLine: 3, endLine: 5 });
    if (!res.ok) return;
    expect(sliceLines(src.rel, src.lines, res.startLine, res.endLine).split('\n')[0]).toMatch(/^export function retry/);
    expect(enclosingDeclaration(src.abs, src.text, 4, 4)).toEqual({ name: 'retry', startLine: 3, endLine: 5 });
  });
  it('reports parse_error positions in LF lines', () => {
    expect(r('f', '/repo/b.ts', "const s = 'a b';\nfunction f( {")).toEqual({ ok: false, reason: 'parse_error', message: "2:14 '}' expected." });
  });
});

describe('more addressable declarations (G1)', () => {
  it('namespace member', () => {
    const src = 'namespace NS {\n  export function f() {}\n  export const k = 1;\n  class C { m() {} }\n}\nnamespace A.B {\n  export function g() {}\n}\n';
    expect(r('NS', '/repo/n.ts', src)).toEqual({ ok: true, startLine: 1, endLine: 5, kind: 'namespace', name: 'NS' });
    expect(r('NS.f', '/repo/n.ts', src)).toEqual({ ok: true, startLine: 2, endLine: 2, kind: 'function', name: 'NS.f' });
    expect(r('NS.k', '/repo/n.ts', src)).toEqual({ ok: true, startLine: 3, endLine: 3, kind: 'const', name: 'NS.k' });
    expect(r('NS.C.m', '/repo/n.ts', src)).toEqual({ ok: true, startLine: 4, endLine: 4, kind: 'method', name: 'NS.C.m' });
    expect(r('A.B.g', '/repo/n.ts', src)).toEqual({ ok: true, startLine: 7, endLine: 7, kind: 'function', name: 'A.B.g' });
    expect(enclosingDeclaration('/repo/n.ts', src, 2, 3)).toEqual({ name: 'NS', startLine: 1, endLine: 5 });
  });
  it('export default object member', () => {
    const src = 'export default {\n  async fetch(req: Request) {\n    return req;\n  },\n  port: 3,\n} satisfies Handler;\n';
    expect(r('default', '/repo/w.ts', src)).toEqual({ ok: true, startLine: 1, endLine: 6, kind: 'default', name: 'default' });
    expect(r('default.fetch', '/repo/w.ts', src)).toEqual({ ok: true, startLine: 2, endLine: 4, kind: 'method', name: 'default.fetch' });
    expect(r('default.port', '/repo/w.ts', src)).toEqual({ ok: true, startLine: 5, endLine: 5, kind: 'property', name: 'default.port' });
    expect(enclosingDeclaration('/repo/w.ts', src, 3, 3)).toEqual({ name: 'default.fetch', startLine: 2, endLine: 4 });
    expect(r('default', '/repo/d.ts', 'export default function () {\n  return 1;\n}\n')).toEqual({ ok: true, startLine: 1, endLine: 3, kind: 'function', name: 'default' });
    expect(r('default.m', '/repo/d.ts', 'export default class {\n  m() {}\n}\n')).toEqual({ ok: true, startLine: 2, endLine: 2, kind: 'method', name: 'default.m' });
  });
  it('exports.handler', () => {
    const src = 'exports.handler = async (event) => {\n  return event;\n};\nmodule.exports.other = 1;\nmodule.exports = {\n  run() {},\n};\n';
    expect(r('exports.handler', '/repo/h.js', src)).toEqual({ ok: true, startLine: 1, endLine: 3, kind: 'export', name: 'exports.handler' });
    expect(r('module.exports.other', '/repo/h.js', src)).toEqual({ ok: true, startLine: 4, endLine: 4, kind: 'export', name: 'module.exports.other' });
    expect(r('module.exports', '/repo/h.js', src)).toEqual({ ok: true, startLine: 5, endLine: 7, kind: 'export', name: 'module.exports' });
    expect(r('module.exports.run', '/repo/h.js', src)).toEqual({ ok: true, startLine: 6, endLine: 6, kind: 'method', name: 'module.exports.run' });
  });
  it('Enum.A', () => {
    const src = 'enum E {\n  A = 1,\n  B,\n}\n';
    expect(r('E.A', '/repo/e.ts', src)).toEqual({ ok: true, startLine: 2, endLine: 2, kind: 'enum member', name: 'E.A' });
    expect(r('E', '/repo/e.ts', src)).toEqual({ ok: true, startLine: 1, endLine: 4, kind: 'enum', name: 'E' });
  });
  it('destructured const names resolve to the whole statement', () => {
    const src = 'const { a, b: [c], ...rest } = obj;\n';
    expect(r('a', '/repo/x.ts', src)).toMatchObject({ ok: true, startLine: 1, endLine: 1, kind: 'const' });
    expect(r('c', '/repo/x.ts', src)).toMatchObject({ ok: true, startLine: 1, endLine: 1, kind: 'const' });
    expect(r('rest', '/repo/x.ts', src)).toMatchObject({ ok: true, startLine: 1, endLine: 1, kind: 'const' });
  });
  it('const+type merge', () => {
    const src = "export const Kind = { a: 'a' } as const;\nexport type Kind = (typeof Kind)[keyof typeof Kind];\n";
    expect(r('Kind', '/repo/k.ts', src)).toEqual({ ok: true, startLine: 1, endLine: 2, kind: 'const+type', name: 'Kind' });
    // an overloaded function merged with a same-named type stays one span
    const ov = 'type F = number;\nfunction F(a: string): void;\nfunction F(a: unknown) {}\n';
    expect(r('F', '/repo/f.ts', ov)).toEqual({ ok: true, startLine: 1, endLine: 3, kind: 'type+function', name: 'F' });
  });
  it('class+interface merge', () => {
    const src = 'interface Foo {\n  a: number;\n}\nclass Foo {\n  a = 1;\n}\n';
    expect(r('Foo', '/repo/f.ts', src)).toEqual({ ok: true, startLine: 1, endLine: 6, kind: 'interface+class', name: 'Foo' });
    expect(r('Foo.a', '/repo/f.ts', src)).toEqual({ ok: true, startLine: 2, endLine: 5, kind: 'property', name: 'Foo.a' });
  });
  it('static+instance member', () => {
    const src = 'class Limiter {\n  allow() { return true }\n  static allow() { return false }\n}\n';
    expect(r('Limiter.allow', '/repo/l.ts', src)).toEqual({ ok: true, startLine: 2, endLine: 3, kind: 'method', name: 'Limiter.allow' });
  });
  it('same-shape repeats stay ambiguous (two interface blocks, two same-named methods)', () => {
    expect(r('Q', '/repo/q.ts', 'interface Q { a: 1 }\ninterface Q { b: 2 }\n')).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(r('C.m', '/repo/c.js', 'class C {\n  m() { return 1 }\n  m() { return 2 }\n}\n')).toMatchObject({ ok: false, reason: 'ambiguous' });
  });
  it('a top-level call is still outside every addressable declaration', () => {
    const src = "server.registerTool('x', {}, async () => {\n  return 1;\n});\n";
    expect(enclosingDeclaration('/repo/m.ts', src, 2, 2)).toBeUndefined();
  });
});

describe('merged twins keep per-part spans for range containment (G1)', () => {
  it('const Kind, a top-level call, type Kind: the call is enclosed by nothing and touches nothing', () => {
    const body = Array.from({ length: 80 }, (_, i) => `  k${i}: 'k${i}',`);
    const src = ['export const Kind = {', ...body, '} as const;', "server.registerTool('x', {}, async () => {", '  return 1;', '});', 'export type Kind = (typeof Kind)[keyof typeof Kind];', ''].join('\n');
    expect(r('Kind', '/repo/k.ts', src)).toEqual({ ok: true, startLine: 1, endLine: 86, kind: 'const+type', name: 'Kind' });
    expect(enclosingDeclaration('/repo/k.ts', src, 84, 84)).toBeUndefined();
    expect(declarationsTouching('/repo/k.ts', src, 84, 84)).toEqual({ names: [], rest: true });
    // inside one part, the merged name (and its resolved span) is what to cite
    expect(enclosingDeclaration('/repo/k.ts', src, 2, 3)).toEqual({ name: 'Kind', startLine: 1, endLine: 86 });
    expect(declarationsTouching('/repo/k.ts', src, 82, 86)).toEqual({ names: ['Kind'], rest: true });
  });
  it('a static and an instance member with another member between them do not enclose it', () => {
    const src = 'class C {\n  allow() { return true }\n  // note\n  other() {}\n  static allow() { return false }\n}\n';
    expect(r('C.allow', '/repo/c.ts', src)).toEqual({ ok: true, startLine: 2, endLine: 5, kind: 'method', name: 'C.allow' });
    expect(enclosingDeclaration('/repo/c.ts', src, 3, 3)).toEqual({ name: 'C', startLine: 1, endLine: 6 });
    expect(enclosingDeclaration('/repo/c.ts', src, 4, 4)).toEqual({ name: 'C.other', startLine: 4, endLine: 4 });
    expect(declarationsTouching('/repo/c.ts', src, 3, 4)).toEqual({ names: ['C'], rest: false });
  });
  it('a getter/setter pair with a member between them does not enclose it', () => {
    const src = 'class P {\n  get v() { return 1 }\n  m() {}\n  set v(x) {}\n}\n';
    expect(r('P.v', '/repo/p.ts', src)).toEqual({ ok: true, startLine: 2, endLine: 4, kind: 'accessor', name: 'P.v' });
    expect(enclosingDeclaration('/repo/p.ts', src, 3, 3)).toEqual({ name: 'P.m', startLine: 3, endLine: 3 });
  });
});

describe('declarationsTouching says whether code outside every declaration is in the range (G1)', () => {
  it('adjacent declarations, blank and comment lines leave no uncitable rest', () => {
    expect(declarationsTouching('/repo/a.ts', 'function a() {}\nfunction b() {}\n', 1, 2)).toEqual({ names: ['a', 'b'], rest: false });
    expect(declarationsTouching('/repo/a.ts', 'function a() {}\n\n// c\nfunction b() {}\n', 1, 4)).toEqual({ names: ['a', 'b'], rest: false });
  });
  it('an import, a top-level call or export = is the rest', () => {
    const src = "import { x } from 'y';\nfunction a() {}\nfoo(\n  1,\n);\nexport = a;\n";
    expect(declarationsTouching('/repo/a.ts', src, 1, 2)).toEqual({ names: ['a'], rest: true });
    expect(declarationsTouching('/repo/a.ts', src, 2, 4)).toEqual({ names: ['a'], rest: true });
    expect(declarationsTouching('/repo/a.ts', src, 6, 6)).toEqual({ names: [], rest: true });
  });
  it('undefined when the file does not parse', () => {
    expect(declarationsTouching('/repo/b.ts', 'function f( {', 1, 1)).toBeUndefined();
  });
});
