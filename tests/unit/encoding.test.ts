import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('public Fest-On text encoding', () => {
  it('contains UTF-8 text without known mojibake markers', async () => {
    const files = [
      'apps/web/app/fiesta-de-disfraces/page.tsx',
      'apps/web/app/fiesta-de-disfraces/tickets.tsx',
      'apps/web/app/api/reserve/route.ts',
    ];
    const source = await Promise.all(files.map(file => readFile(file, 'utf8'))).then(parts => parts.join('\n'));
    expect(source).not.toMatch(/[ÃÂâ]|ï¿½|�|ðŸ/);
    for (const text of ['SÁBADO', 'ELECTRÓNICA', 'ELEGÍ TU', '→', '↓', '✦', '©']) expect(source).toContain(text);
  });
});
