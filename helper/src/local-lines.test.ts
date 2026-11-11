import { expect, it } from 'vitest';
import { localLines } from './local-lines';
async function read(chunks: Buffer[], limit: number) {
  const errors: string[] = [], lines: string[] = [];
  async function* input() { yield* chunks; }
  for await (const line of localLines(input(), limit, message => errors.push(message))) lines.push(line);
  return { errors, lines };
}
it('frames split UTF-8, CRLF, blank lines and a final partial line', async () => {
  const bytes = Buffer.from('é\r\n\n{"a":1}\nlast');
  expect(await read([...bytes].map(b => Buffer.from([b])), 20)).toEqual({ errors: [], lines: ['é', '{"a":1}', 'last'] });
});
it('discards oversized lines until newline and resumes', async () => {
  const result = await read([Buffer.from('1234'), Buffer.from('5678\nok\n12345')], 4);
  expect(result.lines).toEqual(['ok']); expect(result.errors).toHaveLength(2);
});
