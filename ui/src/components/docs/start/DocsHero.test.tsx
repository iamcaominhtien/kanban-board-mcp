// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../../api/client', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, client: { ...(real.client as object), get: api.get } };
});

import { DocsHero } from '../DocsHero';

function setup(layout: 'desktop' | 'tablet' | 'phone') {
  api.get.mockResolvedValue({
    data: {
      builtin: Array.from({ length: 12 }, (_, i) => ({
        id: `t${i}`,
        name: `T${i}`,
        description: '',
        category: 'work',
      })),
      yours: [{ id: 'y' }],
      project: [],
      defaultTemplate: 'blank',
      hidden: ['t3', 't4'],
    },
  });
  const props = { onCreate: vi.fn(), onImport: vi.fn(), onBrowseTemplates: vi.fn(), onDropFiles: vi.fn() };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DocsHero projectName="Kanban Board" projectId="p1" layout={layout} {...props} />
    </QueryClientProvider>,
  );
  return props;
}

afterEach(cleanup);

describe('the empty Docs space', () => {
  it('offers five templates, the whole gallery and an import strip with four sources', async () => {
    const p = setup('desktop');
    expect(screen.getByRole('heading', { name: 'Write down how Kanban Board works' })).toBeTruthy();
    fireEvent.click(screen.getByTestId('hero-template-blog-post'));
    expect(p.onCreate).toHaveBeenCalledWith('blog-post');
    fireEvent.click(await screen.findByRole('button', { name: 'All 11 templates' }));
    expect(p.onBrowseTemplates).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Import a Word file' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import from the clipboard' }));
    expect(p.onImport.mock.calls).toEqual([['word'], ['paste']]);
    fireEvent.click(screen.getByRole('button', { name: /Import…/ }));
    expect(p.onImport).toHaveBeenLastCalledWith();
  });

  it('on a phone: full-width buttons and import as a list of rows', () => {
    const p = setup('phone');
    expect(screen.getByTestId('hero-import-rows')).toBeTruthy();
    expect(screen.queryByTestId('docs-choose-files')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Import HTML' }));
    expect(p.onImport).toHaveBeenCalledWith('html');
  });
});
