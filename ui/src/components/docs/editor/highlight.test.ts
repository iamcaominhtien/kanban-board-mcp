// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildExtensions } from './extensions';
import { cleanEditorMarkdown } from '../../../utils/docsMarkdown';
import { compactMarkdown } from './compactMarkdown';

let editor: Editor | null = null;
const roundTrip = (md: string) => {
  editor = new Editor({
    extensions: buildExtensions({ isTicket: () => false, onLink: () => {} }),
    content: md,
    contentType: 'markdown',
  });
  return compactMarkdown(cleanEditorMarkdown(editor.getMarkdown())).trim();
};

describe('Docs editor: text highlight is stored as ==text==', () => {
  afterEach(() => {
    editor?.destroy();
    editor = null;
  });

  it('keeps ==text== through the editor', () => {
    expect(roundTrip('Tokens last ==30 days== for now.')).toBe('Tokens last ==30 days== for now.');
  });

  it('keeps bold inside a highlight', () => {
    expect(roundTrip('A ==**key** point== here.')).toBe('A ==**key** point== here.');
  });

  it('leaves == inside inline code and code blocks alone', () => {
    expect(roundTrip('Compare with `a == b` only.')).toBe('Compare with `a == b` only.');
    expect(roundTrip('```js\nif (a == b) {}\n```')).toBe('```js\nif (a == b) {}\n```');
  });

  it('shows a <mark> in the editor', () => {
    roundTrip('Read ==this== first.');
    expect(editor!.getHTML()).toContain('<mark>this</mark>');
  });

  it('toggles a highlight on the selection and writes ==…==', () => {
    roundTrip('Make this stand out.');
    editor!.commands.setTextSelection({ from: 6, to: 10 });
    editor!.commands.toggleHighlight();
    expect(compactMarkdown(cleanEditorMarkdown(editor!.getMarkdown())).trim()).toBe('Make ==this== stand out.');
  });
});
