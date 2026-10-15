import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
it('publishes only the Byeongjeom preopening region, without a street address or coordinates', () => {
 const html = readFileSync('index.html', 'utf8');
 expect(html).toContain('병점 지역 개원 준비 중');
 expect(html).not.toMatch(/수원|37\.2636|127\.0286|geo.position|"GeoCoordinates"|병점서로|203호/);
 expect(html).toContain('og-byeongjeom.png');
});
