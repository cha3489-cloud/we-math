// Provider boundary for parent messages. Only a network-free dry-run provider is enabled.
// A real Kakao AlimTalk dealer integration must be added and approved separately; its
// credentials belong in Edge Function secrets only. There is intentionally no text-message fallback.

export type Claim = {
  message_id: string;
  attempt_no: number;
  // Per-claim ownership secret. It is returned only to the service-role worker, is sent back
  // only to service_record_delivery_result, and must never reach the provider or any log.
  claim_nonce: string;
  lease_expires_at: string;
  template_code: string;
  template_version: number;
  body: string;
  recipient_phone: string | null;
  idempotency_key: string;
};

// Exactly what a provider receives. The idempotency key is the message's stable key, so a
// retry after a lost result reuses it and the provider can deduplicate.
export type ProviderRequest = {
  idempotencyKey: string;
  templateCode: string;
  templateVersion: number;
  body: string;
  recipientPhone: string;
};

export type DeliveryResult = {
  message_id: string;
  attempt_no: number;
  claim_nonce: string;
  outcome: 'sent' | 'delivered' | 'failed' | 'retryable';
  result_code: string;
  provider_request_id: string | null;
  dry_run: boolean;
};

export type Provider = {
  name: 'dry_run' | 'kakao_alimtalk';
  dryRun: boolean;
  send: (request: ProviderRequest) => Promise<{ requestId: string; resultCode: string }>;
};

export type DispatchSummary = {
  claimed: number;
  sent: number;
  failed: number;
  retryable: number;
  unrecorded: number;
  dry_run: boolean;
};

// Fixed, identifier-free log line. Never include message ids, nonces, phones, or error text.
export const RECORD_FAILURE_LOG = 'parent message delivery result not recorded';

const dryRunProvider: Provider = {
  name: 'dry_run',
  dryRun: true,
  send: async (request) => ({ requestId: 'dry-run:' + request.idempotencyKey, resultCode: 'dry_run' }),
};

export function selectProvider(env: Record<string, string | undefined>): Provider {
  const requested = (env.PARENT_MESSAGE_PROVIDER || 'dry_run').trim();
  if (requested === 'dry_run') return dryRunProvider;
  if (requested === 'kakao_alimtalk') {
    throw new Error('kakao_alimtalk provider is not enabled in this build');
  }
  throw new Error('unsupported parent message provider');
}

export function classifyProviderError(error: unknown): { outcome: 'failed' | 'retryable'; result_code: string } {
  const err = error as { status?: number; code?: string } | null;
  const status = typeof err?.status === 'number' ? err.status : null;
  if (status !== null && (status >= 500 || status === 429)) return { outcome: 'retryable', result_code: 'http_' + status };
  if (typeof err?.code === 'string' && /^[A-Z0-9_]{1,60}$/.test(err.code)) return { outcome: 'failed', result_code: err.code };
  if (status !== null) return { outcome: 'failed', result_code: 'http_' + status };
  return { outcome: 'retryable', result_code: 'network_error' };
}

const providerRequest = (claim: Claim): ProviderRequest => ({
  idempotencyKey: claim.idempotency_key,
  templateCode: claim.template_code,
  templateVersion: claim.template_version,
  body: claim.body,
  recipientPhone: claim.recipient_phone ?? '',
});

// `record` must throw (or reject) when the database did not accept the result. A provider
// acceptance only counts as sent once the database recorded it under the current claim.
export async function dispatchClaims(
  claims: Claim[],
  provider: Provider,
  record: (result: DeliveryResult) => Promise<unknown>,
  log: (...args: unknown[]) => void = console.error,
): Promise<DispatchSummary> {
  const summary: DispatchSummary = { claimed: 0, sent: 0, failed: 0, retryable: 0, unrecorded: 0, dry_run: provider.dryRun };
  for (const claim of claims) {
    summary.claimed += 1;
    const base = { message_id: claim.message_id, attempt_no: claim.attempt_no, claim_nonce: claim.claim_nonce, dry_run: provider.dryRun };
    let result: DeliveryResult;
    if (!claim.recipient_phone) {
      result = { ...base, outcome: 'failed', result_code: 'no_recipient', provider_request_id: null };
    } else {
      try {
        const sent = await provider.send(providerRequest(claim));
        result = { ...base, outcome: 'sent', result_code: sent.resultCode, provider_request_id: sent.requestId };
      } catch (error) {
        result = { ...base, ...classifyProviderError(error), provider_request_id: null };
      }
    }
    try {
      await record(result);
    } catch {
      summary.unrecorded += 1;
      log(RECORD_FAILURE_LOG);
      continue;
    }
    if (result.outcome === 'sent' || result.outcome === 'delivered') summary.sent += 1;
    else if (result.outcome === 'failed') summary.failed += 1;
    else summary.retryable += 1;
  }
  return summary;
}

// Any unrecorded result makes the whole run non-2xx so a scheduler/admin never sees success
// for a send whose outcome the database does not know. The lease expires and the next claim
// retries with the same provider idempotency key.
export function dispatchResponse(summary: DispatchSummary): { status: number; body: Record<string, unknown> } {
  if (summary.unrecorded > 0) {
    return { status: 502, body: { error: 'delivery result not recorded', ...summary } };
  }
  return { status: 200, body: { ...summary } };
}
