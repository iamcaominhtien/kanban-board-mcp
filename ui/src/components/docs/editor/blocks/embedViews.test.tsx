// @vitest-environment jsdom
import type { JSONContent } from '@tiptap/core';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock('../../../../api/tickets', () => ({
  uploadAnyFile: vi.fn(),
  uploadDescriptionImage: vi.fn(),
  useTickets: () => ({ data: [] }),
  getTicket: vi.fn(() => Promise.reject(new Error('offline'))),
  uploadUrl: (u: string) => u,
}));
vi.mock('../../../../api/client', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, client: { ...(real.client as object), get: api.get, post: api.post } };
});

import type { RichDoc } from '../../../../types/docs';
import { ToastProvider } from '../../../Toast';
import { reportSavedEmbeds } from '../../embeds/cleanedHtml';
import { DocsEditor, type DocsEditorHandle } from '../DocsEditor';
import { filterSlash } from '../slashItems';
import { askBlockUi } from './bus';
import { startDocUpload } from './docUpload';
import { cardToChip, chipToCard } from './refCards';

const noRects = () =>
  ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
Range.prototype.getClientRects = noRects;
Range.prototype.getBoundingClientRect = rect;
const textProto = Text.prototype as unknown as { getClientRects?: () => DOMRectList };
if (!textProto.getClientRects) textProto.getClientRects = noRects;
document.elementFromPoint = () => null;

type Preview = Record<string, unknown>;
let preview: Preview = {};

beforeEach(() => {
  preview = {};
  api.get.mockImplementation((url: string) => {
    if (url === '/docs/link-preview') return Promise.resolve({ data: preview });
    if (url.endsWith('/docs/settings')) return Promise.resolve({ data: { scriptsInEmbeds: 'ask' } });
    return Promise.reject(new Error(`unexpected ${url}`));
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderEditor(content: RichDoc) {
  const ref = createRef<DocsEditorHandle>();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <DocsEditor
          ref={ref}
          projectId="p1"
          content={content}
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

const EMPTY: RichDoc = { type: 'doc', content: [{ type: 'paragraph', attrs: { blockId: 'b-000001' } }] };
const blocks = (ref: ReturnType<typeof renderEditor>) =>
  (ref.current!.getEditor()!.getJSON() as JSONContent).content ?? [];

/** Pastes plain text where the cursor is (the start of the page). */
function paste(surface: HTMLElement, text: string) {
  fireEvent.paste(surface, {
    clipboardData: { getData: (t: string) => (t === 'text/plain' ? text : ''), files: [], types: ['text/plain'] },
  });
}

describe('a pasted link', () => {
  it('asks what it becomes, and Embed video puts a player in its place', async () => {
    preview = {
      url: 'https://www.youtube.com/watch?v=k3Rn8e',
      title: 'Designing a calmer board',
      site: 'youtube.com',
      kind: 'video',
      embeddable: true,
      provider: 'youtube',
      embedUrl: 'https://www.youtube-nocookie.com/embed/k3Rn8e',
    };
    const ref = renderEditor(EMPTY);
    const surface = await screen.findByTestId('docs-editor-surface');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/projects/p1/docs/settings'));
    paste(surface, 'https://www.youtube.com/watch?v=k3Rn8e');
    const menu = await screen.findByTestId('paste-link-menu');
    expect(blocks(ref)[0].content?.[0].marks?.[0].type).toBe('link');
    await screen.findByRole('menuitem', { name: /Embed video/ });
    expect(menu.textContent).toContain('Link card');
    expect(menu.textContent).toContain('Plain link');
    expect(menu.textContent).toContain('Esc keeps the plain link');
    fireEvent.click(screen.getByRole('menuitem', { name: /Embed video/ }));
    expect(blocks(ref)[0]).toMatchObject({
      type: 'linkEmbed',
      attrs: { url: 'https://www.youtube.com/watch?v=k3Rn8e', kind: 'video', title: 'Designing a calmer board' },
    });
    // the player is a picture until Play
    expect(surface.querySelector('iframe')).toBeNull();
  });

  it('offers only a card or a plain link for a site that cannot be embedded; Esc keeps the link', async () => {
    preview = { url: 'https://example.com/plan', title: 'How we plan a quarter', kind: 'link', embeddable: false };
    const ref = renderEditor(EMPTY);
    const surface = await screen.findByTestId('docs-editor-surface');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/projects/p1/docs/settings'));
    paste(surface, 'https://example.com/plan');
    await screen.findByText('How we plan a quarter');
    expect(screen.queryByRole('menuitem', { name: /Embed video/ })).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('paste-link-menu')).toBeNull());
    expect(blocks(ref)[0].type).toBe('paragraph');
    // pasted again, Link card makes a card with what was read
    act(() => {
      ref.current!.getEditor()!.commands.setContent(EMPTY);
    });
    paste(surface, 'https://example.com/plan');
    fireEvent.click(await screen.findByRole('menuitem', { name: /Link card/ }));
    expect(blocks(ref)[0]).toMatchObject({
      type: 'linkEmbed',
      attrs: { url: 'https://example.com/plan', kind: 'card', title: 'How we plan a quarter' },
    });
  });
});

describe('references: chip or card', () => {
  const PAGE: RichDoc = {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { blockId: 'b-000001' }, content: [{ type: 'ticketRef', attrs: { key: 'KAN-12' } }] },
      {
        type: 'paragraph',
        attrs: { blockId: 'b-000002' },
        content: [
          { type: 'text', text: 'Rules live in ' },
          { type: 'docRef', attrs: { page: 'Requirements' } },
          { type: 'text', text: '.' },
        ],
      },
    ],
  };

  it('turns a chip on its own line into a card in its place, and back', async () => {
    api.post.mockResolvedValue({ data: [] });
    const ref = renderEditor(PAGE);
    await screen.findByTestId('docs-editor-surface');
    const editor = ref.current!.getEditor()!;
    act(() => {
      expect(chipToCard(editor, 0)).toBe(true);
    });
    expect(blocks(ref)[0]).toMatchObject({ type: 'ticketCard', attrs: { key: 'KAN-12' } });
    expect(await screen.findByTestId('ticket-card')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show as chip' }));
    expect(blocks(ref)[0]).toMatchObject({
      type: 'paragraph',
      content: [{ type: 'ticketRef', attrs: { key: 'KAN-12' } }],
    });
  });

  it('keeps a chip inside a sentence and puts the card on the next line (block menu "Show as card")', async () => {
    api.post.mockResolvedValue({ data: [] });
    const ref = renderEditor(PAGE);
    await screen.findByTestId('docs-editor-surface');
    const editor = ref.current!.getEditor()!;
    const pos = editor.state.doc.child(0).nodeSize;
    act(() => askBlockUi(editor, { type: 'blockMenu', pos, anchor: new DOMRect(0, 0, 10, 10) }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Show as card' }));
    const list = blocks(ref);
    expect(list[1].content?.some((c) => c.type === 'docRef')).toBe(true);
    expect(list[2]).toMatchObject({ type: 'pageCard', attrs: { page: 'Requirements' } });
    act(() => {
      expect(cardToChip(editor, editor.state.doc.child(0).nodeSize + editor.state.doc.child(1).nodeSize)).toBe(true);
    });
    expect(blocks(ref)[2]).toMatchObject({
      type: 'paragraph',
      content: [{ type: 'docRef', attrs: { page: 'Requirements' } }],
    });
  });
});

describe('HTML embed while editing', () => {
  it('takes the code when typing stops and says what saving removed', async () => {
    const ref = renderEditor({
      type: 'doc',
      content: [{ type: 'htmlEmbed', attrs: { blockId: 'b-0000e1', html: '', title: 'Pricing', runScripts: false } }],
    });
    await screen.findByTestId('docs-editor-surface');
    // a new, empty embed opens on its Code tab
    const code = await screen.findByRole('textbox', { name: 'HTML code' });
    const typed = '<div onclick="track()">\n<h3>Team</h3>\n</div>';
    fireEvent.change(code, { target: { value: typed } });
    await waitFor(() => expect(blocks(ref)[0].attrs?.html).toBe(typed), { timeout: 2000 });
    const frame = document.querySelector('.dk-html-embed iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(screen.getByText(/3 lines/)).toBeTruthy();
    act(() =>
      reportSavedEmbeds(
        { type: 'doc', content: [blocks(ref)[0] as RichDoc] },
        {
          type: 'doc',
          content: [{ type: 'htmlEmbed', attrs: { blockId: 'b-0000e1', html: '<div>\n<h3>Team</h3>\n</div>' } }],
        },
      ),
    );
    const note = await screen.findByTestId('html-embed-removed');
    expect(note.textContent).toContain('Saved. 1 thing was removed');
    expect(note.textContent).toContain('an onclick attribute');
    fireEvent.click(screen.getByRole('button', { name: 'Delete crossed-out lines' }));
    await waitFor(() => expect(blocks(ref)[0].attrs?.html).toBe('<h3>Team</h3>\n</div>'), { timeout: 2000 });
  });
});

describe('file uploads', () => {
  it('keeps a refused file on the page with what the server said, and Remove takes it away', async () => {
    api.post.mockRejectedValue({
      response: {
        status: 415,
        data: { detail: { code: 'type_not_allowed', message: 'Programs cannot be attached.' } },
      },
    });
    const ref = renderEditor(EMPTY);
    await screen.findByTestId('docs-editor-surface');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/projects/p1/docs/settings'));
    const editor = ref.current!.getEditor()!;
    await waitFor(() => expect(startDocUpload(editor, new File(['MZ'], 'setup.exe'), { kind: 'file' })).not.toBeNull());
    expect(await screen.findByText('Blocked. Programs cannot be attached.')).toBeTruthy();
    expect(blocks(ref).some((b) => b.type === 'fileCard')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(blocks(ref).some((b) => b.type === 'fileCard')).toBe(false);
  });

  it('does not send a video over the project limit', async () => {
    api.get.mockImplementation((url: string) =>
      Promise.resolve({ data: url.endsWith('/docs/settings') ? { uploads: { videoMb: 1 } } : {} }),
    );
    const ref = renderEditor(EMPTY);
    await screen.findByTestId('docs-editor-surface');
    const editor = ref.current!.getEditor()!;
    await waitFor(() =>
      expect((editor.storage as unknown as { blockKit: { videoLimitMb: number } }).blockKit.videoLimitMb).toBe(1),
    );
    startDocUpload(editor, new File([new Uint8Array(2 * 1024 * 1024)], 'demo.mp4', { type: 'video/mp4' }), {
      kind: 'video',
    });
    expect(await screen.findByText('Too large. A video can be 1 MB at most.')).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('the Insert catalog', () => {
  it('offers video, HTML embed, Embed from link and Insert diagram on a rich page only', () => {
    const rich = filterSlash('').map((i) => i.id);
    for (const id of ['video', 'html', 'embed-link', 'diagram-insert']) expect(rich).toContain(id);
    const plain = filterSlash('', { rich: false }).map((i) => i.id);
    for (const id of ['video', 'html', 'embed-link', 'diagram-insert']) expect(plain).not.toContain(id);
    expect(filterSlash('youtube')[0].id).toBe('embed-link');
  });
});
