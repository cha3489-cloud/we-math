export type FeedbackItem = {
  problem_ref?: string;
  review_tag?: string;
  comment?: string;
  redo_required?: boolean;
};

export type LearningSyncRecord = {
  submissionId: string;
  studentName: string;
  assignmentTitle: string;
  assignmentDescription?: string;
  status: 'needs_revision' | 'completed';
  submittedAt?: string;
  reviewedAt?: string;
  feedbackBody?: string;
  internalNote?: string;
  items?: FeedbackItem[];
};

export function validateSubmissionId(value: unknown) {
  const id = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    throw new Error('invalid submission');
  }
  return id;
}

export const richText = (content: string) => content ? [{ text: { content: content.slice(0, 2000) } }] : [];
export const titleText = (content: string) => [{ text: { content: content.slice(0, 2000) || '학습기록' } }];
export const syncMarker = (submissionId: string) => `[we-math 제출ID: ${submissionId}]`;

export function cleanItems(items: FeedbackItem[] = []) {
  return items
    .map((item) => ({
      problem_ref: String(item?.problem_ref ?? '').trim(),
      review_tag: String(item?.review_tag ?? '').trim(),
      comment: String(item?.comment ?? '').trim(),
      redo_required: Boolean(item?.redo_required),
    }))
    .filter((item) => item.problem_ref || item.review_tag || item.comment);
}

export function notionMultiSelect(values: string[], max = 8) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .slice(0, max)
    .map((name) => ({ name }));
}

export function parentDraft(record: LearningSyncRecord, items = cleanItems(record.items)) {
  const redoItems = items.filter((item) => item.redo_required);
  const blocked = notionMultiSelect(items.map((item) => item.review_tag)).map((item) => item.name).join(', ');
  if (record.status === 'needs_revision') {
    const redo = redoItems.map((item) => item.problem_ref).filter(Boolean).join(', ');
    return `${record.studentName} 학생은 ${record.assignmentTitle}에서 다시 확인할 부분이 있습니다.`
      + (blocked ? ` 막힌 지점은 ${blocked}입니다.` : '')
      + (redo ? ` 재풀이 문항: ${redo}.` : '')
      + ' 다음 학습에서 같은 유형을 짧게 재확인하겠습니다.';
  }
  return `${record.studentName} 학생은 ${record.assignmentTitle} 제출을 완료했습니다.`
    + (blocked ? ` 확인한 포인트는 ${blocked}입니다.` : '')
    + ' 다음 진도로 이어가겠습니다.';
}

export function buildDailyLearningPage(dailyDataSourceId: string, record: LearningSyncRecord) {
  const items = cleanItems(record.items);
  const redoRequired = items.some((item) => item.redo_required);
  const reviewed = record.reviewedAt ? record.reviewedAt.slice(0, 10) : new Date().toISOString().slice(0, 10);
  const issueTags = notionMultiSelect(items.map((item) => item.review_tag));
  const itemSummary = items.map((item) => {
    const head = [item.problem_ref, item.review_tag].filter(Boolean).join(' · ');
    return `${head}${item.redo_required ? ' · 다시풀기' : ''}${item.comment ? ' — ' + item.comment : ''}`;
  }).join('\n');
  const feedback = String(record.feedbackBody ?? '').trim();
  const internal = String(record.internalNote ?? '').trim();
  const body = [feedback, itemSummary, internal ? `내부메모: ${internal}` : '', syncMarker(record.submissionId)]
    .filter(Boolean).join('\n\n');
  return {
    parent: { type: 'data_source_id', data_source_id: dailyDataSourceId },
    properties: {
      '제목': { title: titleText(`${reviewed} ${record.studentName} · ${record.assignmentTitle}`) },
      '수업날짜': { date: { start: reviewed } },
      '숙제': { select: { name: '제출' } },
      '테스트': { select: { name: '미실시' } },
      '공통진도': { rich_text: richText(record.assignmentTitle) },
      '개별진도': { rich_text: richText(record.assignmentDescription || record.assignmentTitle) },
      '막힌 지점': { multi_select: issueTags },
      '재풀이 결과': { select: { name: redoRequired ? '미실시' : '성공' } },
      '다음 관리강도': { select: { name: redoRequired ? '강화' : '유지' } },
      '한줄평': { rich_text: richText(feedback || (redoRequired ? '재풀이 확인 필요' : '제출 완료')) },
      '내부메모': { rich_text: richText(internal) },
      '학부모문안초안': { rich_text: richText(parentDraft(record, items)) },
      '발송승인': { select: { name: '초안' } },
      '작성완료': { checkbox: true },
      'we-math 출처ID': { rich_text: richText(`${record.submissionId}\n${syncMarker(record.submissionId)}`) },
    },
    children: [{
      object: 'block', type: 'paragraph',
      paragraph: { rich_text: richText('DB 기록 사본\n\n' + body) },
    }],
  };
}

export function buildQueuePage(queueDataSourceId: string, record: LearningSyncRecord) {
  const items = cleanItems(record.items);
  const redoRequired = record.status === 'needs_revision' || items.some((item) => item.redo_required);
  const reviewed = record.reviewedAt ? record.reviewedAt.slice(0, 10) : new Date().toISOString().slice(0, 10);
  return {
    parent: { type: 'data_source_id', data_source_id: queueDataSourceId },
    properties: {
      '업무명': { title: titleText(`${record.studentName} · ${record.assignmentTitle} · ${redoRequired ? '재풀이 확인' : '데일리레포트 검토'}`) },
      '업무분류': { multi_select: notionMultiSelect([redoRequired ? '재풀이확인' : '데일리레포트']) },
      '업무상태': { status: { name: '시작 전' } },
      '우선순위': { select: { name: redoRequired ? '높음' : '보통' } },
      '처리예정일': { date: { start: reviewed } },
      '자동생성출처': { select: { name: 'we-math 제출' } },
      '처리메모': { rich_text: richText(`${parentDraft(record, items)}\n\n${syncMarker(record.submissionId)}`) },
      '작성완료': { checkbox: false },
    },
    children: [{
      object: 'block', type: 'paragraph',
      paragraph: { rich_text: richText(`자동 생성 출처: ${syncMarker(record.submissionId)}`) },
    }],
  };
}
