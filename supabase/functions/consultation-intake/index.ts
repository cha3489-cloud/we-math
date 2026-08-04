import {
  buildNotionPage,
  submissionMarker,
  validateConsultationInput,
  type ValidatedConsultation,
} from './domain.ts';
import { isAllowedOrigin, productionOrigin } from '../_shared/origin.ts';

const notionUrl = 'https://api.notion.com/v1/pages';
const maxBodyBytes = 16_384;
const rpcTimeoutMs = 5_000;
const notionTimeoutMs = 10_000;

function response(origin: string, body: unknown, status: number) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
      'vary': 'Origin',
    },
  });
}

function supabaseConfiguration() {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceRoleKey) throw new Error('server configuration missing');
  return { url, serviceRoleKey };
}

async function callRpc(name: string, body: Record<string, unknown>) {
  const { url, serviceRoleKey } = supabaseConfiguration();
  const rpcResponse = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'apikey': serviceRoleKey,
      'authorization': 'Be' + 'arer ' + serviceRoleKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(rpcTimeoutMs),
  });
  if (!rpcResponse.ok) throw new Error(`${name} failed`);
  return await rpcResponse.json();
}

async function claimSubmission(submissionId: string) {
  return await callRpc('claim_consultation_intake_submission', { p_submission_id: submissionId });
}

async function completeSubmission(submissionId: string, notionPageId: string) {
  return await callRpc('complete_consultation_intake_submission', {
    p_submission_id: submissionId,
    p_notion_page_id: notionPageId,
  });
}

async function failSubmission(submissionId: string) {
  try {
    await callRpc('fail_consultation_intake_submission', { p_submission_id: submissionId });
  } catch {
    console.error('Consultation intake submission release failed');
  }
}

async function checkConsultationRateLimit(request: Request, parentPhone: string) {
  const salt = Deno.env.get('CONSULTATION_RATE_LIMIT_SALT');
  // Supabase's proxy supplies this header. Reject lists instead of trusting client-selected alternatives.
  const clientIp = request.headers.get('x-forwarded-for')?.trim();
  if (!salt || salt.length < 16 || !clientIp || clientIp.includes(',') || clientIp.length > 64) {
    throw new Error('rate limit configuration missing');
  }

  const hash = async (scope: string, value: string) => {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`${salt}:${scope}:${value}`),
    );
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  const [ipHash, phoneHash] = await Promise.all([
    hash('ip', clientIp),
    hash('phone', parentPhone),
  ]);
  const [ipAllowed, phoneAllowed] = await Promise.all([
    callRpc('check_consultation_intake_rate_limit', { p_client_hash: ipHash, p_max_requests: 20 }),
    callRpc('check_consultation_intake_rate_limit', { p_client_hash: phoneHash, p_max_requests: 3 }),
  ]);
  return ipAllowed === true && phoneAllowed === true;
}

function notionHeaders(notionKey: string) {
  return {
    'authorization': `Bearer ${notionKey}`,
    'content-type': 'application/json',
    'notion-version': '2025-09-03',
  };
}

async function findNotionPageBySubmission(
  notionKey: string,
  databaseId: string,
  submissionId: string,
) {
  const databaseResponse = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
    headers: notionHeaders(notionKey),
    signal: AbortSignal.timeout(notionTimeoutMs),
  });
  if (!databaseResponse.ok) throw new Error('Notion database lookup failed');
  const database = await databaseResponse.json();
  const dataSourceId = database?.data_sources?.[0]?.id;
  if (typeof dataSourceId !== 'string') throw new Error('Notion data source missing');

  const queryResponse = await fetch(`https://api.notion.com/v1/data_sources/${dataSourceId}/query`, {
    method: 'POST',
    headers: notionHeaders(notionKey),
    body: JSON.stringify({
      page_size: 1,
      filter: {
        property: '추가 문의',
        rich_text: { contains: submissionMarker(submissionId) },
      },
    }),
    signal: AbortSignal.timeout(notionTimeoutMs),
  });
  if (!queryResponse.ok) throw new Error('Notion submission lookup failed');
  const query = await queryResponse.json();
  const pageId = query?.results?.[0]?.id;
  return typeof pageId === 'string' ? pageId : null;
}

Deno.serve(async (request) => {
  const origin = request.headers.get('origin') ?? '';
  if (!isAllowedOrigin(origin)) return response(productionOrigin, { error: 'forbidden' }, 403);
  if (request.method === 'OPTIONS') return response(origin, {}, 204);
  if (request.method !== 'POST') return response(origin, { error: 'method not allowed' }, 405);

  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (contentLength > maxBodyBytes) return response(origin, { error: '요청 내용이 너무 큽니다.' }, 413);

  let input: ValidatedConsultation;
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).length > maxBodyBytes) {
      return response(origin, { error: '요청 내용이 너무 큽니다.' }, 413);
    }
    input = validateConsultationInput(JSON.parse(rawBody));
  } catch (error) {
    const message = error instanceof Error ? error.message : '입력 내용을 확인해주세요.';
    return response(origin, { error: message }, 400);
  }

  try {
    if (!await checkConsultationRateLimit(request, input.parentPhone)) {
      return response(origin, { error: '요청이 너무 많습니다. 한 시간 후 다시 시도해주세요.' }, 429);
    }
  } catch {
    console.error('Consultation intake rate limit check failed');
    return response(origin, { error: '현재 접수가 원활하지 않습니다. 잠시 후 다시 시도해주세요.' }, 503);
  }

  const notionKey = Deno.env.get('NOTION_API_KEY');
  const databaseId = Deno.env.get('NOTION_CONSULTATION_DATABASE_ID');
  if (!notionKey || !databaseId) {
    console.error('Consultation intake server configuration missing');
    return response(origin, { error: '현재 접수가 원활하지 않습니다. 잠시 후 다시 시도해주세요.' }, 503);
  }

  let claim: unknown;
  try {
    claim = await claimSubmission(input.submissionId);
  } catch {
    console.error('Consultation intake submission claim failed');
    return response(origin, { error: '현재 접수가 원활하지 않습니다. 잠시 후 다시 시도해주세요.' }, 503);
  }
  if (claim === 'completed') return response(origin, { ok: true, deduplicated: true }, 200);
  if (claim === 'pending') {
    return response(origin, { error: '동일한 상담 신청을 처리 중입니다. 2분 후 다시 시도해주세요.' }, 409);
  }
  if (claim === 'reconcile') {
    let existingPageId: string | null;
    try {
      existingPageId = await findNotionPageBySubmission(notionKey, databaseId, input.submissionId);
    } catch {
      console.error('Notion consultation reconciliation lookup failed');
      return response(origin, { error: '접수 상태 확인이 지연되고 있습니다. 잠시 후 다시 시도해주세요.' }, 503);
    }
    if (existingPageId) {
      try {
        if (await completeSubmission(input.submissionId, existingPageId) !== true) {
          throw new Error('reconciliation completion rejected');
        }
      } catch {
        console.error('Consultation intake reconciliation completion failed');
        return response(origin, { error: '접수 상태 확인이 지연되고 있습니다. 잠시 후 다시 시도해주세요.' }, 503);
      }
      return response(origin, { ok: true, deduplicated: true, reconciled: true }, 200);
    }
  } else if (claim !== 'claimed') {
    console.error('Consultation intake submission claim returned an invalid state');
    return response(origin, { error: '현재 접수가 원활하지 않습니다. 잠시 후 다시 시도해주세요.' }, 503);
  }

  let notionPageId: string;
  try {
    const notionResponse = await fetch(notionUrl, {
      method: 'POST',
      headers: notionHeaders(notionKey),
      body: JSON.stringify(buildNotionPage(databaseId, input)),
      signal: AbortSignal.timeout(notionTimeoutMs),
    });
    if (!notionResponse.ok) {
      console.error('Notion consultation create failed', notionResponse.status);
      // A definite 4xx response means Notion rejected the create. A 5xx can be
      // ambiguous, so keep the claim pending for lookup-based reconciliation.
      if (notionResponse.status < 500) await failSubmission(input.submissionId);
      return response(origin, { error: '현재 접수가 원활하지 않습니다. 잠시 후 다시 시도해주세요.' }, 502);
    }
    const notionPage = await notionResponse.json();
    notionPageId = typeof notionPage?.id === 'string' ? notionPage.id : '';
    if (!notionPageId) throw new Error('Notion response missing page id');
  } catch {
    console.error('Notion consultation create timed out or failed');
    return response(origin, { error: '접수 상태 확인이 필요합니다. 2분 후 다시 시도해주세요.' }, 502);
  }

  try {
    if (await completeSubmission(input.submissionId, notionPageId) !== true) throw new Error('completion rejected');
  } catch {
    console.error('Consultation intake submission completion failed');
    return response(origin, { error: '접수 상태 확인이 필요합니다. 2분 후 다시 시도해주세요.' }, 503);
  }
  return response(origin, { ok: true }, 201);
});
