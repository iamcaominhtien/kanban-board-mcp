// @vitest-environment jsdom
import { Editor, type JSONContent } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildExtensions } from '../extensions';
import { checkContrast, cssColor, hexOf, normalizeHex, recentColors, rememberColor } from './palette';
import {
  cleanPastedHtml,
  cleanupNote,
  isForeignRich,
  pasteSource,
  plainParagraphs,
  readPasteDefault,
  writePasteDefault,
} from './pasteMode';
import { RichFormatting, repaste, richStorage } from './RichFormatting';

let editor: Editor | null = null;
const opts = { onFocusMode: vi.fn(), onShortcuts: vi.fn() };

function make(content: JSONContent): Editor {
  editor = new Editor({
    extensions: [...buildExtensions({ isTicket: () => false, onLink: () => {} }), RichFormatting.configure(opts)],
    content,
  });
  return editor;
}

/** Sends a paste with this HTML and text to the editor's paste handlers, as the browser would. */
function paste(ed: Editor, html: string, text: string): boolean {
  const data = { getData: (t: string) => (t === 'text/html' ? html : t === 'text/plain' ? text : ''), files: [] };
  const event = { clipboardData: data, preventDefault() {} } as unknown as ClipboardEvent;
  return !!ed.view.someProp('handlePaste', (f) => f(ed.view, event, ed.state.doc.slice(0, 0)));
}

const WORD = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><body>
<h2 style="font-family:'Times New Roman';color:#C00000">Salt route survey</h2>
<p class=MsoNormal><span style="font-family:Lora;font-size:12pt;color:#1F5A8E">The route runs <b>north</b>.</span><o:p></o:p></p>
</body></html>`;

afterEach(() => {
  editor?.destroy();
  editor = null;
  localStorage.clear();
});

describe('palette and contrast', () => {
  it('draws names through the page variables and keeps hex as it is', () => {
    expect(cssColor('text', 'green')).toBe('var(--rd-c-green, #2E6F40)');
    expect(cssColor('highlight', 'yellow')).toBe('var(--rd-hl-yellow, #FFE9A8)');
    expect(cssColor('text', '#123abc')).toBe('#123abc');
    expect(cssColor('text', 'chartreuse')).toBeUndefined();
    expect(hexOf('text', 'green', '#17211A')).toBe('#7FCB95');
  });

  it('takes typed colours as #rrggbb', () => {
    expect(normalizeHex('2E6F40')).toBe('#2e6f40');
    expect(normalizeHex('#abc')).toBe('#aabbcc');
    expect(normalizeHex('nope')).toBeNull();
  });

  it('warns under 4.5 : 1 with a named colour to try, and says easy to read above', () => {
    const good = checkContrast('#2e6f40', '#FFFFFF');
    expect(good.ok).toBe(true);
    expect(good.message).toMatch(/^Contrast on this page 6\.\d : 1\. Easy to read\.$/);
    const low = checkContrast('#e8b93a', '#FFFFFF');
    expect(low.ok).toBe(false);
    expect(low.message).toMatch(/^Contrast on this page 1\.\d : 1\. Hard to read on white\. Try \w+\.$/);
    expect(low.suggestion).toBe('amber');
    // the same colour on a Night page reads well
    expect(checkContrast('#e8b93a', '#17211A').ok).toBe(true);
  });

  it('keeps the last five colours, newest first', () => {
    for (const c of ['red', 'blue', 'green', 'teal', 'pink', 'amber']) rememberColor('text', c);
    rememberColor('text', 'blue');
    expect(recentColors('text')).toEqual(['blue', 'amber', 'pink', 'teal', 'green']);
    expect(recentColors('highlight')).toEqual([]);
  });
});

describe('paste modes', () => {
  it('tells Word and the web apart, and a copy inside the editor from outside rich text', () => {
    expect(pasteSource(WORD)).toBe('word');
    expect(pasteSource('<p>hi</p>')).toBe('web');
    expect(isForeignRich('<p>hi</p>')).toBe(true);
    expect(isForeignRich('<p data-pm-slice="1 1 []">hi</p>')).toBe(false);
    expect(isForeignRich('')).toBe(false);
  });

  it('Match page style keeps structure and bold, drops fonts, colours and sizes', () => {
    const { html } = cleanPastedHtml(WORD, 'match');
    expect(html).toContain('<h2>Salt route survey</h2>');
    expect(html).toContain('<b>north</b>');
    expect(html).not.toMatch(/style=|color|font|Mso|o:p/i);
  });

  it('Keep formatting keeps colour, a shipped font and the size as the page marks', () => {
    const { html } = cleanPastedHtml(WORD, 'keep');
    expect(html).toContain('data-color="#1f5a8e"');
    expect(html).toContain('data-font-family="lora"');
    expect(html).toContain('data-font-size="16"');
    // Times New Roman is not one of the page fonts: dropped
    expect(html).not.toContain('Times');
  });

  it('turns styled bold and italic (Google Docs) into tags, and cleans the web', () => {
    const gdocs =
      '<b style="font-weight:normal" id="docs-internal-guid-1"><span style="font-weight:700">Bold</span> <span style="font-style:italic">it</span></b>' +
      '<script>x()</script><a href="https://site.test/a?utm_source=x&id=2">link</a>';
    const { html, removed } = cleanPastedHtml(gdocs, 'match');
    expect(html).toContain('<strong>Bold</strong>');
    expect(html).toContain('<em>it</em>');
    expect(html).not.toContain('script');
    expect(html).toContain('href="https://site.test/a?id=2"');
    expect(removed).toEqual({ scripts: 1, tracking: 1, styles: 3 });
    expect(cleanupNote(removed)).toBe('Removed scripts, tracking links and 3 inline styles.');
  });

  it('Plain text is one paragraph per line', () => {
    expect(plainParagraphs('a\r\n\nb\n')).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
      { type: 'paragraph' },
      { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
    ]);
  });

  it('defaults to Match page style, a per-device setting', () => {
    expect(readPasteDefault()).toBe('match');
    writePasteDefault('ask');
    expect(readPasteDefault()).toBe('ask');
  });
});

describe('paste chip in the editor', () => {
  it('pastes Word as Match page style, shows the chip, and switches the paste in place', () => {
    const ed = make({ type: 'doc', content: [{ type: 'paragraph' }] });
    ed.commands.setTextSelection(1);
    expect(paste(ed, WORD, 'Salt route survey\nThe route runs north.')).toBe(true);
    const chip = richStorage(ed)?.paste.get();
    expect(chip).toMatchObject({ mode: 'match', source: 'word', ask: false });
    expect(JSON.stringify(ed.getJSON())).not.toContain('textStyle');
    expect(ed.getJSON().content?.some((n) => n.type === 'heading')).toBe(true);

    repaste(ed, 'keep');
    expect(richStorage(ed)?.paste.get()?.mode).toBe('keep');
    const kept = JSON.stringify(ed.getJSON());
    expect(kept).toContain('"color":"#1f5a8e"');
    expect(kept).toContain('"fontFamily":"lora"');

    repaste(ed, 'plain');
    const plain = ed.getJSON();
    expect(JSON.stringify(plain)).not.toContain('heading');
    expect(JSON.stringify(plain)).not.toContain('bold');
    expect(ed.state.doc.textContent).toContain('Salt route survey');
    expect(ed.state.doc.textContent).toContain('The route runs north.');
  });

  it('closes the chip on the next edit; a copy inside the editor gets no chip', () => {
    const ed = make({ type: 'doc', content: [{ type: 'paragraph' }] });
    ed.commands.setTextSelection(1);
    paste(ed, '<p>From the <b>web</b></p>', 'From the web');
    expect(richStorage(ed)?.paste.get()).not.toBeNull();
    ed.commands.insertContent('x');
    expect(richStorage(ed)?.paste.get()).toBeNull();
    expect(paste(ed, '<p data-pm-slice="1 1 []">inner</p>', 'inner')).toBe(false);
    expect(richStorage(ed)?.paste.get()).toBeNull();
  });

  it('Ask me each time opens the options by itself', () => {
    writePasteDefault('ask');
    const ed = make({ type: 'doc', content: [{ type: 'paragraph' }] });
    ed.commands.setTextSelection(1);
    paste(ed, '<p>x</p>', 'x');
    expect(richStorage(ed)?.paste.get()).toMatchObject({ ask: true, mode: 'match' });
  });
});

describe('shortcuts', () => {
  const key = (ed: Editor, k: string, mods: KeyboardEventInit) => {
    const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods });
    // ProseMirror reads the key without Shift from the key code, as a browser gives it
    if (/^[A-Z]$/.test(k)) Object.defineProperty(ev, 'keyCode', { value: k.charCodeAt(0) });
    ed.view.dom.dispatchEvent(ev);
  };

  it('align, underline, sup and sub, clear, focus mode and the sheet', () => {
    const ed = make({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'abc' }] }] });
    ed.commands.setTextSelection({ from: 1, to: 3 });
    key(ed, 'E', { ctrlKey: true, shiftKey: true });
    expect(ed.getJSON().content?.[0].attrs?.textAlign).toBe('center');
    key(ed, 'J', { ctrlKey: true, shiftKey: true });
    expect(ed.getJSON().content?.[0].attrs?.textAlign).toBe('justify');
    key(ed, 'u', { ctrlKey: true });
    key(ed, '.', { ctrlKey: true });
    const marks = () => (ed.getJSON().content?.[0].content?.[0].marks ?? []).map((m) => m.type).sort();
    expect(marks()).toEqual(['superscript', 'underline']);
    key(ed, ',', { ctrlKey: true });
    expect(marks()).toEqual(['subscript', 'underline']);
    key(ed, '\\', { ctrlKey: true });
    expect(marks()).toEqual([]);
    key(ed, 'F', { ctrlKey: true, shiftKey: true });
    expect(opts.onFocusMode).toHaveBeenCalledTimes(1);
    key(ed, '/', { ctrlKey: true });
    expect(opts.onShortcuts).toHaveBeenCalledTimes(1);
  });
});
