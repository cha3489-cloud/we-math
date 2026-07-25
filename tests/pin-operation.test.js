import { describe, expect, it } from 'vitest';

const minute = 60_000;
const operationLease = 2 * minute;
const initial = () => ({ mustChange: true, generation: 0, resetExpires: null, operation: null, password: 'initial' });
const live = (state, now) => state.operation && state.operation.expires > now;
function beginReset(state, id, now) {
  if (live(state, now)) throw new Error('busy');
  return { ...state, mustChange: true, generation: state.generation + 1, resetExpires: now + 10 * minute,
    operation: { id, kind: 'reset', expires: now + operationLease } };
}
function finishReset(state, id, generation) {
  if (state.operation?.id !== id || state.operation.kind !== 'reset' || state.generation !== generation) return { state, finished: false };
  return { state: { ...state, operation: null }, finished: true };
}
function beginChange(state, expectedGeneration, id, now) {
  if (!state.mustChange || state.generation !== expectedGeneration) throw new Error('state changed');
  if (state.resetExpires !== null && state.resetExpires <= now) throw new Error('expired');
  if (live(state, now)) throw new Error('busy');
  return { ...state, operation: { id, kind: 'change', expires: now + operationLease } };
}
function finishChange(state, id, generation) {
  if (state.operation?.id !== id || state.operation.kind !== 'change' || state.generation !== generation) return { state, finished: false };
  return { state: { ...state, mustChange: false, resetExpires: null, operation: null }, finished: true };
}
const canUsePortal = (state) => !state.mustChange;

describe('PIN operation lease state machine', () => {
  it('orders reset begin -> Auth -> owned finish and remains blocked until finish', () => {
    let state = beginReset(initial(), 'reset-1', 0);
    expect(canUsePortal(state)).toBe(false);
    state = { ...state, password: '123456' }; // external Auth update
    const done = finishReset(state, 'reset-1', 1);
    expect(done.finished).toBe(true);
    expect(done.state).toMatchObject({ password: '123456', mustChange: true, resetExpires: 10 * minute, operation: null });
    expect(canUsePortal(done.state)).toBe(false);
  });
  it('orders change begin -> Auth -> owned finish before portal access', () => {
    let state = finishReset({ ...beginReset(initial(), 'reset', 0), password: '123456' }, 'reset', 1).state;
    state = beginChange(state, 1, 'change', minute);
    expect(() => beginReset(state, 'newer-reset', minute)).toThrow('busy');
    state = { ...state, password: '654321' }; // external Auth update
    const done = finishChange(state, 'change', 1);
    expect(done.finished).toBe(true); expect(canUsePortal(done.state)).toBe(true);
  });
  it('rejects stale ownership and generation so an old completion cannot clear a newer reset', () => {
    const newer = beginReset({ ...initial(), operation: { id: 'old', kind: 'change', expires: 1 } }, 'new-reset', 2);
    const stale = finishChange(newer, 'old', 0);
    expect(stale.finished).toBe(false);
    expect(stale.state).toMatchObject({ mustChange: true, generation: 1, operation: { id: 'new-reset' } });
  });
  it('expires reset eligibility but leaves initial-account change unexpired', () => {
    const reset = finishReset(beginReset(initial(), 'reset', 0), 'reset', 1).state;
    expect(() => beginChange(reset, 1, 'late', 10 * minute)).toThrow('expired');
    expect(beginChange(initial(), 0, 'initial-change', 100 * minute).operation.kind).toBe('change');
  });
  it('keeps Auth failures fail-closed and permits recovery after bounded lease expiry', () => {
    const failedReset = beginReset(initial(), 'crashed', 0); // no Auth update or finish
    expect(canUsePortal(failedReset)).toBe(false);
    expect(() => beginReset(failedReset, 'retry-too-soon', 30_000)).toThrow('busy');
    const retry = beginReset(failedReset, 'retry', operationLease + 1);
    expect(retry.generation).toBe(2); expect(retry.operation.id).toBe('retry');
  });
});
