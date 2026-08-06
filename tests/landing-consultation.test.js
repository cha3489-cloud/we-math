import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');

describe('landing consultation overview', () => {
  it('separates five intake questions from the consultation outcome', () => {
    const section = html.match(/<section id="consult">([\s\S]*?)<\/section>/)?.[1] ?? '';

    expect(section.match(/class="consult-card"/g)).toHaveLength(5);
    expect(section).not.toContain('<div class="consult-check">06</div>');
    expect(section).toContain('상담 후 함께 정하는 것');
    expect(section).toMatch(/class="[^"]*\bconsult-outcome\b[^"]*"/);
    expect(section.match(/class="consult-outcome-item"/g)).toHaveLength(3);
  });

  it('uses a consistent question grid and responsive outcome layout', () => {
    expect(css).toContain('grid-template-columns: repeat(5, minmax(0, 1fr));');
    expect(css).toContain('.consult-outcome-items');
    expect(css).not.toContain('.consult-card:nth-child(6)');
  });
});
