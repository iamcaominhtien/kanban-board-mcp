// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocsPage } from '../../types/docs';
import { SharePopover, isPageId, pageShareUrl } from './SharePopover';

afterEach(cleanup);

const ID = '0cd8ce70-1234-4abc-9def-001122334455';
const page = (over: Partial<DocsPage> = {}) =>
  ({
    id: ID,
    projectId: 'p1',
    title: 'API',
    slug: 'api',
    slugPath: 'architecture/api',
    path: [{ id: 'a', title: 'Architecture', slug: 'architecture' }],
    ...over,
  }) as DocsPage;

describe('Share links by slug path (AC-4)', () => {
  it('shares the slug path when the page has one, with its project', () => {
    const url = new URL(pageShareUrl(page()));
    expect(url.searchParams.get('docs')).toBe('architecture/api');
    expect(url.searchParams.get('proj')).toBe('p1');
  });

  it('falls back to the page id when there is no path of its own', () => {
    const url = new URL(pageShareUrl(page({ slugPath: null })));
    expect(url.searchParams.get('docs')).toBe(ID);
  });

  it('tells a page id from a slug path, so old ?docs=<uuid> links open as before', () => {
    expect(isPageId(ID)).toBe(true);
    expect(isPageId('architecture/api')).toBe(false);
    expect(isPageId('api')).toBe(false);
  });

  it('the popover shows the slug link and still offers the link by page id', () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    render(<SharePopover page={page()} onClose={() => {}} />);
    expect(screen.getByTestId('share-url').textContent).toContain('docs=architecture/api');
    fireEvent.click(screen.getByTestId('share-id-link'));
    expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining(`docs=${ID}`));
  });
});
