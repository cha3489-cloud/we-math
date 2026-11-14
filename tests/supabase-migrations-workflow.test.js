import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const workflow = fs.readFileSync(new URL('../.github/workflows/supabase-migrations.yml', import.meta.url), 'utf8');

describe('Supabase migration workflow CLI', () => {
  it('uses an exact local Supabase CLI v2 pin for both migration commands', () => {
    expect(packageJson.devDependencies?.supabase).toBe('2.122.1');
    expect(packageLock.packages?.['node_modules/supabase']?.version).toBe('2.122.1');
    expect(workflow.match(/npx supabase db push/g) || []).toHaveLength(2);
    expect(workflow).not.toMatch(/npx supabase@(?:latest|3(?:[.\s]|$))/);
  });

  it('links through the IPv4 pooler before using the linked project', () => {
    expect(workflow.match(/npx supabase link/g) || []).toHaveLength(1);
    expect(workflow).toMatch(/npx supabase link[\s\S]*--project-ref "\$SUPABASE_PROJECT_REF"[\s\S]*--password "\$SUPABASE_DB_PASSWORD"/);
    expect(workflow.match(/npx supabase db push \\\n\s+--linked/g) || []).toHaveLength(2);
    expect(workflow.match(/npx supabase db push[\s\S]{0,180}--include-all/g) || []).toHaveLength(2);
    expect(workflow).not.toMatch(/npx supabase db push[\s\S]{0,160}--project-ref/);
    expect(workflow).not.toContain('--skip-pooler');

    const secretCheckIndex = workflow.indexOf('- name: Check required secrets');
    const linkIndex = workflow.indexOf('- name: Link project through the IPv4 pooler');
    const dryRunIndex = workflow.indexOf('- name: Show pending migrations (dry run)');
    const applyIndex = workflow.indexOf('- name: Apply migrations');
    expect(secretCheckIndex).toBeGreaterThan(-1);
    expect(linkIndex).toBeGreaterThan(secretCheckIndex);
    expect(dryRunIndex).toBeGreaterThan(linkIndex);
    expect(applyIndex).toBeGreaterThan(dryRunIndex);
    expect(workflow).toContain('if [ "${{ inputs.confirm }}" != "APPLY" ]');
    expect(workflow).toContain("if: ${{ inputs.mode == 'apply' }}");
  });
});
