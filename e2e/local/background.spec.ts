import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('background server survives its launcher process group and refuses an existing writer lock', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'draw-background-'));
  const root = resolve(import.meta.dirname, '../..');
  const binary = process.env.DRAW_LOCAL_BINARY;
  let pid: number | undefined;
  const launch = async () => {
    const child = spawn(binary ?? process.execPath, [
      ...(binary ? [] : [join(root, 'helper/dist/redcrayon.mjs')]),
      'local', '--background', '--repo', directory, '--store', directory,
    ], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    return { code, stderr, pid: child.pid! };
  };
  try {
    const first = await launch(); expect(first.code).toBe(0);
    const endpoint = JSON.parse(readFileSync(join(directory, 'endpoint.json'), 'utf8'));
    pid = endpoint.pid;
    expect(first.stderr).toContain(`Server PID: ${pid}`);
    expect(statSync(join(directory, 'server.log')).mode & 0o777).toBe(0o600);
    // Simulate the terminal cleaning up its process group after a session ends.
    try { process.kill(-first.pid, 'SIGTERM'); } catch (error) { expect((error as NodeJS.ErrnoException).code).toBe('ESRCH'); }
    const call = async (input: object) => {
      const response = await fetch(`${endpoint.origin}/api/call`, { method: 'POST', headers: { Authorization: `Bearer ${endpoint.token}` }, body: JSON.stringify(input) });
      expect(response.ok).toBe(true); return response.json();
    };
    const board = await call({ action: 'open_board', name: 'Survives the terminal' });
    const second = await launch(); expect(second.code).toBe(0);
    expect(JSON.parse(readFileSync(join(directory, 'endpoint.json'), 'utf8')).pid).toBe(pid);
    expect((await call({ action: 'read_board', board: board.slug })).name).toBe('Survives the terminal');
    process.kill(pid!, 'SIGTERM');
    await expect.poll(() => existsSync(join(directory, 'writer.lock'))).toBe(false);
    pid = undefined;
    const lock = JSON.stringify({ pid: process.pid });
    writeFileSync(join(directory, 'writer.lock'), lock);
    const locked = await launch(); expect(locked.code).not.toBe(0);
    expect(locked.stderr).toContain('local server exited during startup');
    expect(readFileSync(join(directory, 'server.log'), 'utf8')).toContain('local store is locked');
    expect(readFileSync(join(directory, 'writer.lock'), 'utf8')).toBe(lock);
    expect(JSON.parse(readFileSync(join(directory, 'boards.json'), 'utf8')).boards[0].slug).toBe(board.slug);
  } finally {
    if (pid) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* Already stopped. */ }
      await expect.poll(() => existsSync(join(directory, 'writer.lock'))).toBe(false);
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
