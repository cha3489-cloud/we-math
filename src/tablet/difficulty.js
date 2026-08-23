// 적용 경로: src/tablet/difficulty.js
// "어디서 막혔나요?" 선택과 학생 메모를 제출 본문(submissions.body)에 담는 순수 로직.
// 스키마를 늘리지 않고 기존 text 컬럼을 쓰되, 나중에 파싱할 수 있게 형식을 고정한다.
//
// 저장 형식:
//   [막힌 지점]
//   식 세우기, 계산
//
//   [학생 메모]
//   3번에서 식을 어떻게 세워야 할지 모르겠어요.
//
// 둘 다 비어 있으면 빈 문자열을 반환한다. 사진만 내도 제출은 되어야 하기 때문이다.

// 문구는 "틀린 이유"가 아니라 "어디서 막혔는지"를 묻는 쪽으로 고른다.
export const DIFFICULTY_TAGS = [
  '식 세우기',
  '계산',
  '개념이 기억 안 남',
  '문제를 읽고 뭘 해야 할지 모르겠음',
  '풀이 중간에서 막힘',
  '기타',
];

export const MAX_NOTE_LENGTH = 300;

export const TAG_BLOCK = '[막힌 지점]';
export const NOTE_BLOCK = '[학생 메모]';

// 저장 순서는 고른 순서가 아니라 목록 순서로 고정한다. 같은 선택이면 늘 같은 텍스트가 된다.
export function normalizeTags(tags = []) {
  const chosen = new Set(Array.isArray(tags) ? tags : []);
  return DIFFICULTY_TAGS.filter((tag) => chosen.has(tag));
}

export function toggleTag(selected = [], tag) {
  if (!DIFFICULTY_TAGS.includes(tag)) return normalizeTags(selected);
  const chosen = new Set(normalizeTags(selected));
  if (chosen.has(tag)) chosen.delete(tag); else chosen.add(tag);
  return normalizeTags([...chosen]);
}

export function normalizeNote(note) {
  return String(note ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_NOTE_LENGTH);
}

export function composeSubmissionBody(tags = [], note = '') {
  const chosen = normalizeTags(tags);
  const clean = normalizeNote(note);
  const blocks = [];
  if (chosen.length) blocks.push(TAG_BLOCK + '\n' + chosen.join(', '));
  if (clean) blocks.push(NOTE_BLOCK + '\n' + clean);
  return blocks.join('\n\n');
}

// 저장된 본문을 다시 읽어 화면에 보여줄 때 쓴다.
// 규약을 쓰지 않은 예전 제출도 내용을 잃지 않도록 rest 로 돌려준다.
export function parseSubmissionBody(body) {
  const source = String(body ?? '').replace(/\r\n/g, '\n');
  if (!source.trim()) return { tags: [], note: '', rest: '' };

  const sections = [];
  const pattern = /^\[(막힌 지점|학생 메모)\]$/;
  let current = null;
  const before = [];
  for (const line of source.split('\n')) {
    if (pattern.test(line.trim())) {
      current = { name: line.trim(), lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else before.push(line);
  }

  const textOf = (name) => sections
    .filter((section) => section.name === name)
    .map((section) => section.lines.join('\n').trim())
    .filter(Boolean)
    .join('\n');

  const tagText = textOf(TAG_BLOCK);
  return {
    tags: normalizeTags(tagText.split(/[,\n]/).map((item) => item.trim())),
    note: textOf(NOTE_BLOCK),
    rest: before.join('\n').trim(),
  };
}

// 제출 영역 표시용. 아무것도 안 골라도 제출은 가능하다.
export function difficultyPickerModel(selected = [], note = '') {
  const chosen = normalizeTags(selected);
  return {
    options: DIFFICULTY_TAGS.map((tag) => ({ tag, selected: chosen.includes(tag) })),
    selectedCount: chosen.length,
    noteLength: normalizeNote(note).length,
    remaining: MAX_NOTE_LENGTH - normalizeNote(note).length,
    // 선택도 메모도 없으면 본문 없이 사진만 올라간다.
    willAttachBody: composeSubmissionBody(chosen, note) !== '',
  };
}
