import { describe, expect, it } from 'vitest';
import {
  findBundleSource,
  inlineHomepageCss,
  legacyHomepageAssetAliases,
} from '../scripts/homepage-asset-resilience.js';

describe('homepage asset resilience', () => {
  it('inlines the built homepage stylesheet so the page survives a failed stylesheet request', () => {
    const html = `<!doctype html><html><head><link rel="stylesheet" crossorigin href="./assets/analytics-current.css"></head><body></body></html>`;
    const css = '.hero{display:grid;color:#16181b}';

    const result = inlineHomepageCss(html, './assets/analytics-current.css', css);

    expect(result).toContain('<style data-homepage-inline-css>');
    expect(result).toContain(css);
    expect(result).not.toContain('href="./assets/analytics-current.css"');
  });

  it('selects the real homepage code chunk instead of Vite’s small HTML entry wrapper', () => {
    const bundle = {
      wrapper: { type: 'chunk', name: 'main', fileName: 'assets/main-wrapper.js', code: 'import "./main-current.js";' },
      homepage: { type: 'chunk', name: 'index', fileName: 'assets/main-current.js', code: 'const homepage = true;'.repeat(3) },
    };

    expect(findBundleSource(bundle, 'main.js')).toBe('const homepage = true;'.repeat(3));
  });

  it('keeps aliases for the asset filenames referenced by the immediately previous homepage', () => {
    expect(legacyHomepageAssetAliases).toEqual({
      'assets/analytics-CCXdMH2W.css': 'analytics.css',
      'assets/analytics-DWUTgIc7.js': 'analytics.js',
      'assets/main-aJufcXEs.js': 'main.js',
    });
  });
});
