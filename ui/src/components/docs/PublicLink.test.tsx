// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { client } from '../../api/client';
import type { PublicLinkState } from '../../api/docsPublic';
import type { DocsPage } from '../../types/docs';
import { PublicPageApp } from './PublicPageApp';
import { publicDoc } from './publicView';
import { SharePopover } from './SharePopover';

const LINK = {
  token: 'a'.repeat(32),
  path: `/?public=${'a'.repeat(32)}`,
  expiresAt: null,
  showNames: false,
  allowIndex: false,
};

const page = (over: Partial<DocsPage> = {}) =>
  ({
    id: 'p1',
    projectId: 'proj',
    title: 'Rate limiting',
    slug: 'rate-limiting',
    slugPath: 'architecture/rate-limiting',
    version: 15,
    path: [{ id: 'a', title: 'Architecture', slug: 'architecture' }],
    ...over,
  }) as DocsPage;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.head.querySelectorAll('meta[name="robots"]').forEach((m) => m.remove());
});

describe('Share: anyone with the link can read', () => {
  let state: PublicLinkState;
  let put: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(() => Promise.resolve()) } });
    state = { allowed: true, link: null };
    vi.spyOn(client, 'get').mockImplementation(async () => ({ data: state }));
    put = vi.fn(async (_url: string, body: { on: boolean; showNames?: boolean }) => {
      state = body.on
        ? { allowed: true, link: { ...LINK, ...(state.link ?? {}), ...pick(body) } }
        : { allowed: true, link: null };
      return { data: state };
    });
    vi.spyOn(client, 'put').mockImplementation(put as never);
  });
  const pick = (b: { showNames?: boolean; allowIndex?: boolean }) => ({
    ...(b.showNames !== undefined ? { showNames: b.showNames } : {}),
    ...(b.allowIndex !== undefined ? { allowIndex: b.allowIndex } : {}),
  });

  function open(canEdit = true, over: Partial<DocsPage> = {}) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <SharePopover page={page(over)} onClose={() => {}} publicLinks={{ canEdit }} />
      </QueryClientProvider>,
    );
  }

  it('asks first, then turns the link on, changes its options and turns it off', async () => {
    open();
    const toggle = await screen.findByTestId('public-link-toggle');
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(toggle);
    const confirm = screen.getByTestId('public-confirm');
    expect(confirm.textContent).toContain('Make this page public?');
    expect(confirm.textContent).toContain('Drafts and unpublished changes stay private.');
    expect(put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('public-confirm-yes'));
    await screen.findByTestId('public-url');
    expect(put).toHaveBeenLastCalledWith('/docs/pages/p1/public-link', { on: true });
    expect(screen.getByTestId('public-url').textContent).toContain(`?public=${LINK.token}`);

    fireEvent.click(screen.getByTestId('public-show-names'));
    await waitFor(() =>
      expect(put).toHaveBeenLastCalledWith('/docs/pages/p1/public-link', { on: true, showNames: true }),
    );
    fireEvent.change(screen.getByTestId('public-expiry'), { target: { value: '30d' } });
    await waitFor(() =>
      expect(put).toHaveBeenLastCalledWith('/docs/pages/p1/public-link', { on: true, expires: '30d' }),
    );
    fireEvent.click(screen.getByTestId('public-copy'));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(expect.stringContaining(LINK.path)),
    );

    fireEvent.click(screen.getByTestId('public-stop'));
    await waitFor(() => expect(screen.queryByTestId('public-url')).toBeNull());
    expect(put).toHaveBeenLastCalledWith('/docs/pages/p1/public-link', { on: false });
  });

  it('is off with the reason when the project switched public links off, or the page was never published', async () => {
    state = { allowed: false, link: null };
    open();
    expect((await screen.findByTestId('public-link-blocked')).textContent).toBe(
      'Public links are turned off for this project.',
    );
    expect((screen.getByTestId('public-link-toggle') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    state = { allowed: true, link: null };
    open(true, { version: 0 });
    expect((await screen.findByTestId('public-link-blocked')).textContent).toBe(
      'Publish the page before you share it publicly.',
    );
    cleanup();
    open(false);
    expect((await screen.findByTestId('public-link-blocked')).textContent).toContain('Only people who can edit');
  });
});

describe('the public view', () => {
  const body = {
    title: 'What a shared board taught us',
    format: 'rich',
    content: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Write the ticket' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Tracked in KAN-12, see ' },
            { type: 'docRef', attrs: { page: 'Rate limiting' } },
            { type: 'text', text: '.' },
          ],
        },
        { type: 'sketch', attrs: { id: 's1', label: 'Board flow', blockId: 'b-1' } },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Read the report' }] },
      ],
    },
    markdown: 'Tracked in KAN-12.',
    settings: {},
    version: 4,
    updated_at: '2026-10-05T09:00:00Z',
    author: null,
    project: null,
    allow_index: false,
  };
  let get: { mock: { calls: unknown[] } };
  let post: { mock: { calls: unknown[] } };
  beforeEach(() => {
    get = vi.spyOn(client, 'get');
    post = vi.spyOn(client, 'post');
    class IO {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal('ResizeObserver', IO);
    vi.stubGlobal('IntersectionObserver', IO);
  });

  // the app wraps every view in a query client (main.tsx); the public view asks nothing through it
  const app = (token: string) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PublicPageApp token={token} />
      </QueryClientProvider>,
    );

  function serve(status: number, json: unknown) {
    const f = vi.fn(async () => ({ ok: status < 400, status, json: async () => json }) as Response);
    vi.stubGlobal('fetch', f);
    return f;
  }

  it('reads the page with no credentials, asks for nothing else, draws references as text and stays unindexed', async () => {
    const f = serve(200, body);
    app(LINK.token);
    expect((await screen.findByTestId('public-title')).textContent).toBe('What a shared board taught us');
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(new RegExp(`/docs/public/${LINK.token}$`));
    expect(init.credentials).toBe('omit');
    expect(get.mock.calls).toHaveLength(0);
    expect(post.mock.calls).toHaveLength(0);
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex');
    const page = screen.getByTestId('public-page');
    expect(page.querySelector('.dk-chip')).toBeNull();
    expect(page.querySelectorAll('.dk-ref-plain').length).toBe(2);
    expect(page.textContent).toContain('Sketch · Board flow');
    expect(screen.getByTestId('public-pill').textContent).toBe('Public page');
    expect(screen.getByTestId('public-footer').textContent).toContain('Public page · read only');
    // no editing, comments or sharing here
    expect(screen.queryByTestId('edit-page')).toBeNull();
    expect(screen.queryByTestId('share')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Report a problem' }));
    expect(screen.getByTestId('public-report-note')).toBeTruthy();
  });

  it('lets search engines in only when the owner allowed it, and names the author when shown', async () => {
    serve(200, { ...body, allow_index: true, author: 'An Nguyen', project: 'Kanban Board' });
    app(LINK.token);
    await screen.findByTestId('public-title');
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('index, follow');
    expect(screen.getByTestId('page-byline').textContent).toContain('An Nguyen');
    expect(screen.getByTestId('public-footer').textContent).toContain('Public page from Kanban Board');
  });

  it('says a link is no longer public, with no hint of the page', async () => {
    serve(404, { detail: { code: 'public_link_not_found' } });
    app('nope');
    expect((await screen.findByTestId('public-gone')).querySelector('h1')?.textContent).toBe(
      'This link is not public',
    );
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex');
    expect(get.mock.calls).toHaveLength(0);
  });

  it('turns the blocks that need the board into plain text', () => {
    const doc = publicDoc({
      type: 'doc',
      content: [
        { type: 'fileCard', attrs: { name: 'plan.pdf', src: '/uploads/plan.pdf' } },
        { type: 'columns', content: [{ type: 'column', content: [{ type: 'canvas', attrs: { label: 'Flow' } }] }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'kept' }] },
      ],
    });
    expect(JSON.stringify(doc)).toContain('File · plan.pdf');
    expect(JSON.stringify(doc)).toContain('Canvas · Flow');
    expect(JSON.stringify(doc)).not.toContain('"canvas"');
    expect(doc.content?.[2]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'kept' }] });
  });
});
