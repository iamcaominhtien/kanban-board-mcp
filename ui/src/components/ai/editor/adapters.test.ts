// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { textareaAdapter } from './adapters';

function box(value: string, start: number, end = start): HTMLTextAreaElement {
  const el = document.createElement('textarea');
  el.value = value;
  document.body.appendChild(el);
  el.setSelectionRange(start, end);
  return el;
}

/** jsdom has no execCommand; false is what a browser without the command answers, so the fallback edits the text. */
function execCommand(result: boolean) {
  const fn = vi.fn(() => result);
  Object.defineProperty(document, 'execCommand', { value: fn, configurable: true });
  return fn;
}

describe('textareaAdapter', () => {
  beforeEach(() => {
    execCommand(false);
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('replaces the selection with the AI text', () => {
    const el = box('one two three', 4, 7);
    const cap = textareaAdapter(() => el).capture('selection');
    expect(cap?.selection).toBe('two');
    expect(cap?.apply('2', { kind: 'replace' })).toBe(true);
    expect(el.value).toBe('one 2 three');
  });

  it('inserts a block after the selection on a new paragraph', () => {
    const el = box('first line', 0, 5);
    const cap = textareaAdapter(() => el).capture('selection');
    expect(cap?.apply('added', { kind: 'insert', block: true })).toBe(true);
    expect(el.value).toBe('first\n\nadded line');
  });

  it('removes a typed "/ai" before the cursor', () => {
    const el = box('note /ai', 8);
    el.focus();
    const slash = textareaAdapter(() => el).slash?.();
    slash?.remove();
    expect(el.value).toBe('note ');
  });

  it('lets the browser insert the text when it can, so Ctrl+Z undoes it', () => {
    const exec = execCommand(true);
    const el = box('abc', 1, 2);
    const cap = textareaAdapter(() => el).capture('selection');
    expect(cap?.apply('X', { kind: 'replace' })).toBe(true);
    expect(exec).toHaveBeenCalledWith('insertText', false, 'X');
    expect(el.value).toBe('abc');
  });
});
