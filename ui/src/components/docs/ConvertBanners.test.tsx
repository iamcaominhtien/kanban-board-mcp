// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocsPage, DocsVersionSummary } from '../../types/docs';

const versions = vi.hoisted(() => ({ list: [] as DocsVersionSummary[], asked: [] as (string | null)[] }));

vi.mock('../../api/docs', () => ({
  useDocsVersions: (pageId: string | null) => {
    versions.asked.push(pageId);
    return { data: pageId ? versions.list : undefined };
  },
}));

import { ConvertBar, ConvertedNotice } from './ConvertBanners';

afterEach(() => {
  cleanup();
  localStorage.clear();
  versions.list = [];
  versions.asked = [];
});

const v = (version: number, note: string | null): DocsVersionSummary => ({
  version,
  title: 'Guide',
  author: 'Kanban Board',
  note,
  createdAt: '',
  words: 10,
});

const page = (over: Partial<DocsPage> = {}) => ({ id: 'pg1', version: 3, convertState: 'done', ...over }) as DocsPage;

describe('conversion bars', () => {
  it('says the page is converting, or that it could not be converted', () => {
    const { rerender } = render(<ConvertBar lock="converting" />);
    expect(screen.getByTestId('convert-bar').textContent).toBe('Converting this page to the new format…');
    rerender(<ConvertBar lock="failed" />);
    expect(screen.getByTestId('convert-bar').textContent).toBe(
      'This page could not be converted. Its original text is kept, read-only.',
    );
  });
});

describe('converted notice', () => {
  it('shows on a converted page whose latest version is the conversion, until Got it', () => {
    versions.list = [v(2, 'First'), v(3, 'Converted from Markdown')];
    const onViewOriginal = vi.fn();
    const { unmount } = render(<ConvertedNotice page={page()} onViewOriginal={onViewOriginal} />);
    expect(screen.getByTestId('converted-notice').textContent).toContain(
      'This page was converted to the new format. Nothing was removed.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'View original' }));
    expect(onViewOriginal).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByTestId('converted-notice')).toBeNull();
    unmount();
    // dismissed for this page on this device
    render(<ConvertedNotice page={page()} onViewOriginal={onViewOriginal} />);
    expect(screen.queryByTestId('converted-notice')).toBeNull();
    expect(versions.asked[versions.asked.length - 1]).toBeNull();
  });

  it('stays hidden once the page was edited after the conversion, or when it was never converted', () => {
    versions.list = [v(3, 'Converted from Markdown'), v(4, 'Typo')];
    const { rerender } = render(<ConvertedNotice page={page({ version: 4 })} onViewOriginal={() => undefined} />);
    expect(screen.queryByTestId('converted-notice')).toBeNull();
    rerender(<ConvertedNotice page={page({ convertState: null })} onViewOriginal={() => undefined} />);
    expect(screen.queryByTestId('converted-notice')).toBeNull();
    expect(versions.asked[versions.asked.length - 1]).toBeNull();
  });
});
