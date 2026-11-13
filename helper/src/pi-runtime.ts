import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Extensions run inside pi's Node process, even when Draw itself is native. */
export function piHelperCommand(): string[] {
  if (process.env.DRAW_EXECUTABLE) return [process.env.DRAW_EXECUTABLE];
  for (const name of [process.platform === 'win32' ? './draw.exe' : './draw', '../bin/draw']) {
    const native = fileURLToPath(new URL(name, import.meta.url));
    if (existsSync(native)) return [native];
  }
  return [process.execPath, fileURLToPath(new URL('./redcrayon.mjs', import.meta.url))];
}
