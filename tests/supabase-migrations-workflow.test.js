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
});
