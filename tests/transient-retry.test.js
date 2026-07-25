import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_UPDATE_TIMEOUT_MS,
  DB_REQUEST_TIMEOUT_MS,
  PIN_OPERATION_LEASE_MS,
  fetchWithTimeout,
  retryTransientJwtKeyError,
} from '../supabase/functions/_shared/retry.ts';

afterEach(() => vi.useRealTimers());

const transientError = () => Object.assign(
  new Error('invalid JWT: unable to parse or verify signature: unrecognized JWT kid <nil> for algorithm ES256'),
  { code: 'bad_jwt', status: 403 },
);

describe('retryTransientJwtKeyError', () => {
  it('retries the known transient JWT key error and returns a later success', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(transientError())
      .mockRejectedValueOnce(transientError())
      .mockResolvedValue('ok');

    await expect(retryTransientJwtKeyError(operation, { attempts: 5, sleep: async () => {} })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('does not retry unrelated errors', async () => {
    const error = Object.assign(new Error('invalid credentials'), { code: 'bad_jwt', status: 403 });
    const operation = vi.fn().mockRejectedValue(error);

    await expect(retryTransientJwtKeyError(operation, { attempts: 5, sleep: async () => {} })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('stops after the configured attempt limit', async () => {
    const operation = vi.fn().mockImplementation(async () => { throw transientError(); });

    await expect(retryTransientJwtKeyError(operation, { attempts: 4, sleep: async () => {} })).rejects.toThrow('unrecognized JWT kid');
    expect(operation).toHaveBeenCalledTimes(4);
  });


  it('keeps the worst retry plus finish budget below the database lease', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const operation = vi.fn().mockImplementation(() => new Promise((_, reject) => {
      setTimeout(() => reject(transientError()), AUTH_UPDATE_TIMEOUT_MS);
    }));

    const result = retryTransientJwtKeyError(operation);
    const assertion = expect(result).rejects.toThrow('unrecognized JWT kid');
    await vi.runAllTimersAsync();
    await assertion;

    const retryElapsed = Date.now() - startedAt;
    expect(operation).toHaveBeenCalledTimes(6);
    expect(retryElapsed).toBe(27_100);
    expect(DB_REQUEST_TIMEOUT_MS + retryElapsed + DB_REQUEST_TIMEOUT_MS).toBeLessThan(PIN_OPERATION_LEASE_MS);
  });

  it.each([
    [{ code: 'other', status: 403, message: 'unrecognized JWT kid <nil>' }],
    [{ code: 'bad_jwt', status: 401, message: 'unrecognized JWT kid <nil>' }],
    [{ code: 'bad_jwt', status: 403, message: 'different JWT failure' }],
  ])('requires the exact transient error predicate for retries', async (shape) => {
    const error = Object.assign(new Error(shape.message), shape);
    const operation = vi.fn().mockRejectedValue(error);

    await expect(retryTransientJwtKeyError(operation, { sleep: async () => {} })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('keeps the timeout active until a stalled response body is consumed', async () => {
    vi.useFakeTimers();
    let requestSignal;
    const stalledFetch = vi.fn(async (_input, init = {}) => {
      requestSignal = init.signal;
      return new Response(new ReadableStream({
        start(controller) {
          requestSignal.addEventListener('abort', () => controller.error(requestSignal.reason), { once: true });
        },
      }));
    });
    const timedFetch = fetchWithTimeout(4_000, stalledFetch);
    const response = await timedFetch('https://example.test');
    const bodyResult = response.text();
    const bodyAssertion = expect(bodyResult).rejects.toBeDefined();

    await vi.advanceTimersByTimeAsync(4_000);

    expect(requestSignal.aborted).toBe(true);
    await bodyAssertion;
  });

  it('preserves and propagates a caller abort signal', async () => {
    let requestSignal;
    const stalledFetch = vi.fn(async (_input, init = {}) => {
      requestSignal = init.signal;
      return new Response(new ReadableStream({
        start(controller) {
          requestSignal.addEventListener('abort', () => controller.error(requestSignal.reason), { once: true });
        },
      }));
    });
    const caller = new AbortController();
    const response = await fetchWithTimeout(4_000, stalledFetch)('https://example.test', { signal: caller.signal });
    const bodyResult = response.text();
    const bodyAssertion = expect(bodyResult).rejects.toBeDefined();

    caller.abort(new DOMException('caller stopped', 'AbortError'));

    expect(requestSignal.aborted).toBe(true);
    await bodyAssertion;
  });

});
