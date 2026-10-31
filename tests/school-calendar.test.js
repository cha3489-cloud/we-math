import { describe, expect, it } from 'vitest';
import calendarData from '../src/portal/school-calendar-data.json';
import {
  calendarMonthCells,
  filterSchoolCalendarEvents,
  schoolCalendarPublicationNote,
} from '../src/portal/school-calendar.js';

const expectedSchools = [
  '태안초등학교',
  '송화초등학교',
  '화성벌말초등학교',
  '병점중학교',
  '병점고등학교',
  '안화초등학교',
  '안화중학교',
  '안화고등학교',
];

describe('nearby school calendar data', () => {
  it('records the eight nearby schools with traceable official sources', () => {
    expect(calendarData.schools.map((school) => school.name).sort()).toEqual([...expectedSchools].sort());
    for (const school of calendarData.schools) {
      expect(school.schoolCode).toMatch(/^\d{7}$/);
      expect(school.address).toContain('화성시');
      expect(school.sourceUrl).toMatch(/^https:\/\//);
      expect(school.checkedAt).toBe('2026-10-30');
    }
  });

  it('keeps confirmed events source-grounded and covers exams, breaks and school closure days', () => {
    expect(calendarData.events.length).toBeGreaterThan(30);
    const types = new Set(calendarData.events.map((event) => event.type));
    expect(types.has('중간고사')).toBe(true);
    expect(types.has('기말고사')).toBe(true);
    expect(types.has('여름방학')).toBe(true);
    expect(types.has('겨울방학')).toBe(true);
    expect(types.has('학교휴업일')).toBe(true);
    expect(types.has('공통휴일')).toBe(true);
    for (const event of calendarData.events) {
      expect(event.status).toBe('confirmed');
      expect(event.startDate).toMatch(/^202[67]-\d{2}-\d{2}$/);
      expect(event.endDate).toMatch(/^202[67]-\d{2}-\d{2}$/);
      expect(event.sourceUrl).toMatch(/^https:\/\//);
      expect(event.checkedAt).toBe('2026-10-30');
    }
  });

  it('preserves the verified official event names without known transcription errors', () => {
    const names = calendarData.events.map((event) => event.originalName);
    expect(names.some((name) => name.includes('대힉수학능력시험'))).toBe(false);
    expect(names.some((name) => name.includes('종업시('))).toBe(false);
    expect(names).toContain('대학수학능력시험(학교장재량휴업일)');
    expect(names).toContain('종업식(1,2학년)/졸업식(3학년)/급식미실시');
    const correctedNames = new Set([
      '대학수학능력시험(학교장재량휴업일)',
      '종업식(1,2학년)/졸업식(3학년)/급식미실시',
    ]);
    const corrected = calendarData.events.filter((event) => correctedNames.has(event.originalName));
    expect(corrected).toHaveLength(2);
    expect(corrected.every((event) => event.sourceDocument.includes('NEIS'))).toBe(true);
  });

  it('does not invent 2027 school-year exams or breaks before official publication', () => {
    expect(calendarData.publication['2027SchoolYear'].status).toBe('unpublished');
    expect(calendarData.publication['2027SchoolYear'].note).toContain('추정');
    const invented = calendarData.events.filter((event) => (
      event.startDate >= '2027-03-01'
      && ['중간고사', '기말고사', '여름방학', '겨울방학', '학교휴업일'].includes(event.type)
    ));
    expect(invented).toEqual([]);
  });
});

describe('school calendar view model', () => {
  it('builds a Monday-first month grid and includes overlapping date ranges', () => {
    const cells = calendarMonthCells(2026, 6, calendarData.events);
    expect(cells).toHaveLength(35);
    expect(cells[0].date).toBe('2026-06-01');
    const election = cells.find((cell) => cell.date === '2026-06-03');
    expect(election.events.some((event) => event.originalName.includes('선거'))).toBe(true);
  });

  it('filters by school, event type and year without hiding shared holidays', () => {
    const filtered = filterSchoolCalendarEvents(calendarData.events, {
      school: '병점고등학교',
      type: '중간고사',
      year: '2026',
    });
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((event) => event.school === '병점고등학교' && event.type === '중간고사')).toBe(true);
  });

  it('explains that the 2027 school year is not yet published', () => {
    expect(schoolCalendarPublicationNote(calendarData, 2027)).toContain('미발표');
  });
});
