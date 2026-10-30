import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import * as extraction from './extract-graph';

function repository(files: Record<string, string>): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'architecture-test-'));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(path, file)), { recursive: true });
    writeFileSync(join(path, file), content);
  }
  execFileSync('git', ['init', '-q', path]);
  execFileSync('git', ['add', '.'], { cwd: path });
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

test('tracked JS imports use stable file and npm keys with AST evidence', async () => {
  assert.equal(typeof extraction.extractGraph, 'function');
  const repo = repository({
    'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@app/*":["src/*"]}}}',
    'package.json': '{"private":true,"workspaces":["packages/*"]}',
    'src/main.ts': 'import { value } from "@app/util"; export * from "@repo/common"; const fs = require("node:fs"); import("left-pad"); // import("fake-comment")',
    'src/util.ts': 'export const value = 1;',
    'src/main.test.ts': 'import "./main.js"; const common = require("@repo/common");',
    'packages/common/package.json': '{"name":"@repo/common","exports":"./src/index.ts"}',
    'packages/common/src/index.ts': 'export const common = 1;',
  });
  try {
    writeFileSync(join(repo.path, 'src/untracked.ts'), 'import "ignored";');
    const graph = await extraction.extractGraph(repo.path);
    assert.deepEqual(graph.nodes.map(node => node.key), [
      'js:packages/common/src/index.ts', 'js:src/main.test.ts', 'js:src/main.ts', 'js:src/util.ts', 'npm:left-pad',
    ]);
    assert.deepEqual(graph.edges.map(edge => [edge.from, edge.to, edge.evidence]), [
      ['js:src/main.test.ts', 'js:packages/common/src/index.ts', 'test-import'],
      ['js:src/main.test.ts', 'js:src/main.ts', 'test-import'],
      ['js:src/main.ts', 'js:packages/common/src/index.ts', 'import'],
      ['js:src/main.ts', 'js:src/util.ts', 'import'],
      ['js:src/main.ts', 'npm:left-pad', 'import'],
    ]);
    assert.ok(graph.edges.every(edge => edge.relation === 'imports'));
    assert.ok(!graph.files.includes('src/untracked.ts'));
    assert.deepEqual(graph, await extraction.extractGraph(repo.path));
  } finally { repo.cleanup(); }
});

test('unresolved relative and configured local aliases fail the entire graph', async () => {
  assert.equal(typeof extraction.extractGraph, 'function');
  for (const specifier of ['./missing', '@app/missing']) {
    const repo = repository({
      'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@app/*":["src/*"]}}}',
      'src/main.ts': `import "${specifier}";`,
    });
    try { await assert.rejects(extraction.extractGraph(repo.path), /unresolved local import/i); }
    finally { repo.cleanup(); }
  }
});

test('Go packages include test-only external modules and exclude standard library', async () => {
  assert.equal(typeof extraction.extractGraph, 'function');
  const dependency = mkdtempSync(join(tmpdir(), 'architecture-go-dependency-'));
  writeFileSync(join(dependency, 'go.mod'), 'module example.com/testdep\n\ngo 1.22\n');
  writeFileSync(join(dependency, 'dep.go'), 'package testdep\nconst Value = 1\n');
  const repo = repository({
    'go.mod': `module example.com/root\n\ngo 1.22\n\nrequire example.com/testdep v0.0.0\nreplace example.com/testdep => ${dependency}\n`,
    'root.go': 'package root\nimport ("fmt"; "example.com/root/internal/a")\nfunc F() { fmt.Println(a.A) }\n',
    'root_test.go': 'package root_test\nimport ("testing"; "example.com/testdep")\nfunc TestF(t *testing.T) { _ = testdep.Value }\n',
    'internal/a/a.go': 'package a\nconst A = 1\n',
  });
  try {
    const graph = await extraction.extractGraph(repo.path);
    assert.deepEqual(graph.nodes.map(node => node.key), ['go-module:example.com/testdep', 'go:example.com/root', 'go:example.com/root/internal/a']);
    assert.deepEqual(graph.edges.map(edge => [edge.from, edge.to, edge.evidence]), [
      ['go:example.com/root', 'go-module:example.com/testdep', 'test-import'],
      ['go:example.com/root', 'go:example.com/root/internal/a', 'import'],
    ]);
  } finally { repo.cleanup(); rmSync(dependency, { recursive: true, force: true }); }
});

test('graph limit rejects oversized graphs without silently truncating', () => {
  assert.equal(typeof extraction.finalizeGraph, 'function');
  const nodes = Array.from({ length: 5001 }, (_, index) => ({ key: `js:${index}.ts`, label: `${index}`, sublabel: '', kind: 'service' as const }));
  assert.throws(() => extraction.finalizeGraph({ nodes, edges: [], files: [] }), /5000 nodes/);
  const edges = Array.from({ length: 20001 }, (_, index) => ({ from: 'js:0.ts', to: 'js:1.ts', label: `${index}`, relation: 'imports' as const, evidence: 'import' as const }));
  assert.throws(() => extraction.finalizeGraph({ nodes: nodes.slice(0, 2), edges, files: [] }), /20000 edges/);
});

test('Go JSON stream parser respects braces and escaped quotes inside documentation', () => {
  assert.equal(typeof extraction.parseGoListStream, 'function');
  assert.deepEqual(extraction.parseGoListStream('{"ImportPath":"a","Doc":"a { \\"quoted\\" }"}\n{"ImportPath":"b"}'), [
    { ImportPath: 'a', Doc: 'a { "quoted" }' }, { ImportPath: 'b' },
  ]);
});

test('tracked symlinks are rejected before repository tools or parsers read them', async () => {
  const repo = repository({ 'index.ts': 'export const value = 1;' });
  try {
    symlinkSync('/etc/passwd', join(repo.path, 'host-file'));
    execFileSync('git', ['add', 'host-file'], { cwd: repo.path });
    await assert.rejects(extraction.extractGraph(repo.path), /symlink/i);
  } finally { repo.cleanup(); }
});

test('mixed JavaScript and Go repositories require a tracked root Go module', async () => {
  const repo = repository({ 'index.ts': 'export const value = 1;', 'backend/root.go': 'package backend\nfunc F() {}\n' });
  try { await assert.rejects(extraction.extractGraph(repo.path), /tracked root go\.mod.*only the root Go module/i); }
  finally { repo.cleanup(); }
});

test('nested Go modules reject a mixed-language snapshot instead of publishing an incomplete graph', async () => {
  const repo = repository({
    'go.mod': 'module example.com/root\n\ngo 1.22\n',
    'root.go': 'package root\nfunc F() {}\n',
    'backend/go.mod': 'module example.com/backend\n\ngo 1.22\n',
    'backend/root.go': 'package backend\nfunc F() {}\n',
    'index.ts': 'export const value = 1;',
  });
  try { await assert.rejects(extraction.extractGraph(repo.path), /nested Go module.*only the root Go module/i); }
  finally { repo.cleanup(); }
});

test('mixed root Go and JavaScript sources merge even when Go imports only the standard library', async () => {
  const repo = repository({
    'go.mod': 'module example.com/mixed\n\ngo 1.22\n',
    'root.go': 'package mixed\nimport "fmt"\nfunc F() { fmt.Println("ok") }\n',
    'index.ts': 'export const value = 1;',
  });
  try {
    const graph = await extraction.extractGraph(repo.path);
    assert.deepEqual(graph.nodes.map(node => node.key), ['go:example.com/mixed', 'js:index.ts']);
    assert.deepEqual(graph.edges, []);
  } finally { repo.cleanup(); }
});
