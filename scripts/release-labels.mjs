// Turns a PR's labels into releases for .github/workflows/release-labels.yml.
// release:<component> picks what ships; exactly one of major, minor, patch picks
// the bump. A PR with neither kind releases nothing.
//
//   LABELS='["release:plugin","minor"]' node scripts/release-labels.mjs check
//   LABELS=… TAGS="$(git tag)" node scripts/release-labels.mjs plan   # "<component> <tag> <last tag or empty>" per line
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const COMPONENTS = {
  plugin: { prefix: 'plugin-v', seed: 'plugin/package.json' },
};
const BUMPS = ['major', 'minor', 'patch'];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** Returns { components, bump }, or throws when the labels are half set. */
export function parseLabels(labels) {
  const components = labels.filter(l => l.startsWith('release:')).map(l => l.slice('release:'.length));
  const bumps = labels.filter(l => BUMPS.includes(l));
  if (!components.length && !bumps.length) return { components: [], bump: null };
  const unknown = components.filter(c => !Object.hasOwn(COMPONENTS, c));
  if (unknown.length) throw new Error(`unknown label ${unknown.map(c => `release:${c}`).join(', ')}; use ${Object.keys(COMPONENTS).map(c => `release:${c}`).join(', ')}`);
  if (!components.length) throw new Error(`label ${bumps.join(', ')} also needs a release:<component> label (${Object.keys(COMPONENTS).join(', ')})`);
  if (bumps.length !== 1) throw new Error(`release labels need exactly one of ${BUMPS.join(', ')}; found ${bumps.join(', ') || 'none'}`);
  return { components, bump: bumps[0] };
}

/** The tag after the highest <prefix>X.Y.Z tag (or seed, when higher or no tag exists), and that last tag. */
export function nextTag(prefix, tags, bump, seed = '0.0.0') {
  const parse = tag => SEMVER.exec(tag.slice(prefix.length)).slice(1).map(Number);
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const own = tags.filter(t => t.startsWith(prefix) && SEMVER.test(t.slice(prefix.length)));
  const last = own.reduce((max, t) => (max && cmp(parse(max), parse(t)) >= 0 ? max : t), null);
  const fromSeed = parse(prefix + seed);
  const [major, minor, patch] = last && cmp(parse(last), fromSeed) > 0 ? parse(last) : fromSeed;
  const next = bump === 'major' ? [major + 1, 0, 0] : bump === 'minor' ? [major, minor + 1, 0] : [major, minor, patch + 1];
  return { tag: prefix + next.join('.'), last };
}

const seedOf = component => {
  const file = COMPONENTS[component].seed;
  return file ? JSON.parse(readFileSync(file, 'utf8')).version : '0.0.0';
};

export function plan(labels, tags, seed = seedOf) {
  const { components, bump } = parseLabels(labels);
  return components.map(c => ({ component: c, ...nextTag(COMPONENTS[c].prefix, tags, bump, seed(c)) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command] = process.argv.slice(2);
    const labels = () => JSON.parse(process.env.LABELS ?? '[]');
    if (command === 'check') {
      const { components, bump } = parseLabels(labels());
      console.log(components.length ? `merging releases ${components.map(c => `${c} (${bump})`).join(', ')}` : 'no release labels; merging releases nothing');
    } else if (command === 'plan') {
      const tags = (process.env.TAGS ?? '').split('\n').map(t => t.trim()).filter(Boolean);
      for (const { component, tag, last } of plan(labels(), tags)) console.log(`${component} ${tag} ${last ?? ''}`.trim());
    } else {
      throw new Error('usage: release-labels.mjs check | plan');
    }
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
