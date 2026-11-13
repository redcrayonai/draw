// The canvas plugin interface (`@draw/canvas`, plugins/README.md). A plugin's client/
// part imports only this file. It stays types-only: the core hands these values to
// plugin code, and scripts/plugin-api-types.mjs checks them against main.

/** A node on the board. */
export type CanvasNode = { id: bigint; label: string };

/** The board one panel mount shows. A board switch unmounts the panel and mounts it again. */
export type CanvasBoard = {
  id: bigint;
  workspaceId: bigint;
  /** The link in the address bar. On a share-link visit it holds the share token (#s=): treat it as a secret. */
  link: string;
};

export type Canvas = {
  board: CanvasBoard;
  /** The selected nodes, in board order. */
  selectedNodes(): CanvasNode[];
  /** Calls `listener` after every selection change; returns its removal. */
  onSelectionChange(listener: () => void): () => void;
  /** The person's bearer token for the board database (an account's, else this browser's guest token), or null. */
  token(): Promise<string | null>;
  /** This plugin's canvasSettings from plugin.json, each '' when unset. The panel shows only when all are set. */
  settings: Readonly<Record<string, string>>;
};

/** The panel docked on the right of the board. The core owns its launcher button, frame, Close and width. */
export type CanvasPanel = {
  /** The launcher button's text and the panel's title. */
  label: string;
  /** Fills `el` on the first open. Closing only hides the panel; the returned cleanup runs on a
   *  board switch or when the plugin stops being available. On open the core focuses `[autofocus]` in `el`. */
  mount(el: HTMLElement, canvas: Canvas): void | (() => void);
};

/** An agent people talk to in the board's chat panel. The core owns the panel: the transcript, the
 *  message box, the queue, Stop and the launcher. The plugin only carries messages to its agent and back. */
export type CanvasAgent = {
  /** Its name in the chat panel. */
  name: string;
  /** Starts the conversation for the board on screen. A board switch stops it and opens another. */
  open(canvas: Canvas, reply: AgentReply): AgentConversation;
};

/** How a conversation reports the reply to the message it was last sent. */
export type AgentReply = {
  /** More of the reply's text. */
  text(delta: string): void;
  /** What the agent is doing now, in a few words. The step before it counts as done. */
  step(summary: string): void;
  /** The reply ended. Pass a sentence when it failed or was cut short; the panel shows it. */
  done(problem?: string): void;
};

export type AgentConversation = {
  /** One message at a time: the next comes only after `done`. `about` is what the person attached
   *  from their selection, in words. */
  send(text: string, about?: string): void;
  /** Ends the reply under way. Call nothing on `reply` for it afterwards. */
  stop(): void;
  /** Forgets the conversation. Leave it out and the panel offers no "New chat". */
  reset?(): void;
};

/** What a plugin's client/index.ts exports. */
export type CanvasPart = { panel?: CanvasPanel; agent?: CanvasAgent };
