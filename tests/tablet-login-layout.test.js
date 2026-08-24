import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const css = read('src/tablet/tablet.css');
const html = read('tablet/index.html');

// 고친 문제: 로그인 화면에서 카드는 560px 로 가운데 놓이는데 헤더는 컨테이너
// 전체 폭을 써서, 로고가 카드보다 왼쪽에 찍혔다. 실측으로 1024px 화면에서 201px,
// 768px 화면에서 80px 어긋났다. 아래 검사는 그 상태로 되돌아가는 것을 막는다.

describe('tablet login layout — shared width token', () => {
  it('defines one width token for the auth card', () => {
    expect(css).toMatch(/--auth-max:\s*560px/);
  });

  it('sizes the auth card from the token instead of a loose literal', () => {
    const panel = css.match(/\.tablet-panel\{[\s\S]*?\}/)?.[0] ?? '';
    expect(panel).toContain('max-width:var(--auth-max)');
    // 가운데 정렬은 margin auto 로 유지한다
    expect(panel).toContain('margin:0 auto');
    expect(panel).not.toMatch(/max-width:\s*560px/);
  });

  it('pins the header to the same measure on the two auth screens', () => {
    expect(css).toContain('.tablet:has(> #login:not([hidden])) .tablet-header');
    expect(css).toContain('.tablet:has(> #pinChange:not([hidden])) .tablet-header');
    const rule = css.match(/\.tablet:has\(> #login[\s\S]*?\}/)?.[0] ?? '';
    expect(rule).toContain('max-width:var(--auth-max)');
    expect(rule).toContain('margin-inline:auto');
  });

  it('leaves the today and detail headers at full width', () => {
    // :has() 조건이 로그인/PIN 변경에만 걸려야 한다. today/detail 이 들어가면
    // 본문은 전체 폭인데 헤더만 좁아져서 반대 방향으로 어긋난다.
    const rule = css.match(/\.tablet:has\(> #login[\s\S]*?\}/)?.[0] ?? '';
    expect(rule).not.toContain('#today');
    expect(rule).not.toContain('#detail');
  });

  it('keeps both auth panels on the same class so they share the width', () => {
    // 두 화면이 같은 클래스를 써야 헤더 정렬 규칙과 카드 폭이 함께 움직인다.
    expect(html).toContain('<section id=login class=tablet-panel>');
    expect(html).toContain('<section id=pinChange class=tablet-panel hidden>');
  });
});

describe('tablet login layout — no horizontal overflow', () => {
  it('keeps border-box sizing so padding never widens a row', () => {
    expect(css).toContain('*{box-sizing:border-box;}');
  });

  it('lets the keypad columns shrink below their content width', () => {
    // 1fr 만 쓰면 최소 폭이 내용 크기(min-content)로 잡혀 좁은 화면에서 넘친다.
    expect(css).toMatch(/\.keypad\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
    expect(css).not.toMatch(/\.keypad\{[^}]*grid-template-columns:repeat\(3,1fr\)/);
  });

  it('gives the phone input an explicit width instead of its intrinsic size', () => {
    const field = css.match(/\.tablet-field input\{[\s\S]*?\}/)?.[0] ?? '';
    expect(field).toContain('width:100%');
    expect(field).toContain('min-width:0');
  });

  // 갤럭시탭에서 실제로 나온 증상: 카드 왼쪽 여백은 남고 오른쪽만 잘렸다.
  // 원인은 grid 자식의 기본 min-width:auto 다. 글꼴이나 기기 글자 크기가 커지면
  // 한 줄의 내용 폭이 카드 안쪽을 넘고, 칸 전체가 그 폭으로 늘어난다.
  // (재현: 카드를 260px 로 좁히면 고치기 전 55px 넘쳤고, 고친 뒤 0px 이다.)
  it('lets every form row shrink below its content width', () => {
    expect(css).toMatch(/\.tablet-form > \*,\s*\.tablet-field > \*\{min-width:0;\}/);
  });

  it('lets the field wrapper itself shrink too', () => {
    const rule = css.match(/\.tablet-field\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('min-width:0');
  });

  it('clips the unbreakable PIN dots instead of letting them widen the card', () => {
    const rule = css.match(/\.pin-display\{[\s\S]*?\}/)?.[0] ?? '';
    expect(rule).toContain('min-width:0');
    expect(rule).toContain('overflow:hidden');
  });
});

describe('tablet login layout — touch targets survive the fix', () => {
  it('keeps the 64px minimum touch target', () => {
    expect(css).toContain('--touch-min:64px');
  });

  it('still applies it to every control on the login screen', () => {
    for (const selector of ['.tablet-field input', '.pin-display', '.keypad-key', '.tablet-primary']) {
      const rule = css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{[\\s\\S]*?\\}'))?.[0] ?? '';
      expect(rule).toContain('min-height:var(--touch-min)');
    }
  });
});
