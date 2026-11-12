import type { LocalBoard } from '../../shared/local';
import type { ChatSession } from '../../shared/chat';

type Status = { connected: boolean; connecting: boolean; state: string; error?: string; session?: ChatSession; approvals: { id: string; summary: string }[] };
export function mountLocalChat(container: HTMLElement, read: () => LocalBoard | undefined, selected: () => string[], call: (input: unknown) => Promise<unknown>, report: (message: string) => void) {
  const section = document.createElement('section');
  section.innerHTML = `<p role="status" data-connection>Disconnected</p><details data-connection-settings><summary>Connection settings</summary><p data-session class="local-session"></p><form data-attach><label>Existing Codex thread ID<input name="threadId" required></label><label>Control socket (optional)<input name="socketPath" placeholder="/absolute/path/to/socket"></label><button>Connect Codex</button></form><p>Claude Code and pi connect through their local hook or extension. Approvals stay in their terminal.</p></details><button type="button" data-stop>Stop agent</button><div data-approvals></div><div data-messages></div><form data-send><label>Message to your agent<textarea name="text" placeholder="Ask about this board…" required></textarea></label><button>Send feedback</button></form>`;
  container.append(section);
  const attach = section.querySelector<HTMLFormElement>('[data-attach]')!;
  const send = section.querySelector<HTMLFormElement>('[data-send]')!;
  let draftId: string | undefined;
  let sending = false;
  const run = (task: () => Promise<unknown>) => { void task().catch(error => report(error.message)); };
  attach.onsubmit = event => {
    event.preventDefault(); const board = read(); if (!board) return;
    const values = new FormData(attach);
    run(() => call({ action: 'attach_conversation', board: board.slug, threadId: values.get('threadId'), ...(values.get('socketPath') ? { socketPath: values.get('socketPath') } : {}) }));
  };
  send.oninput = () => { draftId = undefined; };
  send.onsubmit = event => {
    event.preventDefault(); const board = read(); if (!board || sending) return;
    const text = String(new FormData(send).get('text')); draftId ??= crypto.randomUUID();
    const id = draftId;
    sending = true;
    run(async () => {
      try { await call({ action: 'send_feedback', board: board.slug, id, text, selected: selected() }); if (draftId === id) { send.reset(); draftId = undefined; } }
      finally { sending = false; }
    });
  };
  section.querySelector<HTMLButtonElement>('[data-stop]')!.onclick = () => run(() => call({ action: 'stop_agent', board: read()?.slug }));
  return {
    status(status: Status) {
      section.querySelector('[data-connection]')!.textContent = `${status.connecting ? 'Connecting' : status.connected ? status.state : 'Disconnected'}${status.error ? `\n${status.error}` : ''}`;
      section.querySelector('[data-session]')!.textContent = status.session?.id ?? 'No conversation attached';
      section.querySelector('[data-stop]')!.textContent = status.session?.capabilities.stop === 'step' ? 'Stop after current step' : 'Stop agent';
      const approvals = section.querySelector('[data-approvals]')!; approvals.replaceChildren();
      for (const approval of status.approvals) {
        const p = document.createElement('p'); p.textContent = approval.summary; approvals.append(p);
        for (const decision of ['accept', 'decline'] as const) {
          const button = document.createElement('button'); button.textContent = decision === 'accept' ? 'Allow once' : 'Decline';
          button.onclick = () => run(() => call({ action: 'approve_agent', board: read()?.slug, id: approval.id, decision })); approvals.append(button);
        }
      }
    },
    render() {
      const board = read(); if (!board) return;
      if (board.conversation && (!board.conversation.agent || board.conversation.agent === 'codex') && !attach.contains(document.activeElement)) {
        (attach.elements.namedItem('threadId') as HTMLInputElement).value = board.conversation.threadId;
        (attach.elements.namedItem('socketPath') as HTMLInputElement).value = board.conversation.socketPath ?? '';
      }
      const messages = section.querySelector('[data-messages]')!; messages.replaceChildren();
      for (const feedback of board.feedback) {
        const message = document.createElement('article'); message.className = 'local-message';
        const prompt = document.createElement('p'); prompt.className = 'local-prompt'; prompt.textContent = feedback.text;
        const state = document.createElement('span'); state.className = 'local-delivery'; state.textContent = feedback.state;
        message.append(prompt, state);
        if (feedback.state === 'uncertain') { const warning = document.createElement('p'); warning.textContent = 'Delivery uncertain. Check the terminal before issuing this instruction again.'; message.append(warning); }
        if (feedback.reply) { const reply = document.createElement('p'); reply.textContent = feedback.reply; message.append(reply); }
        messages.append(message);
        if (feedback.state === 'saved') {
          const button = document.createElement('button'); button.textContent = 'Send saved message';
          button.onclick = () => run(() => call({ action: 'send_feedback', board: board.slug, id: feedback.id, text: feedback.text, selected: [] })); messages.append(button);
        }
      }
    },
  };
}
