import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const settings = {
	PUBLIC_ALGOLIA_APP_ID: 'docs-test',
	PUBLIC_ALGOLIA_SEARCH_API_KEY: 'search-only-test-key',
	PUBLIC_ALGOLIA_INDEX_NAME: 'draw-docs-test',
};
const empty = Object.fromEntries(Object.keys(settings).map(key => [key, '']));
const cases = [
	['no settings keeps local search available', empty, true],
	['all settings accepts the DocSearch configuration', settings, true],
	...Object.keys(settings).map(key => [`missing ${key} fails with setup instructions`, { ...settings, [key]: '' }, false]),
];

for (const [name, env, valid] of cases) {
	test(name, () => {
		const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./astro.config.mjs')"], {
			cwd: new URL('../', import.meta.url),
			env: { ...process.env, ...env },
			encoding: 'utf8',
		});
		assert.equal(result.status, valid ? 0 : 1, result.stderr);
		if (!valid) assert.match(result.stderr, /Set all three PUBLIC_ALGOLIA_ settings/);
	});
}
