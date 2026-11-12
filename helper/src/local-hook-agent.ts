import { randomUUID } from 'node:crypto';
import type { ChatEvent, ChatSession } from '../../shared/chat';

type Delivery = { type: 'message'; id: string; text: string } | { type: 'stop' | 'replaced' };
/** A local hook/extension transports the existing chat contract into its own running session. */
export class LocalHookAgent {
  readonly session: ChatSession;
  private waiting?: (value: Delivery | null) => void;
  private pending?: { delivery: Delivery; dispatched: boolean; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
  private stopping = false;
  private stopRequested = false;
  private closed = false;
  private lease: ReturnType<typeof setTimeout>;
  constructor(agent: 'claude-code' | 'pi', threadId: string, private emit: (event: ChatEvent) => void, private disconnected: () => void) {
    this.session = { id: `${agent}:${threadId}`, agent, name: agent === 'pi' ? 'pi' : 'Claude Code', capabilities: { stop: agent === 'pi' ? 'interrupt' : 'step', approvals: false } };
    this.lease = setTimeout(() => this.disconnect(), 45000); this.lease.unref();
    emit({ type: 'state', state: 'idle' });
  }
  disconnect() { if (this.closed) return; this.close(); this.disconnected(); }
  async poll(): Promise<Delivery | null> {
    if (this.closed) throw new Error('UNAVAILABLE: reconnect the agent hook');
    this.lease.refresh();
    if (this.stopping) { this.stopping = false; return { type: 'stop' }; }
    if (this.pending && !this.pending.dispatched) { this.pending.dispatched = true; return this.pending.delivery; }
    this.waiting?.({ type: 'replaced' });
    return new Promise(resolve => {
      const timer = setTimeout(() => finish(null), 20000);
      const finish = (value: Delivery | null) => { clearTimeout(timer); if (this.waiting === finish) this.waiting = undefined; resolve(value); };
      this.waiting = finish;
    });
  }
  send(text: string): Promise<void> {
    if (this.closed || this.pending) return Promise.reject(new Error('UNAVAILABLE: agent hook is busy or disconnected'));
    this.stopRequested = false; this.stopping = false;
    return new Promise((resolve, reject) => {
      const delivery: Delivery = { type: 'message', id: randomUUID(), text };
      const timer = setTimeout(() => { this.pending = undefined; reject(new Error('UNCONFIRMED: agent did not acknowledge delivery; check its terminal')); }, 25000);
      this.pending = { delivery, dispatched: false, resolve, reject, timer };
      if (this.waiting) { this.pending.dispatched = true; this.waiting(delivery); }
    });
  }
  claudeHook(input: Record<string, unknown>) {
    if (this.closed || this.session.agent !== 'claude-code' || !input || typeof input !== 'object') throw new Error('REJECTED: wrong agent hook');
    this.lease.refresh();
    if (this.pending?.delivery.type === 'message' && Array.isArray(input.received) && input.received.includes(this.pending.delivery.id)) this.acknowledge(this.pending.delivery.id);
    if (input.hook_event_name === 'UserPromptSubmit') {
      const prompt = typeof input.prompt === 'string' ? input.prompt : '';
      const delivery = /^Board chat \[([a-f0-9-]+)\]:/.exec(prompt);
      if (delivery && this.pending?.delivery.type === 'message' && this.pending.delivery.id === delivery[1]) this.acknowledge(delivery[1]);
      this.stopRequested = false; this.emit({ type: 'state', state: 'working' });
    }
    if (input.hook_event_name === 'PreToolUse') {
      if (this.stopRequested) return { continue: false, stopReason: 'Stopped from the board. Wait for the user’s next instruction.' };
      this.emit({ type: 'state', state: 'working' });
    }
    if (input.hook_event_name === 'Stop') {
      if (typeof input.last_assistant_message === 'string' && input.last_assistant_message) this.emit({ type: 'text', message: randomUUID(), delta: input.last_assistant_message.slice(0, 256000), final: !this.stopRequested });
      this.emit({ type: 'state', state: this.stopRequested ? 'stopped' : 'idle' });
    }
    if (input.hook_event_name === 'SessionEnd') this.disconnect();
    return {};
  }
  acknowledge(id: string) {
    const pending = this.pending;
    if (!pending || pending.delivery.type !== 'message' || pending.delivery.id !== id || !pending.dispatched) throw new Error('UNCONFIRMED: delivery acknowledgement is no longer pending');
    clearTimeout(pending.timer); this.pending = undefined; pending.resolve();
  }
  event(value: ChatEvent) {
    if (this.closed || !value || typeof value !== 'object') throw new Error('REJECTED: invalid agent event');
    this.lease.refresh();
    if (value.type === 'state' && ['idle', 'working', 'stopping', 'stopped'].includes(value.state)) this.emit(value);
    else if (value.type === 'text' && typeof value.message === 'string' && value.message.length <= 200 && typeof value.delta === 'string' && value.delta.length <= 256000 && typeof value.final === 'boolean') this.emit(value);
    else throw new Error('REJECTED: unsupported agent event');
  }
  async stop() {
    this.stopping = true; this.stopRequested = true;
    const unsent = this.pending && !this.pending.dispatched;
    if (unsent) {
      clearTimeout(this.pending!.timer); this.pending!.reject(new Error('UNCONFIRMED: delivery stopped before acknowledgement')); this.pending = undefined;
    }
    this.emit({ type: 'state', state: unsent ? 'stopped' : 'stopping' });
    if (this.waiting) { this.stopping = false; this.waiting({ type: 'stop' }); }
  }
  async approve() { throw new Error('UNAVAILABLE: handle approvals in the agent terminal'); }
  close() {
    if (this.closed) return; this.closed = true; clearTimeout(this.lease); this.waiting?.(null);
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error('UNCONFIRMED: agent hook disconnected')); this.pending = undefined; }
  }
}
