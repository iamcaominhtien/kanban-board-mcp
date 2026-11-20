// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const uploads = vi.hoisted(() => ({
  uploadAnyFile: vi.fn(),
  uploadDescriptionImage: vi.fn(),
}));

vi.mock('../../../api/tickets', () => ({
  ...uploads,
  useTickets: () => ({ data: [] }),
  uploadUrl: (u: string) => u,
}));

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../../api/client', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, client: { ...(real.client as object), get: api.get, post: api.post } };
});

import { BLOCK_ID_RE } from '../../../richdoc';
import type { RichDoc } from '../../../types/docs';
import { ToastProvider } from '../../Toast';
import { DocsEditor, type DocsEditorHandle } from './DocsEditor';

// jsdom has no layout; ProseMirror measures the selection to scroll it into view
const noRects = () =>
  ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
Range.prototype.getClientRects = noRects;
Range.prototype.getBoundingClientRect = rect;
const textProto = Text.prototype as unknown as { getClientRects?: () => DOMRectList };
if (!textProto.getClientRects) textProto.getClientRects = noRects;
document.elementFromPoint = () => null;

const PAGE: RichDoc = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { blockId: 'b-0000a1', level: 2, textAlign: 'center' },
      content: [{ type: 'text', text: 'Intro' }],
    },
    {
      type: 'paragraph',
      attrs: { blockId: 'b-0000a2' },
      content: [{ type: 'text', text: 'Teal', marks: [{ type: 'textStyle', attrs: { color: 'teal' } }] }],
    },
  ],
};

function renderEditor(onContentChange = vi.fn()) {
  const ref = createRef<DocsEditorHandle>();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <DocsEditor
          ref={ref}
          projectId="p1"
          content={PAGE}
          onContentChange={onContentChange}
          nodes={[]}
          currentPageId="pg1"
          pageTitle="Overview"
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onContentChange, ref };
}

function blockIds(doc: RichDoc): string[] {
  const out: string[] = [];
  const walk = (n: RichDoc) => {
    if (n.attrs && 'blockId' in n.attrs) out.push(String(n.attrs.blockId));
    n.content?.forEach(walk);
  };
  walk(doc);
  return out;
}

describe('DocsEditor on a rich page', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('loads the JSON with its rich attributes and has no Markdown pane', async () => {
    renderEditor();
    const surface = await screen.findByTestId('docs-editor-surface');
    const h2 = surface.querySelector('h2')!;
    expect(h2.textContent).toBe('Intro');
    expect(h2.getAttribute('data-block-id')).toBe('b-0000a1');
    expect(surface.querySelector('[data-color="teal"]')?.textContent).toBe('Teal');
    expect(screen.queryByRole('textbox', { name: 'Markdown source' })).toBeNull();
  });

  it('reports nothing when the page was only opened, and flushContent gives the page back as it was', async () => {
    const { onContentChange, ref } = renderEditor();
    const surface = await screen.findByTestId('docs-editor-surface');
    fireEvent.focus(surface);
    fireEvent.blur(surface);
    await new Promise((r) => setTimeout(r, 250));
    expect(onContentChange).not.toHaveBeenCalled();
    expect(ref.current?.flushContent()).toEqual(PAGE);
    expect(ref.current?.flush()).toBe('## Intro\n\nTeal');
  });

  it('emits the page JSON after an edit, every block with a valid, unique block id', async () => {
    // Rich Docs phase 5: a file attached to a rich page is a file card, uploaded to the project's Docs uploads
    api.get.mockResolvedValue({ data: {} });
    api.post.mockResolvedValue({
      data: {
        src: '/uploads/report_abc.xlsx',
        name: 'report.xlsx',
        size: 3,
        mime: 'application/vnd.ms-excel',
        kind: 'file',
      },
    });
    const { onContentChange } = renderEditor();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/projects/p1/docs/settings'));
    const input = screen.getByTestId('docs-attach-input');
    Object.defineProperty(input, 'files', {
      value: [new File(['a,b'], 'report.xlsx', { type: 'application/vnd.ms-excel' })],
      configurable: true,
    });
    fireEvent.change(input);
    await waitFor(
      () => expect(JSON.stringify(onContentChange.mock.lastCall?.[0])).toContain('/uploads/report_abc.xlsx'),
      { timeout: 3000 },
    );
    const doc = onContentChange.mock.lastCall?.[0] as RichDoc;
    expect(doc.type).toBe('doc');
    expect(doc.content?.find((b) => b.type === 'heading')).toMatchObject({
      attrs: { blockId: 'b-0000a1', textAlign: 'center' },
    });
    expect(doc.content?.find((b) => b.type === 'fileCard')).toMatchObject({
      attrs: { src: '/uploads/report_abc.xlsx', name: 'report.xlsx', size: 3 },
    });
    expect(api.post).toHaveBeenCalledWith('/projects/p1/docs/uploads', expect.any(FormData), expect.anything());
    expect(uploads.uploadAnyFile).not.toHaveBeenCalled();
    const ids = blockIds(doc);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(ids.every((id) => BLOCK_ID_RE.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
