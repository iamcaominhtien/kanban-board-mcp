// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocsTreeNode } from '../../../types/docs';
import type { DocsGallery } from '../../../types/docsGallery';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../../api/client', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, client: { ...(real.client as object), get: api.get, post: api.post } };
});

import { NewPageDialog } from '../NewPageDialog';

let gallery: DocsGallery;
const NODES = [
  { id: 'arch', parentId: null, title: 'Architecture', slug: 'architecture', position: 0 },
  { id: 'api', parentId: 'arch', title: 'API', slug: 'api', position: 0 },
] as DocsTreeNode[];

function setup(props: Partial<Parameters<typeof NewPageDialog>[0]> = {}) {
  const onCreated = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <NewPageDialog
        projectId="p1"
        nodes={NODES}
        initialParentId={null}
        onClose={vi.fn()}
        onCreated={onCreated}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onCreated };
}

const cards = () =>
  within(screen.getByTestId('template-list'))
    .queryAllByRole('radio')
    .map((r) => r.getAttribute('data-testid'));

beforeEach(() => {
  gallery = {
    builtin: [
      {
        id: 'blank',
        name: 'Blank',
        description: 'Start from an empty page',
        category: 'work',
        settings: {},
        preview: '',
      },
      {
        id: 'requirements',
        name: 'Requirements',
        description: 'Goals, scope and criteria',
        category: 'work',
        settings: {},
        preview: '# Requirements\n\n## Goals',
      },
      {
        id: 'blog-post',
        name: 'Blog post',
        description: 'Cover, centred title, pull quote',
        category: 'writing',
        settings: { width: 'narrow', bodyFont: 'source-serif' },
        preview: 'A ticket is a promise.',
      },
    ],
    yours: [],
    project: [],
    defaultTemplate: 'blank',
    hidden: [],
  };
  api.get.mockReset().mockImplementation(async (url: string) => {
    if (url === '/projects/p1/docs/gallery') return { data: gallery };
    if (url === '/projects/p1/docs/ai') return { data: { state: 'off' } };
    throw new Error(`unexpected GET ${url}`);
  });
  api.post.mockReset();
});
afterEach(cleanup);

describe('the New page gallery', () => {
  it('filters with the chips and the search, and says when nothing matches', async () => {
    setup();
    await waitFor(() => expect(cards()).toContain('template-blog-post'));
    expect(cards()).toEqual(['template-blank', 'template-canvas', 'template-requirements', 'template-blog-post']);
    fireEvent.click(screen.getByTestId('chip-writing'));
    expect(cards()).toEqual(['template-blog-post']);
    fireEvent.click(screen.getByTestId('chip-all'));
    fireEvent.change(screen.getByLabelText('Find a template'), { target: { value: 'pitch deck' } });
    expect(cards()).toEqual([]);
    expect(screen.getByText('No templates match “pitch deck”')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(cards()).toHaveLength(4);
  });

  it('says where templates come from when there are none under Yours', async () => {
    setup({ initialChip: 'yours' });
    expect(await screen.findByText('You have no templates yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Browse all templates' }));
    await waitFor(() => expect(cards()).toHaveLength(4));
  });

  it('previews the chosen card and names the page after it until a title is typed', async () => {
    setup();
    fireEvent.click(await screen.findByTestId('template-blog-post'));
    const preview = screen.getByTestId('template-preview');
    expect(preview.textContent).toMatch(/Preview · Blog post/);
    expect(preview.textContent).toMatch(/Serif · Narrow/);
    expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe('Blog post');
  });

  it('catches an empty title before creating, and warns about a title already used under the parent', async () => {
    setup({ initialParentId: 'arch' });
    await screen.findByTestId('template-blank');
    fireEvent.click(screen.getByRole('button', { name: 'Create page' }));
    expect(screen.getByText('Give the page a title to create it.')).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'API' } });
    expect(screen.getByTestId('title-clash').textContent).toMatch(/already exists under Architecture.*api-2/);
  });

  it('creates a page from a gallery template with from-template, and Blank the way it always did', async () => {
    api.post.mockResolvedValue({ data: { id: 'new', title: 'Field notes' } });
    const { onCreated } = setup();
    fireEvent.click(await screen.findByTestId('template-blog-post'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Field notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create page' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(api.post).toHaveBeenCalledWith('/projects/p1/docs/pages/from-template', {
      title: 'Field notes',
      parentId: null,
      template: 'blog-post',
    });
    cleanup();
    api.post.mockClear();
    setup();
    fireEvent.click(await screen.findByTestId('template-blank'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Plain' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create page' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/projects/p1/docs/pages', {
        title: 'Plain',
        parentId: null,
        template: 'blank',
      }),
    );
  });

  it('lists saved templates under Yours with their menu, and falls back to the old list when the gallery fails', async () => {
    gallery.yours = [
      {
        id: 't1',
        name: 'Weekly status',
        description: null,
        category: 'work',
        keeps: 'content',
        scope: 'project',
        owner: 'An',
        mine: true,
        usedCount: 2,
        createdAt: '',
        updatedAt: '',
        settings: null,
        preview: 'Done this week',
      },
    ];
    setup({ initialChip: 'yours' });
    await waitFor(() => expect(cards()).toEqual(['template-t1']));
    expect(screen.getByText('Yours · this project')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Weekly status: template actions' }));
    const menu = screen.getByRole('menu', { name: 'Weekly status actions' });
    expect(within(menu).getByRole('menuitem', { name: /Keep to me/ })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: /Rename/ })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: /Delete template/ })).toBeTruthy();
    cleanup();

    api.get.mockImplementation(async (url: string) => {
      if (url === '/docs/templates')
        return { data: [{ id: 'blank', name: 'Blank', description: 'Empty', markdown: '' }] };
      if (url === '/projects/p1/docs/ai') return { data: { state: 'off' } };
      throw Object.assign(new Error('404'), { response: { status: 404 } });
    });
    api.post.mockResolvedValue({ data: { id: 'n' } });
    setup({ initialTemplate: 'blank', initialTitle: 'Old way' });
    await waitFor(() => expect(cards()).toEqual(['template-blank', 'template-canvas']), { timeout: 4000 });
    fireEvent.click(screen.getByRole('button', { name: 'Create page' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/projects/p1/docs/pages', {
        title: 'Old way',
        parentId: null,
        template: 'blank',
      }),
    );
  });
});
