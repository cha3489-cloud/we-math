import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { clearLearningPlan, createLearningPlanController, renderLearningPlan, isLearningPlanBackendMissing } from '../src/tablet/learning-plan-view.js';

const root = resolve(import.meta.dirname, '..');
const doc = () => new JSDOM('<section id=todayPlan><p id=todayPlanWarning></p><ol id=todayPlanItems></ol><p id=todayPlanStatus></p></section>').window.document;
const ready = (patch = {}) => ({
  status: 'ready', revision: 2, remaining_priority_count: 1, new_progress_approved: false,
  items: [
    { id: 'i1', item_type: 'homework', title: '<b>숙제</b>', body: '', student_status: 'pending', teacher_status: 'pending', locked: false },
    { id: 'i2', item_type: 'redo', title: '재풀이', body: '', student_status: 'submitted', teacher_status: 'pending', locked: false },
    { id: 'i3', item_type: 'auto_progress', title: '새 진도', body: '', student_status: 'pending', teacher_status: 'pending', locked: true },
    { id: 'i4', item_type: 'note', title: '메모', body: '', student_status: 'pending', teacher_status: 'pending', locked: false },
  ],
  ...patch,
});

describe('learning tablet plan snapshot', () => {
  it('shows a preparing message instead of an empty screen when no plan is published', () => {
    const d = doc();
    renderLearningPlan(d, { status: 'preparing' }, {});
    expect(d.getElementById('todayPlanStatus').textContent).toBe('오늘 계획 준비 중 · 매쓰플랫 먼저 시작');
    expect(d.getElementById('todayPlanItems').children).toHaveLength(0);
  });

  it('renders items in snapshot order with a warning, locked new progress, and submitted-only completion', () => {
    const d = doc();
    const onSubmit = vi.fn();
    renderLearningPlan(d, ready(), { onSubmit });
    const items = [...d.querySelectorAll('#todayPlanItems li')];
    expect(items.map((li) => li.dataset.itemType)).toEqual(['homework', 'redo', 'auto_progress', 'note']);
    expect(d.querySelector('#todayPlanItems b')).toBeNull();
    expect(items[0].querySelector('strong').textContent).toBe('<b>숙제</b>');
    expect(d.getElementById('todayPlanWarning').textContent).toBe('먼저 확인할 숙제·재풀이가 1건 남아 있어요. 선생님 확인 후 새 진도를 시작해요.');
    expect(items[0].querySelector('button').textContent).toBe('완료 제출');
    expect(items[1].querySelector('.plan-item-state').textContent).toBe('선생님 확인 중');
    expect(items[1].querySelector('button')).toBeNull();
    expect(items[2].querySelector('button').disabled).toBe(true);
    expect(items[2].querySelector('.plan-item-state').textContent).toBe('선생님 확인 후 시작');
    expect(items[3].querySelector('button')).toBeNull();
    items[0].querySelector('button').click();
    expect(onSubmit).toHaveBeenCalledWith('i1');
  });

  it('shows teacher confirmation as final and clears the warning when nothing remains', () => {
    const d = doc();
    renderLearningPlan(d, ready({ remaining_priority_count: 0, items: [{ id: 'i1', item_type: 'homework', title: '숙제', student_status: 'submitted', teacher_status: 'confirmed', locked: false }] }), {});
    expect(d.getElementById('todayPlanWarning').textContent).toBe('');
    expect(d.querySelector('.plan-item-state').textContent).toBe('확인 완료');
  });

  it('clears and hides the prior student plan synchronously on logout', () => {
    const d = doc();
    renderLearningPlan(d, ready(), {});
    clearLearningPlan(d);
    expect(d.getElementById('todayPlan').hidden).toBe(true);
    expect(d.getElementById('todayPlanItems').children).toHaveLength(0);
    expect(d.getElementById('todayPlanWarning').textContent).toBe('');
    expect(d.getElementById('todayPlanStatus').textContent).toBe('');
  });

  it('hides the section only for the exact missing-function rollout error', () => {
    expect(isLearningPlanBackendMissing({ code: 'PGRST202', message: 'Could not find the function public.student_today_learning_plan without parameters' })).toBe(true);
    expect(isLearningPlanBackendMissing({ code: '42883', message: 'function public.student_today_learning_plan() does not exist' })).toBe(true);
    expect(isLearningPlanBackendMissing({ code: '42501', message: 'permission denied for function student_today_learning_plan' })).toBe(false);
    expect(isLearningPlanBackendMissing({ code: 'PGRST202', message: 'Could not find the function public.other' })).toBe(false);
    expect(isLearningPlanBackendMissing(null)).toBe(false);
  });

  it('wires the tablet to the shared snapshot RPC while keeping phone + PIN login', () => {
    const main = readFileSync(resolve(root, 'src/tablet/main.js'), 'utf8');
    const html = readFileSync(resolve(root, 'tablet/index.html'), 'utf8');
    expect(main).toContain("rpc('student_today_learning_plan')");
    expect(main).toContain("rpc('student_submit_learning_item'");
    expect(html).toContain('id=todayPlan ');
    expect(html).toContain('id=loginForm');
    expect(main).not.toContain('kiosk_attendance');
  });
});

describe('learning tablet plan logout race', () => {
  const deferred = () => { let resolve; let reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
  const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };
  function harness() {
    const d = doc();
    const submits = [];
    let user = 'student-a';
    const loadPlan = vi.fn(() => Promise.resolve({ data: ready(), error: null }));
    const submitItem = vi.fn(() => { const call = deferred(); submits.push(call); return call.promise; });
    const plan = createLearningPlanController(d, { loadPlan, submitItem, currentUser: () => user });
    return { d, plan, submits, loadPlan, submitItem, setUser: (next) => { user = next; } };
  }
  const expectCleared = (d) => {
    expect(d.getElementById('todayPlan').hidden).toBe(true);
    expect(d.getElementById('todayPlanItems').children).toHaveLength(0);
    expect(d.getElementById('todayPlanStatus').textContent).toBe('');
    expect(d.getElementById('todayPlanWarning').textContent).toBe('');
  };

  it('loads and submits for the current student, then reloads the plan', async () => {
    const { d, plan, submits, loadPlan, submitItem } = harness();
    await plan.load();
    expect(d.getElementById('todayPlan').hidden).toBe(false);
    d.querySelector('#todayPlanItems li button').click();
    expect(submitItem).toHaveBeenCalledWith('i1');
    submits[0].resolve({ error: null });
    await flush();
    expect(loadPlan).toHaveBeenCalledTimes(2);
    expect(d.getElementById('todayPlanItems').children).toHaveLength(4);
  });

  it('does not repopulate the prior student plan when a submit succeeds after logout', async () => {
    const { d, plan, submits, loadPlan, setUser } = harness();
    await plan.load();
    const pending = plan.submit('i1');
    plan.reset();
    setUser(null);
    expectCleared(d);
    submits[0].resolve({ error: null });
    await pending;
    await flush();
    expect(loadPlan).toHaveBeenCalledTimes(1);
    expectCleared(d);
  });

  it('does not post an error when a submit fails after logout', async () => {
    const { d, plan, submits, loadPlan, setUser } = harness();
    await plan.load();
    const pending = plan.submit('i1');
    plan.reset();
    setUser(null);
    submits[0].resolve({ error: { message: 'priority items remain' } });
    await pending;
    expect(loadPlan).toHaveBeenCalledTimes(1);
    expectCleared(d);

    const second = plan.submit('i1');
    plan.reset();
    submits[1].reject(new Error('Failed to fetch'));
    await expect(second).resolves.toBeUndefined();
    expect(loadPlan).toHaveBeenCalledTimes(1);
    expectCleared(d);
  });

  it('ignores a submit response when the signed-in student changed without an explicit reset', async () => {
    const { d, plan, submits, loadPlan, setUser } = harness();
    await plan.load();
    clearLearningPlan(d);
    const pending = plan.submit('i1');
    setUser('student-b');
    submits[0].resolve({ error: { message: 'boom' } });
    await pending;
    expect(loadPlan).toHaveBeenCalledTimes(1);
    expectCleared(d);
  });

  it('wires logout and the tablet submit path through the session-guarded controller', () => {
    const main = readFileSync(resolve(root, 'src/tablet/main.js'), 'utf8');
    expect(main).toContain('createLearningPlanController(document');
    expect(main).toMatch(/addEventListener\('click', async \(\) => \{\s*\/\/[^\n]*\n\s*learningPlan[.]reset\(\);/);
    expect(main).not.toContain('async function submitLearningItem');
  });
});
