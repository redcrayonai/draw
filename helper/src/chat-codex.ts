import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Duplex, Readable, Writable } from 'node:stream';
import WebSocket from 'ws';
import type { ApprovalDecision, ChatEvent, ChatSession, ChatState } from '../../shared/chat';

type Frame = Record<string, any>;
type PendingApproval = { requestId: string | number; turnId: string; itemId: string; summary: string; decisions: string[] };
const REQUEST_MS = 30_000;
const MAX_FRAME = 32 * 1024 * 1024;
const summaries: Record<string, string> = {
  commandExecution: 'Run a command', fileChange: 'Change files', mcpToolCall: 'Use a connected tool',
  dynamicToolCall: 'Use a tool', collabToolCall: 'Work with another agent', webSearch: 'Search the web',
  imageView: 'View an image', contextCompaction: 'Compact conversation history',
};

/** Attach to an already loaded thread: never create a server, a thread, or another execution session. */
export async function connectCodex(options: {
  threadId: string; cwd: string; socketPath?: string; emit: (event: ChatEvent) => void; onDisconnect?: () => void; signal?: AbortSignal;
}): Promise<{
  session: ChatSession; send(text: string): Promise<void>; stop(): Promise<void>;
  approve(id: string, decision: ApprovalDecision): Promise<void>; close(): void;
}> {
  const { threadId, emit } = options;
  if (options.signal?.aborted) throw new Error('UNAVAILABLE: the conversation connection was cancelled.');
  if (!threadId.trim()) throw new Error('UNAVAILABLE: choose the existing terminal thread to connect.');
  const cwd = realpathSync(options.cwd);
  const child = spawn('codex', ['app-server', 'proxy', ...(options.socketPath ? ['--sock', options.socketPath] : [])], {
    cwd, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const transport = new WebSocket('ws://localhost', {
    createConnection: () => Duplex.fromWeb({ readable: Readable.toWeb(child.stdout), writable: Writable.toWeb(child.stdin) }),
    handshakeTimeout: REQUEST_MS, maxPayload: MAX_FRAME, perMessageDeflate: false,
  });
  let closed = false;
  let ready = false;
  let sequence = 0;
  let state: ChatState = 'idle';
  let activeTurn: string | undefined;
  let sending: Promise<void> | undefined;
  const requests = new Map<string, { resolve(value: Frame): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const approvals = new Map<string, PendingApproval>();
  const fileChanges = new Map<string, string[]>();
  const text = new Map<string, string>();
  const completed = new Set<string>();
  const users = new Set<string>();
  const boardTurns = new Set<string>();
  const finishedTurns = new Set<string>();
  const historyOverlap = new Set<string>();
  // Bound replay protection to the recent history window (20 turns x 200 items).
  const remember = (seen: Set<string>, id: string) => {
    seen.add(id);
    if (seen.size > 4000) seen.delete(seen.values().next().value!);
  };
  let deferredUsers: Frame[] = [];
  let buffered: Frame[] = [];
  const setState = (next: ChatState) => { state = next; emit({ type: 'state', state }); };
  const resolveApproval = (id: string) => {
    const approval = approvals.get(id);
    if (!approval) return;
    approvals.delete(id);
    emit({ type: 'approval', id, summary: approval.summary, status: 'resolved' });
  };
  const clearApprovals = (turnId?: string, itemId?: string) => {
    for (const [id, approval] of approvals) {
      if ((!turnId || approval.turnId === turnId) && (!itemId || approval.itemId === itemId)) resolveApproval(id);
    }
  };
  const abort = () => close();
  const close = (reason?: string) => {
    if (closed) return;
    closed = true;
    options.signal?.removeEventListener('abort', abort);
    transport.terminate();
    child.stdin.destroy();
    child.kill(); // Only this stdio proxy belongs to us; the daemon and terminal keep running.
    for (const request of requests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(reason ?? 'UNAVAILABLE: the conversation connection closed.'));
    }
    requests.clear();
    clearApprovals();
    if (reason) {
      emit({ type: 'notice', tone: 'attention', text: reason });
      setState('stopped');
      options.onDisconnect?.();
    }
  };
  const disconnected = () => close('UNAVAILABLE: the terminal connection was lost. Check the terminal before sending again.');
  const write = (frame: Frame) => {
    if (closed) throw new Error('UNAVAILABLE: reconnect to the terminal conversation.');
    transport.send(JSON.stringify(frame));
  };
  const rpc = (method: string, params: Frame): Promise<Frame> => new Promise((resolve, reject) => {
    if (closed) return reject(new Error('UNAVAILABLE: reconnect to the terminal conversation.'));
    const id = `board-${++sequence}`;
    const timer = setTimeout(() => close('UNCONFIRMED: the terminal did not acknowledge the request. Check it before retrying.'), REQUEST_MS);
    timer.unref();
    requests.set(id, { resolve, reject, timer });
    try { write({ id, method, params }); } catch { disconnected(); }
  });
  const item = (value: Frame, turnId: string, done: boolean) => {
    if (typeof value.id !== 'string') return;
    const id = value.id;
    if (value.type === 'fileChange' && Array.isArray(value.changes)) {
      fileChanges.set(id, value.changes.flatMap((change: Frame) => typeof change.path === 'string' ? [change.path] : []));
    }
    if (value.type === 'userMessage') {
      if (sending) { deferredUsers.push({ item: value, turnId }); return; }
      if (users.has(id)) return;
      remember(users, id);
      if (boardTurns.has(turnId)) return;
      const content = Array.isArray(value.content) ? value.content : [];
      const prompt = content.filter((part: Frame) => part.type === 'text' && typeof part.text === 'string').map((part: Frame) => part.text).join('\n');
      if (prompt) emit({ type: 'user', id, text: prompt, origin: 'terminal' });
    } else if (value.type === 'agentMessage') {
      if (completed.has(id)) return;
      const whole = typeof value.text === 'string' ? value.text : '';
      const previous = text.get(id) ?? '';
      // Completion is authoritative; history and live updates may overlap during attachment.
      const delta = whole.startsWith(previous) ? whole.slice(previous.length) : '';
      text.set(id, whole.startsWith(previous) ? whole : previous);
      if (delta || done) emit({ type: 'text', message: id, delta, final: done });
      if (done) { remember(completed, id); historyOverlap.delete(id); text.delete(id); }
    } else if (summaries[value.type]) {
      emit({ type: 'tool', id, phase: done ? 'done' : 'start', summary: summaries[value.type] });
    }
    if (done) { clearApprovals(turnId, id); fileChanges.delete(id); }
  };
  const handle = (frame: Frame) => {
    const p = frame.params;
    if (!p || p.threadId !== threadId) return;
    if (frame.id !== undefined) {
      const command = frame.method === 'item/commandExecution/requestApproval';
      const file = frame.method === 'item/fileChange/requestApproval';
      if (!command && !file) {
        emit({ type: 'notice', tone: 'attention', text: 'Your agent needs input in the terminal.' });
        return;
      }
      if ((typeof frame.id !== 'string' && typeof frame.id !== 'number') || typeof p.turnId !== 'string' || typeof p.itemId !== 'string') return;
      if (p.turnId !== activeTurn || [...approvals.values()].some(approval => approval.requestId === frame.id)) return;
      const id = `approval-${randomUUID()}`;
      const workingDirectory = typeof p.cwd === 'string' ? p.cwd : cwd;
      const files = fileChanges.get(p.itemId) ?? [];
      const summary = file
        ? `Allow file changes in ${workingDirectory}?\n${files.length ? files.join('\n') : 'Review the changes in your terminal.'}${typeof p.grantRoot === 'string' ? `\nRequested write root for this session: ${p.grantRoot}` : ''}`
        : p.networkApprovalContext
          ? `Allow network access to ${p.networkApprovalContext.host ?? 'the requested host'} (${p.networkApprovalContext.protocol ?? 'network'}) from ${workingDirectory}?`
          : `Allow this command in ${workingDirectory}?\n${typeof p.command === 'string' ? p.command : 'Review the command in your terminal.'}`;
      approvals.set(id, { requestId: frame.id, turnId: p.turnId, itemId: p.itemId, summary,
        decisions: Array.isArray(p.availableDecisions) ? p.availableDecisions : ['accept', 'decline'] });
      emit({ type: 'approval', id, summary, status: 'pending' });
      return;
    }
    switch (frame.method) {
      case 'turn/started':
        if (typeof p.turn?.id !== 'string') return;
        activeTurn = p.turn.id;
        setState('working');
        break;
      case 'turn/completed': {
        if (typeof p.turn?.id !== 'string') return;
        clearApprovals(p.turn.id);
        if (sending) finishedTurns.add(p.turn.id);
        if (activeTurn && p.turn.id !== activeTurn) return;
        activeTurn = undefined;
        const uncertain = new Map([...text].filter(([id]) => historyOverlap.delete(id)));
        if (uncertain.size) {
          // Delta notifications have no offsets. Read authoritative text after an interrupted
          // turn instead of guessing which buffered suffix was already in attachment history.
          void rpc('thread/turns/list', { threadId, limit: 20, sortDirection: 'desc', itemsView: 'full' }).then(history => {
            if (closed) return;
            const items = history.data?.find((turn: Frame) => turn.id === p.turn.id)?.items ?? [];
            for (const [message, previous] of uncertain) {
              const whole = items.find((entry: Frame) => entry.id === message)?.text;
              if (typeof whole !== 'string' || !whole.startsWith(previous)) throw new Error('Incomplete reply history');
              emit({ type: 'text', message, delta: whole.slice(previous.length), final: true });
            }
          }).catch(() => {
            if (closed) return;
            for (const message of uncertain.keys()) emit({ type: 'text', message, delta: '', final: true });
            emit({ type: 'notice', tone: 'attention', text: 'Could not restore the end of this reply. Check the terminal.' });
          });
        }
        for (const message of text.keys()) {
          if (!uncertain.has(message)) emit({ type: 'text', message, delta: '', final: true });
          remember(completed, message);
        }
        text.clear();
        if (p.turn.status === 'failed') emit({ type: 'notice', tone: 'attention', text: 'The agent could not finish this turn. Check the terminal for details.' });
        setState(p.turn.status === 'interrupted' ? 'stopped' : 'idle');
        break;
      }
      case 'thread/status/changed':
        if (p.status?.type === 'active') { if (state !== 'stopping') setState('working'); }
        else if (p.status?.type === 'idle') { activeTurn = undefined; clearApprovals(); if (state !== 'stopping' && state !== 'stopped') setState('idle'); }
        else if (p.status?.type === 'notLoaded' || p.status?.type === 'systemError') disconnected();
        break;
      case 'item/started': case 'item/completed':
        if (p.item && typeof p.turnId === 'string') item(p.item, p.turnId, frame.method === 'item/completed');
        break;
      case 'item/agentMessage/delta':
        if (typeof p.itemId !== 'string' || typeof p.delta !== 'string' || completed.has(p.itemId) || historyOverlap.has(p.itemId)) return;
        text.set(p.itemId, (text.get(p.itemId) ?? '') + p.delta);
        emit({ type: 'text', message: p.itemId, delta: p.delta, final: false });
        break;
      case 'serverRequest/resolved':
        for (const [id, approval] of approvals) if (approval.requestId === p.requestId) resolveApproval(id);
        break;
      case 'thread/closed': disconnected(); break;
      case 'error':
        emit({ type: 'notice', tone: 'attention', text: p.willRetry ? 'The agent encountered a problem and is retrying.' : 'The agent encountered a problem. Check the terminal for details.' });
        break;
    }
  };
  child.on('error', disconnected);
  child.on('exit', disconnected);
  child.stdin.on('error', disconnected);
  child.stdout.on('error', disconnected);
  child.stdout.on('end', disconnected);
  transport.on('error', disconnected);
  transport.on('close', disconnected);
  transport.on('message', (data, isBinary) => {
    if (closed) return;
    if (isBinary) return close('UNAVAILABLE: the terminal sent an invalid response.');
    let frame: Frame;
    try { frame = JSON.parse(data.toString()); } catch { return close('UNAVAILABLE: the terminal sent an invalid response.'); }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return disconnected();
    if (!frame.method && typeof frame.id === 'string') {
      const pending = requests.get(frame.id);
      if (!pending) return;
      requests.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.error) pending.reject(new Error('UNAVAILABLE: the terminal rejected the request. Check the terminal for details.'));
      else if (frame.result && typeof frame.result === 'object') pending.resolve(frame.result);
      else pending.reject(new Error('UNAVAILABLE: the terminal sent an invalid response.'));
    } else if (ready) handle(frame);
    else {
      if (buffered.length >= 2000) return close('UNAVAILABLE: too many terminal updates arrived while connecting.');
      buffered.push(frame);
    }
  });
  const validate = (thread: Frame) => {
    if (thread?.id !== threadId || typeof thread.cwd !== 'string' || realpathSync(thread.cwd) !== cwd) {
      throw new Error('UNAVAILABLE: the terminal conversation belongs to another working directory.');
    }
    if (thread.status?.type !== 'idle' && thread.status?.type !== 'active') {
      throw new Error('UNAVAILABLE: this thread is not running in the shared app server. Connect the terminal to that server first.');
    }
  };
  try {
    if (options.signal?.aborted) throw new Error('UNAVAILABLE: the conversation connection was cancelled.');
    options.signal?.addEventListener('abort', abort, { once: true });
    await new Promise<void>((resolve, reject) => {
      transport.once('open', resolve);
      transport.once('error', () => reject(new Error('UNAVAILABLE: could not connect to the terminal app server.')));
      transport.once('close', () => reject(new Error('UNAVAILABLE: the terminal connection closed.')));
    });
    await rpc('initialize', { clientInfo: { name: 'redcrayon', title: 'Board chat', version: '1.0.0' } });
    write({ method: 'initialized', params: {} });
    const read = await rpc('thread/read', { threadId });
    validate(read.thread);
    const resumed = await rpc('thread/resume', { threadId, excludeTurns: true });
    validate(resumed.thread);
    const history = await rpc('thread/turns/list', { threadId, limit: 20, sortDirection: 'desc', itemsView: 'full' });
    if (closed) throw new Error('UNAVAILABLE: the terminal connection closed while connecting.');
    if (!Array.isArray(history.data)) throw new Error('UNAVAILABLE: the terminal sent invalid conversation history.');
    const historyIds = new Set<string>();
    for (const turn of [...history.data].reverse()) {
      if (typeof turn.id !== 'string' || !Array.isArray(turn.items)) continue;
      if (turn.status === 'inProgress') activeTurn = turn.id;
      for (const entry of turn.items.slice(-200)) {
        historyIds.add(entry.id);
        item(entry, turn.id, turn.status !== 'inProgress');
      }
    }
    setState(activeTurn || resumed.thread.status.type === 'active' ? 'working' : 'idle');
    ready = true;
    // Buffered deltas may already be in history; completion fills any missing suffix.
    for (const frame of buffered) {
      if (frame.method === 'item/agentMessage/delta' && historyIds.has(frame.params?.itemId)) {
        if (text.has(frame.params.itemId)) historyOverlap.add(frame.params.itemId);
        continue;
      }
      handle(frame);
    }
    buffered = [];
    if (closed) throw new Error('UNAVAILABLE: the terminal connection closed while connecting.');
    const session: ChatSession = { id: `codex:${threadId}`, agent: 'codex', name: 'Codex', capabilities: { stop: 'interrupt', approvals: true, end: true } };
    return {
      session,
      send(prompt) {
        if (closed) return Promise.reject(new Error('UNAVAILABLE: reconnect to the terminal conversation.'));
        if (!prompt.trim()) return Promise.reject(new Error('UNAVAILABLE: enter a message to send.'));
        if (sending || activeTurn || state === 'working' || state === 'stopping') return Promise.reject(new Error('UNAVAILABLE: wait for the current turn to finish.'));
        setState('working');
        sending = (async () => {
          try {
            const result = await rpc('turn/start', { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }] });
            if (typeof result.turn?.id !== 'string') throw new Error('UNCONFIRMED: the terminal did not identify the new turn. Check it before retrying.');
            remember(boardTurns, result.turn.id);
            if (result.turn.status === 'inProgress' && !finishedTurns.has(result.turn.id)) activeTurn = result.turn.id;
          } catch (error) {
            if (!closed && !activeTurn) setState('idle');
            throw error;
          } finally {
            sending = undefined;
            finishedTurns.clear();
            const queued = deferredUsers;
            deferredUsers = [];
            for (const entry of queued) item(entry.item, entry.turnId, true);
          }
        })();
        return sending;
      },
      async stop() {
        if (sending) await sending;
        if (closed) throw new Error('UNAVAILABLE: reconnect to the terminal conversation.');
        if (!activeTurn) {
          if (state === 'working') throw new Error('UNAVAILABLE: the active turn is not yet known. Stop it in the terminal.');
          setState('stopped');
          return;
        }
        setState('stopping');
        try { await rpc('turn/interrupt', { threadId, turnId: activeTurn }); }
        catch (error) { if (!closed && activeTurn) setState('working'); throw error; }
      },
      async approve(id, decision) {
        const approval = approvals.get(id);
        const answer = decision === 'decline' && approval?.decisions.includes('cancel') && !approval.decisions.includes('decline') ? 'cancel' : decision;
        if (closed || !approval || (decision !== 'accept' && decision !== 'decline') || !approval.decisions.includes(answer)) {
          throw new Error('UNAVAILABLE: that approval is no longer pending or that decision is not offered.');
        }
        write({ id: approval.requestId, result: { decision: answer } });
        if (answer === 'cancel') emit({ type: 'notice', text: 'Declined. The agent will stop this turn.' });
        resolveApproval(id);
      },
      close: () => close(),
    };
  } catch (error) { close(); throw error; }
}
