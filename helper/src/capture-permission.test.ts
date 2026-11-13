import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestCaptureApproval, requireCapturePermission } from './capture-permission';
import { DEFAULT_PERMISSIONS } from './permissions';

const browser = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: (_command: string, args: string[], callback: (error: null) => void) => { browser(args[0]); callback(null); },
}));

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'draw-consent-'));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  browser.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

function form(timeout = 3000) {
  let opened!: (url: string) => void;
  const url = new Promise<string>(resolve => { opened = resolve; });
  const decision = requestCaptureApproval('File: <script>unsafe</script> & source.ts', opened, timeout);
  return { url, decision };
}
function post(url: string, body: string, headers: Record<string, string> = {}) {
  return fetch(url, { method: 'POST', body, headers: { Origin: new URL(url).origin, ...headers } });
}

describe('one-use source approval', () => {
  it('GET only shows escaped details; a deliberate same-origin form submission approves once', async () => {
    const pending = form();
    const url = await pending.url;
    const response = await fetch(url);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const page = await response.text();
    expect(page).toContain('&lt;script&gt;unsafe&lt;/script&gt; &amp; source.ts');
    expect(page).not.toContain('<script>');
    expect(page.indexOf('value="deny"')).toBeLessThan(page.indexOf('value="allow"'));
    let settled = false;
    void pending.decision.then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(await (await post(url, 'decision=allow')).text()).toContain('Approved once');
    expect(await pending.decision).toBe(true);
    await expect(fetch(url)).rejects.toThrow();
  });
  it('rejects cross-origin, wrong-token and malformed submissions without consuming consent', async () => {
    const pending = form();
    const url = await pending.url;
    expect((await post(url, 'decision=allow', { Origin: 'https://example.com' })).status).toBe(403);
    expect((await fetch(url, { method: 'POST', body: 'decision=allow' })).status).toBe(403);
    expect((await post(url, 'decision=allow', { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await post(url + '-wrong', 'decision=allow')).status).toBe(403);
    expect((await post(url, 'decision=allow&extra=yes')).status).toBe(400);
    expect((await post(url, 'x'.repeat(129))).status).toBe(413);
    expect(await (await post(url, 'decision=deny')).text()).toContain('Denied');
    expect(await pending.decision).toBe(false);
  });
  it('expires without approval and closes when opening the browser throws', async () => {
    const pending = form(25);
    await pending.url;
    expect(await pending.decision).toBe(false);
    let url = '';
    await expect(requestCaptureApproval('details', value => { url = value; throw new Error('browser failed'); })).rejects.toThrow('browser failed');
    await expect(fetch(url)).rejects.toThrow();
  });
  it('closes pending forms on batch cancellation and never opens an already cancelled request', async () => {
    const controller = new AbortController();
    let opened!: (url: string) => void;
    const url = new Promise<string>(resolve => { opened = resolve; });
    const decision = requestCaptureApproval('details', opened, 60_000, controller.signal);
    const address = await url;
    controller.abort();
    expect(await decision).toBe(false);
    await expect(fetch(address)).rejects.toThrow();
    const open = vi.fn();
    expect(await requestCaptureApproval('details', open, 60_000, controller.signal)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});

describe('source policy before filesystem access', () => {
  function policy(overrides: Partial<typeof DEFAULT_PERMISSIONS> = {}) {
    const path = join(directory, 'policy.json');
    writeFileSync(path, JSON.stringify({ permissions: { ...DEFAULT_PERMISSIONS, ...overrides } }));
    vi.stubEnv('DRAW_PERMISSION_FILE', path);
  }
  it.each(['ref', 'cite', 'checkpoint'] as const)('blocks %s in a nonexistent checkout without opening a browser', async kind => {
    policy();
    await expect(requireCapturePermission(kind, { cwd: '/nonexistent-draw-checkout', path: 'source.ts' })).rejects.toThrow('source capture is denied');
    expect(process.stderr.write).not.toHaveBeenCalled();
  });
  it('requires both source-read and upload choices; metadata needs neither', async () => {
    policy({ snippets: 'ask' });
    await expect(requireCapturePermission('ref', { cwd: directory, path: 'source.ts' })).rejects.toThrow('source capture is denied');
    policy({ uploads: 'ask' });
    await expect(requireCapturePermission('ref', { cwd: directory, path: 'source.ts' })).rejects.toThrow('source capture is denied');
    await expect(requireCapturePermission('start', { cwd: directory })).resolves.toBeUndefined();
    expect(process.stderr.write).not.toHaveBeenCalled();
    policy({ boards: 'deny' });
    await expect(requireCapturePermission('start', { cwd: directory })).rejects.toThrow('board access is denied');
  });
  it('fails closed for missing or corrupt configured policies', async () => {
    const path = join(directory, 'missing.json');
    vi.stubEnv('DRAW_PERMISSION_FILE', path);
    await expect(requireCapturePermission('start', { cwd: directory })).rejects.toThrow('settings are missing');
    writeFileSync(path, '{}');
    await expect(requireCapturePermission('ref', { cwd: directory })).rejects.toThrow('settings are invalid');
  });
  it.each(['allow', 'deny', 'revoke'] as const)('honors the one-use %s decision before capture can proceed', async decision => {
    policy({ snippets: 'ask', uploads: 'ask' });
    let submitted: Promise<unknown> | undefined;
    browser.mockImplementation((url: string) => {
      if (decision === 'revoke') policy({ snippets: 'ask', uploads: 'deny' });
      submitted = post(url, `decision=${decision === 'deny' ? 'deny' : 'allow'}`);
    });
    const capture = requireCapturePermission('ref', { cwd: directory, path: 'source.ts' });
    if (decision === 'allow') await expect(capture).resolves.toBeUndefined();
    else await expect(capture).rejects.toThrow(decision === 'deny' ? 'not approved' : 'capture is denied');
    await submitted;
    expect(browser).toHaveBeenCalledTimes(1);
  });
});
