// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { JSONContent } from '@tiptap/core';

const mammoth = vi.hoisted(() => ({ convertToHtml: vi.fn() }));
vi.mock('mammoth', () => ({ default: mammoth }));

import { BLOCK_ID_RE } from '../../../richdoc';
import {
  ImportError,
  cleanHtml,
  docxToHtml,
  fileProblem,
  fileToDoc,
  guessPaste,
  htmlToDoc,
  pasteFindings,
  pasteToDoc,
  sourceForFiles,
  titleFromName,
} from './importConvert';

const types = (doc: JSONContent) => (doc.content ?? []).map((n) => n.type);
const text = (n: JSONContent): string => (n.text ?? '') + (n.content ?? []).map(text).join('');
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('which files can be imported', () => {
  it('says why a file cannot be, before it is read', () => {
    expect(fileProblem({ name: 'notes.pages', size: 10 })).toMatchObject({
      code: 'unsupported',
      text: 'Export it from Pages as Word (.docx) and import that.',
    });
    expect(fileProblem({ name: 'big-report.docx', size: 34 * 1024 * 1024 })).toMatchObject({ code: 'too_large' });
    expect(fileProblem({ name: 'plan.md', size: 10 })?.code).toBe('markdown');
    expect(fileProblem({ name: 'rate-limits.docx', size: 48 * 1024 })).toBeNull();
    expect(fileProblem({ name: 'notes.HTM', size: 10 })).toBeNull();
  });

  it('opens on the source the files are', () => {
    expect(sourceForFiles([{ name: 'a.md' }, { name: 'b.markdown' }])).toBe('markdown');
    expect(sourceForFiles([{ name: 'a.md' }, { name: 'spec.docx' }])).toBe('word');
    expect(sourceForFiles([{ name: 'notes.html' }])).toBe('html');
    expect(sourceForFiles([])).toBe('markdown');
  });

  it('makes a title from a file name', () => {
    expect(titleFromName('requirements/rate-limits.docx')).toBe('rate limits');
  });
});

describe('HTML into a page', () => {
  it('removes scripts, styles, forms and handlers, and turns a frame into a link', () => {
    const { dom, title } = cleanHtml(
      '<html><head><title>Notes</title><style>p{}</style></head><body><p onclick="x()" class="a">Hi</p>' +
        '<script>alert(1)</script><form><input></form><iframe src="https://example.com/v"></iframe></body></html>',
    );
    expect(title).toBe('Notes');
    expect(dom.body.innerHTML).toBe('<p>Hi</p><p><a href="https://example.com/v">https://example.com/v</a></p>');
  });

  it('reads headings, lists, tables and marks with the editor schema, with a block id on every block', async () => {
    const page = await htmlToDoc(
      '<h1>Release notes</h1><p>We shipped <b>rate limiting</b>.</p><ul><li>Per-token counters</li></ul>' +
        '<table><tr><th>Plan</th></tr><tr><td>Free</td></tr></table>',
    );
    expect(page.title).toBe('Release notes');
    expect(types(page.doc)).toEqual(['paragraph', 'bulletList', 'table']);
    expect(page.doc.content![0].content![1]).toMatchObject({ text: 'rate limiting', marks: [{ type: 'bold' }] });
    for (const block of page.doc.content!) expect(block.attrs?.blockId).toMatch(BLOCK_ID_RE);
  });

  it('uploads data: pictures and points the page at the upload', async () => {
    const upload = vi.fn().mockResolvedValue('https://board/uploads/p1.png');
    const page = await htmlToDoc(`<p>Look</p><img src="${PNG}" alt="Chart">`, upload);
    expect(upload).toHaveBeenCalledTimes(1);
    expect((upload.mock.calls[0][0] as File).type).toBe('image/png');
    const img = page.doc.content!.find((n) => n.type === 'image');
    expect(img?.attrs?.src).toBe('https://board/uploads/p1.png');
    expect(page.droppedPictures).toBe(0);
  });

  it('drops a picture whose upload fails, and counts it', async () => {
    const page = await htmlToDoc(`<p>Look</p><img src="${PNG}">`, vi.fn().mockRejectedValue(new Error('413')));
    expect(page.droppedPictures).toBe(1);
    expect(types(page.doc)).toEqual(['paragraph']);
  });
});

describe('a Word file', () => {
  it('goes through mammoth to HTML, then into a page', async () => {
    mammoth.convertToHtml.mockResolvedValueOnce({
      value: '<h1>Rate limits</h1><p>Every route counts requests.</p>',
      messages: [],
    });
    const file = new File([new Uint8Array([0x50, 0x4b, 3, 4])], 'rate-limits.docx');
    const page = await fileToDoc(file);
    expect(mammoth.convertToHtml).toHaveBeenCalledWith({ arrayBuffer: expect.any(ArrayBuffer) });
    expect(page.title).toBe('Rate limits');
    expect(text(page.doc)).toBe('Every route counts requests.');
  });

  it('is refused with a reason when it is password-protected or unreadable', async () => {
    const locked = new File([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0])], 'api-guide.docx');
    await expect(docxToHtml(locked)).rejects.toThrow('This file is password-protected.');
    mammoth.convertToHtml.mockRejectedValueOnce(new Error('zip'));
    const broken = new File([new Uint8Array([1, 2, 3, 4])], 'broken.docx');
    await expect(docxToHtml(broken)).rejects.toBeInstanceOf(ImportError);
  });
});

describe('pasting', () => {
  it('guesses HTML, Markdown or plain text', () => {
    expect(guessPaste('<h1>Release notes</h1>\n<p>This week…</p>')).toBe('html');
    expect(guessPaste('# Release notes\n\n- one\n- two')).toBe('markdown');
    expect(guessPaste('Some **bold** words')).toBe('markdown');
    expect(guessPaste('Just a few words.\nAnd a second line.')).toBe('text');
    expect(guessPaste('  ')).toBe('text');
  });

  it('says what it found', () => {
    expect(pasteFindings('<h1>x</h1><ul><li>a</li></ul><b>y</b>', 'html')).toEqual(['headings', 'list', 'bold']);
  });

  it('reads each guess in its own way, and the guess can be switched', async () => {
    const md = await pasteToDoc('# Title\n\nSome **bold**', 'markdown');
    expect(md.title).toBe('Title');
    expect(types(md.doc)).toEqual(['paragraph']);
    const asText = await pasteToDoc('# Title\n\nSome **bold**', 'text');
    expect(asText.title).toBeNull();
    expect(text(asText.doc)).toBe('# TitleSome **bold**');
    const html = await pasteToDoc('<p>A <i>b</i></p>', 'html');
    expect(html.doc.content![0].content![1]).toMatchObject({ text: 'b', marks: [{ type: 'italic' }] });
  });
});
