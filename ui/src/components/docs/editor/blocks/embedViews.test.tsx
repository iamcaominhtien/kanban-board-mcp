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
import { siteUrl } from '../../embeds/htmlSandbox';
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

describe('HTML embed of a site (a folder, a .zip or an .html page)', () => {
  const SITE = {
    id: 'ab12cd34ef56',
    url: '/docs/sites/ab12cd34ef56/index.html',
    entry: 'index.html',
    files: [
      { path: 'index.html', bytes: 40 },
      { path: 'js/globe.js', bytes: 9 },
    ],
    bytes: 49,
  };
  const embedDoc = (attrs: Record<string, unknown>): RichDoc => ({
    type: 'doc',
    content: [{ type: 'htmlEmbed', attrs: { blockId: 'b-0000e2', html: '', runScripts: false, ...attrs } }],
  });
  const folderFiles = () => {
    const page = new File(['<h1>Globe</h1><script src="js/globe.js"></script>'], 'index.html', { type: 'text/html' });
    const script = new File(['spin()'], 'globe.js');
    Object.defineProperty(page, 'webkitRelativePath', { value: 'globe/index.html' });
    Object.defineProperty(script, 'webkitRelativePath', { value: 'globe/js/globe.js' });
    return [page, script];
  };
  const pick = (input: HTMLElement, files: File[]) => {
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    fireEvent.change(input);
  };
  const openMore = () => fireEvent.click(screen.getByRole('button', { name: 'More' }));

  it('uploads a folder from the embed, shows the site by its address and takes the folder name', async () => {
    api.post.mockResolvedValue({ data: SITE });
    const ref = renderEditor(embedDoc({}));
    await screen.findByTestId('docs-editor-surface');
    const input = screen.getByTestId('html-embed-folder-input');
    expect(input.hasAttribute('webkitdirectory')).toBe(true);
    openMore();
    expect(screen.getByRole('menuitem', { name: 'Upload folder…' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Upload .zip / .html…' })).toBeTruthy();
    pick(input, folderFiles());
    await waitFor(() => expect(blocks(ref)[0].attrs?.src).toBe(SITE.url));
    expect(blocks(ref)[0]).toMatchObject({
      type: 'htmlEmbed',
      attrs: { blockId: 'b-0000e2', title: 'globe', html: '', runScripts: true },
    });
    const [url, form] = api.post.mock.lastCall as [string, FormData];
    expect(url).toBe('/projects/p1/docs/sites');
    expect((form.getAll('files') as File[]).map((f) => f.name)).toEqual(['globe/index.html', 'globe/js/globe.js']);
    // a site has no Code tab; the frame opens its address
    expect(screen.queryByRole('tab', { name: 'Code' })).toBeNull();
    const frame = document.querySelector('.dk-html-embed iframe')!;
    expect(frame.getAttribute('src')).toBe(siteUrl(SITE.url));
    expect(screen.getByTestId('html-embed-site').textContent).toBe('Site · index.html');
  });

  it('uploads a .zip or an .html page into the embed and keeps its title; Back to inline code lets the site go', async () => {
    api.post.mockResolvedValue({ data: SITE });
    const ref = renderEditor(embedDoc({ title: 'Solar system', html: '<p>old</p>' }));
    await screen.findByTestId('docs-editor-surface');
    pick(screen.getByTestId('html-embed-file-input'), [new File(['PK'], 'solar.zip', { type: 'application/zip' })]);
    await waitFor(() => expect(blocks(ref)[0].attrs?.src).toBe(SITE.url));
    expect(blocks(ref)[0].attrs?.title).toBe('Solar system');
    expect(((api.post.mock.lastCall as [string, FormData])[1].get('files') as File).name).toBe('solar.zip');
    openMore();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Back to inline code' }));
    expect(blocks(ref)[0].attrs?.src).toBeNull();
    expect(await screen.findByRole('textbox', { name: 'HTML code' })).toBeTruthy();
  });

  it('keeps a refused upload on the embed with what the server said; Cancel puts back what it showed', async () => {
    api.post.mockRejectedValue({ response: { status: 422, data: { detail: 'no_html_page' } } });
    const ref = renderEditor(embedDoc({ html: '<p>kept</p>' }));
    await screen.findByTestId('docs-editor-surface');
    pick(screen.getByTestId('html-embed-folder-input'), folderFiles());
    expect(await screen.findByText(/There is no HTML page in it/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(blocks(ref)[0].attrs).toMatchObject({ src: null, html: '<p>kept</p>' });
  });

  it('a dropped .html file becomes an HTML embed of a site, not a file card', async () => {
    api.post.mockResolvedValue({ data: { ...SITE, url: '/docs/sites/ab12cd34ef56/globe.html', entry: 'globe.html' } });
    const ref = renderEditor(EMPTY);
    const surface = await screen.findByTestId('docs-editor-surface');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/projects/p1/docs/settings'));
    const editor = ref.current!.getEditor()!;
    // jsdom has no layout: the drop lands at the start of the page
    editor.view.posAtCoords = () => ({ pos: 1, inside: 0 });
    const file = new File(['<h1>Globe</h1>'], 'globe.html', { type: 'text/html' });
    fireEvent.drop(surface, { dataTransfer: { files: [file], types: ['Files'], getData: () => '' } });
    await waitFor(() =>
      expect(blocks(ref).find((b) => b.type === 'htmlEmbed')?.attrs?.src).toBe('/docs/sites/ab12cd34ef56/globe.html'),
    );
    expect(blocks(ref).find((b) => b.type === 'htmlEmbed')?.attrs?.title).toBe('globe');
    expect(blocks(ref).some((b) => b.type === 'fileCard')).toBe(false);
    expect(api.post).toHaveBeenCalledWith('/projects/p1/docs/sites', expect.any(FormData), expect.anything());
  });

  it('a pasted .zip with no page in it goes in as a file card instead', async () => {
    api.post.mockImplementation((url: string) =>
      url.endsWith('/docs/sites')
        ? Promise.reject({ response: { status: 422, data: { detail: { code: 'no_html_page' } } } })
        : Promise.resolve({
            data: { src: '/uploads/data_1.zip', name: 'data.zip', size: 2, mime: 'application/zip', kind: 'file' },
          }),
    );
    const ref = renderEditor(EMPTY);
    const surface = await screen.findByTestId('docs-editor-surface');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/projects/p1/docs/settings'));
    const file = new File(['PK'], 'data.zip', { type: 'application/zip' });
    fireEvent.paste(surface, { clipboardData: { getData: () => '', files: [file], types: ['Files'] } });
    await waitFor(() => expect(blocks(ref).find((b) => b.type === 'fileCard')?.attrs?.src).toBe('/uploads/data_1.zip'));
    expect(blocks(ref).some((b) => b.type === 'htmlEmbed')).toBe(false);
  });
});

describe('Turn into HTML embed (block menu of a code block)', () => {
  const code = (language: string | null, text: string): RichDoc => ({
    type: 'doc',
    content: [{ type: 'codeBlock', attrs: { blockId: 'b-0000c1', language }, content: [{ type: 'text', text }] }],
  });

  it('turns an HTML code block into an embed of its code, keeping the block id', async () => {
    const html = '<canvas id="c"></canvas>\n<script>draw()</script>';
    const ref = renderEditor(code('html', html));
    await screen.findByTestId('docs-editor-surface');
    const editor = ref.current!.getEditor()!;
    askBlockUi(editor, { type: 'blockMenu', pos: 0, anchor: new DOMRect(0, 0, 10, 10) });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Turn into HTML embed' }));
    expect(blocks(ref)[0]).toMatchObject({
      type: 'htmlEmbed',
      attrs: { blockId: 'b-0000c1', html, runScripts: true, src: null },
    });
  });

  it('offers it for a code block with no language, not for another language', async () => {
    const ref = renderEditor(code('javascript', 'run()'));
    await screen.findByTestId('docs-editor-surface');
    const editor = ref.current!.getEditor()!;
    askBlockUi(editor, { type: 'blockMenu', pos: 0, anchor: new DOMRect(0, 0, 10, 10) });
    await screen.findByTestId('block-menu');
    expect(screen.queryByRole('menuitem', { name: 'Turn into HTML embed' })).toBeNull();
    cleanup();
    const plain = renderEditor(code(null, '<b>Hi</b>'));
    await screen.findByTestId('docs-editor-surface');
    askBlockUi(plain.current!.getEditor()!, { type: 'blockMenu', pos: 0, anchor: new DOMRect(0, 0, 10, 10) });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Turn into HTML embed' }));
    expect(blocks(plain)[0]).toMatchObject({ type: 'htmlEmbed', attrs: { html: '<b>Hi</b>', runScripts: false } });
  });
});
