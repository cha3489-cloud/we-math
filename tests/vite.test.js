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
  it('keeps landing, student, and admin entry points', () => {
    expect(Object.keys(config.build.rollupOptions.input).sort()).toEqual(['admin', 'main', 'student']);
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
