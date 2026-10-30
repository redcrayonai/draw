export interface Disconnectable {
  disconnect(): void;
}

export async function runBootWithRecovery(
  connection: Disconnectable,
  boot: () => Promise<void>,
  resetReconnectBackoff: () => void,
  scheduleReconnect: (reason: string) => void
): Promise<void> {
  try {
    await boot();
    resetReconnectBackoff();
  } catch (error) {
    scheduleReconnect(String(error));
    connection.disconnect();
  }
}
