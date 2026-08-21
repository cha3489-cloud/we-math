import { describe, expect, it } from 'vitest';
import { build } from 'vite';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import config from '../vite.config.js';

const readJavaScript = (directory) => readdirSync(directory, { recursive: true })
  .filter((path) => path.endsWith('.js'))
  .map((path) => readFileSync(join(directory, path), 'utf8'))
  .join('\n');

describe('Vite multi-page build', () => {
  it('keeps landing, consultation, student, admin, tablet, and blog entry points', () => {
    expect(Object.keys(config.build.rollupOptions.input)).toEqual(expect.arrayContaining([
      'admin',
      'blog',
      'blogChoosingAcademy',
      'blogHomeworkRoutine',
      'consultation',
      'main',
      'student',
      'tablet',
    ]));
  });
  it('keeps the tablet entry outside the generated blog input markers', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'vite.config.js'), 'utf8');
    const generatedBlocks = source.match(/generated-vite-input:[^\n]*:start[\s\S]*?generated-vite-input:[^\n]*:end/g) ?? [];
    // The blog generator rewrites these blocks, so an entry placed inside one would be lost.
    for (const block of generatedBlocks) expect(block).not.toContain('tablet');
    expect(source).toContain("tablet: resolve(__dirname, 'tablet/index.html')");
  });

  it('includes public Supabase configuration when Cloudflare build env is empty', async () => {
    const envDir = mkdtempSync(join(tmpdir(), 'we-math-empty-env-'));
    const outDir = mkdtempSync(join(tmpdir(), 'we-math-build-'));
    const previousUrl = process.env.VITE_SUPABASE_URL;
    const previousKey = process.env.VITE_SUPABASE_ANON_KEY;
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.VITE_SUPABASE_ANON_KEY;
    try {
      await build({ ...config, configFile: false, envDir, build: { ...config.build, outDir, emptyOutDir: true } });
      const javascript = readJavaScript(outDir);
      expect(javascript).toContain('tcpitbsrfouwmfkkdqhg.supabase.co');
      expect(javascript).toContain('sb_publishable_');
    } finally {
      if (previousUrl === undefined) delete process.env.VITE_SUPABASE_URL; else process.env.VITE_SUPABASE_URL = previousUrl;
      if (previousKey === undefined) delete process.env.VITE_SUPABASE_ANON_KEY; else process.env.VITE_SUPABASE_ANON_KEY = previousKey;
      rmSync(envDir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 30_000);
});
