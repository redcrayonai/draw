import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { Identity, Timestamp } from 'spacetimedb';
import { boardVersions, pluginCatalog, resetPlugins, workspacePlugins } from '$lib/plugins';
import { myWorkspaces } from '$lib/workspaces';
const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('$lib/stdb', () => ({ apiToken: async () => 'user-token' }));
vi.stubGlobal('fetch', h.fetch);
import BoardVersions from './BoardVersions.svelte';

const VERSIONS_PLUGIN = { id: 'versions', name: 'Versions', description: '', available: true };
const version = (id: bigint, boardId = 2n) => ({ id, workspaceId: 4n, boardId, boardName: 'Payments', objectKey: 'k', sha256: 's', bytes: 10n, formatVersion: 1,
  createdBy: new Identity('aa'.repeat(32)), creatorName: 'Ada', createdAt: Timestamp.fromDate(new Date(Date.now() - 60_000)) });
const enabled = (on = true) => workspacePlugins.set([{ key: '4:versions', workspaceId: 4n, plugin: 'versions', enabled: on, updatedAt: new Timestamp(1n) }]);

beforeEach(() => {
  resetPlugins();
  pluginCatalog.set([VERSIONS_PLUGIN]);
  h.fetch.mockReset();
});

it('stays hidden until the deployment offers it and the workspace turned it on', () => {
  enabled(false);
  const { container, unmount } = render(BoardVersions, { props: { boardId: 2n, workspaceId: 4n, canEdit: true } });
  expect(container.textContent).toBe('');
  unmount();
  enabled();
  pluginCatalog.set([{ ...VERSIONS_PLUGIN, available: false }]);
  expect(render(BoardVersions, { props: { boardId: 2n, workspaceId: 4n, canEdit: true } }).container.textContent).toBe('');
});

it("lists this board's versions with time and creator; viewers get no actions", async () => {
  enabled();
  boardVersions.set([version(7n), version(8n, 3n)]);
  render(BoardVersions, { props: { boardId: 2n, workspaceId: 4n, canEdit: false } });
  await fireEvent.click(screen.getByText('Versions · 1'));
  expect(screen.getByText(/Ada/)).toBeInTheDocument();
  expect(screen.queryByRole('button')).toBeNull();
});

it('lets a workspace guest save but not restore, as the server rules', async () => {
  enabled();
  boardVersions.set([version(7n)]);
  myWorkspaces.set([{ id: 4n, name: 'Client', personal: false, role: 'guest', createdAt: new Timestamp(1n) }]);
  render(BoardVersions, { props: { boardId: 2n, workspaceId: 4n, canEdit: true } });
  expect(screen.getByRole('button', { name: 'save version' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Restore the version/ })).toBeNull();
  myWorkspaces.set([]);
});

it('saves, and restores into a new board it links to', async () => {
  enabled();
  boardVersions.set([version(7n)]);
  h.fetch.mockImplementation(async (url: string, init: RequestInit) => {
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer user-token');
    return url.endsWith('/restore') ? Response.json({ boardId: '9', slug: 'fresh' }, { status: 201 }) : Response.json({ versionId: '8' }, { status: 201 });
  });
  render(BoardVersions, { props: { boardId: 2n, workspaceId: 4n, canEdit: true } });
  await fireEvent.click(screen.getByText('save version'));
  expect(h.fetch).toHaveBeenCalledWith('/api/versions', expect.objectContaining({ body: JSON.stringify({ boardId: '2' }) }));
  await screen.findByText('save version'); // no longer saving…
  await fireEvent.click(screen.getByRole('button', { name: /Restore the version/ }));
  expect((await screen.findByRole('link', { name: 'Open it' })).getAttribute('href')).toContain('#b=fresh');
  expect(JSON.parse(h.fetch.mock.calls[1][1].body).requestKey).toMatch(/^[0-9a-f]{64}$/);
});

it('retries a failed restore with the same request key', async () => {
  enabled();
  boardVersions.set([version(7n)]);
  h.fetch.mockResolvedValueOnce(Response.json({ error: 'UNCONFIRMED: the board server did not confirm the restore.' }, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ boardId: '9', slug: 'fresh' }, { status: 201 }));
  render(BoardVersions, { props: { boardId: 2n, workspaceId: 4n, canEdit: true } });
  const button = screen.getByRole('button', { name: /Restore the version/ });
  await fireEvent.click(button);
  await screen.findByRole('alert');
  await screen.findByText('restore as copy');
  await fireEvent.click(button);
  await screen.findByRole('link', { name: 'Open it' });
  const [first, second] = h.fetch.mock.calls.map(([, init]) => JSON.parse(init.body).requestKey);
  expect(second).toBe(first);
});

it("shows the server's refusal", async () => {
  enabled();
  h.fetch.mockResolvedValue(Response.json({ error: 'REJECTED: version rule: the Versions plugin is off in this workspace' }, { status: 403 }));
  render(BoardVersions, { props: { boardId: 2n, workspaceId: 4n, canEdit: true } });
  await fireEvent.click(screen.getByText('save version'));
  expect(await screen.findByRole('alert')).toHaveTextContent('REJECTED: version rule: the Versions plugin is off');
});
