// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const uploads = vi.hoisted(() => ({
  uploadAnyFile: vi.fn(),
  uploadDescriptionImage: vi.fn(),
}));

vi.mock('../../../api/tickets', () => ({
  ...uploads,
  useTickets: () => ({ data: [] }),
}));

import { ToastProvider } from '../../Toast';
import { DocsEditor } from './DocsEditor';

// jsdom has no layout; ProseMirror measures the selection to scroll it into view
const noRects = () =>
  ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) });
Range.prototype.getClientRects = noRects;
Range.prototype.getBoundingClientRect = rect;
const textProto = Text.prototype as unknown as { getClientRects?: () => DOMRectList };
if (!textProto.getClientRects) textProto.getClientRects = noRects;
document.elementFromPoint = () => null;

function renderEditor(onChange = vi.fn(), markdown = 'Intro') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <DocsEditor
          projectId="p1"
          markdown={markdown}
          mode="visual"
          onChange={onChange}
          nodes={[]}
          currentPageId="pg1"
          pageTitle="Overview"
          filename="overview.md"
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return onChange;
}

describe('DocsEditor: opening a page is not an edit (ideas IP-15)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("does not report the editor's own normalised Markdown when the text was only focused and left", async () => {
    // stored with extra blank lines and a padded table: the editor writes both differently
    const onChange = renderEditor(vi.fn(), '\n\nIntro\n\n| A   | B   |\n| --- | --- |\n| 1   | 2   |\n\n');
    const surface = await screen.findByTestId('docs-editor-surface');
    fireEvent.focus(surface);
    fireEvent.blur(surface);
    await new Promise((r) => setTimeout(r, 50));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('still reports a real edit', async () => {
    uploads.uploadAnyFile.mockResolvedValue({
      id: 'abc',
      url: '/uploads/report_abc.xlsx',
      name: 'report.xlsx',
      size: 3,
      type: 'application/vnd.ms-excel',
      markdown: '[report.xlsx](/uploads/report_abc.xlsx)',
    });
    const onChange = renderEditor(vi.fn(), '\n\nIntro\n\n');
    const input = screen.getByTestId('docs-attach-input');
    Object.defineProperty(input, 'files', {
      value: [new File(['a,b'], 'report.xlsx', { type: 'application/vnd.ms-excel' })],
      configurable: true,
    });
    fireEvent.change(input);
    await waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 3000 });
    expect(onChange.mock.lastCall?.[0]).toContain('report.xlsx');
  });
});
