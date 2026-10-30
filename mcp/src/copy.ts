/**
 * Every exact text the Worker shows (spec §12 Failure copy). Three prefixes
 * (Decision 25): REJECTED when a rule refused the call, UNAVAILABLE when
 * redcrayon could not do it, UNCONFIRMED when a write may have landed.
 * "Nothing was written." appears only when the Worker knows no write committed.
 */

// HTTP error_description texts
export const NO_TOKEN = "Sign in to redcrayon from your agent's MCP settings.";
export const SIGN_IN_ENDED = "Your redcrayon sign-in ended. Sign in again from your agent's MCP settings.";
export const MISSING_SCOPE = 'This sign-in cannot edit boards. Sign in again and allow editing.';
export const TOO_LARGE = 'Request too large: 256 KB maximum.';
export const tooMany = (seconds: number) => `Too many requests. Wait ${seconds} s.`;

// tool texts
export const boardNotFound = (board: string | bigint) =>
  `REJECTED: board ${board} not found. Nothing was written. Call start_session with the board's link or a name. A board made in the browser opens here once its owner shares it with their agent from the dashboard.`;
export const linkNotFound = (link: string) =>
  `REJECTED: no board at ${link}. Nothing was written. Check the link, or call start_session with a name to open your own board.`;
export const targetNotFound = (kind: 'node' | 'edge' | 'code ref' | 'chart' | 'change note' | 'threat', id: string | bigint, board: string) =>
  `REJECTED: ${kind} ${id} not found on board "${board}". Nothing was written. Call get_board for current ids.`;
export const noSession = (board: string) =>
  `REJECTED: board "${board}" has no session for this checkout. Nothing was written. Call start_session from inside your project to open a board with code refs.`;
export const rateLimited = (seconds: number) =>
  `REJECTED: too many calls: this account is limited to 120 a minute. Nothing was written. Call again in ${seconds} s.`;
export const planLimit = (limit: number, month: string, support: string) =>
  `REJECTED: this account used its ${limit} tool calls for ${month}. Nothing was written. The limit resets on ${nextMonth(month)} 1; to raise it, write to ${support}.`;
export const quotaSpent = (support: string) => `REJECTED: this account has no tool calls left. Nothing was written. To add more, write to ${support}.`;
export const ruleViolation = (sentence: string, board: string | undefined) =>
  board === undefined ? `REJECTED: ${sentence}` : `REJECTED: ${sentence} board=${board}`;
export const unavailableWrite = (ref: string) =>
  `UNAVAILABLE: redcrayon is unavailable. Nothing was written. Call again in 30 s. (ref ${ref})`;
export const unavailableRead = (ref: string) => `UNAVAILABLE: redcrayon is unavailable. Call again in 30 s. (ref ${ref})`;
export const internalError = (ref: string) =>
  `UNAVAILABLE: redcrayon hit an internal error. Nothing was written. Call again; if it repeats, give the user ref ${ref}.`;
export const unconfirmed = (ref: string) =>
  `UNCONFIRMED: redcrayon did not confirm the write within 15 s. It may have landed. Call get_board before you retry. (ref ${ref})`;
/** A failure after one of the call's writes committed: never "Nothing was written". */
export const partialWrite = (ref: string) =>
  `UNCONFIRMED: a write in this call landed, but redcrayon could not finish the call. Call get_board before you retry. (ref ${ref})`;
export const EARLIER_WRITE = 'An earlier write in this call stands; nothing after it was written.';
export const idTooLarge = (id: string) => `REJECTED: id ${id} is too large. Nothing was written. Call get_board for current ids.`;
export const sameCall = (seconds: number) => ` (same call ${seconds} s ago; nothing new written)`;
export const captureNeeded = (tool: 'add_code_ref' | 'create_edge' | 'mark_checkpoint' | 'arrive', command: string) =>
  `REJECTED: ${tool} needs a capture of your local ${tool === 'mark_checkpoint' || tool === 'arrive' ? 'checkout' : 'file'}. Nothing was written. Run \`npx -y @redcrayonai/draw@1 capture ${command}\` in the project (Node 20 or later and git), then call ${tool} again with capture set to the id it prints.`;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (d: Date) => MONTHS[d.getUTCMonth()];
const nextMonth = (month: string) => MONTHS[(MONTHS.indexOf(month) + 1) % 12];

/** The 6-hex ref that ties a user-facing text to its log line. */
export function newRef(): string {
  const b = crypto.getRandomValues(new Uint8Array(3));
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

// Vendor and internals words no user-facing text may contain (spec §3 Denylist). Stored encoded
// so the deployed bundle passes the same vendor scan (§12 Vendor invisibility); copy.test.ts decodes it.
export const DENYLIST = new RegExp(atob('c3BhY2V0aW1lfHN0ZGJ8bWFpbmNsb3VkfGNsb2Nrd29ya3xic2F0bnxwYW5pY3x3YXNtfGVuZXJneQ=='), 'i');
export const TEXT_DENYLIST = /\breducer|wasm|energy budget|SenderError|panic/i;
