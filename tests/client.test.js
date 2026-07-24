import { afterEach, describe, expect, it, vi } from 'vitest';
import { invokeAuthenticated, supabase } from '../src/portal/client.js';

describe('authenticated Edge Function calls', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends the current access token explicitly', async () => {
    vi.spyOn(supabase.auth, 'getSession').mockResolvedValue({ data: { session: { access_token: 'test-access-token' } }, error: null });
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(invokeAuthenticated('change-pin', { pin: '654321' })).resolves.toEqual({ ok: true });
    const [url, options] = request.mock.calls[0];
    expect(url).toMatch(/\/functions\/v1\/change-pin$/);
    expect(options.headers.Authorization).toBe('Bearer test-access-token');
    expect(options.headers.apikey).toMatch(/^sb_publishable_/);
  });

  it('surfaces the server error message', async () => {
    vi.spyOn(supabase.auth, 'getSession').mockResolvedValue({ data: { session: { access_token: 'test-access-token' } }, error: null });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    }));
    await expect(invokeAuthenticated('change-pin', { pin: '654321' })).rejects.toThrow('forbidden');
  });
});
