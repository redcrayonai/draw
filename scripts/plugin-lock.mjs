// Rules for outside plugins (PLUGINS.md, "Design: plugins outside this repo"): the draw
// versions a plugin supports, the plugins file and its lock. Pure functions; the builder
// (scripts/builder.mjs) does the I/O around them.
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const rule = message => `plugin rule: ${message}`;
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const CARET = /^\^(\d+)\.(\d+)\.(\d+)$/;

/** `^1.4.0 || ^2.0.0` → [[1, 4, 0], [2, 0, 0]]. Only caret ranges: the interface follows semver. */
export function parseRange(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error(rule('draw must be a caret range such as "^0.3.0"'));
  return text.split('||').map(part => {
    const match = CARET.exec(part.trim());
    if (!match) throw new Error(rule(`draw must be a caret range such as "^0.3.0", not '${text}'`));
    return match.slice(1).map(Number);
  });
}

/** npm caret semantics: ^1.4.0 is >=1.4.0 <2.0.0, ^0.3.0 is >=0.3.0 <0.4.0, ^0.0.3 is 0.0.3 only. */
export function satisfies(version, range) {
  const match = VERSION.exec(version);
  if (!match) throw new Error(rule(`not a draw version: '${version}'`));
  const v = match.slice(1).map(Number);
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  return parseRange(range).some(min => {
    const max = min[0] > 0 ? [min[0] + 1, 0, 0] : min[1] > 0 ? [0, min[1] + 1, 0] : [0, 0, min[2] + 1];
    return cmp(v, min) >= 0 && cmp(v, max) < 0;
  });
}

/** DRAW_VERSION, else /draw/VERSION in the builder image, else the newest v* tag; null when none. */
export function drawVersion(root, env = process.env, versionFile = '/draw/VERSION') {
  if (env.DRAW_VERSION) return env.DRAW_VERSION.replace(/^v/, '');
  if (existsSync(versionFile)) {
    const value = readFileSync(versionFile, 'utf8').trim().replace(/^v/, '');
    if (VERSION.test(value)) return value;
  }
  try {
    const tag = execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*.[0-9]*.[0-9]*'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return tag.replace(/^v/, '');
  } catch {
    return null;
  }
}

/** Problems with a plugin's range against this draw; outside plugins must declare one. */
export function rangeProblems(plugin, version, { outside = false, label = plugin.id } = {}) {
  if (plugin.draw === undefined) return outside ? [rule(`${label} must declare the draw versions it supports ("draw": "^X.Y.Z" in plugin.json)`)] : [];
  if (!version) return [rule("cannot tell draw's version; fetch tags or set DRAW_VERSION")];
  return satisfies(version, plugin.draw) ? [] : [rule(`${label} supports draw ${plugin.draw}; this is draw ${version}. Upgrade the plugin, or mark it "skip": true.`)];
}

export { rule };
