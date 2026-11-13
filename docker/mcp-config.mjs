import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const ts = createRequire(new URL('../mcp/package.json', import.meta.url))('typescript');

export function composeConfig(text) {
  const { config, error } = ts.parseConfigFileTextToJson('wrangler.jsonc', text);
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  delete config.analytics_engine_datasets;
  delete config.triggers;
  return config;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(composeConfig(readFileSync(process.argv[2], 'utf8')), null, 2));
}
