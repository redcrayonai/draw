/**
 * The plugin's chat hook: hands one hook's input to this checkout's `redcrayon
 * chat` and prints its answer. Without a running helper it does nothing, so no
 * text leaves the machine until the agent starts a chat. Its own small bundle:
 * MessageDisplay holds each batch of terminal text until this exits.
 */
import { connect } from 'node:net';
import { chatDir, chatSocketPath, removeDeadSockets } from './chat-path';

const WAIT_MS = 2000;

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => (raw += chunk));
process.stdin.on('end', () => {
  let cwd = process.cwd();
  try {
    const input = JSON.parse(raw) as { cwd?: unknown };
    if (typeof input.cwd === 'string') cwd = input.cwd;
  } catch {
    process.exit(0);
  }
  const socket = connect(chatSocketPath(cwd));
  let answer = '';
  const timer = setTimeout(() => process.exit(0), WAIT_MS);
  socket.on('connect', () => socket.write(`${raw.replace(/\n/g, ' ')}\n`));
  socket.on('data', chunk => (answer += chunk.toString()));
  // The shell filter let this hook through, yet this checkout has no helper: heal a dead helper's socket, so the next hooks skip Node.
  socket.on('error', () => void removeDeadSockets(chatDir(), Date.now()).finally(() => process.exit(0)));
  socket.on('close', () => {
    clearTimeout(timer);
    process.stdout.write(answer, () => process.exit(0));
  });
});
