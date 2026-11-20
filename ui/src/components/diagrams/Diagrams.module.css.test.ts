import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'Diagrams.module.css'), 'utf8');
const rule = (sel: string) =>
  new RegExp(`(?:^|\\n)${sel.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';

describe('diagram preview sizing', () => {
  it('fills the column width and lets the height follow the aspect ratio', () => {
    const img = rule('.stage img');
    expect(img).toMatch(/width:\s*100%/);
    expect(img).toMatch(/height:\s*auto/);
    expect(img).not.toMatch(/max-height/);
  });

  it('only caps the stage for very tall drawings, which then scroll', () => {
    const stage = rule('.stage');
    expect(stage).toMatch(/max-height:\s*min\(1400px/);
    expect(stage).toMatch(/overflow-y:\s*auto/);
    expect(css).not.toMatch(/\.embedSmall \.stage img/);
  });
});
