/**
 * "Connect an agent" setup copy (hosted MCP spec §12), one source for the
 * canvas dialog and the dashboard's agent page. Every string is exact;
 * client/src/connect.test.ts pins them. `url` is this deployment's server URL
 * (VITE_MCP_URL), also used by the custom-server launch commands.
 */

export const CONNECT_PROMPT = 'Open a Draw board for this task and draw what you build on it as you go.';

export const CONNECT_FOOTER = [
  'Drawing needs only the URL. To check code refs, redcrayon uploads each file your agent cites and deletes it within 10 minutes. It keeps paths, line numbers, git hashes, hashes of the cited lines and the GitHub repo address. It keeps the cited lines themselves only if you turn on storing code.',
  'Boards your agent opens are private to your account until you share them from your dashboard.',
];

const CURSOR_INSTALL = 'cursor://anysphere.cursor-deeplink/mcp/install?name=draw&config=';

/** A copyable snippet. `label` captions its box; `name` completes "Copy the …". */
export interface GuideBox {
  label: string;
  name: string;
  text: string;
}

/** One numbered step, its parts in display order. */
export interface GuideStep {
  title: string;
  text?: string;
  /** Cursor's one-click install. */
  link?: { text: string; href: string };
  boxes?: GuideBox[];
  note?: string;
  /** Optional setup details, folded away under `summary`. */
  more?: { summary: string; box: GuideBox };
}

export interface GuideTab {
  id: string;
  label: string;
  steps: GuideStep[];
}

/**
 * VITE_MCP_URL as both apps take it: an http(s) URL with the endpoint path
 * (a bare origin fails sign-in: the server's resource is …/mcp), and never a
 * local one in a production build. Anything else reads as unset, which hides
 * the setup.
 */
export function readMcpUrl(value: unknown, production: boolean): string | undefined {
  return typeof value === 'string' &&
    /^https?:\/\/[^/]+\/./.test(value) &&
    !(production && /localhost|127\.0\.0\.1/.test(value))
    ? value
    : undefined;
}

/** base64 of the UTF-8 bytes: plain btoa() throws on non-Latin-1 text. */
export function base64Utf8(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

/** URL-encoded, or a '+' in the base64 reaches Cursor as a space. */
export function cursorInstallUrl(url: string): string {
  return CURSOR_INSTALL + encodeURIComponent(base64Utf8(JSON.stringify({ url })));
}

export function connectGuide(url: string): GuideTab[] {
  const json = JSON.stringify({ mcpServers: { draw: { url } } }, null, 2);
  const urlBox = { label: 'url', name: 'server URL', text: url };
  const serverLaunch = (agent: string) => ({
    summary: 'Using your own server? Start here instead',
    box: { label: 'macOS / Linux terminal', name: 'custom server command', text: `REDCRAYON_MCP_URL='${url.replaceAll("'", "'\\''")}' ${agent}` },
  });
  const draw = (note?: string): GuideStep => ({
    title: 'Start drawing',
    boxes: [{ label: 'prompt', name: 'prompt', text: CONNECT_PROMPT }],
    note,
  });
  return [
    {
      id: 'claude',
      label: 'Claude Code',
      steps: [
        {
          title: 'Install the plugin',
          boxes: [{ label: 'terminal', name: 'install command', text: 'claude plugin marketplace add redcrayonai/draw && claude plugin install draw@redcrayonai' }],
          note: 'Includes drawing skills, automatic code refs, and board chat support.',
        },
        {
          title: 'Sign in',
          text: 'Start a new Claude Code session in your project, run /mcp, choose draw, then Authenticate. Approve in the browser tab that opens.',
          more: serverLaunch('claude'),
        },
        {
          title: 'Open your board',
          boxes: [{ label: 'Claude Code', name: 'drawing command', text: '/draw:navigate' }],
          note: 'Open the board link to continue in private chat. Board chat needs Node 22+ and a Claude Code version supporting MessageDisplay and asyncRewake hooks.',
        },
      ],
    },
    {
      id: 'cursor',
      label: 'Cursor',
      steps: [
        {
          title: 'Add the server',
          link: { text: 'add to Cursor', href: cursorInstallUrl(url) },
          note: 'Opens Cursor and asks you to confirm.',
          more: {
            summary: 'Or paste it into ~/.cursor/mcp.json',
            box: { label: '~/.cursor/mcp.json', name: 'Cursor config', text: json },
          },
        },
        {
          title: 'Sign in',
          text: 'In Cursor Settings → MCP, draw shows a login button. Click it and approve in the browser.',
        },
        draw(),
      ],
    },
    {
      id: 'codex',
      label: 'Codex',
      steps: [
        {
          title: 'Install the plugin',
          boxes: [{ label: 'terminal', name: 'install command', text: 'codex plugin marketplace add redcrayonai/draw && codex plugin add draw@redcrayonai' }],
          note: 'Requires a Codex version with plugin support. After adding the marketplace, you can also install Draw from /plugins.',
        },
        {
          title: 'Sign in',
          text: 'Start a new Codex session in your project. When Draw asks you to connect, approve in the browser with the account you use for your boards.',
          more: serverLaunch('codex'),
        },
        draw('Open the board link. Private chat needs Node 22+ and access to the same Codex conversation through a shared app server. If chat cannot attach, keep chatting in Codex; drawing still works.'),
      ],
    },
    {
      id: 'claude-ai',
      label: 'claude.ai',
      steps: [
        {
          title: 'Add the connector',
          text: 'In claude.ai: Customize → Connectors → Add custom connector. Name it draw and paste this URL.',
          boxes: [urlBox],
          note: 'On Team and Enterprise plans an owner adds it once for everyone.',
        },
        { title: 'Sign in', text: 'Click Connect next to draw and approve in the tab that opens.' },
        draw('claude.ai draws from the conversation. Code refs and checkpoints need a coding agent in your project.'),
      ],
    },
    {
      id: 'other',
      label: 'Other',
      steps: [
        {
          title: 'Add the server',
          boxes: [urlBox, { label: 'mcp.json', name: 'mcp.json config', text: json }],
          note: 'Any MCP client with remote servers and sign-in. VS Code uses "servers" and "type": "http".',
        },
        { title: 'Sign in', text: 'Your client opens a browser to sign in the first time it connects.' },
        draw(),
      ],
    },
  ];
}
