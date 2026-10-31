const pad = (value) => String(value).padStart(2, '0');

function isoDate(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function parseIso(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date, amount) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + amount);
  return next;
}

function monthBounds(year, month) {
  return {
    start: `${year}-${pad(month)}-01`,
    end: isoDate(new Date(Date.UTC(year, month, 0))),
  };
}

function overlaps(event, startDate, endDate) {
  return event.startDate <= endDate && event.endDate >= startDate;
}

export function filterSchoolCalendarEvents(events, filters = {}) {
  const school = filters.school || '';
  const type = filters.type || '';
  const year = String(filters.year || '');
  const yearStart = year ? `${year}-01-01` : '';
  const yearEnd = year ? `${year}-12-31` : '';
  return events.filter((event) => {
    if (school && event.school !== school && event.scope !== 'common') return false;
    if (type && event.type !== type) return false;
    if (year && !overlaps(event, yearStart, yearEnd)) return false;
    return true;
  });
}

export function calendarMonthCells(year, month, events = []) {
  const { start, end } = monthBounds(year, month);
  const first = parseIso(start);
  const last = parseIso(end);
  const firstWeekday = first.getUTCDay() || 7;
  const lastWeekday = last.getUTCDay() || 7;
  const gridStart = addDays(first, 1 - firstWeekday);
  const gridEnd = addDays(last, 7 - lastWeekday);
  const cells = [];
  for (let day = gridStart; day <= gridEnd; day = addDays(day, 1)) {
    const dayIso = isoDate(day);
    cells.push({
      date: dayIso,
      day: day.getUTCDate(),
      inMonth: dayIso >= start && dayIso <= end,
      events: events.filter((event) => overlaps(event, dayIso, dayIso)),
    });
  }
  return cells;
}

export function schoolCalendarPublicationNote(data, year) {
  if (Number(year) === 2027 && data.publication?.['2027SchoolYear']?.status === 'unpublished') {
    return '2027학년도 3월 이후 일정은 미발표입니다. 현재는 공식 공개된 2026학년도 연장 일정만 표시하며 추정 일정은 넣지 않았습니다.';
  }
  return `${year}년 학교별 공식 학사일정 확인본 · 마지막 확인 ${data.checkedAt}`;
}

function createOption(document, value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  return option;
}

function eventDateCopy(event) {
  return event.startDate === event.endDate
    ? event.startDate
    : `${event.startDate} ~ ${event.endDate}`;
}

function renderEventBadge(document, event) {
  const badge = document.createElement('span');
  badge.className = 'school-calendar-event';
  badge.dataset.eventType = event.type;
  badge.title = `${event.school} · ${event.originalName}`;
  const school = document.createElement('b');
  school.textContent = event.scope === 'common' ? '공통' : event.school.replace(/(초등|중|고등)학교$/, '');
  const title = document.createElement('span');
  title.textContent = event.originalName;
  badge.append(school, title);
  return badge;
}

function renderCalendarGrid(document, container, year, month, events) {
  const cells = calendarMonthCells(year, month, events);
  container.replaceChildren(...cells.map((cell) => {
    const day = document.createElement('div');
    day.className = `school-calendar-day${cell.inMonth ? '' : ' outside'}`;
    day.dataset.date = cell.date;
    const number = document.createElement('span');
    number.className = 'school-calendar-day-number';
    number.textContent = String(cell.day);
    day.append(number);
    for (const event of cell.events.slice(0, 3)) day.append(renderEventBadge(document, event));
    if (cell.events.length > 3) {
      const more = document.createElement('span');
      more.className = 'school-calendar-more';
      more.textContent = `+${cell.events.length - 3}개`;
      day.append(more);
    }
    return day;
  }));
}

function renderMonthList(document, container, events) {
  if (!events.length) {
    const empty = document.createElement('p');
    empty.className = 'school-calendar-list-empty';
    empty.textContent = '선택한 조건에 해당하는 공식 일정이 없습니다.';
    container.replaceChildren(empty);
    return;
  }
  container.replaceChildren(...events.map((event) => {
    const item = document.createElement('article');
    item.className = 'school-calendar-list-item';
    const date = document.createElement('time');
    date.dateTime = event.startDate;
    date.textContent = eventDateCopy(event);
    const copy = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = event.originalName;
    const meta = document.createElement('span');
    meta.textContent = `${event.school} · ${event.type} · 확정`;
    copy.append(title, meta);
    const source = document.createElement('a');
    source.href = event.sourceUrl;
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    source.textContent = '공식 출처';
    item.append(date, copy, source);
    return item;
  }));
}

export function bindSchoolCalendar(document, data, now = new Date()) {
  const grid = document.getElementById('schoolCalendarGrid');
  if (!grid) return null;
  const monthLabel = document.getElementById('calendarMonthLabel');
  const schoolFilter = document.getElementById('calendarSchoolFilter');
  const typeFilter = document.getElementById('calendarTypeFilter');
  const yearFilter = document.getElementById('calendarYearFilter');
  const publicationNote = document.getElementById('calendarPublicationNote');
  const eventList = document.getElementById('calendarEventList');
  const previous = document.getElementById('calendarPrev');
  const next = document.getElementById('calendarNext');

  schoolFilter.replaceChildren(createOption(document, '', '전체 학교'));
  for (const school of data.schools) {
    schoolFilter.append(createOption(document, school.name, school.name));
  }

  const currentYear = now.getFullYear();
  const state = {
    year: currentYear === 2026 || currentYear === 2027 ? currentYear : 2026,
    month: currentYear === 2026 || currentYear === 2027 ? now.getMonth() + 1 : 10,
  };
  yearFilter.value = String(state.year);

  const render = () => {
    yearFilter.value = String(state.year);
    monthLabel.textContent = `${state.year}년 ${state.month}월`;
    publicationNote.textContent = schoolCalendarPublicationNote(data, state.year);
    const selected = filterSchoolCalendarEvents(data.events, {
      school: schoolFilter.value,
      type: typeFilter.value,
      year: state.year,
    });
    const bounds = monthBounds(state.year, state.month);
    const monthEvents = selected
      .filter((event) => overlaps(event, bounds.start, bounds.end))
      .sort((left, right) => left.startDate.localeCompare(right.startDate) || left.school.localeCompare(right.school, 'ko'));
    renderCalendarGrid(document, grid, state.year, state.month, monthEvents);
    renderMonthList(document, eventList, monthEvents);
    previous.disabled = state.year === 2026 && state.month === 1;
    next.disabled = state.year === 2027 && state.month === 12;
  };

  const moveMonth = (amount) => {
    const nextDate = new Date(Date.UTC(state.year, state.month - 1 + amount, 1));
    const nextYear = nextDate.getUTCFullYear();
    if (nextYear < 2026 || nextYear > 2027) return;
    state.year = nextYear;
    state.month = nextDate.getUTCMonth() + 1;
    render();
  };

  previous.addEventListener('click', () => moveMonth(-1));
  next.addEventListener('click', () => moveMonth(1));
  schoolFilter.addEventListener('change', render);
  typeFilter.addEventListener('change', render);
  yearFilter.addEventListener('change', () => {
    state.year = Number(yearFilter.value);
    render();
  });
  render();
  return { render, state };
}
