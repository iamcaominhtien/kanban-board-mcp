import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** `text` as a pattern that matches it literally (every special character escaped, the backslash too). */
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const css = readFileSync(join(__dirname, 'Diagrams.module.css'), 'utf8');
const rule = (sel: string) => new RegExp(`(?:^|\\n)${escapeRegExp(sel)}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';

describe('diagram preview sizing', () => {
  it('shows the drawing at its own size, only made smaller to fit the column, with no height cap', () => {
    const img = rule('.stage img');
    expect(img).toMatch(/(?:^|\s)width:\s*auto/);
    expect(img).toMatch(/max-width:\s*100%/);
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
