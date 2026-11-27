import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');

function ruleFor(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('landing page progressive enhancement', () => {
  it('keeps reveal content visible when JavaScript is blocked by an in-app browser', () => {
    const revealRule = ruleFor('.reveal');

    expect(revealRule).toMatch(/opacity:\s*1/);
    expect(revealRule).toMatch(/transform:\s*none/);
    expect(revealRule).not.toMatch(/opacity:\s*0/);
  });
});
