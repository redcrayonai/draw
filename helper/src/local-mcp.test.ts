import { afterEach, expect, it, vi } from 'vitest';
import { localCall, runLocalMcp } from './local-mcp';
import { LOCAL_REQUEST_BYTES } from '../../shared/local';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('closes MCP on an oversized frame instead of silently dropping an outstanding request', async () => {
  vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
    yield Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":"');
    yield Buffer.alloc(LOCAL_REQUEST_BYTES, 97);
    throw new Error('must stop reading before the newline');
  });
  await expect(runLocalMcp(['--per-repo'])).rejects.toThrow('input line exceeds the size limit');
});
it('rejects oversized serialized requests before opening an HTTP connection', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(localCall({ origin: 'http://127.0.0.1:1', token: 'test' }, { text: 'é'.repeat(LOCAL_REQUEST_BYTES / 2) })).rejects.toThrow('split it into smaller batches');
  expect(fetch).not.toHaveBeenCalled();
});
