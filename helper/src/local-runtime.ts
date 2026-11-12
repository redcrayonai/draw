import { resolve } from 'node:path';

export const standalone = (globalThis as { Bun?: { isStandaloneExecutable?: boolean } }).Bun?.isStandaloneExecutable === true;

/** Hooks must invoke the executable itself when its JavaScript lives inside the binary. */
export function localCommand(entry = process.argv[1]): string[] {
  return standalone ? [process.execPath] : [process.execPath, resolve(entry)];
}
