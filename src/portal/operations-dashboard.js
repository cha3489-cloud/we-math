// Today-first operations dashboard model. Today's sessions are always complete, so their
// counts are the lengths of the lists shown. Older unresolved sessions, failed and draft parent
// messages, and makeup drafts are keyset-paged; their counts come from the server's full-queue aggregates
// (snapshot.queues) and never drop below the rows already loaded.
import { isCheckoutOverdue, isMissingAttendance } from '../kiosk/rules.js';

export const DASHBOARD_BUCKETS = [
  'scheduled', 'present', 'late', 'missing', 'absent', 'checkout_needed',
  'plan_missing', 'message_failed', 'message_draft', 'planned_exceptions', 'planned_absence_drafts', 'makeup_followup',
];
const SESSION_BUCKETS = ['scheduled', 'present', 'late', 'missing', 'absent', 'checkout_needed', 'plan_missing', 'planned_exceptions'];

// Paged queues and the id field used to de-duplicate appended pages.
export const QUEUE_KEYS = { unresolved_sessions: 'attendance_id', failed_messages: 'id', draft_messages: 'id', makeup_drafts: 'batch_id' };
// Which paged queue feeds each bucket ("더 보기" target). 'scheduled' never has older rows.
export const BUCKET_QUEUE = {
  present: 'unresolved_sessions', late: 'unresolved_sessions', missing: 'unresolved_sessions', absent: 'unresolved_sessions',
  checkout_needed: 'unresolved_sessions', plan_missing: 'unresolved_sessions', planned_exceptions: 'unresolved_sessions',
  message_failed: 'failed_messages', message_draft: 'draft_messages', planned_absence_drafts: 'makeup_drafts', makeup_followup: 'makeup_drafts',
};

const asRows = (value) => (Array.isArray(value) ? value.filter((row) => row && typeof row === 'object') : []);
const hasFollowup = (row, kind) => Array.isArray(row.open_followups) && row.open_followups.includes(kind);
const activeException = (row) => row.exception && row.exception.status === 'active';
const sessionOf = (row) => ({
  starts_at: row.starts_at, ends_at: row.ends_at, status: row.session_status ?? 'scheduled',
  missing_after_minutes: row.missing_after_minutes,
});
const aggregate = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
const queueMeta = (snapshot, queue) => {
  const meta = snapshot?.queues?.[queue];
  return meta && typeof meta === 'object' ? meta : null;
};

function classifySessions(rows, now) {
  const lists = Object.fromEntries(SESSION_BUCKETS.map((key) => [key, []]));
  for (const row of rows.filter((r) => (r.session_status ?? 'scheduled') !== 'cancelled')) {
    const status = row.status;
    if (status === 'scheduled') {
      if (activeException(row)) lists.planned_exceptions.push(row);
      else if (hasFollowup(row, 'missing') || isMissingAttendance(row, sessionOf(row), now)) lists.missing.push(row);
      else lists.scheduled.push(row);
    } else if (status === 'present' || status === 'late') {
      lists[status].push(row);
      if (hasFollowup(row, 'checkout_needed') || isCheckoutOverdue(row, sessionOf(row), now)) lists.checkout_needed.push(row);
      if (row.plan_status !== 'published') lists.plan_missing.push(row);
    } else if (status === 'absent' || status === 'excused') {
      lists.absent.push(row);
    }
  }
  return lists;
}

export function buildOperationsBuckets(snapshot, now = new Date()) {
  const lists = {};
  const counts = {};
  const today = classifySessions(asRows(snapshot?.sessions), now);
  const older = classifySessions(asRows(snapshot?.unresolved_sessions), now);
  const olderMeta = queueMeta(snapshot, 'unresolved_sessions');
  for (const key of SESSION_BUCKETS) {
    lists[key] = [...today[key], ...older[key]];
    const total = aggregate(olderMeta?.[key]);
    counts[key] = today[key].length + (total === null ? older[key].length : Math.max(total, older[key].length));
  }
  lists.message_failed = asRows(snapshot?.failed_messages).filter((m) => !m.manual_followup_at);
  lists.message_draft = asRows(snapshot?.draft_messages).filter((m) => m.status === 'draft' || m.status === 'approved');
  const batches = asRows(snapshot?.makeup_drafts);
  lists.planned_absence_drafts = batches.filter((b) => b.origin === 'planned_absence' && b.status === 'draft');
  lists.makeup_followup = batches.filter((b) => b.status === 'manual_followup');
  const paged = (key, total) => (total === null ? lists[key].length : Math.max(total, lists[key].length));
  counts.message_failed = paged('message_failed', aggregate(queueMeta(snapshot, 'failed_messages')?.total));
  counts.message_draft = paged('message_draft', aggregate(queueMeta(snapshot, 'draft_messages')?.total));
  const draftMeta = queueMeta(snapshot, 'makeup_drafts');
  counts.planned_absence_drafts = paged('planned_absence_drafts', aggregate(draftMeta?.planned_absence_drafts));
  counts.makeup_followup = paged('makeup_followup', aggregate(draftMeta?.makeup_followup));
  return {
    counts: Object.fromEntries(DASHBOARD_BUCKETS.map((key) => [key, counts[key]])),
    lists: Object.fromEntries(DASHBOARD_BUCKETS.map((key) => [key, lists[key]])),
  };
}

// Appends a keyset page to a snapshot queue without duplicates; returns a new snapshot.
export function mergeQueuePage(snapshot, queue, page) {
  if (!Object.hasOwn(QUEUE_KEYS, queue)) throw new Error('invalid queue');
  const idKey = QUEUE_KEYS[queue];
  const existing = asRows(snapshot?.[queue]);
  const seen = new Set(existing.map((row) => row[idKey]));
  const appended = asRows(page?.items).filter((row) => {
    if (seen.has(row[idKey])) return false;
    seen.add(row[idKey]);
    return true;
  });
  const meta = queueMeta(snapshot, queue) || {};
  return {
    ...snapshot,
    [queue]: [...existing, ...appended],
    queues: {
      ...(snapshot?.queues || {}),
      [queue]: { ...meta, has_more: page?.has_more === true, next_cursor: typeof page?.next_cursor === 'string' ? page.next_cursor : null },
    },
  };
}

// ── realtime + polling ──────────────────────────────────────────────────────
// Secret-free refresh signal only. Operational rows, codes, recipients, tokens and audit
// data are never delivered through Realtime; the client reloads a narrow admin RPC snapshot.
export const OPS_REALTIME_TABLES = Object.freeze([
  'operations_refresh_events',
]);
export const OPS_POLL_MS = 30_000;
export const OPS_REALTIME_DEBOUNCE_MS = 500;

// Single-flight background refresh: realtime bursts are debounced into one request, polling
// stays on as a safety net even after SUBSCRIBED, and at most one refresh runs with at most
// one queued behind it. stop() removes the channel and every timer.
export function createLiveRefresh({
  client, refresh, isActive = () => true, tables = OPS_REALTIME_TABLES,
  pollMs = OPS_POLL_MS, debounceMs = OPS_REALTIME_DEBOUNCE_MS, channelName = 'admin-today-operations',
}) {
  let started = false;
  let stopped = false;
  let channel = null;
  let poll = null;
  let debounce = null;
  let inFlight = null;
  let queued = null;
  let status = 'idle';

  function run() {
    let pending;
    try {
      pending = Promise.resolve(refresh());
    } catch (error) {
      pending = Promise.reject(error);
    }
    inFlight = pending.catch(() => {}).finally(() => { inFlight = null; });
    return inFlight;
  }
  function request() {
    if (stopped) return Promise.resolve();
    if (inFlight) {
      if (!queued) {
        queued = inFlight.then(() => {
          queued = null;
          return stopped ? undefined : run();
        });
      }
      return queued;
    }
    return run();
  }
  function onChange() {
    if (stopped || debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      if (!stopped && isActive()) request();
    }, debounceMs);
  }
  function start() {
    if (started || stopped) return;
    started = true;
    poll = setInterval(() => { if (!stopped && isActive()) request(); }, pollMs);
    if (client && typeof client.channel === 'function') {
      const ch = client.channel(channelName);
      for (const table of tables) ch.on('postgres_changes', { event: '*', schema: 'public', table }, onChange);
      ch.subscribe((next) => { status = next; });
      channel = ch;
    }
  }
  function stop() {
    stopped = true;
    if (poll) clearInterval(poll);
    if (debounce) clearTimeout(debounce);
    poll = null;
    debounce = null;
    if (channel && typeof client?.removeChannel === 'function') {
      Promise.resolve(client.removeChannel(channel)).catch(() => {});
    }
    channel = null;
  }
  return { start, stop, request, status: () => status };
}

export const CONFLICT_COPY = '다른 사용자가 먼저 변경했습니다. 최신 상태를 확인해 주세요.';
export const REFRESH_FAILED_COPY = '처리는 완료됐지만 화면 새로고침에 실패했습니다.';

export function mutationErrorCopy(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (error?.code === '40001' || /state changed|revision changed/.test(message)) return CONFLICT_COPY;
  return message || '처리하지 못했습니다.';
}

// Latest-only refresh guard plus truthful mutation/refresh reporting.
export function createRefreshCoordinator(apply) {
  let latest = 0;
  async function refresh(load) {
    latest += 1;
    const ticket = latest;
    let data;
    try {
      data = await load();
    } catch (error) {
      if (ticket !== latest) return false;
      throw error;
    }
    if (ticket !== latest) return false;
    apply(data);
    return true;
  }
  async function mutate(run, load) {
    try {
      await run();
    } catch (error) {
      return { committed: false, refreshed: false, message: mutationErrorCopy(error) };
    }
    try {
      await refresh(load);
      return { committed: true, refreshed: true, message: '' };
    } catch {
      return { committed: true, refreshed: false, message: REFRESH_FAILED_COPY };
    }
  }
  return { refresh, mutate, isLatest: (ticket) => ticket === latest };
}
