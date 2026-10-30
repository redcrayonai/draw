import { describe, it, expect } from 'vitest';
import { runBootWithRecovery } from '../src/connection-recovery';

describe('runBootWithRecovery', () => {
  it('keeps the backoff counter and disconnects when boot fails', async () => {
    const calls: string[] = [];
    await runBootWithRecovery(
      { disconnect: () => calls.push('disconnect') },
      async () => {
        throw new Error('joinBoard failed');
      },
      () => calls.push('reset'),
      reason => calls.push(`schedule:${reason}`)
    );

    expect(calls).toEqual(['schedule:Error: joinBoard failed', 'disconnect']);
  });

  it('resets the backoff counter after a successful boot', async () => {
    const calls: string[] = [];
    await runBootWithRecovery(
      { disconnect: () => calls.push('disconnect') },
      async () => {
        calls.push('boot');
      },
      () => calls.push('reset'),
      reason => calls.push(`schedule:${reason}`)
    );

    expect(calls).toEqual(['boot', 'reset']);
  });
});
