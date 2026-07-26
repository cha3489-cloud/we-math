import { afterEach, describe, expect, it, vi } from 'vitest';
import { invokeAuthenticated, isMissingFeedbackSourceColumn, isMissingExplicitFeedbackRpc, supabase } from '../src/portal/client.js';

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

  it('recognizes only the two expected mixed-schema compatibility errors', () => {
    expect(isMissingFeedbackSourceColumn({ code: '42703', message: 'column feedback.auto_composed does not exist' })).toBe(true);
    expect(isMissingFeedbackSourceColumn({ code: '42501', message: 'permission denied for auto_composed' })).toBe(false);
    expect(isMissingExplicitFeedbackRpc({ code: 'PGRST202', message: 'review_submission_v2 with p_auto_composed was not found' })).toBe(true);
    expect(isMissingExplicitFeedbackRpc({ code: 'PGRST202', message: 'some_other_rpc was not found' })).toBe(false);
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
