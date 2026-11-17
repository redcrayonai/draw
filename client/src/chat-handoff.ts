import { createChatConnection, type ChatConnection, type ChatConnectionOptions } from './chat-connection';

/** Ask the existing conversation to move; a queue receipt is not proof it has moved. */
export function requestChatHandoff(url: string, token: ChatConnectionOptions['token'], text: string, connect: (options: ChatConnectionOptions) => ChatConnection = createChatConnection): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = `handoff-${crypto.randomUUID()}`;
    let session: string | null = null;
    let sent = false;
    let finished = false;
    const finish = (error?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      connection.close();
      if (error) reject(new Error(error));
      else resolve();
    };
    const timeout = setTimeout(() => finish('Could not confirm the handoff request. Check your agent before trying again.'), 15_000);
    const connection = connect({
      url, token,
      status() {},
      receive(frame) {
        if (finished) return;
        // The relay says at once when no conversation is attached there: do not wait out the timer.
        if (frame.agent === 'gone' && !sent) return finish('Your agent is not connected to board chat on that board. Paste the handoff prompt into your agent.');
        if (frame.type === 'sessions' && !sent) {
          if (frame.sessions?.length > 1) return finish('There is more than one session on that board. Paste the handoff prompt into the session you want.');
          session = frame.selected ?? null;
        }
        if (frame.type === 'snapshot' && session && frame.session?.id === session && !sent) {
          sent = true;
          if (!connection.send({ type: 'send', id, session, text })) finish('Could not send the handoff request. Paste the prompt into your agent.');
        }
        if (sent && frame.session === session && ((frame.type === 'delivered' && frame.id === id) ||
          (frame.type === 'queue' && frame.queue?.some((item: { id: string }) => item.id === id)))) finish();
      },
    });
    connection.start();
  });
}
