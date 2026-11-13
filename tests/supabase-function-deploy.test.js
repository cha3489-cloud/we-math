import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

describe('consultation intake function deployment', () => {
  it('deploys the public intake function when its server code changes on main', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/supabase-function-deploy.yml'), 'utf8');
    expect(workflow).toContain('supabase/functions/consultation-intake/**');
    expect(workflow).toContain('supabase/functions/_shared/**');
    expect(workflow).toContain('SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}');
    expect(workflow).toContain('npx supabase functions deploy consultation-intake');
    expect(workflow).toContain('--project-ref "$SUPABASE_PROJECT_REF"');
    expect(workflow).toContain('npx --yes deno check supabase/functions/consultation-intake/index.ts');
    expect(workflow).toContain("inputs.restore_inactive == true");
    expect(workflow).toContain('https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF');
    expect(workflow).toContain('curl -fsS -X POST -H "$auth" "$api/restore"');
    expect(workflow).toContain('if [ "$status" = "ACTIVE_HEALTHY" ]');
  });
});
