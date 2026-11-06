/** The relay transport owns retries and authentication; the shell owns conversation state. */
export type ChatFrame = Record<string, any>;
export type ConnectionStatus = 'connecting' | 'reconnecting' | 'waiting' | 'syncing' | 'ready' | 'offline';
export const IDLE_REAUTH_MS = 5 * 60_000;

export interface ChatConnectionOptions {
  url: string;
  token(): Promise<string | null>;
  receive(frame: ChatFrame): void;
  status(status: ConnectionStatus, reason?: string): void;
}
export interface ChatConnection {
  start(): void;
  close(): void;
  send(frame: ChatFrame): boolean;
}

export function createChatConnection(opts: ChatConnectionOptions): ChatConnection {
  let socket: WebSocket | null = null;
  let active = false;
  let generation = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let reauth: ReturnType<typeof setTimeout> | undefined;
  let backoff = 2000;
  let refusals = 0;
  let agentPresent = false;

  const retryLater = (reason?: string) => {
    if (!active) return;
    clearTimeout(retry);
    if (reason) refusals++;
    opts.status('reconnecting', refusals >= 3 ? reason : undefined);
    retry = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  };
  const send = (frame: ChatFrame): boolean => {
    if (socket?.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      const failed = socket;
      socket = null;
      clearTimeout(reauth);
      failed.close();
      retryLater();
      return false;
    }
  };
  async function connect(): Promise<void> {
    clearTimeout(retry);
    if (!active || socket) return;
    const attempt = ++generation;
    try {
      const token = await opts.token();
      if (!active || attempt !== generation) return;
      if (!token) return retryLater('Chat needs the board to be connected first.');
      const current = new WebSocket(opts.url);
      socket = current;
      const live = () => active && generation === attempt && socket === current;
      const authenticate = async (sync: boolean) => {
        try {
          const fresh = await opts.token();
          if (!live()) return;
          if (!fresh) throw new Error('Chat needs the board to be connected first.');
          send({ auth: fresh, ...(sync ? { sync } : {}) });
        } catch {
          if (!live()) return;
          socket = null;
          clearTimeout(reauth);
          current.close();
          retryLater('Chat needs the board to be connected first.');
        }
      };
      const scheduleAuth = () => {
        clearTimeout(reauth);
        reauth = setTimeout(() => {
          if (!live()) return;
          void authenticate(false);
          scheduleAuth();
        }, agentPresent ? 30_000 : IDLE_REAUTH_MS);
      };
      let firstStatus = true;
      current.addEventListener('open', () => {
        if (live()) send({ auth: token, role: 'person' });
      });
      current.addEventListener('message', event => {
        if (!live()) return;
        let frame: ChatFrame;
        try { frame = JSON.parse(String(event.data)); } catch { return; }
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return;
        if (frame.ok) {
          backoff = 2000;
          refusals = 0;
          scheduleAuth();
          return;
        }
        if (frame.agent) {
          agentPresent = frame.agent === 'connected';
          opts.status(agentPresent ? 'syncing' : 'waiting');
          if (agentPresent && !firstStatus) void authenticate(true);
          firstStatus = false;
          scheduleAuth();
        }
        opts.receive(frame);
      });
      current.addEventListener('close', event => {
        if (!live()) return;
        socket = null;
        agentPresent = false;
        clearTimeout(reauth);
        retryLater(event.code === 4001 || event.code === 4008 ? event.reason || 'The chat closed.' : undefined);
      });
    } catch {
      if (active && generation === attempt) retryLater('Chat could not connect. Retrying automatically.');
    }
  }
  return {
    start() {
      if (active) return;
      active = true;
      opts.status('connecting');
      void connect();
    },
    close() {
      active = false;
      generation++;
      clearTimeout(retry);
      clearTimeout(reauth);
      const previous = socket;
      socket = null;
      previous?.close();
    },
    send,
  };
}
