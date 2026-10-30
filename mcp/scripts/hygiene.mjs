// Bundle hygiene (spec §12): the built Worker holds no DB SDK, no code built
// from strings, and imports no child_process or file system. Run after
// `pnpm run build`.
import { readFileSync } from 'node:fs';

const bundle = readFileSync(new URL('../dist/worker.js', import.meta.url), 'utf8');
const banned = [
  [/DbConnectionImpl/, 'the DB SDK connection'],
  [/new Function\s*\(/, 'new Function'],
  [/\bfrom\s*["'](node:)?(child_process|fs)["']|require\(\s*["'](node:)?(child_process|fs)["']\s*\)|import\(\s*["'](node:)?(child_process|fs)["']\s*\)/, 'a child_process or fs import'],
];
const found = banned.filter(([re]) => re.test(bundle)).map(([, what]) => what);
if (found.length) {
  console.error(`hygiene: the Worker bundle contains ${found.join(', ')}`);
  process.exit(1);
}
console.error('hygiene: clean');
