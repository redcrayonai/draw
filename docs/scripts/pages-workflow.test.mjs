import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const workflow = readFileSync(new URL('../../.github/workflows/docs.yml', import.meta.url), 'utf8');

test('Pages publishes only checked main builds, including manual runs', () => {
	assert.match(workflow, /^  workflow_dispatch:$/m);
	assert.doesNotMatch(workflow.split('\njobs:\n')[0], /pages: write|id-token: write/);
	const deploy = workflow.split('\n  deploy:\n')[1];
	assert.ok(deploy, 'A Pages deployment job is required');
	const condition = deploy.match(/^    if: (.+)$/m)[1];
	for (const [event_name, ref, allowed] of [
		['push', 'refs/heads/main', true],
		['workflow_dispatch', 'refs/heads/main', true],
		['workflow_dispatch', 'refs/heads/docs-starlight', false],
		['pull_request', 'refs/pull/3/merge', false],
		['pull_request', 'refs/heads/main', false],
	]) {
		assert.equal(runInNewContext(condition, { github: { event_name, ref } }), allowed, `${event_name}: ${ref}`);
	}
	assert.match(deploy, /^    needs: build$/m);
	assert.match(deploy, /^      pages: write$/m);
	assert.match(deploy, /^      id-token: write$/m);
	assert.match(deploy, /^      name: github-pages$/m);
	assert.match(deploy, /uses: actions\/deploy-pages@v5/);
	const upload = workflow.match(/      - name: Upload Pages artifact\n([\s\S]*?)(?=\n  deploy:)/)[1];
	assert.equal(upload.match(/^        if: (.+)$/m)[1], condition);
	assert.match(upload, /uses: actions\/upload-pages-artifact@v4/);
	assert.match(upload, /^          path: docs\/dist$/m);
	assert.ok(workflow.indexOf('name: Check page vocabulary') < workflow.indexOf('name: Upload Pages artifact'));
});
