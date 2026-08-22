import { describe, expect, it } from 'vitest';
import {
  DIFFICULTY_TAGS, MAX_NOTE_LENGTH, TAG_BLOCK, NOTE_BLOCK,
  normalizeTags, toggleTag, normalizeNote,
  composeSubmissionBody, parseSubmissionBody, difficultyPickerModel,
} from '../src/tablet/difficulty.js';

describe('difficulty tag options', () => {
  it('offers the six starting choices from the PRD', () => {
    expect(DIFFICULTY_TAGS).toEqual([
      '식 세우기',
      '계산',
      '개념이 기억 안 남',
      '문제를 읽고 뭘 해야 할지 모르겠음',
      '풀이 중간에서 막힘',
      '기타',
    ]);
  });

  it('asks where the student got stuck, not what they got wrong', () => {
    // 문구가 학생을 탓하는 쪽으로 바뀌지 않게 고정한다.
    for (const tag of DIFFICULTY_TAGS) {
      expect(tag).not.toMatch(/틀린|실수|못함|부족/);
    }
  });
});

describe('selecting tags', () => {
  it('allows more than one tag at a time', () => {
    let selected = toggleTag([], '식 세우기');
    selected = toggleTag(selected, '계산');
    expect(selected).toEqual(['식 세우기', '계산']);
  });

  it('turns a tag back off when tapped again', () => {
    const selected = toggleTag(toggleTag([], '계산'), '계산');
    expect(selected).toEqual([]);
  });

  it('keeps the list order stable no matter the tap order', () => {
    const a = toggleTag(toggleTag([], '기타'), '식 세우기');
    const b = toggleTag(toggleTag([], '식 세우기'), '기타');
    expect(a).toEqual(b);
    expect(a).toEqual(['식 세우기', '기타']);
  });

  it('ignores a tag that is not on the list', () => {
    expect(toggleTag(['계산'], '아무거나')).toEqual(['계산']);
    expect(toggleTag([], null)).toEqual([]);
  });

  it('drops unknown values when normalising', () => {
    expect(normalizeTags(['계산', '없는항목', '식 세우기'])).toEqual(['식 세우기', '계산']);
    expect(normalizeTags(null)).toEqual([]);
    expect(normalizeTags('계산')).toEqual([]);
  });
});

describe('note handling', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeNote('  3번이 어려워요.  ')).toBe('3번이 어려워요.');
  });

  it('collapses runs of blank lines but keeps a single break', () => {
    expect(normalizeNote('첫줄\n\n\n\n둘째줄')).toBe('첫줄\n\n둘째줄');
    expect(normalizeNote('첫줄\n둘째줄')).toBe('첫줄\n둘째줄');
  });

  it('normalises windows line endings', () => {
    expect(normalizeNote('첫줄\r\n둘째줄')).toBe('첫줄\n둘째줄');
  });

  it('caps a very long note', () => {
    expect(normalizeNote('가'.repeat(500))).toHaveLength(MAX_NOTE_LENGTH);
  });

  it('handles empty input', () => {
    for (const value of ['', '   ', null, undefined]) expect(normalizeNote(value)).toBe('');
  });
});

describe('composing the submission body', () => {
  it('writes both blocks in the agreed format', () => {
    const body = composeSubmissionBody(
      ['식 세우기', '문제를 읽고 뭘 해야 할지 모르겠음'],
      '3번에서 식을 어떻게 세워야 할지 모르겠어요.',
    );
    expect(body).toBe(
      '[막힌 지점]\n식 세우기, 문제를 읽고 뭘 해야 할지 모르겠음\n\n'
      + '[학생 메모]\n3번에서 식을 어떻게 세워야 할지 모르겠어요.',
    );
  });

  it('stays empty when the student picked nothing and wrote nothing', () => {
    // 사진만 내도 제출은 되어야 하므로 빈 문자열이어야 한다.
    expect(composeSubmissionBody([], '')).toBe('');
    expect(composeSubmissionBody(null, null)).toBe('');
    expect(composeSubmissionBody([], '   ')).toBe('');
  });

  it('writes only the tag block when there is no note', () => {
    expect(composeSubmissionBody(['계산'], '')).toBe('[막힌 지점]\n계산');
  });

  it('writes only the note block when nothing was picked', () => {
    expect(composeSubmissionBody([], '그냥 어려웠어요.')).toBe('[학생 메모]\n그냥 어려웠어요.');
  });

  it('keeps special characters as written', () => {
    const note = '2 < 3 이고 a&b "인용" \'따옴표\' 100% <script>x</script>';
    expect(composeSubmissionBody([], note)).toContain(note);
  });
});

describe('parsing a stored body back', () => {
  const roundTrip = (tags, note) => parseSubmissionBody(composeSubmissionBody(tags, note));

  it('reads back exactly what was written', () => {
    const result = roundTrip(['계산', '기타'], '13번이 헷갈려요.');
    expect(result.tags).toEqual(['계산', '기타']);
    expect(result.note).toBe('13번이 헷갈려요.');
    expect(result.rest).toBe('');
  });

  it('reads a tag-only body', () => {
    const result = roundTrip(['풀이 중간에서 막힘'], '');
    expect(result.tags).toEqual(['풀이 중간에서 막힘']);
    expect(result.note).toBe('');
  });

  it('reads a note-only body', () => {
    const result = roundTrip([], '메모만 남겼어요.');
    expect(result.tags).toEqual([]);
    expect(result.note).toBe('메모만 남겼어요.');
  });

  it('keeps a multi-line note intact', () => {
    const note = '첫째 줄입니다.\n\n둘째 줄입니다.';
    expect(roundTrip(['계산'], note).note).toBe(note);
  });

  it('returns empty parts for an empty body', () => {
    for (const value of ['', '   ', null, undefined]) {
      const result = parseSubmissionBody(value);
      expect(result).toEqual({ tags: [], note: '', rest: '' });
    }
  });

  it('does not lose an older free-text submission that has no markers', () => {
    // 규약 이전에 저장된 본문도 화면에서 사라지면 안 된다.
    const result = parseSubmissionBody('예전에 그냥 적은 내용입니다.');
    expect(result.tags).toEqual([]);
    expect(result.note).toBe('');
    expect(result.rest).toBe('예전에 그냥 적은 내용입니다.');
  });

  it('ignores a marker-looking line that a student typed inside the note', () => {
    const note = '문제에 [막힌 지점] 이라고 적혀 있었어요';
    const result = roundTrip(['계산'], note);
    expect(result.tags).toEqual(['계산']);
    expect(result.note).toBe(note);
  });

  it('drops a tag that is no longer on the list', () => {
    const result = parseSubmissionBody('[막힌 지점]\n계산, 폐기된항목');
    expect(result.tags).toEqual(['계산']);
  });
});

describe('picker view model', () => {
  it('marks which tags are on', () => {
    const model = difficultyPickerModel(['계산'], '');
    expect(model.options).toHaveLength(DIFFICULTY_TAGS.length);
    expect(model.options.find((option) => option.tag === '계산').selected).toBe(true);
    expect(model.options.find((option) => option.tag === '기타').selected).toBe(false);
    expect(model.selectedCount).toBe(1);
  });

  it('reports remaining note characters', () => {
    const model = difficultyPickerModel([], '가나다');
    expect(model.noteLength).toBe(3);
    expect(model.remaining).toBe(MAX_NOTE_LENGTH - 3);
  });

  it('tells whether a body will be attached at all', () => {
    expect(difficultyPickerModel([], '').willAttachBody).toBe(false);
    expect(difficultyPickerModel(['계산'], '').willAttachBody).toBe(true);
    expect(difficultyPickerModel([], '메모').willAttachBody).toBe(true);
  });

  it('exposes the block markers used by the stored format', () => {
    expect(TAG_BLOCK).toBe('[막힌 지점]');
    expect(NOTE_BLOCK).toBe('[학생 메모]');
  });
});
