import { describe, expect, it } from 'vitest';
import { CAPTURE_TTL_MS, CHUNK_CHARS, CaptureVault, captureGone, claim, openCapture, sealCapture, storeUpload } from './captures';
import { memoryCaptures } from './test/env';
import type { ClaimCall } from '../../shared/capture';

const store = () => {
  let held: { chunks: string[]; created: number } | undefined;
  return {
    write: (chunks: string[], created: number) => void (held = { chunks, created }),
    take: () => {
      const h = held;
      held = undefined;
      return h;
    },
    peek: () => held,
  };
};

describe('CaptureVault', () => {
  it('stores in chunks, gives the text back once, and never after 10 minutes', () => {
    let now = 0;
    const s = store();
    const v = new CaptureVault(s, () => now);
    const text = 'x'.repeat(CHUNK_CHARS * 2 + 5);
    v.put(text);
    expect(s.peek()!.chunks).toHaveLength(3);
    expect(v.take()).toBe(text);
    expect(v.take()).toBeUndefined();
    v.put('again');
    now = CAPTURE_TTL_MS + 1;
    expect(v.take()).toBeUndefined();
  });

  it('never splits a surrogate pair across chunks', () => {
    const s = store();
    const v = new CaptureVault(s);
    const text = 'a'.repeat(CHUNK_CHARS - 1) + '😀' + 'b';
    v.put(text);
    for (const c of s.peek()!.chunks) expect(c).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    expect(v.take()).toBe(text);
  });
});

describe('storeUpload', () => {
  // an 8 MB body of [{},{},…] parses to far more than 128 MB; the claim, behind sign-in, parses it once
  it('refuses a body without a capture outline with 400, before any write', async () => {
    const writes: string[] = [];
    const spy = (id: string) => ({ put: async (text: string) => void writes.push(id + text), take: async () => undefined });
    for (const body of ['[{},{}', 'not json', '{"kind":"other"}', '{"v":1}', '[{"kind":"start"}]', '']) {
      expect(await storeUpload(body, spy)).toEqual({ status: 400, json: { error: 'invalid_capture' } });
    }
    expect(writes).toEqual([]);
    expect((await storeUpload(' {"v":1,"kind": "checkpoint","files":[]}\n', spy)).status).toBe(200);
  });

  it('stores an outline as sent; the claim refuses one that is not JSON', async () => {
    const captures = memoryCaptures();
    const res = await storeUpload('{"kind":"start",}', captures);
    const id = (res.json as { capture: string }).capture;
    await expect(claim(captures, id, { tool: 'start_session' } as ClaimCall)).rejects.toThrow(/not an object/);
  });
});

describe('sealed uploads (RC-690)', () => {
  const ID = 'cap_' + 'A'.repeat(22);
  const body = '{"v":1,"kind":"cite","file":{"path":"src/a.ts","text":"export const needle = 1; // 😀"}}';

  it('opens only with the id it was sealed for, and a plaintext body is gone', async () => {
    const sealed = await sealCapture(ID, body);
    expect(sealed).not.toContain('needle');
    expect(await openCapture(ID, sealed)).toBe(body);
    expect(await sealCapture(ID, body)).not.toBe(sealed); // a fresh IV each time
    expect(await openCapture('cap_' + 'B'.repeat(22), sealed)).toBeUndefined();
    expect(await openCapture(ID, body)).toBeUndefined();
    expect(await openCapture(ID, sealed.slice(0, -4) + 'AAAA')).toBeUndefined();
    expect(await openCapture(ID, '')).toBeUndefined();
  });

  it('is base64 of a 12-byte IV and the ciphertext with its 16-byte tag, whatever the padding', async () => {
    for (const text of ['', 'a', 'ab', 'abc', 'abcd', '😀', 'é'.repeat(5)]) {
      const sealed = await sealCapture(ID, text);
      expect(atob(sealed)).toHaveLength(12 + new TextEncoder().encode(text).length + 16); // atob refuses padding inside the string
      expect(await openCapture(ID, sealed)).toBe(text);
    }
  });

  it('seals a body of 8 MB', async () => {
    const big = '{"kind":"start","pad":"' + 'x'.repeat(8 * 1024 * 1024) + '"}';
    expect(await openCapture(ID, await sealCapture(ID, big))).toBe(big);
  });

  it('stores no substring of the cited file, and a body stored before the deploy is gone', async () => {
    const inner = memoryCaptures();
    const stored: string[] = [];
    const captures = (id: string) => ({ put: async (text: string) => (stored.push(text), inner(id).put(text)), take: () => inner(id).take() });
    const res = await storeUpload(body, captures);
    const id = (res.json as { capture: string }).capture;
    expect(stored).toHaveLength(1);
    for (const piece of ['needle', 'export const', 'src/a.ts', '"kind"']) expect(stored[0]).not.toContain(piece);
    // the claim opens it: whatever it answers, it is not "gone"
    expect(((await claim(captures, id, { tool: 'start_session' } as ClaimCall).catch(e => e)) as Error).message).not.toBe(captureGone(id));

    const legacy = memoryCaptures();
    await legacy(ID).put(body);
    await expect(claim(legacy, ID, { tool: 'start_session' } as ClaimCall)).rejects.toThrow(captureGone(ID));
  });
});
