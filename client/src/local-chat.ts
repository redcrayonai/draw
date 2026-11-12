import type { LocalBoard } from '../../shared/local';
import type { ChatSession } from '../../shared/chat';

type Status = { connected: boolean; connecting: boolean; state: string; error?: string; session?: ChatSession; approvals: { id: string; summary: string }[] };
export function mountLocalChat(container: HTMLElement, read: () => LocalBoard | undefined, selected: () => string[], call: (input: unknown) => Promise<unknown>, report: (message: string) => void) {
  const section = document.createElement('section');
  section.innerHTML = `<h2>Conversation</h2><p role="status" data-connection>Disconnected</p><form data-attach><label>Existing thread ID<input name="threadId" required></label><label>Control socket (optional)<input name="socketPath" placeholder="/absolute/path/to/socket"></label><button>Connect</button></form><button type="button" data-stop>Stop agent</button><div data-approvals></div><h2>Feedback</h2><form data-send><label>Message to your agent<textarea name="text" required></textarea></label><button>Send feedback</button></form><div data-messages></div>`;
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
      section.querySelector('[data-connection]')!.textContent = `${status.connecting ? 'Connecting' : status.connected ? status.state : 'Disconnected'}${status.session ? ` · ${status.session.id}` : ''}${status.error ? `\n${status.error}` : ''}`;
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
      if (board.conversation && !attach.contains(document.activeElement)) {
        (attach.elements.namedItem('threadId') as HTMLInputElement).value = board.conversation.threadId;
        (attach.elements.namedItem('socketPath') as HTMLInputElement).value = board.conversation.socketPath ?? '';
      }
      const messages = section.querySelector('[data-messages]')!; messages.replaceChildren();
      for (const feedback of board.feedback) {
        const p = document.createElement('p'); p.textContent = `${feedback.state} · ${feedback.text}${feedback.state === 'uncertain' ? '\nDelivery uncertain. Check the terminal before issuing this instruction again.' : ''}${feedback.reply ? `\n\n${feedback.reply}` : ''}`; messages.append(p);
        if (feedback.state === 'saved') {
          const button = document.createElement('button'); button.textContent = 'Send saved message';
          button.onclick = () => run(() => call({ action: 'send_feedback', board: board.slug, id: feedback.id, text: feedback.text, selected: [] })); messages.append(button);
        }
      }
    },
  };
}
