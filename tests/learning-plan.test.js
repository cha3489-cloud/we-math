import { describe, expect, it } from 'vitest';
import { orderPlanItems, suggestNextProgress, planGate } from '../src/portal/learning-plan.js';

describe('learning plan ordering', () => {
  it('orders overdue homework, redo, carried progress, then new progress and plan items, keeping input order within a type', () => {
    const ordered = orderPlanItems([
      { item_type: 'mathflat', title: 'M' },
      { item_type: 'auto_progress', title: 'P' },
      { item_type: 'redo', title: 'R1' },
      { item_type: 'carryover', title: 'C' },
      { item_type: 'homework', title: 'H' },
      { item_type: 'redo', title: 'R2' },
      { item_type: 'note', title: 'N' },
    ]);
    expect(ordered.map((i) => i.title)).toEqual(['H', 'R1', 'R2', 'C', 'P', 'M', 'N']);
  });
  it('drops malformed items instead of inventing work', () => {
    expect(orderPlanItems(null)).toEqual([]);
    expect(orderPlanItems([null, { item_type: 'bogus', title: 'x' }, { item_type: 'homework', title: '' }, { item_type: 'homework', title: 'ok' }]).map((i) => i.title)).toEqual(['ok']);
  });
});

describe('next progress suggestion', () => {
  const catalog = [1, 2, 3, 4, 5, 6].map((n) => ({ progress_sequence: n, title: '단원 ' + n }));
  it('carries incomplete planned progress first, then continues after the last teacher-confirmed item', () => {
    const previous = [
      { item_type: 'auto_progress', progress_sequence: 3, title: '단원 3', teacher_status: 'confirmed' },
      { item_type: 'auto_progress', progress_sequence: 4, title: '단원 4', teacher_status: 'pending', student_status: 'submitted' },
    ];
    expect(suggestNextProgress(previous, catalog, 2)).toEqual([
      { item_type: 'carryover', progress_sequence: 4, title: '단원 4' },
      { item_type: 'auto_progress', progress_sequence: 5, title: '단원 5' },
      { item_type: 'auto_progress', progress_sequence: 6, title: '단원 6' },
    ]);
  });
  it('never treats student submission or attendance as completed progress', () => {
    const previous = [{ item_type: 'auto_progress', progress_sequence: 1, title: '단원 1', teacher_status: 'pending', student_status: 'submitted' }];
    expect(suggestNextProgress(previous, catalog, 1)[0]).toEqual({ item_type: 'carryover', progress_sequence: 1, title: '단원 1' });
  });
  it('starts from the beginning of the catalog without history and returns nothing for empty catalogs', () => {
    expect(suggestNextProgress([], catalog, 1)).toEqual([{ item_type: 'auto_progress', progress_sequence: 1, title: '단원 1' }]);
    expect(suggestNextProgress(undefined, [], 2)).toEqual([]);
  });
});

describe('plan gate', () => {
  it('warns while priority work is unconfirmed and unlocks only after confirmation or explicit approval', () => {
    const items = [
      { item_type: 'homework', teacher_status: 'pending', student_status: 'submitted' },
      { item_type: 'auto_progress', teacher_status: 'pending' },
    ];
    expect(planGate(items, false)).toEqual({ remaining: 1, newProgressLocked: true, warning: true });
    expect(planGate(items, true)).toEqual({ remaining: 1, newProgressLocked: false, warning: true });
    expect(planGate([{ item_type: 'homework', teacher_status: 'confirmed' }], false)).toEqual({ remaining: 0, newProgressLocked: false, warning: false });
  });
});
