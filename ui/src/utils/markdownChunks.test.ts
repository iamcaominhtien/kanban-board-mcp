import { describe, expect, it } from 'vitest';
import { splitMarkdown } from './markdownChunks';

const section = (n: number, body = 30) =>
  [`## Section ${n}`, '', ...Array.from({ length: body }, (_, i) => `Line ${i} of section ${n}.`), ''].join('\n');

const strip = (text: string) => text.replace(/^\n+/, '');

describe('splitMarkdown', () => {
  it('keeps a short page whole', () => {
    const md = section(1) + section(2);
    expect(splitMarkdown(md)).toEqual([{ text: md, start: 0 }]);
  });

  it('cuts a long page only before headings, and the pieces give the page back with its line numbers', () => {
    const md = Array.from({ length: 40 }, (_, i) => section(i)).join('\n');
    const pieces = splitMarkdown(md, 60, 100);
    expect(pieces.length).toBeGreaterThan(3);
    for (const p of pieces.slice(1)) expect(strip(p.text).startsWith('## Section')).toBe(true);
    // each piece starts on its own line of the page: its nodes carry the page's line numbers
    const lines = md.split('\n');
    for (const p of pieces) {
      expect(p.text.split('\n').length - 1).toBeGreaterThanOrEqual(p.start);
      expect(strip(p.text).split('\n')[0]).toBe(lines[p.start]);
    }
    expect(pieces.map((p) => p.text.split('\n').slice(p.start).join('\n')).join('\n')).toBe(md);
  });

  it('never cuts inside a code fence or a math block', () => {
    const fence = ['```md', ...Array.from({ length: 80 }, (_, i) => `## not a heading ${i}`), '```'].join('\n');
    const math = ['$$', ...Array.from({ length: 80 }, (_, i) => `# x_${i}`), '$$'].join('\n');
    const md = [section(1, 70), fence, section(2, 70), math, section(3, 70), section(4, 70)].join('\n');
    const pieces = splitMarkdown(md, 50, 60);
    for (const p of pieces.slice(1)) expect(strip(p.text)).toMatch(/^## Section \d/);
  });

  it('keeps a fence open until a closing fence as long as the opening one (nested fences, info strings)', () => {
    const inner = ['````md', '```python', ...Array.from({ length: 80 }, (_, i) => `# comment ${i}`), '```', '````'];
    const tilde = ['~~~text', '~~~python', ...Array.from({ length: 80 }, (_, i) => `## not ${i}`), '~~~'];
    const md = [section(1, 70), ...inner, section(2, 70), ...tilde, section(3, 70), section(4, 70)].join('\n');
    const pieces = splitMarkdown(md, 50, 60);
    for (const p of pieces.slice(1)) expect(strip(p.text)).toMatch(/^## Section \d/);
  });

  it('does not cut before an indented heading (it may be inside a list item)', () => {
    const list = ['- item', ...Array.from({ length: 80 }, (_, i) => `  ## inside ${i}\n  text`)];
    const md = [section(1, 70), ...list, section(2, 70), section(3, 70)].join('\n');
    for (const p of splitMarkdown(md, 50, 60).slice(1)) expect(strip(p.text)).toMatch(/^## Section \d/);
  });

  it('does not cut a page with reference definitions or footnotes', () => {
    const md = Array.from({ length: 40 }, (_, i) => section(i)).join('\n') + '\n[docs]: https://example.com\n';
    expect(splitMarkdown(md, 60, 100)).toHaveLength(1);
    const fn = Array.from({ length: 40 }, (_, i) => section(i)).join('\n') + '\n[^1]: A note.\n';
    expect(splitMarkdown(fn, 60, 100)).toHaveLength(1);
  });
});
