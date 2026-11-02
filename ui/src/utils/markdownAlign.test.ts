import { describe, expect, it } from 'vitest';
import { splitAlignBlocks, stripAlignMarkers } from './markdownAlign';

describe('splitAlignBlocks', () => {
  it('keeps plain Markdown as one part', () => {
    expect(splitAlignBlocks('Hello\n\nWorld')).toEqual([{ align: null, markdown: 'Hello\n\nWorld' }]);
  });

  it('splits centred and right-aligned blocks the way the editor writes them', () => {
    const md = 'Intro\n\n::: center\nMiddle **bold**\n:::\n\n::: right\nEnd\n:::\n\nAfter';
    expect(splitAlignBlocks(md)).toEqual([
      { align: null, markdown: 'Intro\n' },
      { align: 'center', markdown: 'Middle **bold**' },
      { align: 'right', markdown: 'End' },
      { align: null, markdown: '\nAfter' },
    ]);
  });

  it('keeps headings and lists inside an aligned block', () => {
    const [seg] = splitAlignBlocks('::: center\n# Title\n\n- a\n- b\n:::');
    expect(seg).toEqual({ align: 'center', markdown: '# Title\n\n- a\n- b' });
  });

  it('ignores the markers inside a fenced code block', () => {
    const md = '```\n::: center\nnot aligned\n:::\n```';
    expect(splitAlignBlocks(md)).toEqual([{ align: null, markdown: md }]);
  });

  it('runs an unclosed block to the end, and leaves a stray closing line as text', () => {
    expect(splitAlignBlocks('::: right\nlast line')).toEqual([{ align: 'right', markdown: 'last line' }]);
    expect(splitAlignBlocks('text\n:::')).toEqual([{ align: null, markdown: 'text\n:::' }]);
  });

  it('accepts the marker lines with spaces around them', () => {
    expect(splitAlignBlocks('  ::: center  \nx\n  :::  ')).toEqual([{ align: 'center', markdown: 'x' }]);
  });
});

describe('stripAlignMarkers', () => {
  it('drops the marker lines and keeps the text', () => {
    expect(stripAlignMarkers('a\n::: center\nb\n:::\nc')).toBe('a\nb\nc');
  });
});
