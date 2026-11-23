// Pure learning-plan rules shared by the admin workspace and the learning tablet.
// The database publish function applies the same priority order; this mirrors it for drafting/display.

export const PLAN_ITEM_ORDER = ['homework', 'redo', 'carryover', 'auto_progress', 'mathflat', 'note'];
export const PRIORITY_TYPES = new Set(['homework', 'redo', 'carryover']);
export const NEW_PROGRESS_TYPES = new Set(['auto_progress', 'mathflat']);

function validItem(item) {
  return item && typeof item === 'object' && PLAN_ITEM_ORDER.includes(item.item_type)
    && typeof item.title === 'string' && item.title.trim() !== '';
}

export function orderPlanItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => validItem(item))
    .sort((a, b) => (PLAN_ITEM_ORDER.indexOf(a.item.item_type) - PLAN_ITEM_ORDER.indexOf(b.item.item_type)) || (a.index - b.index))
    .map(({ item }) => item);
}

const isProgress = (item) => item && ['auto_progress', 'carryover'].includes(item.item_type) && Number.isInteger(item.progress_sequence);

// Only a teacher confirmation counts as completed progress.
export function suggestNextProgress(previousItems, catalog, count = 1) {
  const previous = Array.isArray(previousItems) ? previousItems.filter(isProgress) : [];
  const ordered = Array.isArray(catalog)
    ? catalog.filter((entry) => entry && Number.isInteger(entry.progress_sequence) && typeof entry.title === 'string')
      .slice().sort((a, b) => a.progress_sequence - b.progress_sequence)
    : [];
  const confirmed = previous.filter((item) => item.teacher_status === 'confirmed').map((item) => item.progress_sequence);
  const lastDone = confirmed.length ? Math.max(...confirmed) : 0;
  const carried = previous
    .filter((item) => item.teacher_status !== 'confirmed')
    .sort((a, b) => a.progress_sequence - b.progress_sequence)
    .map((item) => ({ item_type: 'carryover', progress_sequence: item.progress_sequence, title: item.title }));
  const carriedSeq = new Set(carried.map((item) => item.progress_sequence));
  const fresh = ordered
    .filter((entry) => entry.progress_sequence > lastDone && !carriedSeq.has(entry.progress_sequence))
    .slice(0, Math.max(0, count))
    .map((entry) => ({ item_type: 'auto_progress', progress_sequence: entry.progress_sequence, title: entry.title }));
  return [...carried, ...fresh];
}

export function planGate(items, newProgressApproved) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const remaining = list.filter((item) => PRIORITY_TYPES.has(item.item_type) && item.teacher_status !== 'confirmed').length;
  return { remaining, newProgressLocked: remaining > 0 && !newProgressApproved, warning: remaining > 0 };
}
