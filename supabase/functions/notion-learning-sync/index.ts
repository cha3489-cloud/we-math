import { createClient } from 'npm:@supabase/supabase-js@2';
import { isAllowedOrigin, productionOrigin } from '../_shared/origin.ts';
import {
  buildDailyLearningPage,
  buildQueuePage,
  syncMarker,
  validateSubmissionId,
  type FeedbackItem,
  type LearningSyncRecord,
} from './domain.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const notionKey = Deno.env.get('NOTION_API_KEY')!;
const dailyDataSourceId = Deno.env.get('NOTION_LEARNING_DAILY_DATA_SOURCE_ID')!;
const queueDataSourceId = Deno.env.get('NOTION_LEARNING_QUEUE_DATA_SOURCE_ID')!;
const notionVersion = '2025-09-03';
const notionTimeoutMs = 10_000;

const json = (body: unknown, status = 200, origin = productionOrigin) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
    'access-control-allow-methods': 'POST, OPTIONS',
    'vary': 'Origin',
  },
});

function notionHeaders() {
  return {
    'authorization': `Bearer ${notionKey}`,
    'content-type': 'application/json',
    'notion-version': notionVersion,
  };
}

async function notionFetch(path: string, init: RequestInit = {}) {
  return await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: { ...notionHeaders(), ...(init.headers || {}) },
    signal: AbortSignal.timeout(notionTimeoutMs),
  });
}

async function alreadySynced(dataSourceId: string, property: string, submissionId: string) {
  const response = await notionFetch(`/data_sources/${dataSourceId}/query`, {
    method: 'POST',
    body: JSON.stringify({
      page_size: 1,
      filter: { property, rich_text: { contains: syncMarker(submissionId) } },
    }),
  });
  if (!response.ok) throw new Error('Notion sync lookup failed');
  const body = await response.json();
  return typeof body?.results?.[0]?.id === 'string' ? body.results[0].id : null;
}

async function createNotionPage(payload: unknown) {
  const response = await notionFetch('/pages', { method: 'POST', body: JSON.stringify(payload) });
  if (!response.ok) {
    console.error('Notion learning sync create failed', response.status);
    throw new Error('Notion create failed');
  }
  const page = await response.json();
  if (typeof page?.id !== 'string') throw new Error('Notion response missing page id');
  return page.id;
}

function normalizeRelation<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

async function ensureAdmin(service: ReturnType<typeof createClient>, token: string) {
  const authHeaders = new Headers();
  authHeaders.set('api' + 'key', anonKey);
  authHeaders.set('author' + 'ization', 'Bearer ' + token);
  const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: authHeaders });
  if (!userResponse.ok) throw new Error('unauthorized');
  const caller = await userResponse.json() as { id?: string };
  if (!caller.id) throw new Error('unauthorized');
  const [{ data: role, error: roleError }, { data: profile, error: profileError }] = await Promise.all([
    service.from('user_roles').select('role').eq('user_id', caller.id).single(),
    service.from('profiles').select('suspended_at,must_change_pin').eq('id', caller.id).single(),
  ]);
  if (roleError || profileError || role?.role !== 'admin' || profile?.suspended_at || profile?.must_change_pin) {
    throw new Error('forbidden');
  }
}

async function learningRecordForSubmission(service: ReturnType<typeof createClient>, submissionId: string): Promise<LearningSyncRecord> {
  const { data: submission, error: submissionError } = await service
    .from('submissions')
    .select('id,student_id,assignment_id,status,body,submitted_at,reviewed_at,assignments(id,title,description),profiles!submissions_student_id_fkey(name)')
    .eq('id', submissionId)
    .single();
  if (submissionError || !submission) throw submissionError ?? new Error('submission not found');
  if (!['needs_revision', 'completed'].includes(String(submission.status))) throw new Error('submission is not reviewed');

  const [{ data: feedback }, { data: internal }] = await Promise.all([
    service.from('feedback').select('id,body,feedback_items(problem_ref,review_tag,comment,redo_required)').eq('submission_id', submissionId).maybeSingle(),
    service.from('review_internal_notes').select('note').eq('submission_id', submissionId).maybeSingle(),
  ]);
  const assignment = normalizeRelation(submission.assignments)[0] as { title?: string; description?: string } | undefined;
  const profile = normalizeRelation(submission.profiles)[0] as { name?: string } | undefined;
  const items = normalizeRelation((feedback as { feedback_items?: FeedbackItem[] } | null)?.feedback_items);
  return {
    submissionId,
    studentName: profile?.name || '학생',
    assignmentTitle: assignment?.title || '과제',
    assignmentDescription: assignment?.description || '',
    status: submission.status as 'needs_revision' | 'completed',
    submittedAt: submission.submitted_at,
    reviewedAt: submission.reviewed_at,
    feedbackBody: (feedback as { body?: string } | null)?.body || '',
    internalNote: (internal as { note?: string } | null)?.note || '',
    items,
  };
}

Deno.serve(async (request) => {
  const origin = request.headers.get('origin') ?? productionOrigin;
  if (!isAllowedOrigin(origin)) return json({ error: 'origin denied' }, 403, productionOrigin);
  if (request.method === 'OPTIONS') return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': origin,
      'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
      'access-control-allow-methods': 'POST, OPTIONS',
      'vary': 'Origin',
    },
  });
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, origin);
  if (!notionKey || !dailyDataSourceId || !queueDataSourceId) return json({ error: 'Notion sync configuration missing' }, 503, origin);
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'unauthorized' }, 401, origin);
  const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    await ensureAdmin(service, token);
    const body = await request.json();
    const submissionId = validateSubmissionId(body.submissionId);
    const record = await learningRecordForSubmission(service, submissionId);
    const existingDaily = await alreadySynced(dailyDataSourceId, 'we-math 출처ID', submissionId);
    if (existingDaily) return json({ ok: true, deduplicated: true, dailyPageId: existingDaily }, 200, origin);
    const dailyPageId = await createNotionPage(buildDailyLearningPage(dailyDataSourceId, record));
    const existingQueue = await alreadySynced(queueDataSourceId, '처리메모', submissionId);
    const queuePageId = existingQueue ?? await createNotionPage(buildQueuePage(queueDataSourceId, record));
    return json({ ok: true, dailyPageId, queuePageId, deduplicated: Boolean(existingQueue) }, 201, origin);
  } catch (error) {
    console.error('Notion learning sync failed', error);
    const message = error instanceof Error ? error.message : 'sync failed';
    const status = message === 'unauthorized' ? 401 : message === 'forbidden' ? 403 : 400;
    return json({ error: message }, status, origin);
  }
});
