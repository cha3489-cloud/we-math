import { it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

it('publishes the verified December 2026 opening status and academy address', () => {
  const html = readFileSync('index.html', 'utf8');

  expect(html).toContain('2026년 12월 개원 예정');
  expect(html).toContain('경기도 화성시 병점구 병점서로 21, 상가1동 203호');
  expect(html).toContain('"streetAddress": "병점서로 21, 상가1동 203호 (병점역 센트럴허브시티)"');
  expect(html).not.toMatch(/병점 지역 개원 준비 중|상세 주소 추후 공개|사업자등록번호|계좌번호/);
  expect(html).toContain('og-byeongjeom-december-2026.png');
});

it('ships a 1200 by 630 social image for the December opening update', () => {
  const imagePath = 'public/img/og-byeongjeom-december-2026.png';
  expect(existsSync(imagePath)).toBe(true);

  const png = readFileSync(imagePath);
  expect(png.readUInt32BE(16)).toBe(1200);
  expect(png.readUInt32BE(20)).toBe(630);
});
