import { describe, expect, it, vi } from 'vitest';
import { currentUserOrNull } from '../src/auth.js';

describe('authentication bootstrap', () => {
  it('treats an absent session as a normal signed-out state', async () => {
    const auth = {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      getUser: vi.fn(),
    };
    await expect(currentUserOrNull(auth)).resolves.toBeNull();
    expect(auth.getUser).not.toHaveBeenCalled();
  });

  it('returns a server-verified user when a session exists', async () => {
    const user = { id: 'student-id' };
    const auth = {
      getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'local-session' } }, error: null }),
      getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }),
    };
    await expect(currentUserOrNull(auth)).resolves.toBe(user);
    expect(auth.getUser).toHaveBeenCalledOnce();
  });

  it('surfaces session storage failures', async () => {
    const error = new Error('session storage unavailable');
    const auth = { getSession: vi.fn().mockResolvedValue({ data: null, error }), getUser: vi.fn() };
    await expect(currentUserOrNull(auth)).rejects.toBe(error);
  });

  it('surfaces user verification failures for an existing session', async () => {
    const error = new Error('token verification failed');
    const auth = {
      getSession: vi.fn().mockResolvedValue({ data: { session: {} }, error: null }),
      getUser: vi.fn().mockResolvedValue({ data: null, error }),
    };
    await expect(currentUserOrNull(auth)).rejects.toBe(error);
  });
});
