import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Match agent identity scoping: one anonymous identity per server host, across databases. */
export function tokenPathFor(uri: string, explicitPath?: string): string {
  if (explicitPath) return resolve(explicitPath);
  const host = new URL(uri).hostname;
  return join(ROOT, '.context', `importer-token.${LOOPBACK.has(host) ? 'localhost' : host}`);
}

export function readTokenAt(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim() || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Claim a new anonymous identity once, or verify the established credential is unchanged. */
export function saveTokenAt(path: string, token: string, savedToken?: string): void {
  if (savedToken === undefined) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, token + '\n', { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('Anonymous identity was saved by another command; retry with the existing token file.');
      }
      throw error;
    }
  } else if (token !== savedToken || readTokenAt(path) !== savedToken) {
    throw new Error('Anonymous identity changed; retry with the current token file.');
  }
  chmodSync(path, 0o600);
}
