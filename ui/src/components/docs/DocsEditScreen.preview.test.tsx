// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocsLayout } from '../../hooks/useDocsLayout';
import type { DocsPage } from '../../types/docs';

vi.mock('../../api/tickets', () => ({
  uploadAnyFile: vi.fn(),
  uploadDescriptionImage: vi.fn(),
  useTickets: () => ({ data: [] }),
}));

import { client } from '../../api/client';
import { ToastProvider } from '../Toast';
import { DocsEditScreen } from './DocsEditScreen';

// jsdom has no layout; ProseMirror measures the selection to scroll it into view
const noRects = () =>
  ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
Range.prototype.getClientRects = noRects;
Range.prototype.getBoundingClientRect = rect;
document.elementFromPoint = () => null;

beforeEach(() => {
  const pending = () => new Promise<never>(() => undefined);
  vi.spyOn(client, 'get').mockImplementation(pending);
  vi.spyOn(client, 'post').mockImplementation(pending);
  vi.spyOn(client, 'put').mockImplementation(pending);
  class IO {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  vi.stubGlobal('IntersectionObserver', IO);
  vi.stubGlobal('ResizeObserver', IO);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const PAGE: DocsPage = {
  id: 'p1',
  projectId: 'proj',
  parentId: null,
  title: 'The Salt Road',
  slug: 'salt-road',
  status: 'published',
  version: 2,
  markdown: 'Nobody remembered who had first called it the salt road.',
  format: 'rich',
  content: {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Nobody remembered who had first called it the salt road.' }],
      },
    ],
  },
  settings: { width: 'narrow', bodyFont: 'lora', eyebrow: 'Chapter three' },
  headings: [],
  path: [],
  createdBy: 'Hoa Mai',
  updatedBy: 'Hoa Mai',
  updatedAt: '2026-11-12T10:00:00Z',
  createdAt: '2026-11-01T10:00:00Z',
  hasUnpublishedChanges: false,
  draft: null,
};

function show(layout: DocsLayout) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenSettings = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <DocsEditScreen
          projectId="proj"
          projectName="Kanban Board"
          page={PAGE}
          nodes={[]}
          onExit={() => undefined}
          layout={layout}
          onOpenSettings={onOpenSettings}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onOpenSettings };
}

describe('DocsEditScreen', () => {
  it('edits on the page as its settings draw it, and Preview shows it as readers will see it', () => {
    const { onOpenSettings } = show('desktop');
    const scroll = screen.getByTestId('editor-scroll');
    expect(scroll.className).toContain('dk-paged');
    expect(scroll.style.getPropertyValue('--dp-col')).toBe('clamp(560px, 50vw, 880px)');
    expect(scroll.style.getPropertyValue('--dp-body-font')).toContain('Lora');
    expect(screen.getByTestId('page-eyebrow').textContent).toBe('Chapter three');
    expect((screen.getByLabelText('Page title') as HTMLInputElement).value).toBe('The Salt Road');
    expect(screen.getByTestId('editor-toolbar').dataset.variant).toBe('top');

    fireEvent.click(screen.getByTestId('edit-page-settings'));
    expect(onOpenSettings).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('preview-toggle'));
    const preview = screen.getByTestId('editor-preview');
    expect(preview.textContent).toContain('The Salt Road');
    expect(preview.textContent).toContain('Nobody remembered who had first called it the salt road.');
    expect(preview.style.getPropertyValue('--dp-col')).toBe('clamp(560px, 50vw, 880px)');
    // the editor stays (hidden), with its text and undo history
    expect(screen.getByTestId('editor-scroll')).toBeTruthy();
    fireEvent.click(screen.getByTestId('preview-toggle'));
    expect(screen.queryByTestId('editor-preview')).toBeNull();
  });

  it('puts the formatting bar at the bottom and the rest in a sheet on a phone', () => {
    show('phone');
    expect(screen.getByTestId('editor-toolbar').dataset.variant).toBe('bottom');
    expect(screen.queryByTestId('discard')).toBeNull();
    fireEvent.click(screen.getByTestId('edit-more'));
    expect(screen.getByTestId('edit-more-sheet').textContent).toContain('Discard draft');
    fireEvent.click(screen.getByTestId('preview-toggle'));
    expect(screen.getByTestId('editor-preview')).toBeTruthy();
  });

  it('makes the formatting bar a sideways strip on a tablet', () => {
    show('tablet');
    expect(screen.getByTestId('editor-toolbar').dataset.variant).toBe('strip');
  });
});
