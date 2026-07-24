import { describe, expect, it } from 'vitest';
import config from '../vite.config.js';
describe('Vite multi-page build', () => {
  it('keeps landing, student, and admin entry points', () => {
    expect(Object.keys(config.build.rollupOptions.input).sort()).toEqual(['admin', 'main', 'student']);
  });
});
