import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { selectProvider, dispatchClaims, classifyProviderError, dispatchResponse, RECORD_FAILURE_LOG } from '../supabase/functions/parent-message-dispatch/domain.ts';

const root = resolve(import.meta.dirname, '..');
const NONCE = 'a'.repeat(64);
const claim = (n, attempt = 1) => ({
  message_id: 'm' + n, attempt_no: attempt, claim_nonce: NONCE, lease_expires_at: '2099-01-01T00:05:00Z',
  template_code: 'attendance_present', template_version: 1, body: '본문', recipient_phone: '010-0000-0000', idempotency_key: 'k' + n,
});

describe('parent message dispatch boundary', () => {
  it('defaults to a network-free dry-run provider and refuses the real provider without approval', () => {
    expect(selectProvider({}).name).toBe('dry_run');
    expect(selectProvider({ PARENT_MESSAGE_PROVIDER: 'dry_run' }).name).toBe('dry_run');
    expect(() => selectProvider({ PARENT_MESSAGE_PROVIDER: 'kakao_alimtalk' })).toThrow(/not enabled/);
    expect(() => selectProvider({ PARENT_MESSAGE_PROVIDER: 'sms' })).toThrow(/unsupported/);
  });

  it('records dry-run results as sent with the claim ownership and never falls back to another channel', async () => {
    const recorded = [];
    const provider = selectProvider({});
    await dispatchClaims([claim(1)], provider, async (result) => { recorded.push(result); });
    expect(recorded).toEqual([{ message_id: 'm1', attempt_no: 1, claim_nonce: NONCE, outcome: 'sent', result_code: 'dry_run', provider_request_id: 'dry-run:k1', dry_run: true }]);

    const failing = { name: 'kakao_alimtalk', dryRun: false, send: async () => { throw Object.assign(new Error('invalid template'), { status: 400, code: 'TEMPLATE_REJECTED' }); } };
    const transient = { name: 'kakao_alimtalk', dryRun: false, send: async () => { throw Object.assign(new Error('timeout'), { status: 503 }); } };
    const out = [];
    await dispatchClaims([claim(2)], failing, async (r) => out.push(r));
    await dispatchClaims([claim(3)], transient, async (r) => out.push(r));
    expect(out.map((r) => [r.message_id, r.outcome, r.result_code])).toEqual([['m2', 'failed', 'TEMPLATE_REJECTED'], ['m3', 'retryable', 'http_503']]);
  });

  it('sends the stable idempotency key to the provider and never the claim nonce, across retries', async () => {
    const requests = [];
    const provider = { name: 'kakao_alimtalk', dryRun: false, send: async (req) => { requests.push(req); return { requestId: 'r', resultCode: 'ok' }; } };
    await dispatchClaims([claim(7, 1)], provider, async () => { throw new Error('db down'); }, () => {});
    await dispatchClaims([{ ...claim(7, 2), claim_nonce: 'b'.repeat(64) }], provider, async () => {});
    expect(requests.map((r) => r.idempotencyKey)).toEqual(['k7', 'k7']);
    expect(JSON.stringify(requests)).not.toContain(NONCE);
    expect(JSON.stringify(requests)).not.toContain('b'.repeat(64));
    expect(Object.keys(requests[0]).sort()).toEqual(['body', 'idempotencyKey', 'recipientPhone', 'templateCode', 'templateVersion']);
  });

  it('does not report success when provider acceptance could not be recorded, logging only a fixed line', async () => {
    const logs = [];
    const provider = selectProvider({});
    const summary = await dispatchClaims([claim(1), claim(2)], provider, async (r) => {
      if (r.message_id === 'm1') throw Object.assign(new Error('delivery attempt ownership changed m1 010-0000-0000'), { code: '40001' });
    }, (...args) => logs.push(args));
    expect(summary).toMatchObject({ claimed: 2, sent: 1, unrecorded: 1 });
    expect(logs).toEqual([[RECORD_FAILURE_LOG]]);
    expect(RECORD_FAILURE_LOG).not.toMatch(/m1|010|\{/);
    const response = dispatchResponse(summary);
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(response.body)).not.toMatch(/m1|m2|010|nonce/);
    expect(dispatchResponse({ ...summary, unrecorded: 0 }).status).toBe(200);
  });

  it('classifies provider errors without leaking recipient details', () => {
    expect(classifyProviderError(Object.assign(new Error('010-0000-0000 rejected'), { status: 400 }))).toEqual({ outcome: 'failed', result_code: 'http_400' });
    expect(classifyProviderError(new Error('network down'))).toEqual({ outcome: 'retryable', result_code: 'network_error' });
  });

  it('keeps provider credentials server-side and authorizes only admins or the service scheduler', () => {
    const source = readFileSync(resolve(root, 'supabase/functions/parent-message-dispatch/index.ts'), 'utf8');
    expect(source).toContain("Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')");
    expect(source).toContain("rpc('is_admin')");
    expect(source).toContain("rpc('service_claim_parent_messages'");
    expect(source).toContain("rpc('service_record_delivery_result'");
    expect(source).toContain('p_claim_nonce: result.claim_nonce');
    expect(source).toContain('dispatchResponse(');
    expect(source).not.toMatch(/console\.(error|log)\([^)]*(message_id|claim_nonce|recipient)/);
    expect(source).not.toMatch(/sms|lms/i);
    for (const file of ['src/portal/admin.js', 'src/kiosk/main.js', 'src/makeup/main.js']) {
      expect(readFileSync(resolve(root, file), 'utf8')).not.toMatch(/SERVICE_ROLE|service_role|KAKAO_/);
    }
  });
});
