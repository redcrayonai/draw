import { beforeEach, describe, expect, it, vi } from 'vitest';
import html from '../index.html?raw';
import { mountCanvasPlugins, type CanvasHostDeps, type CanvasPlugin } from './plugin-mounts';
import type { Canvas, CanvasPanel } from './plugin-api';

let board: { id: bigint; workspaceId: bigint | undefined; link: string };
let on: Set<string>;
let selected: { id: bigint; label: string }[];

function plugin(id: string, panel: CanvasPanel, settings: Record<string, string> = {}): CanvasPlugin {
  return { id, name: id, settings, canvas: { panel } };
}

/** A panel that records its mounts and cleanups and puts an autofocus field in its body. */
function recorder(label: string) {
  const mounts: Canvas[] = [];
  const cleanups = vi.fn();
  const panel: CanvasPanel = {
    label,
    mount(el, canvas) {
      mounts.push(canvas);
      const input = document.createElement('textarea');
      input.autofocus = true;
      el.append(input);
      return cleanups;
    },
  };
  return { panel, mounts, cleanups };
}

function host(parts: CanvasPlugin[], extra: Partial<CanvasHostDeps> = {}) {
  document.body.innerHTML = html;
  const api = mountCanvasPlugins({
    board: () => board,
    enabled: (id, workspaceId) => workspaceId === 7n && on.has(id),
    selectedNodes: () => selected,
    token: async () => 'tok-1',
    parts,
    storage: localStorage,
    ...extra,
  });
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const launch = (id: string) => document.querySelector<HTMLButtonElement>(`#plugin-launcher [data-plugin="${id}"]`);
  return { api, launch, launcher: $('plugin-launcher'), dock: $('plugin-dock'), title: $('plugin-dock-title'), body: $('plugin-dock-body') };
}

beforeEach(() => {
  localStorage.clear();
  board = { id: 1n, workspaceId: 7n, link: 'https://draw.example/#b=checkout' };
  on = new Set(['chat']);
  selected = [];
});

describe('canvas plugin panels', () => {
  it('shows a labeled launcher only on a workspace board whose workspace turned the plugin on, with its settings set', () => {
    const chat = recorder('Agent');
    const { launch, launcher, api } = host([plugin('chat', chat.panel, { CHAT_URL: 'https://agent.example' })]);
    expect(launcher.hidden).toBe(false);
    expect(launch('chat')!.textContent).toBe('Agent');

    on.clear();
    api.refresh();
    expect(launch('chat')).toBeNull();
    expect(launcher.hidden).toBe(true);

    on.add('chat');
    board = { ...board, workspaceId: undefined }; // a personal board or a share-link guest
    api.refresh();
    expect(launcher.hidden).toBe(true);
    board = { ...board, workspaceId: 0n };
    api.refresh();
    expect(launcher.hidden).toBe(true);

    const unset = host([plugin('chat', chat.panel, { CHAT_URL: ' ' })]);
    expect(unset.launcher.hidden).toBe(true);
    expect(chat.mounts).toHaveLength(0);
  });

  it('mounts on the first open with the board, selection, token and settings; closing keeps it mounted', async () => {
    const chat = recorder('Agent');
    const { launch, launcher, dock, title, body } = host([plugin('chat', chat.panel, { CHAT_URL: 'https://agent.example' })]);
    launch('chat')!.click();
    expect(dock.hidden).toBe(false);
    expect(launcher.hidden).toBe(true);
    expect(title.textContent).toBe('Agent');
    expect(document.body.classList.contains('plugin-dock-open')).toBe(true);
    expect(document.activeElement).toBe(body.querySelector('textarea'));
    const canvas = chat.mounts[0];
    expect(canvas.board).toEqual({ id: 1n, workspaceId: 7n, link: 'https://draw.example/#b=checkout' });
    expect(canvas.settings).toEqual({ CHAT_URL: 'https://agent.example' });
    expect(Object.isFrozen(canvas.settings)).toBe(true);
    expect(await canvas.token()).toBe('tok-1');
    selected = [{ id: 3n, label: 'Auth' }];
    expect(canvas.selectedNodes()).toEqual([{ id: 3n, label: 'Auth' }]);

    dock.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dock.hidden).toBe(true);
    expect(document.activeElement).toBe(launch('chat'));
    launch('chat')!.click();
    (document.getElementById('plugin-dock-close') as HTMLButtonElement).click();
    expect(dock.hidden).toBe(true);
    expect(chat.mounts).toHaveLength(1);
    expect(chat.cleanups).not.toHaveBeenCalled();
  });

  it('a plugin that throws on mount shows an error card; the other plugin still works', () => {
    on.add('notes');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const notes = recorder('Notes');
    const broken: CanvasPanel = { label: 'Agent', mount() { throw new Error('boom'); } };
    const { launch, body, title } = host([plugin('chat', broken), plugin('notes', notes.panel)]);
    launch('chat')!.click();
    const card = body.querySelector('[data-plugin="chat"] .plugin-error')!;
    expect(card.getAttribute('role')).toBe('alert');
    expect(card.textContent).toBe('Agent stopped working.The rest of the board is fine. Reload the page to try again.');
    expect(warn).toHaveBeenCalledWith('plugin.canvas_failed', 'chat', expect.any(Error));

    (document.getElementById('plugin-dock-close') as HTMLButtonElement).click();
    launch('notes')!.click();
    expect(title.textContent).toBe('Notes');
    expect(notes.mounts).toHaveLength(1);
    expect(body.querySelector<HTMLElement>('[data-plugin="chat"]')!.hidden).toBe(true);
    expect(body.querySelector<HTMLElement>('[data-plugin="notes"]')!.hidden).toBe(false);
    warn.mockRestore();
  });

  it('a selection listener that throws fails only its own plugin', () => {
    on.add('notes');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const heard = vi.fn();
    const bad: CanvasPanel = { label: 'Agent', mount(_el, canvas) { canvas.onSelectionChange(() => { throw new Error('bad listener'); }); } };
    const good: CanvasPanel = { label: 'Notes', mount(_el, canvas) { canvas.onSelectionChange(heard); } };
    const { launch, api, body } = host([plugin('chat', bad), plugin('notes', good)]);
    launch('chat')!.click();
    (document.getElementById('plugin-dock-close') as HTMLButtonElement).click();
    launch('notes')!.click();
    api.selectionChanged();
    expect(body.querySelector('[data-plugin="chat"] .plugin-error')).not.toBeNull();
    expect(heard).toHaveBeenCalledTimes(1);
    api.selectionChanged();
    expect(heard).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('a board switch cleans up and mounts again with the new board; turning the plugin off closes it', () => {
    const chat = recorder('Agent');
    const { launch, api, dock } = host([plugin('chat', chat.panel)]);
    launch('chat')!.click();
    board = { id: 2n, workspaceId: 7n, link: 'https://draw.example/#b=payments' };
    api.boardChanged();
    expect(chat.cleanups).toHaveBeenCalledTimes(1);
    expect(chat.mounts.map(c => c.board.id)).toEqual([1n, 2n]);
    expect(dock.hidden).toBe(false);

    on.clear();
    api.refresh();
    expect(chat.cleanups).toHaveBeenCalledTimes(2);
    expect(dock.hidden).toBe(true);
    expect(document.querySelector('[data-plugin="chat"]')).toBeNull();
  });

  it('resizes from its left edge with the arrow keys, within limits, and remembers the width', () => {
    const { launch } = host([plugin('chat', recorder('Agent').panel)]);
    launch('chat')!.click();
    const edge = document.getElementById('plugin-dock-resize')!;
    edge.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(document.body.style.getPropertyValue('--plugin-dock-w')).toBe('344px');
    expect(localStorage.getItem('plugin-dock-width')).toBe('344');
    for (let i = 0; i < 10; i++) edge.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.body.style.getPropertyValue('--plugin-dock-w')).toBe('280px');
    edge.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(document.body.style.getPropertyValue('--plugin-dock-w')).toBe('320px');
  });
});
