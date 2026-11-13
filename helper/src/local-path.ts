import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function localDirectory(repo: string) {
  return join(homedir(), '.redcrayon', 'local', createHash('sha256').update(realpathSync(repo)).digest('hex').slice(0, 24));
}
