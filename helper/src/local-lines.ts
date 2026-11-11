/** Bounded byte-oriented NDJSON framing. Oversized lines are discarded through their newline. */
export async function* localLines(input: AsyncIterable<Uint8Array>, limit: number, rejected: (message: string) => void): AsyncGenerator<string> {
  let parts: Buffer[] = [], size = 0, dropping = false;
  for await (const chunk of input) {
    const bytes = Buffer.from(chunk);
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline;
      if (!dropping) {
        const part = bytes.subarray(start, end);
        size += part.length;
        if (size > limit) { parts = []; size = 0; dropping = true; rejected('REJECTED: input line exceeds the size limit'); }
        else parts.push(part);
      }
      if (newline >= 0) {
        if (!dropping) { const line = Buffer.concat(parts).toString('utf8').trim(); if (line) yield line; }
        parts = []; size = 0; dropping = false;
      }
      start = end + 1;
    }
  }
  if (!dropping && size) { const line = Buffer.concat(parts).toString('utf8').trim(); if (line) yield line; }
}
