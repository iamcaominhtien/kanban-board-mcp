import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'docs.css'), 'utf8');

describe('"Changed in vN" marks', () => {
  it('label only the first block of a run of changed blocks, so a label never sits over the block above', () => {
    // jsdom does not lay out CSS: the rule itself is what keeps two labels from overlapping a heading
    expect(css).toMatch(/\.dk-md \.dk-changed \+ \.dk-changed::after\s*\{\s*content:\s*none;/);
  });
});
