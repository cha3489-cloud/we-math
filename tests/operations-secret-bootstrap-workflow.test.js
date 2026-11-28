import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const workflow = readFileSync(resolve(root, '.github/workflows/supabase-operations-functions.yml'), 'utf8');

const deploy = workflow.slice(workflow.indexOf('\n  deploy:'));
const stepsOf = (text) => text.split(/\n      - /).slice(1).map((s) => `- ${s}`);
const steps = stepsOf(deploy);
const bootstrapIndex = steps.findIndex((s) => /name: .*HMAC/i.test(s) && /secrets set/.test(s));
const bootstrap = steps[bootstrapIndex] ?? '';
const indexOfStep = (needle) => steps.findIndex((s) => s.includes(needle));

describe('attendance HMAC secret bootstrap in the deploy workflow', () => {
  it('has a bootstrap step that runs before either function deploys', () => {
    expect(bootstrapIndex).toBeGreaterThan(-1);
    expect(bootstrapIndex).toBeLessThan(indexOfStep('functions deploy attendance-code'));
    expect(bootstrapIndex).toBeLessThan(indexOfStep('functions deploy parent-message-dispatch'));
  });

  it('no longer fails the deploy just because the secret is missing', () => {
    expect(deploy).not.toContain('refusing to deploy attendance-code');
  });

  it('only generates when the secret name is absent, and never rotates an existing one', () => {
    expect(bootstrap).toContain('secrets list');
    expect(bootstrap).toMatch(/grep -qx 'ATTENDANCE_CODE_HMAC_SECRET'/);
    // generation + set live inside the "name not found" branch
    expect(bootstrap).toMatch(/if ! grep -qx 'ATTENDANCE_CODE_HMAC_SECRET'[\s\S]*openssl rand[\s\S]*secrets set[\s\S]*\bfi\b/);
    expect((bootstrap.match(/secrets set/g) ?? []).length).toBe(1);
  });

  it('generates at least 32 random bytes with openssl rand', () => {
    const m = bootstrap.match(/openssl rand (?:-(?:base64|hex) )?(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeGreaterThanOrEqual(32);
    expect(bootstrap).not.toMatch(/\$RANDOM|date \+|uuidgen/);
  });

  it('re-lists secret names after setting and fails if the name is still missing', () => {
    const afterSet = bootstrap.slice(bootstrap.indexOf('secrets set'));
    expect(afterSet).toMatch(/names="\$\(list_names\)"/);
    expect(afterSet).toMatch(/exit 1/);
  });

  it('writes the value to a private mktemp file and cleans it up on every exit path', () => {
    expect(bootstrap).toMatch(/secret_file="\$\(mktemp\)"/);
    expect(bootstrap).toMatch(/chmod 600 "\$secret_file"/);
    expect(bootstrap).toMatch(/trap '[^']*rm -f "\$secret_file"[^']*' EXIT/);
    expect(bootstrap.indexOf('trap ')).toBeLessThan(bootstrap.indexOf('mktemp'));
    expect(bootstrap.indexOf('mktemp')).toBeLessThan(bootstrap.indexOf('chmod 600'));
    expect(bootstrap.indexOf('chmod 600')).toBeLessThan(bootstrap.indexOf('openssl rand'));
    // explicit cleanup right after the CLI call, in addition to the trap
    const afterSet = bootstrap.slice(bootstrap.indexOf('secrets set'));
    expect(afterSet).toMatch(/rm -f "\$secret_file"/);
  });

  it('unsets the secret variable immediately after writing it to the file', () => {
    const lines = bootstrap.split('\n');
    const write = lines.findIndex((l) => /^\s*printf '[^']*' "\$ATTENDANCE_CODE_HMAC_SECRET" > "\$secret_file"\s*$/.test(l));
    expect(write).toBeGreaterThan(-1);
    expect(lines[write + 1]).toMatch(/^\s*unset ATTENDANCE_CODE_HMAC_SECRET\s*$/);
    expect(bootstrap).toMatch(/trap '[^']*unset ATTENDANCE_CODE_HMAC_SECRET[^']*' EXIT/);
  });

  it('passes the file to supabase via --env-file, never stdin or argv, with output suppressed', () => {
    expect(bootstrap).toMatch(/secrets set[^\n]*--env-file "\$secret_file"[^\n]*>\/dev\/null 2>&1/);
    expect(bootstrap).not.toContain('/dev/stdin');
    expect(bootstrap).not.toMatch(/secrets set[^\n]*ATTENDANCE_CODE_HMAC_SECRET=/);
    expect(bootstrap).not.toMatch(/secrets set[^\n]*\$\{?ATTENDANCE_CODE_HMAC_SECRET/);
  });

  it('never prints, traces, exports or uploads the value', () => {
    expect(bootstrap).toMatch(/set \+x/);
    expect(bootstrap).not.toMatch(/set -\w*x/);
    const usesValue = bootstrap.split('\n').filter((l) => /\$\{?ATTENDANCE_CODE_HMAC_SECRET\b/.test(l));
    expect(usesValue.length).toBeGreaterThan(0);
    for (const line of usesValue) {
      expect(line).not.toMatch(/\becho\b|>&2|\btee\b|>>|\bexport\b/);
    }
    expect(bootstrap).not.toMatch(/\bcat\b[^\n]*secret_file|\bxargs\b/);
    expect(workflow).not.toMatch(/GITHUB_OUTPUT|GITHUB_ENV|upload-artifact|add-mask|::set-output/);
    expect(workflow).not.toContain('secrets.ATTENDANCE_CODE_HMAC_SECRET');
  });

  it('has no GitHub expression interpolation inside run scripts (no shell injection)', () => {
    for (const s of steps) {
      const run = s.split(/\n\s+run: /)[1] ?? '';
      expect(run).not.toContain('${{');
    }
  });

  it('does not configure a real Kakao provider (code default dry_run stays)', () => {
    const code = workflow.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
    expect(code).not.toMatch(/PARENT_MESSAGE_PROVIDER|KAKAO/i);
  });
});
