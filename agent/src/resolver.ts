/**
 * Symbol -> line range for TypeScript/JavaScript using only ts.createSourceFile
 * (no program, no type checker; 1-11 ms per file in the 2026-10-02 probe).
 *
 * Contract (repeated in the add_code_ref tool description):
 * - top-level function / class / interface / type / enum / namespace by bare name
 * - a `const x = ...` (and each destructured name) resolves to the whole variable statement
 * - class and interface members as `Class.member` (methods, accessors, properties, constructor)
 * - enum members as `Enum.member`; namespace members as `NS.member` (`A.B.member`)
 * - the default export as `default` (ExportAssignment or anonymous function/class), its
 *   object-literal or class members as `default.member`
 * - CommonJS `exports.x`, `module.exports`, `module.exports.x` (and object members of the latter)
 * - overload signatures and their implementation are one span; a get/set pair is one span
 * - same-named declarations of different shapes are one span (const + type, class +
 *   interface, function + namespace, static + instance member); same-shape repeats stay ambiguous;
 *   only each declaration's own lines enclose code, never the gap between two of them
 * - the range excludes leading JSDoc (getStart skips trivia)
 * - an exact top-level match beats a same-named member (names are fully qualified)
 * - nested and local declarations are not addressable; enclosingDeclaration names
 *   what to cite instead (add_code_ref refuses ranges for these extensions), and
 *   declarationsTouching tells a range across declarations from one outside them all
 * - the TS parser never throws, so the extension gate and parseDiagnostics are mandatory
 */
import ts from 'typescript';
import { extname } from 'node:path';

export const RESOLVABLE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

export type Candidate = { name: string; kind: string; startLine: number; endLine: number };

export type ResolveResult =
  | { ok: true; startLine: number; endLine: number; kind: string; name: string }
  | { ok: false; reason: 'ambiguous'; candidates: Candidate[] }
  | { ok: false; reason: 'not_found'; suggestions: string[] }
  | { ok: false; reason: 'unsupported_language'; ext: string }
  | { ok: false; reason: 'parse_error'; message: string };

/**
 * The one symbol rule, identical to module/src/index.ts symbolNeedle (P1.6);
 * scripts/eval-session.mjs imports this one (F18): a resolver-named member ref
 * ('Limiter.allow') points at the member's own lines, which never spell the
 * class name, so the needle is the last dotted segment. Undotted symbols (and a
 * symbol whose dot is trailing) are matched whole.
 */
export function symbolNeedle(symbol: string): string {
  const dot = symbol.lastIndexOf('.');
  const tail = dot >= 0 ? symbol.slice(dot + 1) : symbol;
  return tail.length > 0 ? tail : symbol;
}

// A span of source positions. `openOverload` marks a body-less signature that
// the next same-named declaration (its overload or implementation) extends.
// `flavors` are the declaration shapes merged into the span (see buildIndex).
// `parts` are the merged declarations' own spans: start..end is what the name
// resolves to, but only a part encloses code (G1) — the code between two
// same-named declarations (a top-level call between const Kind and type Kind)
// belongs to neither.
type Span = { start: number; end: number };
type IndexEntry = { name: string; kind: string; start: number; end: number; openOverload: boolean; flavors: Set<string>; parts: Span[] };

function scriptKindFor(ext: string): ts.ScriptKind {
  switch (ext) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function kindLabel(node: ts.Node): string {
  if (ts.isFunctionDeclaration(node)) return 'function';
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'type';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isEnumMember(node)) return 'enum member';
  if (ts.isModuleDeclaration(node)) return 'namespace';
  if (ts.isExportAssignment(node)) return 'default';
  if (ts.isExpressionStatement(node)) return 'export';
  if (ts.isVariableStatement(node)) return 'const';
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return 'method';
  if (ts.isGetAccessor(node)) return 'getter';
  if (ts.isSetAccessor(node)) return 'setter';
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) return 'property';
  if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) return 'property';
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  return 'declaration';
}

function isDefaultExport(stmt: ts.Statement): boolean {
  return ts.canHaveModifiers(stmt) && (ts.getModifiers(stmt) ?? []).some(m => m.kind === ts.SyntaxKind.DefaultKeyword);
}

function topLevelName(stmt: ts.Statement): string | undefined {
  if (
    ts.isFunctionDeclaration(stmt) ||
    ts.isClassDeclaration(stmt) ||
    ts.isInterfaceDeclaration(stmt) ||
    ts.isTypeAliasDeclaration(stmt) ||
    ts.isEnumDeclaration(stmt)
  ) {
    if (stmt.name) return stmt.name.text;
    // `export default function () {}` / `export default class {}`
    if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && isDefaultExport(stmt)) return 'default';
  }
  // `namespace NS {}` (a string-named `declare module 'x'` is not addressable)
  if (ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name)) return stmt.name.text;
  return undefined;
}

function memberName(m: ts.Node): string | undefined {
  if (ts.isConstructorDeclaration(m)) return 'constructor';
  const n = (m as { name?: ts.Node }).name;
  if (!n) return undefined;
  if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isPrivateIdentifier(n)) return n.text;
  return undefined;
}

function isStatic(m: ts.Node): boolean {
  return ts.canHaveModifiers(m) && (ts.getModifiers(m) ?? []).some(x => x.kind === ts.SyntaxKind.StaticKeyword);
}

// Every identifier a declaration binds, including destructured ones.
function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap(el => (ts.isOmittedExpression(el) ? [] : bindingNames(el.name)));
}

// `{...}`, `({...})`, `{...} as T` and `{...} satisfies T` are all the object literal.
function objectLiteral(e: ts.Expression): ts.ObjectLiteralExpression | undefined {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
  return ts.isObjectLiteralExpression(e) ? e : undefined;
}

// 'exports.x', 'module.exports' and 'module.exports.x' for a CommonJS export
// assignment target; undefined for anything else.
function commonJsExport(e: ts.Expression): string | undefined {
  const path: string[] = [];
  while (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) {
    path.unshift(e.name.text);
    e = e.expression;
  }
  if (!ts.isIdentifier(e)) return undefined;
  path.unshift(e.text);
  const name = path.join('.');
  return name === 'module.exports' || /^(module\.)?exports\.[^.]+$/.test(name) ? name : undefined;
}

function isOverloadSignature(node: ts.Node): boolean {
  return (
    ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) && !node.body) ||
    ts.isMethodSignature(node)
  );
}

function buildIndex(sf: ts.SourceFile): IndexEntry[] {
  const index: IndexEntry[] = [];
  // `flavor` is the declaration's shape: its kind, plus static and the
  // container's kind for members.
  const add = (name: string, kind: string, node: ts.Node, flavor = kind) => {
    const start = node.getStart(sf);
    const end = node.getEnd();
    const openOverload = isOverloadSignature(node);
    // TypeScript overloads are adjacent: signatures, then (optionally) the
    // implementation. They are one declaration, so they are one span.
    const prev = index[index.length - 1];
    if (prev && prev.name === name && prev.flavors.has(flavor) && prev.openOverload) {
      prev.end = end;
      prev.parts[prev.parts.length - 1].end = end;
      prev.openOverload = openOverload;
      return;
    }
    // A getter and setter of the same name are one property: one span (its
    // parts do not enclose members declared between them).
    if (kind === 'getter' || kind === 'setter') {
      const other = kind === 'getter' ? 'setter' : 'getter';
      const pair = index.find(e => e.name === name && e.kind === other);
      if (pair) {
        pair.start = Math.min(pair.start, start);
        pair.end = Math.max(pair.end, end);
        pair.kind = 'accessor';
        pair.flavors.add(flavor);
        pair.parts.push({ start, end });
        return;
      }
    }
    // Same-named declarations of different shapes are one name, so one span:
    // a value and a type (const Kind + type Kind), a class and an interface,
    // a function and a namespace, a static and an instance member. A repeat of
    // the same shape (a JS redeclaration, two interface blocks) stays apart.
    const twin = index.find(e => e.name === name && !e.flavors.has(flavor));
    if (twin) {
      twin.start = Math.min(twin.start, start);
      twin.end = Math.max(twin.end, end);
      twin.openOverload = openOverload;
      twin.flavors.add(flavor);
      twin.parts.push({ start, end });
      if (!twin.kind.split('+').includes(kind)) twin.kind = `${twin.kind}+${kind}`;
      return;
    }
    index.push({ name, kind, start, end, openOverload, flavors: new Set([flavor]), parts: [{ start, end }] });
  };
  const addMembers = (owner: string, container: string, members: readonly ts.Node[]) => {
    for (const m of members) {
      const mn = memberName(m);
      if (mn === undefined) continue;
      const kind = kindLabel(m);
      add(`${owner}.${mn}`, kind, m, `${container}:${isStatic(m) ? 'static ' : ''}${kind}`);
    }
  };
  const addStatements = (statements: readonly ts.Statement[], prefix: string) => {
    for (const stmt of statements) {
      const name = topLevelName(stmt);
      const qualified = name === undefined ? undefined : prefix + name;
      if (qualified) add(qualified, kindLabel(stmt), stmt);
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          for (const n of bindingNames(decl.name)) add(prefix + n, 'const', stmt);
        }
      }
      if (qualified && (ts.isClassDeclaration(stmt) || ts.isInterfaceDeclaration(stmt))) addMembers(qualified, kindLabel(stmt), stmt.members);
      if (qualified && ts.isEnumDeclaration(stmt)) addMembers(qualified, 'enum', stmt.members);
      // namespace NS { ... } -> NS.member; namespace A.B { ... } -> A.B.member
      if (qualified && ts.isModuleDeclaration(stmt) && stmt.body) {
        const body = stmt.body;
        if (ts.isModuleBlock(body)) addStatements(body.statements, `${qualified}.`);
        else if (ts.isModuleDeclaration(body)) addStatements([body], `${qualified}.`);
      }
      // export default <expression>; an object literal's members are default.member
      if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
        add(`${prefix}default`, 'default', stmt);
        const obj = objectLiteral(stmt.expression);
        if (obj) addMembers(`${prefix}default`, 'object', obj.properties);
      }
      // CommonJS: exports.x = ..., module.exports.x = ..., module.exports = {...}
      if (
        prefix === '' &&
        ts.isExpressionStatement(stmt) &&
        ts.isBinaryExpression(stmt.expression) &&
        stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const target = commonJsExport(stmt.expression.left);
        if (target) {
          add(target, 'export', stmt);
          const obj = target === 'module.exports' ? objectLiteral(stmt.expression.right) : undefined;
          if (obj) addMembers(target, 'object', obj.properties);
        }
      }
    }
  };
  addStatements(sf.statements, '');
  return index;
}

/**
 * 1-based line and column of a source position, counting LF only. The TS
 * scanner also breaks lines at CR, U+2028 and U+2029, but readSource, git and
 * the client split on /\r?\n/, so sf.getLineAndCharacterOfPosition would put a
 * range one line off per such character (G16). CRLF still counts once.
 */
type LineOf = (pos: number) => { line: number; column: number };

function lfLineTable(text: string): LineOf {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return pos => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: pos - starts[lo] + 1 };
  };
}

type Parsed = { sf: ts.SourceFile; lineOf: LineOf };

// Parse with the extension gate and the parseDiagnostics check every caller needs.
function parse(absPath: string, source: string): Parsed | Exclude<ResolveResult, { ok: true }> {
  const ext = extname(absPath).toLowerCase();
  if (!RESOLVABLE_EXTENSIONS.includes(ext)) return { ok: false, reason: 'unsupported_language', ext };
  const sf = ts.createSourceFile(absPath, source, ts.ScriptTarget.Latest, true, scriptKindFor(ext));
  // parseDiagnostics is populated at runtime but absent from the public typings.
  const diags = (sf as unknown as { parseDiagnostics?: ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  const lineOf = lfLineTable(source);
  if (diags.length > 0) {
    const d = diags[0];
    const { line, column } = lineOf(d.start ?? 0);
    return {
      ok: false,
      reason: 'parse_error',
      message: `${line}:${column} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`,
    };
  }
  return { sf, lineOf };
}

function lineRange(lineOf: LineOf, e: Span): { startLine: number; endLine: number } {
  return { startLine: lineOf(e.start).line, endLine: lineOf(e.end).line };
}

/**
 * The innermost addressable declaration one of whose parts (see IndexEntry)
 * contains startLine..endLine, with the lines its name resolves to,
 * or undefined (outside every declaration, unparseable, or not TS/JS). Used to
 * tell the model which symbol to cite instead of a range.
 */
export function enclosingDeclaration(
  absPath: string,
  source: string,
  startLine: number,
  endLine: number
): { name: string; startLine: number; endLine: number } | undefined {
  const parsed = parse(absPath, source);
  if (!('sf' in parsed)) return undefined;
  const { sf, lineOf } = parsed;
  let best: { name: string; startLine: number; endLine: number } | undefined;
  let bestSize = Infinity;
  for (const e of buildIndex(sf)) {
    for (const part of e.parts) {
      const r = lineRange(lineOf, part);
      if (r.startLine > startLine || r.endLine < endLine) continue;
      if (r.endLine - r.startLine < bestSize) {
        bestSize = r.endLine - r.startLine;
        best = { name: e.name, ...lineRange(lineOf, e) };
      }
    }
  }
  return best;
}

/**
 * Used when no one declaration encloses a range. `names`: the outermost
 * addressable declarations one of whose parts shares a line with
 * startLine..endLine, in source order (empty: the range is outside every
 * declaration). `rest`: some line of the range holds top-level code no part
 * covers (an import, a top-level call, `export =`), which no name can cite;
 * blank and comment-only lines do not count. Undefined when the file does not
 * parse (or is not TS/JS).
 */
export function declarationsTouching(
  absPath: string,
  source: string,
  startLine: number,
  endLine: number
): { names: string[]; rest: boolean } | undefined {
  const parsed = parse(absPath, source);
  if (!('sf' in parsed)) return undefined;
  const { sf, lineOf } = parsed;
  const parts = buildIndex(sf).flatMap(e => e.parts.map(part => ({ name: e.name, ...lineRange(lineOf, part) })));
  const touching = parts.filter(d => d.startLine <= endLine && d.endLine >= startLine);
  const outermost = touching.filter(d => !touching.some(o => o !== d && o.startLine <= d.startLine && o.endLine >= d.endLine && o.endLine - o.startLine > d.endLine - d.startLine));
  const names = [...new Set(outermost.sort((a, b) => a.startLine - b.startLine).map(d => d.name))];
  // Every addressable top-level statement is a part of its own, so a line of
  // a top-level statement that no part covers is code no name reaches.
  const rest = sf.statements.some(stmt => {
    const s = lineRange(lineOf, { start: stmt.getStart(sf), end: stmt.getEnd() });
    for (let line = Math.max(s.startLine, startLine); line <= Math.min(s.endLine, endLine); line++) {
      if (!parts.some(p => p.startLine <= line && p.endLine >= line)) return true;
    }
    return false;
  });
  return { names, rest };
}

export function resolveSymbol(absPath: string, source: string, symbol: string): ResolveResult {
  const parsed = parse(absPath, source);
  if (!('sf' in parsed)) return parsed;
  const { sf, lineOf } = parsed;

  const index = buildIndex(sf);
  const matches = index.filter(e => e.name === symbol);
  if (matches.length === 1) {
    return { ok: true, ...lineRange(lineOf, matches[0]), kind: matches[0].kind, name: matches[0].name };
  }
  if (matches.length > 1) {
    return { ok: false, reason: 'ambiguous', candidates: matches.map(m => ({ name: m.name, kind: m.kind, ...lineRange(lineOf, m) })) };
  }
  const needle = symbolNeedle(symbol).toLowerCase();
  const suggestions = [...new Set(index.filter(e => e.name.toLowerCase().includes(needle)).map(e => e.name))].slice(0, 8);
  return { ok: false, reason: 'not_found', suggestions };
}
