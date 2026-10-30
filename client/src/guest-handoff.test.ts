import { describe, expect, it, vi } from 'vitest';
import { signInWithGuestBoard } from './guest-handoff';

const SLUG = 'c4bb879c7355360696d9';
const board = { id: 7n, slug: SLUG };

describe('guest sign-in handoff', () => {
  it('issues and persists proof of ownership before the sign-in redirect', async () => {
    const storage = {setItem: vi.fn(), removeItem: vi.fn()};
    const offer = vi.fn().mockResolvedValue(undefined);
    const auth = {ensureSignedIn: vi.fn(async () => {
      expect(offer).toHaveBeenCalledTimes(1);
      expect(storage.setItem).toHaveBeenCalledTimes(1);
      const request = offer.mock.calls[0][0];
      expect(JSON.parse(storage.setItem.mock.calls[0][1])).toEqual({boardId: '7', code: request.code, slug: SLUG});
      expect(request.code).toHaveLength(64);
      return true;
    })};
    await expect(signInWithGuestBoard(auth, board, offer, storage, 'claim')).resolves.toBe(true);
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('clears the pending claim on cancellation without changing ownership', async () => {
    const storage = {setItem: vi.fn(), removeItem: vi.fn()};
    const offer = vi.fn().mockResolvedValue(undefined);
    await expect(signInWithGuestBoard({ensureSignedIn: async () => false}, board, offer, storage, 'claim')).resolves.toBe(false);
    expect(storage.removeItem).toHaveBeenCalledWith('claim');
  });

  it('never opens sign-in when preserving the owned guest board fails', async () => {
    const auth = {ensureSignedIn: vi.fn()};
    await expect(signInWithGuestBoard(auth, board, async () => {throw new Error('offline');}, sessionStorage, 'claim')).rejects.toThrow('offline');
    expect(auth.ensureSignedIn).not.toHaveBeenCalled();
  });

  it('does not claim public examples or other users boards', async () => {
    const offer = vi.fn(); const storage = {setItem: vi.fn(), removeItem: vi.fn()};
    await signInWithGuestBoard({ensureSignedIn: async () => true}, undefined, offer, storage, 'claim');
    expect(offer).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});
