import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const requiredJobs = [
  'workflow-checks', 'bindings-check', 'test-node', 'session-flows',
  'build-client', 'build-web', 'module-tests', 'secret-scan', 'security-scan', 'e2e',
  'compose-smoke',
];

/** The jobs a docs, GitHub config or scripts-only PR skips; workflow-checks and secret-scan always run, main runs everything. */
export const fullJobs = [
  'bindings-check', 'test-node', 'session-flows', 'build-client', 'build-web',
  'module-tests', 'security-scan', 'e2e', 'compose-smoke', 'cloud-variant',
];

// Markdown (plugin/ ships its skill texts, so not there), .github and workflow YAML (not
// .github/actions: composite steps the jobs run), and any scripts/ directory (scripts/ and
// cloud/scripts/ tests run in workflow-checks; mcp/scripts/ is covered on main only).
const light = file => /(?:^|\/)scripts\/|^\.github\/(?:workflows\/|ISSUE_TEMPLATE\/)?[^/]+\.ya?ml$/.test(file)
  || (file.endsWith('.md') && !file.startsWith('plugin/'));

/** False when every changed file is markdown, GitHub YAML or a script. */
export const needsFull = files => !files.length || !files.every(light);

export const failedJobs = results => {
  const skippable = results?.changes?.outputs?.full === 'false' ? fullJobs : [];
  return [...new Set([...requiredJobs, ...Object.keys(results ?? {})])]
    .filter(name => results?.[name]?.result !== 'success' && !(skippable.includes(name) && results?.[name]?.result === 'skipped'));
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'changes') {
    // changed paths on stdin, one per line
    const files = readFileSync(0, 'utf8').split('\n').filter(Boolean);
    console.log(`full=${needsFull(files)}`);
  } else {
    const results = JSON.parse(process.env.CI_NEEDS ?? '{}');
    const failed = failedJobs(results);
    for (const name of failed) console.error(`${name}: ${results?.[name]?.result ?? 'missing'}`);
    if (failed.length) process.exitCode = 1;
  }
}
