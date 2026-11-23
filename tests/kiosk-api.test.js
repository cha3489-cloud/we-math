import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createKioskCaller } from '../src/kiosk/api.js';

const root = resolve(import.meta.dirname, '..');
const TOKEN = 'ab'.repeat(32);

describe('kiosk browser boundary', () => {
  it('sends the six digits only to the attendance-code Edge Function over HTTPS with the publishable key', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ result: 'checked_in', status: 'present', student_label: '가○○', at: 'x' }), { status: 200 }));
    const call = createKioskCaller({ fetch, supabaseUrl: 'https://project.supabase.co', publishableKey: 'sb_publishable_test' });
    await expect(call(TOKEN, 'check_in', '482913')).resolves.toMatchObject({ result: 'checked_in' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://project.supabase.co/functions/v1/attendance-code');
    expect(init.method).toBe('POST');
    expect(init.headers.apikey).toBe('sb_publishable_test');
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(JSON.parse(init.body)).toEqual({ op: 'kiosk', device_token: TOKEN, action: 'check_in', code: '482913' });
    expect(init.cache).toBe('no-store');
  });

  it('refuses a non-HTTPS function URL outside local development', () => {
    expect(() => createKioskCaller({ fetch: vi.fn(), supabaseUrl: 'http://project.supabase.co', publishableKey: 'k' })).toThrow(/HTTPS/);
    expect(() => createKioskCaller({ fetch: vi.fn(), supabaseUrl: 'http://127.0.0.1:54321', publishableKey: 'k' })).not.toThrow();
  });

  it('treats non-2xx responses as a network failure so the kiosk shows the staff fallback', async () => {
    const call = createKioskCaller({ fetch: vi.fn(async () => new Response('{"error":"x"}', { status: 503 })), supabaseUrl: 'https://p.supabase.co', publishableKey: 'k' });
    await expect(call(TOKEN, 'check_in', '482913')).rejects.toThrow();
  });

  it('never calls a PostgREST RPC with the raw code', () => {
    const main = readFileSync(resolve(root, 'src/kiosk/main.js'), 'utf8');
    const app = readFileSync(resolve(root, 'src/kiosk/app.js'), 'utf8');
    const api = readFileSync(resolve(root, 'src/kiosk/api.js'), 'utf8');
    for (const source of [main, app, api]) {
      expect(source).not.toMatch(/\.rpc\(/);
      expect(source).not.toContain('kiosk_attendance');
    }
    expect(main).toContain('createKioskCaller');
  });
});
