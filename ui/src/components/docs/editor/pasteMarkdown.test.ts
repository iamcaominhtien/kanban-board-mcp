import { describe, expect, it } from 'vitest';
import { markdownToPaste } from './pasteMarkdown';

describe('markdownToPaste', () => {
  it('takes Markdown with block syntax from a plain-text source', () => {
    expect(markdownToPaste('## Title\n\n- one\n- two', '')).toBe('## Title\n\n- one\n- two');
    expect(markdownToPaste('| a | b |\n|---|---|\n| 1 | 2 |', '')).not.toBeNull();
    expect(markdownToPaste('```sh\nls\n```', '')).not.toBeNull();
    expect(markdownToPaste('Steps:\r\n1. one\r\n2. two', '')).toBe('Steps:\n1. one\n2. two');
  });

  it('leaves one line, prose and rich HTML to the browser', () => {
    expect(markdownToPaste('## Title', '')).toBeNull();
    expect(markdownToPaste('just words\nmore words', '')).toBeNull();
    expect(markdownToPaste('## Title\n\n- one', '<h2>Title</h2><ul><li>one</li></ul>')).toBeNull();
  });

  it('treats a code editor’s styled copy as plain text', () => {
    expect(markdownToPaste('## Title\n- one', '<div style="color:#000"><span>## Title</span><br><span>- one</span></div>')).not.toBeNull();
  });
});
