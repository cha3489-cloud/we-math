export const AUTH_UPDATE_TIMEOUT_MS = 4_000;
export const DB_REQUEST_TIMEOUT_MS = 20_000;
export const PIN_OPERATION_LEASE_MS = 120_000;

type RetryOptions = {
  attempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};


export const fetchWithTimeout = (
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): typeof fetch => async (input, init = {}) => {
  const controller = new AbortController();
  const callerSignal = init.signal;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException('request timed out', 'TimeoutError')),
    timeoutMs,
  );
  const cleanup = () => {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  };
  try {
    const response = await fetchImpl(input, { ...init, signal: controller.signal });
    if (!response.body) {
      cleanup();
      return response;
    }
    const transform = new TransformStream<Uint8Array, Uint8Array>();
    void response.body.pipeTo(transform.writable).then(cleanup, cleanup);
    return new Response(transform.readable, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    cleanup();
    throw error;
  }
};

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const isTransientJwtKeyError = (error: unknown) => {
  const candidate = error as { code?: string; status?: number; message?: string } | null;
  return candidate?.code === 'bad_jwt'
    && candidate?.status === 403
    && candidate?.message?.includes('unrecognized JWT kid') === true;
};

export async function retryTransientJwtKeyError<T>(
  operation: () => Promise<T>,
  { attempts = 6, sleep = wait }: RetryOptions = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientJwtKeyError(error) || attempt + 1 >= attempts) throw error;
      await sleep(Math.min(100 * (2 ** attempt), 1600));
    }
  }
  throw lastError;
}
