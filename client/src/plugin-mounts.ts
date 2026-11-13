// Canvas plugin panels (plugins/README.md, "Canvas part"): a labeled launcher button per
// plugin and one dock on the right. The core owns the button, the dock's frame, Close,
// Escape and width; a plugin's panel only fills its body. Each panel sits behind an error
// boundary and shows only on workspace boards whose workspace turned the plugin on.
// A plugin's agent has no button or dock of its own: it joins the board's chat panel (chat-agents.ts).
import type { BoardAgent } from './chat-agents';
import { CANVAS_PARTS } from './plugins.generated';
import type { Canvas, CanvasNode, CanvasPart } from './plugin-api';

export type CanvasPlugin = { id: string; name: string; settings: Record<string, string>; canvas: CanvasPart };

export type CanvasHostDeps = {
  /** The board on screen; workspaceId is undefined (or 0n) off workspaces, where no canvas plugin shows. */
  board(): { id: bigint; workspaceId: bigint | undefined; link: string } | undefined;
  /** Whether this workspace turned the plugin on (my_workspace_plugins). */
  enabled(pluginId: string, workspaceId: bigint): boolean;
  selectedNodes(): CanvasNode[];
  token(): Promise<string | null>;
  onOpen?(): void;
  parts?: CanvasPlugin[];
  storage?: Storage;
};

export type CanvasHost = {
  readonly isOpen: boolean;
  close(): void;
  refresh(): void;
  boardChanged(): void;
  selectionChanged(): void;
  /** The agents plugins provide for the board on screen, under the same rules as their panels. */
  agents(): BoardAgent[];
};

const WIDTH_KEY = 'plugin-dock-width';
const WIDTH_DEFAULT = 320;
const WIDTH_MIN = 280;
const WIDTH_STEP = 24;
const widthMax = () => Math.floor(window.innerWidth * 0.7);
const clampWidth = (w: number) => Math.max(WIDTH_MIN, Math.min(widthMax(), Math.round(w)));

type Mounted = { el: HTMLElement; cleanup?: () => void; listeners: Set<() => void>; failed: boolean };

export function mountCanvasPlugins(deps: CanvasHostDeps): CanvasHost {
  const all = deps.parts ?? CANVAS_PARTS;
  const parts = all.filter(p => p.canvas.panel);
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const launcher = $<HTMLElement>('plugin-launcher');
  const dock = $<HTMLElement>('plugin-dock');
  const title = $<HTMLElement>('plugin-dock-title');
  const body = $<HTMLElement>('plugin-dock-body');
  const closeBtn = $<HTMLButtonElement>('plugin-dock-close');
  const resize = $<HTMLElement>('plugin-dock-resize');
  let storage: Storage | undefined;
  try { storage = deps.storage ?? localStorage; } catch { storage = undefined; }

  const mounted = new Map<string, Mounted>();
  let active: string | undefined;
  let listed = '';

  const workspaceOf = () => {
    const board = deps.board();
    return board && board.workspaceId !== undefined && board.workspaceId !== 0n ? { ...board, workspaceId: board.workspaceId } : undefined;
  };
  const available = (plugin: CanvasPlugin): boolean => {
    const board = workspaceOf();
    if (!board || Object.values(plugin.settings).some(value => !value.trim())) return false;
    try { return deps.enabled(plugin.id, board.workspaceId); } catch { return false; }
  };

  const fail = (plugin: CanvasPlugin, error: unknown) => {
    console.warn('plugin.canvas_failed', plugin.id, error);
    const entry = mounted.get(plugin.id);
    if (!entry || entry.failed) return;
    entry.failed = true;
    entry.listeners.clear();
    try { entry.cleanup?.(); } catch { /* already failed */ }
    entry.cleanup = undefined;
    const card = document.createElement('div');
    card.className = 'plugin-error';
    card.setAttribute('role', 'alert');
    const head = document.createElement('b');
    head.textContent = `${plugin.canvas.panel!.label} stopped working.`;
    const line = document.createElement('span');
    line.textContent = 'The rest of the board is fine. Reload the page to try again.';
    card.append(head, line);
    entry.el.replaceChildren(card);
  };

  /** What a plugin's part gets of the board on screen. */
  const canvasFor = (plugin: CanvasPlugin, listeners: Set<() => void>): Canvas => {
    const board = workspaceOf()!;
    return {
      board: { id: board.id, workspaceId: board.workspaceId, link: board.link },
      selectedNodes: () => deps.selectedNodes(),
      onSelectionChange(listener) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      token: () => deps.token(),
      settings: Object.freeze({ ...plugin.settings }),
    };
  };
  // Selection listeners of each plugin agent's current conversation. A new conversation replaces the last one's,
  // and a board switch or the plugin going away drops them: an ended conversation hears nothing more.
  const agentListeners = new Map<string, Set<() => void>>();

  const mount = (plugin: CanvasPlugin): Mounted => {
    const existing = mounted.get(plugin.id);
    if (existing) return existing;
    const el = document.createElement('div');
    el.className = 'plugin-body';
    el.dataset.plugin = plugin.id;
    body.append(el);
    const entry: Mounted = { el, listeners: new Set(), failed: false };
    mounted.set(plugin.id, entry);
    try {
      const cleanup = plugin.canvas.panel!.mount(el, canvasFor(plugin, entry.listeners));
      if (typeof cleanup === 'function') entry.cleanup = cleanup;
    } catch (error) { fail(plugin, error); }
    return entry;
  };

  const unmount = (id: string) => {
    const entry = mounted.get(id);
    if (!entry) return;
    mounted.delete(id);
    try { entry.cleanup?.(); } catch (error) { console.warn('plugin.canvas_failed', id, error); }
    entry.el.remove();
  };

  const show = (on: boolean) => {
    dock.hidden = !on;
    launcher.hidden = on || !parts.some(available);
    document.body.classList.toggle('plugin-dock-open', on);
  };

  const open = (plugin: CanvasPlugin, focus = true) => {
    deps.onOpen?.();
    const entry = mount(plugin);
    active = plugin.id;
    for (const other of mounted.values()) other.el.hidden = other !== entry;
    title.textContent = plugin.canvas.panel!.label;
    show(true);
    if (focus) (entry.el.querySelector<HTMLElement>('[autofocus]') ?? closeBtn).focus();
  };

  const close = () => {
    if (!active) return;
    const was = active;
    active = undefined;
    show(false);
    const button = launcher.querySelector<HTMLElement>(`[data-plugin="${was}"]`);
    button?.focus();
    // Its button sits in the launcher's closed list: back to the button that opens the list.
    if (document.activeElement !== button) document.getElementById('act-chat')?.focus();
  };

  const refresh = () => {
    const shown = parts.filter(available);
    for (const id of [...mounted.keys()]) if (!shown.some(p => p.id === id)) unmount(id);
    // Unchanged: keep the buttons, and the focus on one of them.
    const ids = shown.map(p => p.id).join(' ');
    if (ids !== listed) launcher.replaceChildren(...shown.map(plugin => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'plugin-launch';
      button.dataset.plugin = plugin.id;
      button.textContent = plugin.canvas.panel!.label;
      button.setAttribute('aria-controls', 'plugin-dock');
      button.addEventListener('click', () => open(plugin));
      return button;
    }));
    listed = ids;
    if (active && !shown.some(p => p.id === active)) close();
    else show(active !== undefined);
  };

  closeBtn.addEventListener('click', close);
  dock.addEventListener('keydown', evt => {
    if (evt.key !== 'Escape') return;
    evt.stopPropagation(); // the canvas's own Escape would clear the selection
    close();
  });

  // The width the person chose; shown clamped to the window.
  let wanted = WIDTH_DEFAULT;
  const stored = Number((() => { try { return storage?.getItem(WIDTH_KEY); } catch { return null; } })() ?? NaN);
  if (Number.isFinite(stored) && stored >= WIDTH_MIN) wanted = Math.round(stored);
  const showWidth = () => {
    const w = clampWidth(wanted);
    document.body.style.setProperty('--plugin-dock-w', `${w}px`);
    resize.setAttribute('aria-valuenow', String(w));
    resize.setAttribute('aria-valuemin', String(WIDTH_MIN));
    resize.setAttribute('aria-valuemax', String(Math.max(WIDTH_MIN, widthMax())));
  };
  const setWidth = (w: number, remember: boolean) => {
    wanted = clampWidth(w);
    showWidth();
    if (remember) {
      try { storage?.setItem(WIDTH_KEY, String(wanted)); } catch { /* kept for this page only */ }
    }
  };
  let drag: { x: number; w: number } | null = null;
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    resize.classList.remove('drag');
    document.body.classList.remove('plugin-dock-resizing');
    setWidth(wanted, true);
  };
  resize.addEventListener('pointerdown', evt => {
    if (evt.button !== 0) return;
    evt.preventDefault(); // no text selection while dragging
    resize.setPointerCapture?.(evt.pointerId);
    drag = { x: evt.clientX, w: clampWidth(wanted) };
    resize.classList.add('drag');
    document.body.classList.add('plugin-dock-resizing');
  });
  resize.addEventListener('pointermove', evt => {
    // the dock is on the right: moving the edge left widens it
    if (drag) setWidth(drag.w + drag.x - evt.clientX, false);
  });
  resize.addEventListener('pointerup', endDrag);
  resize.addEventListener('pointercancel', endDrag);
  resize.addEventListener('lostpointercapture', endDrag);
  resize.addEventListener('keydown', evt => {
    if (evt.key !== 'ArrowLeft' && evt.key !== 'ArrowRight') return;
    evt.preventDefault();
    evt.stopPropagation(); // these arrows belong to the handle alone
    setWidth(clampWidth(wanted) + (evt.key === 'ArrowLeft' ? WIDTH_STEP : -WIDTH_STEP), true);
  });
  resize.addEventListener('dblclick', () => setWidth(WIDTH_DEFAULT, true));
  window.addEventListener('resize', showWidth);
  showWidth();
  refresh();

  return {
    get isOpen() { return active !== undefined; },
    close,
    refresh,
    boardChanged() {
      agentListeners.clear();
      const was = active;
      for (const id of [...mounted.keys()]) unmount(id);
      active = undefined;
      refresh();
      const again = parts.find(p => p.id === was);
      if (again && available(again)) open(again, false);
    },
    agents: () => all.filter(p => p.canvas.agent && available(p)).map(plugin => ({
      id: plugin.id,
      name: plugin.canvas.agent!.name,
      open: reply => {
        const listeners = new Set<() => void>();
        agentListeners.set(plugin.id, listeners);
        return plugin.canvas.agent!.open(canvasFor(plugin, listeners), reply);
      },
    })),
    selectionChanged() {
      for (const [id, listeners] of agentListeners) {
        if (!all.some(p => p.id === id && available(p))) { agentListeners.delete(id); continue; }
        for (const listener of [...listeners]) {
          try { listener(); } catch (error) { console.warn('plugin.canvas_failed', id, error); }
        }
      }
      for (const plugin of parts) {
        const entry = mounted.get(plugin.id);
        if (!entry || entry.failed) continue;
        for (const listener of [...entry.listeners]) {
          try { listener(); } catch (error) { fail(plugin, error); break; }
        }
      }
    },
  };
}
