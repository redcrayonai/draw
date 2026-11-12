import { createServer, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { LocalStore, atomicWrite } from './local-store';
import { isSecretFile, pathProblem } from '../../shared/capture';
import { readSource } from '../../agent/src/local-deps';
import { gitIsCitable } from '../../agent/src/git';
import { boardHref } from '../../shared/board-link';
import { LocalChat } from './local-chat';
import { LocalActivity } from './local-activity';

const unavailable = (message: string): never => { throw new Error(`UNAVAILABLE: ${message}`); };
export const MAX_LOCAL_VIEWER_BYTES = 4 * 1024 * 1024;
export function sendLocalEvent(response: Pick<ServerResponse, 'writableLength' | 'write' | 'destroy'>, frame: string) {
  if (response.writableLength + Buffer.byteLength(frame) > MAX_LOCAL_VIEWER_BYTES) { response.destroy(); return false; }
  response.write(frame);
  return true;
}
export async function startLocal(options: { repo: string; directory: string; assets: string; port?: number }) {
  const repo = realpathSync(options.repo);
  const store = new LocalStore(options.directory);
  const token = randomBytes(32).toString('hex');
  const viewers = new Map<ServerResponse, string>();
  const activities = new Map<string, LocalActivity>();
  let origin = '';
  const withLink = (board: ReturnType<LocalStore['read']>) => ({ ...board, url: `${boardHref({ app: origin, slug: board.slug, db: 'local', home: 'local' })}&key=${token}` });
  function broadcast(slug: string) {
    const frame = `data: ${JSON.stringify(store.read(slug))}\n\nevent: chat\ndata: ${JSON.stringify(chat.status(slug))}\n\n`;
    for (const [response, board] of viewers) {
      if (board === slug && !sendLocalEvent(response, frame)) viewers.delete(response);
    }
  }
  const chat = new LocalChat(store, broadcast);
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    try {
      if (`http://${request.headers.host}` !== origin || (request.headers.origin && request.headers.origin !== origin) || request.headers['sec-fetch-site'] === 'cross-site') {
        response.writeHead(403); response.end('REJECTED: untrusted local request'); return;
      }
      const url = new URL(request.url!, origin);
      const authorized = request.headers.authorization === `Bearer ${token}` || request.headers.cookie?.split(';').some(c => c.trim() === `draw_local=${token}`);
      if (url.pathname.startsWith('/api/')) {
        if (!authorized) { response.writeHead(401); response.end('REJECTED: open the startup link to connect'); return; }
        if (url.pathname === '/api/events' && request.method === 'GET') {
          const slug = url.searchParams.get('board') ?? '';
          const board = store.read(slug);
          if (viewers.size >= 32) unavailable('too many open viewers');
          response.writeHead(200, { 'Content-Type': 'text/event-stream' });
          sendLocalEvent(response, `data: ${JSON.stringify(board)}\n\n`);
          sendLocalEvent(response, `event: chat\ndata: ${JSON.stringify(chat.status(slug))}\n\n`);
          if (activities.has(slug)) sendLocalEvent(response, `event: activity\ndata: ${JSON.stringify(activities.get(slug)!.snapshot())}\n\n`);
          viewers.set(response, slug);
          response.on('close', () => viewers.delete(response));
          return;
        }
        if (request.method !== 'POST' || url.pathname !== '/api/call') { response.writeHead(404); response.end(); return; }
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 1024 * 1024) { response.writeHead(413); response.end('REJECTED: request too large'); request.destroy(); return; }
          chunks.push(chunk);
        }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!input || typeof input !== 'object') unavailable('invalid request');
        let result: unknown;
        switch (input.action) {
          case 'list_boards': result = store.list(); break;
          case 'open_board': result = withLink(store.create(input.name, repo)); break;
          case 'read_board': result = withLink(store.read(input.board)); break;
          case 'apply_board': result = store.mutate(input.board, input.revision, input.operations); broadcast(input.board); break;
          case 'attach_conversation': result = await chat.attach(input.board, input.threadId, input.socketPath); break;
          case 'connect_local_agent':
            if (!['claude-code', 'pi'].includes(input.agent)) throw new Error('REJECTED: unsupported local agent');
            result = await chat.attach(input.board, input.threadId, undefined, input.agent, input.cwd); break;
          case 'disconnect_local_agent': chat.hook(input.board, input.session).disconnect(); result = {}; break;
          case 'poll_local_agent': result = await chat.hook(input.board, input.session).poll(); break;
          case 'ack_local_agent': chat.hook(input.board, input.session).acknowledge(input.id); result = {}; break;
          case 'local_agent_event': chat.hook(input.board, input.session).event(input.event); result = {}; break;
          case 'claude_local_hook': result = chat.hook(input.board, input.session).claudeHook(input.hook); break;
          case 'send_feedback': result = await chat.send(input.board, input.id, input.text, input.selected ?? []); break;
          case 'chat_status': store.read(input.board); result = chat.status(input.board); break;
          case 'stop_agent': await chat.stop(input.board); result = {}; break;
          case 'approve_agent': await chat.approve(input.board, input.id, input.decision); result = {}; break;
          case 'activity': {
            const board = store.read(input.board);
            let activity = activities.get(board.slug);
            if (!activity) {
              if (activities.size >= 32) unavailable('activity board limit reached; restart the local server');
              activity = new LocalActivity(window => {
                const frame = `event: activity\ndata: ${JSON.stringify(window)}\n\n`;
                for (const [response, slug] of viewers) if (slug === board.slug && !sendLocalEvent(response, frame)) viewers.delete(response);
              });
              activities.set(board.slug, activity);
            }
            result = activity.accept(board, input.mapping, input.events);
            if (input.flush === true) activity.flush();
            break;
          }
          case 'read_code': {
            const board = store.read(input.board);
            const ref = input.ref;
            if (!ref || pathProblem(ref.path) || isSecretFile(ref.path) || !Number.isSafeInteger(ref.start) || !Number.isSafeInteger(ref.end) || ref.start < 1 || ref.end < ref.start || ref.end - ref.start > 1000) unavailable('invalid or protected code reference');
            const source = readSource(board.repo, ref.path);
            if (isSecretFile(source.rel) || !gitIsCitable(board.repo, source.rel)) unavailable('this file is protected or ignored');
            if (ref.end > source.lines.length) unavailable('code range extends beyond the file');
            result = { path: source.rel, start: ref.start, text: source.lines.slice(ref.start - 1, ref.end).join('\n') };
            break;
          }
          default: unavailable('unsupported local operation');
        }
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result));
        return;
      }
      if (url.pathname === '/session' && request.method === 'POST') {
        if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401); response.end(); return; }
        response.setHeader('Set-Cookie', `draw_local=${token}; HttpOnly; SameSite=Strict; Path=/`);
        response.writeHead(204); response.end(); return;
      }
      if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
      const asset = url.pathname === '/' ? 'local.html' : decodeURIComponent(url.pathname.slice(1));
      if (asset !== 'local.html' && !asset.startsWith('assets/')) { response.writeHead(404); response.end(); return; }
      const root = realpathSync(options.assets);
      const file = realpathSync(resolve(root, asset));
      const rel = relative(root, file);
      if (rel.startsWith(`..${sep}`) || rel === '..' || !statSync(file).isFile()) unavailable('asset does not exist');
      const mime = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': mime }); response.end(readFileSync(file));
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error && /^(REJECTED|UNAVAILABLE|UNCONFIRMED):/.test(error.message) ? error.message : 'UNAVAILABLE: local request failed; check the path or input and try again.' }));
    }
  });
  server.requestTimeout = 15000;
  server.maxConnections = 64;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('UNAVAILABLE: could not start local listener');
    origin = `http://127.0.0.1:${address.port}`;
    const discovery = join(options.directory, 'endpoint.json');
    atomicWrite(discovery, JSON.stringify({ origin, token, repo, pid: process.pid }));
    const heartbeat = setInterval(() => {
      for (const response of viewers.keys()) if (!sendLocalEvent(response, ': heartbeat\n\n')) viewers.delete(response);
    }, 15000);
    heartbeat.unref();
    const trafficTimer = setInterval(() => { for (const activity of activities.values()) activity.flush(); }, 1000);
    trafficTimer.unref();
    return { origin, token, store, url: `${store.list()[0] ? boardHref({ app: origin, slug: store.list()[0].slug, db: 'local', home: 'local' }) : `${origin}/#local`}&key=${token}`, close: async () => {
      clearInterval(heartbeat);
      clearInterval(trafficTimer);
      chat.close();
      for (const response of viewers.keys()) response.destroy();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      try { if (existsSync(discovery)) unlinkSync(discovery); } finally { store.close(); }
    } };
  } catch (error) { server.close(); store.close(); throw error; }
}
