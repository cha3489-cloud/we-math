import { describe, expect, it } from 'vitest';
import { buildOperationsBuckets, DASHBOARD_BUCKETS, createRefreshCoordinator } from '../src/portal/operations-dashboard.js';

const NOW = '2099-11-16T09:10:00.000Z';
const base = { session_status: 'scheduled', starts_at: '2099-11-16T07:00:00.000Z', ends_at: '2099-11-16T08:30:00.000Z', open_followups: [], exception: null, plan_status: null };
const row = (id, patch) => ({ ...base, attendance_id: id, student_name: '학생' + id, status: 'scheduled', checked_in_at: null, checked_out_at: null, ...patch });

const snapshot = {
  sessions: [
    row('a', { starts_at: '2099-11-16T10:00:00.000Z', ends_at: '2099-11-16T11:00:00.000Z' }),
    row('b'),
    row('c', { exception: { type: 'expected_late', status: 'active' } }),
    row('d', { status: 'present', checked_in_at: '2099-11-16T06:55:00.000Z', plan_status: 'published' }),
    row('e', { status: 'late', checked_in_at: '2099-11-16T07:05:00.000Z', checked_out_at: '2099-11-16T08:31:00.000Z', plan_status: 'draft' }),
    row('f', { status: 'absent' }),
    row('g', { status: 'present', checked_in_at: '2099-11-15T06:55:00.000Z', starts_at: '2099-11-15T07:00:00.000Z', ends_at: '2099-11-15T08:00:00.000Z', open_followups: ['checkout_needed'], plan_status: 'published' }),
    row('h', { session_status: 'cancelled' }),
  ],
  failed_messages: [
    { id: 'm1', manual_followup_at: null },
    { id: 'm2', manual_followup_at: '2099-11-16T08:00:00.000Z' },
  ],
  makeup_drafts: [
    { batch_id: 'k1', origin: 'planned_absence', status: 'draft' },
    { batch_id: 'k2', origin: 'absence', status: 'manual_followup' },
  ],
};

describe('today-first operations dashboard', () => {
  it('derives every count from exactly the list it shows', () => {
    const { counts, lists } = buildOperationsBuckets(snapshot, NOW);
    for (const key of DASHBOARD_BUCKETS) expect(counts[key]).toBe(lists[key].length);
    const ids = (key) => lists[key].map((r) => r.attendance_id || r.id || r.batch_id);
    expect(ids('scheduled')).toEqual(['a']);
    expect(ids('missing')).toEqual(['b']);
    expect(ids('planned_exceptions')).toEqual(['c']);
    expect(ids('present')).toEqual(['d', 'g']);
    expect(ids('late')).toEqual(['e']);
    expect(ids('absent')).toEqual(['f']);
    expect(ids('checkout_needed')).toEqual(['d', 'g']);
    expect(ids('plan_missing')).toEqual(['e']);
    expect(ids('message_failed')).toEqual(['m1']);
    expect(ids('planned_absence_drafts')).toEqual(['k1']);
    expect(ids('makeup_followup')).toEqual(['k2']);
  });
  it('treats malformed or empty snapshots as empty instead of failing', () => {
    const { counts } = buildOperationsBuckets(null, NOW);
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    const { lists } = buildOperationsBuckets({ sessions: [null, 'x', { status: 'late' }], failed_messages: 'bad' }, NOW);
    expect(lists.late).toHaveLength(1);
    expect(lists.message_failed).toEqual([]);
  });
});

describe('refresh coordinator', () => {
  it('ignores stale overlapping refreshes and distinguishes committed mutations from refresh failures', async () => {
    const applied = [];
    const coordinator = createRefreshCoordinator((data) => applied.push(data));
    let resolveSlow;
    const slow = coordinator.refresh(() => new Promise((resolve) => { resolveSlow = resolve; }));
    const fast = coordinator.refresh(async () => 'fresh');
    await fast;
    resolveSlow('stale');
    await slow;
    expect(applied).toEqual(['fresh']);

    const ok = await coordinator.mutate(async () => ({ id: 1 }), async () => { throw new Error('network'); });
    expect(ok).toEqual({ committed: true, refreshed: false, message: '처리는 완료됐지만 화면 새로고침에 실패했습니다.' });
    const failed = await coordinator.mutate(async () => { throw new Error('attendance state changed'); }, async () => 'x');
    expect(failed).toEqual({ committed: false, refreshed: false, message: '다른 사용자가 먼저 변경했습니다. 최신 상태를 확인해 주세요.' });
    const both = await coordinator.mutate(async () => ({ id: 2 }), async () => 'after');
    expect(both).toEqual({ committed: true, refreshed: true, message: '' });
    expect(applied.at(-1)).toBe('after');
  });

  it('suppresses an older failed refresh after a newer refresh has already won', async () => {
    const applied = [];
    const coordinator = createRefreshCoordinator((data) => applied.push(data));
    let rejectSlow;
    const slow = coordinator.refresh(() => new Promise((resolve, reject) => { rejectSlow = reject; }));
    await coordinator.refresh(async () => 'fresh');
    rejectSlow(new Error('stale network error'));
    await expect(slow).resolves.toBe(false);
    expect(applied).toEqual(['fresh']);
  });
});
