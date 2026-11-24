// Run with the repository's tsx runner after changing the hosted tool definitions.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { TOOLS } from '../src/tools';
const catalog = Object.entries(TOOLS).map(([name, tool]) => ({
  name, title: tool.title, description: tool.description, annotations: tool.annotations, inputSchema: z.toJSONSchema(tool.input, { target: 'draft-7', io: 'input' }),
}));
const file = new URL('../../helper/src/hosted-tools.json', import.meta.url);
const json = JSON.stringify(catalog, null, 2) + '\n';
if (process.argv.includes('--check')) assert.equal(readFileSync(file, 'utf8'), json, 'Regenerate the native hosted tool catalog.');
else writeFileSync(file, json);
