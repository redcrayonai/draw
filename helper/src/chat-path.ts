import { createHash } from 'node:crypto';
import { existsSync, readdirSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** In the home directory: anyone on a shared machine can create a folder in /tmp first and read or answer what goes through it. */
export const chatDir = () => join(homedir(), '.redcrayon', 'chat');

/** Where the hooks find this checkout's helper: the git root, found without running git, since a hook must be fast. */
export function chatSocketPath(cwd: string, session?: string): string {
  // A symlinked path (macOS's /tmp) must find the same helper as its real one.
  let start = cwd;
  try {
    start = realpathSync(cwd);
  } catch {
    // a directory that went away: no helper to find anyway
  }
  let root = start;
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) {
      root = dir;
      break;
    }
    if (dirname(dir) === dir) break;
  }
  return join(chatDir(), `${createHash('sha256').update(session ? `${root}\0${session}` : root).digest('hex').slice(0, 16)}.sock`);
}

/** Younger than this, a socket may belong to a helper that made the file and is about to listen on it. */
const NEW_SOCKET_MS = 5000;

/**
 * Removes the sockets of helpers that died without exiting (a crash, a reboot): nothing listens
 * on them, and while one is there every hook on this machine starts Node for nothing. Asks each
 * socket, because a live helper's file looks just as old.
 */
export async function removeDeadSockets(dir: string, now: number): Promise<void> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter(name => name.endsWith('.sock'))
      .map(
        name =>
          new Promise<void>(resolve => {
            const path = join(dir, name);
            const probe = connect(path);
            probe.once('connect', () => {
              probe.destroy();
              resolve();
            });
            probe.once('error', (err: NodeJS.ErrnoException) => {
              try {
                if (err.code === 'ECONNREFUSED' && now - statSync(path).mtimeMs > NEW_SOCKET_MS) unlinkSync(path);
              } catch {
                // another process got there first
              }
              resolve();
            });
          })
      )
  );
}
