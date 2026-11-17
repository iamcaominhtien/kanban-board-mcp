// @vitest-environment jsdom
import type { JSONContent } from '@tiptap/core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock('../../../../api/tickets', () => ({
  uploadAnyFile: vi.fn(),
  uploadDescriptionImage: vi.fn(),
  useTickets: () => ({ data: [] }),
}));
vi.mock('../../../../api/client', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, client: { ...(real.client as object), get: api.get, post: api.post } };
});

import type { RichDoc } from '../../../../types/docs';
import { ToastProvider } from '../../../Toast';
import { DocsEditor, type DocsEditorHandle } from '../DocsEditor';
import { askBlockUi } from './bus';
import { startImageUpload } from './imageUpload';

const noRects = () =>
  ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
Range.prototype.getClientRects = noRects;
Range.prototype.getBoundingClientRect = rect;
const textProto = Text.prototype as unknown as { getClientRects?: () => DOMRectList };
if (!textProto.getClientRects) textProto.getClientRects = noRects;
document.elementFromPoint = () => null;
if (!URL.createObjectURL) URL.createObjectURL = () => 'blob:local';
if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {};

const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

const PAGE: RichDoc = {
  type: 'doc',
  content: [
    p('Intro'),
    {
      type: 'image',
      attrs: { src: 'https://img.example/a.png', placement: 'floatRight', widthPct: 40, wrapGap: 20, alt: 'Team' },
    },
    {
      type: 'columns',
      attrs: { ratio: '1:2', line: true },
      content: [
        { type: 'column', content: [p('Left')] },
        { type: 'column', content: [p('Right')] },
      ],
    },
    {
      type: 'callout',
      attrs: { kind: 'custom', color: 'violet', icon: '💡', style: 'bar', title: 'Idea' },
      content: [p('Own colour')],
    },
    { type: 'horizontalRule', attrs: { style: 'stars' } },
    { type: 'blockquote', attrs: { variant: 'serif', source: 'Hoa Mai' }, content: [p('Write it down once')] },
    {
      type: 'pullQuote',
      attrs: { textAlign: 'left' },
      content: [{ type: 'text', text: 'The board became the place' }],
    },
    { type: 'bulletList', attrs: { listStyle: 'square' }, content: [{ type: 'listItem', content: [p('One')] }] },
  ],
};

function renderEditor() {
  const ref = createRef<DocsEditorHandle>();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <DocsEditor
          ref={ref}
          projectId="p1"
          content={PAGE}
          onContentChange={vi.fn()}
          nodes={[]}
          currentPageId="pg1"
          pageTitle="Overview"
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return ref;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('block views in the editor', () => {
  it('draws images, columns, callouts, dividers, quotes and lists as the reader does', async () => {
    api.get.mockResolvedValue({ data: { uploads: { imageMb: 10 } } });
    renderEditor();
    const surface = await screen.findByTestId('docs-editor-surface');
    const img = surface.querySelector('.dk-img-floatRight') as HTMLElement;
    expect(img).toBeTruthy();
    expect(img.getAttribute('style')).toContain('width:40%');
    expect(img.getAttribute('style')).toContain('margin-left:20px');
    const cols = surface.querySelector('.dk-colsv') as HTMLElement;
    expect(cols.className).toContain('dk-colsv-line');
    expect(cols.style.getPropertyValue('--dk-cols')).toBe('minmax(0, 1fr) minmax(0, 2fr)');
    const callout = surface.querySelector('[data-callout="custom"]') as HTMLElement;
    expect(callout.getAttribute('data-callout-style')).toBe('bar');
    expect(callout.textContent).toContain('💡');
    expect((callout.querySelector('input[aria-label="Callout title"]') as HTMLInputElement).value).toBe('Idea');
    expect(surface.querySelector('.dk-rule-stars')?.textContent).toBe('* * *');
    expect(surface.querySelector('blockquote.dk-quote-serif')).toBeTruthy();
    expect((surface.querySelector('input[aria-label="Source"]') as HTMLInputElement).value).toBe('Hoa Mai');
    expect((surface.querySelector('.dk-pullquote') as HTMLElement).style.textAlign).toBe('left');
    expect(surface.querySelector('ul[data-list-style="square"]')).toBeTruthy();
  });

  it('says how large a refused picture is, against the project limit', async () => {
    api.get.mockResolvedValue({ data: { uploads: { imageMb: 2 } } });
    const ref = renderEditor();
    await screen.findByTestId('docs-editor-surface');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/projects/p1/docs/settings'));
    const big = new File([new Uint8Array(3 * 1024 * 1024)], 'offsite.jpg', { type: 'image/jpeg' });
    const editor = ref.current!.getEditor()!;
    await waitFor(() =>
      expect((editor.storage as unknown as { blockKit: { imageLimitMb: number } }).blockKit.imageLimitMb).toBe(2),
    );
    startImageUpload(editor, big, { limitMb: 2 });
    expect(await screen.findByText('Too large')).toBeTruthy();
    expect(screen.getByText('offsite.jpg is 3.0 MB. An image can be 2 MB at most.')).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('keeps a failed upload in the page with Try again', async () => {
    api.get.mockResolvedValue({ data: {} });
    api.post.mockRejectedValueOnce(new Error('offline'));
    const ref = renderEditor();
    await screen.findByTestId('docs-editor-surface');
    const editor = ref.current!.getEditor()!;
    startImageUpload(editor, new File(['x'], 'login-error.png', { type: 'image/png' }), { limitMb: 10 });
    expect(await screen.findByText('Upload failed')).toBeTruthy();
    expect(screen.getByText('login-error.png did not reach the server. It is kept in this browser.')).toBeTruthy();
    api.post.mockResolvedValueOnce({ data: { src: '/uploads/login.png', name: 'login.png', kind: 'image' } });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(JSON.stringify(editor.getJSON())).toContain('/uploads/login.png'));
    // Rich Docs phase 5: pictures go to the project's Docs uploads (its limit, a virus scan), as kind "image"
    expect(api.post.mock.lastCall?.[0]).toBe('/projects/p1/docs/uploads');
    expect((api.post.mock.lastCall?.[1] as FormData).get('kind')).toBe('image');
  });

  it('opens the Insert image dialog with its three tabs', async () => {
    api.get.mockResolvedValue({ data: {} });
    const ref = renderEditor();
    await screen.findByTestId('docs-editor-surface');
    askBlockUi(ref.current!.getEditor(), { type: 'insertImage' });
    const dialog = await screen.findByRole('dialog', { name: 'Insert image' });
    expect(dialog.textContent).toContain('PNG, JPG, GIF, WebP or SVG, up to 10 MB.');
    fireEvent.click(screen.getByRole('tab', { name: 'Project files' }));
    expect(dialog.textContent).toContain('a.png');
  });

  it('opens the block menu from the handle and duplicates the block with a new id', async () => {
    api.get.mockResolvedValue({ data: {} });
    const ref = renderEditor();
    await screen.findByTestId('docs-editor-surface');
    const editor = ref.current!.getEditor()!;
    askBlockUi(editor, { type: 'blockMenu', pos: 0, anchor: new DOMRect(0, 0, 10, 10) });
    const menu = await screen.findByTestId('block-menu');
    expect(menu.textContent).toContain('Paragraph');
    expect(menu.textContent).toContain('Copy link to block');
    fireEvent.click(screen.getByRole('menuitem', { name: /Duplicate/ }));
    const blocks = (editor.getJSON() as JSONContent).content ?? [];
    expect(blocks[0].content?.[0].text).toBe('Intro');
    expect(blocks[1].content?.[0].text).toBe('Intro');
    expect(blocks[1].attrs?.blockId).not.toBe(blocks[0].attrs?.blockId);
  });

  it('turns a paragraph into a heading from the block menu', async () => {
    api.get.mockResolvedValue({ data: {} });
    const ref = renderEditor();
    await screen.findByTestId('docs-editor-surface');
    const editor = ref.current!.getEditor()!;
    askBlockUi(editor, { type: 'blockMenu', pos: 0, anchor: new DOMRect(0, 0, 10, 10) });
    fireEvent.click(await screen.findByRole('menuitem', { name: /Turn into/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Heading 2' }));
    expect(editor.getJSON().content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } });
  });
});
