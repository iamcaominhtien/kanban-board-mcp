// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocsPage } from '../../types/docs';

const api = vi.hoisted(() => ({
  patchPageSettings: vi.fn(),
}));
vi.mock('../../api/docs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/docs')>()),
  patchPageSettings: api.patchPageSettings,
}));

import { docsKeys } from '../../api/docs';
import { ToastProvider } from '../Toast';
import { PageSettingsPanel } from './PageSettingsPanel';
import { SETTINGS_SAVE_MS } from './usePageSettings';

const PAGE: DocsPage = {
  id: 'p1',
  projectId: 'proj',
  parentId: null,
  title: 'Release notes',
  slug: 'release-notes',
  status: 'published',
  version: 3,
  markdown: 'Hello',
  format: 'rich',
  content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] },
  settings: { status: 'final' },
  headings: [],
  path: [],
  createdBy: 'Hoa Mai',
  updatedBy: 'Hoa Mai',
  updatedAt: '2026-11-12T10:00:00Z',
  createdAt: '2026-11-01T10:00:00Z',
  hasUnpublishedChanges: false,
  draft: null,
};

function setup(opts: { readOnly?: string | null; layout?: 'desktop' | 'tablet' | 'phone' } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(docsKeys.page(PAGE.id), PAGE);
  const onClose = vi.fn();
  const view = () => qc.getQueryData<DocsPage>(docsKeys.page(PAGE.id))!;
  function Live() {
    // the panel shows the cached page, as DocsView gives it
    const { data } = useQuery({
      queryKey: docsKeys.page(PAGE.id),
      queryFn: () => PAGE,
      enabled: false,
      staleTime: Infinity,
    });
    return (
      <PageSettingsPanel page={data!} layout={opts.layout ?? 'desktop'} readOnly={opts.readOnly} onClose={onClose} />
    );
  }
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <Live />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { qc, view, onClose };
}

async function flushSave() {
  await act(async () => {
    vi.advanceTimersByTime(SETTINGS_SAVE_MS + 10);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  api.patchPageSettings.mockReset();
  api.patchPageSettings.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
    ...PAGE,
    settings: Object.fromEntries(Object.entries({ ...PAGE.settings, ...patch }).filter(([, v]) => v !== null)),
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('PageSettingsPanel', () => {
  it('changes the page at once and saves the choices of a pause together', async () => {
    const { view } = setup();
    fireEvent.click(screen.getByTestId('ps-width-wide'));
    // the cached page (what the reader draws) changes before anything is sent
    expect(view().settings).toEqual({ status: 'final', width: 'wide' });
    expect(api.patchPageSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('ps-margins-roomy'));
    await flushSave();
    expect(api.patchPageSettings).toHaveBeenCalledTimes(1);
    expect(api.patchPageSettings).toHaveBeenCalledWith('p1', { width: 'wide', margins: 'roomy' });
    expect(view().settings).toEqual({ status: 'final', width: 'wide', margins: 'roomy' });
  });

  it('writes the right key from each tab', async () => {
    setup();
    const pick = async (testId: string) => {
      fireEvent.click(screen.getByTestId(testId));
      await flushSave();
    };
    await pick('ps-spacing-tight');
    expect(api.patchPageSettings).toHaveBeenLastCalledWith('p1', { blockSpacing: 'tight' });
    await pick('ps-view-paged');
    expect(api.patchPageSettings).toHaveBeenLastCalledWith('p1', { view: 'paged' });
    await pick('ps-editor-outline');
    expect(api.patchPageSettings).toHaveBeenLastCalledWith('p1', { editorOutline: false });

    fireEvent.click(screen.getByTestId('ps-tab-text'));
    fireEvent.change(screen.getByTestId('ps-text-font'), { target: { value: 'lora' } });
    await flushSave();
    expect(api.patchPageSettings).toHaveBeenLastCalledWith('p1', { bodyFont: 'lora' });
    fireEvent.change(screen.getByTestId('ps-base-size'), { target: { value: '17' } });
    await flushSave();
    expect(api.patchPageSettings).toHaveBeenLastCalledWith('p1', { baseSize: 17, textSize: null });
    await pick('ps-paragraphs-indent');
    expect(api.patchPageSettings).toHaveBeenLastCalledWith('p1', { paragraphs: 'indent' });
    await pick('ps-text-align-justify');
    expect(api.patchPageSettings).toHaveBeenLastCalledWith('p1', { textAlign: 'justify' });
    await pick('ps-drop-cap');
    expect(api.patchPageSettings).toHaveBeenLastCalledWith('p1', { dropCap: true });
    await pick('ps-pair-editorial');
    expect(api.patchPageSettings).toHaveBeenLastCalledWith('p1', { bodyFont: null, headingFont: 'source-serif' });
    await pick('ps-lh-1.8');
    expect(api.patchPageSettings).toHaveBeenLastCalledWith('p1', { lineHeight: 1.8 });

    fireEvent.click(screen.getByTestId('ps-tab-colour'));
    await pick('ps-bg-sepia');
    expect(api.patchPageSettings).toHaveBeenLastCalledWith('p1', { background: 'sepia' });
    // the palette keeps its names, with the values of the chosen background
    expect(screen.getByTestId('ps-palette-text').textContent).toContain('Ink');
    expect(screen.getByTestId('ps-palette-highlight').textContent).toContain('Yellow');

    fireEvent.click(screen.getByTestId('ps-tab-header'));
    await pick('ps-title-size-huge');
    expect(api.patchPageSettings).toHaveBeenLastCalledWith('p1', { titleSize: 'huge' });
    await pick('ps-show-title');
    expect(api.patchPageSettings).toHaveBeenLastCalledWith('p1', { showTitle: false });
    await pick('ps-edited-by');
    expect(api.patchPageSettings).toHaveBeenLastCalledWith('p1', { showEditedBy: false });
    await pick('ps-outline-depth-2');
    expect(api.patchPageSettings).toHaveBeenLastCalledWith('p1', { outlineDepth: 2 });
    await pick('ps-outline');
    expect(api.patchPageSettings).toHaveBeenLastCalledWith('p1', { showOutline: false });
    await pick('ps-title-style-display');
    expect(api.patchPageSettings).toHaveBeenLastCalledWith('p1', { titleStyle: 'display' });
    await pick('ps-title-align-center');
    expect(api.patchPageSettings).toHaveBeenLastCalledWith('p1', { titleAlign: 'center' });
    fireEvent.change(screen.getByTestId('ps-eyebrow'), { target: { value: 'ENGINEERING NOTES' } });
    await flushSave();
    expect(api.patchPageSettings).toHaveBeenLastCalledWith('p1', { eyebrow: 'ENGINEERING NOTES' });
    await pick('ps-byline');
    expect(api.patchPageSettings).toHaveBeenLastCalledWith('p1', { showByline: false });
    await pick('ps-reading-time');
    expect(api.patchPageSettings).toHaveBeenLastCalledWith('p1', { showReadingTime: false });

    fireEvent.click(screen.getByTestId('ps-tab-cover'));
    const link = screen.getByLabelText('Image link');
    fireEvent.change(link, { target: { value: 'https://example.com/cover.jpg' } });
    fireEvent.submit(link.closest('form')!);
    await flushSave();
    const cover = {
      src: 'https://example.com/cover.jpg',
      positionX: 50,
      positionY: 50,
      height: 'm',
      fit: 'fill',
      dim: 0,
      titleOnCover: false,
    };
    expect(api.patchPageSettings).toHaveBeenLastCalledWith('p1', { cover });
    await pick('ps-cover-height-full');
    expect(api.patchPageSettings).toHaveBeenLastCalledWith('p1', { cover: { ...cover, height: 'full' } });
    await pick('ps-cover-pos-100-0');
    expect(api.patchPageSettings).toHaveBeenLastCalledWith('p1', {
      cover: { ...cover, height: 'full', positionX: 100, positionY: 0 },
    });
    await pick('ps-cover-fit-fit');
    expect(api.patchPageSettings).toHaveBeenLastCalledWith('p1', {
      cover: { ...cover, height: 'full', positionX: 100, positionY: 0, fit: 'fit' },
    });
    fireEvent.click(screen.getByTestId('ps-cover-source-colour'));
    await pick('ps-cover-colour-teal');
    expect(api.patchPageSettings).toHaveBeenLastCalledWith('p1', {
      cover: {
        color: '#0F766E',
        height: 'full',
        positionX: 100,
        positionY: 0,
        fit: 'fit',
        dim: 0,
        titleOnCover: false,
      },
    });
    await pick('ps-cover-remove');
    expect(api.patchPageSettings).toHaveBeenLastCalledWith('p1', { cover: null });
  });

  it('Reset sends every look key back to its default and keeps the others', async () => {
    const { view, qc } = setup();
    act(() => {
      qc.setQueryData(docsKeys.page('p1'), {
        ...PAGE,
        settings: { status: 'final', width: 'wide', background: 'night' },
      });
      // React Query tells its observers on the next tick
      vi.advanceTimersByTime(1);
    });
    fireEvent.click(screen.getByTestId('ps-reset'));
    expect(view().settings).toEqual({ status: 'final' });
    await flushSave();
    const sent = api.patchPageSettings.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.values(sent).every((v) => v === null)).toBe(true);
    expect(sent).toHaveProperty('width', null);
    expect(sent).toHaveProperty('background', null);
    expect(sent).not.toHaveProperty('status');
  });

  it('goes back to what it was and says so when the server refuses', async () => {
    api.patchPageSettings.mockRejectedValueOnce({
      response: { status: 422, data: { detail: { code: 'invalid_settings', message: 'Unknown page width.' } } },
    });
    const { view } = setup();
    fireEvent.click(screen.getByTestId('ps-width-full'));
    expect(view().settings).toEqual({ status: 'final', width: 'full' });
    await flushSave();
    expect(view().settings).toEqual({ status: 'final' });
    expect(screen.getByText("Couldn't save the page settings")).toBeTruthy();
    expect(screen.getByText('Unknown page width.')).toBeTruthy();
  });

  it('is read-only for people who cannot edit the page', () => {
    setup({ readOnly: 'Only project members can edit pages in this space' });
    expect(screen.getByText('Only project members can edit pages in this space')).toBeTruthy();
    const wide = screen.getByTestId('ps-width-wide') as HTMLButtonElement;
    expect(wide.closest('fieldset')!.disabled).toBe(true);
    fireEvent.click(wide);
    expect(api.patchPageSettings).not.toHaveBeenCalled();
    expect((screen.getByTestId('ps-reset') as HTMLButtonElement).disabled).toBe(true);
  });

  it('is a bottom sheet on a phone and a drawer on a tablet', () => {
    setup({ layout: 'phone' });
    expect(screen.getByTestId('page-settings-sheet')).toBeTruthy();
    cleanup();
    setup({ layout: 'tablet' });
    expect(screen.getByTestId('page-settings-drawer')).toBeTruthy();
  });
});
