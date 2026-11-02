// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
if (!Text.prototype.getClientRects) (Text.prototype as unknown as Element).getClientRects = noRects;
document.elementFromPoint = () => null;

function renderEditor(onChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <DocsEditor
          projectId="p1"
          markdown="Intro"
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

function pick(input: HTMLElement, file: File) {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

const sheet = () =>
  new File(['a,b'], 'report.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

describe('DocsEditor: attaching a file that is not a picture', () => {
  beforeEach(() => {
    uploads.uploadAnyFile.mockResolvedValue({
      id: 'abc',
      url: '/uploads/report_abc.xlsx',
      name: 'report.xlsx',
      size: 3,
      type: 'application/vnd.ms-excel',
      markdown: '[report.xlsx](/uploads/report_abc.xlsx)',
    });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('has an attach button and inserts the Excel file as a link to the stored file', async () => {
    const onChange = renderEditor();
    expect(screen.getByRole('button', { name: /Attach a file/ })).toBeTruthy();
    pick(screen.getByTestId('docs-attach-input'), sheet());
    await waitFor(() => expect(uploads.uploadAnyFile).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining('[report.xlsx](/uploads/report_abc.xlsx)')),
    );
    expect(uploads.uploadDescriptionImage).not.toHaveBeenCalled();
  });

  it('attaches an Excel file picked in the image picker instead of failing as a bad image', async () => {
    const onChange = renderEditor();
    pick(screen.getByLabelText('Upload image'), sheet());
    await waitFor(() => expect(uploads.uploadAnyFile).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining('[report.xlsx](/uploads/report_abc.xlsx)')),
    );
    expect(uploads.uploadDescriptionImage).not.toHaveBeenCalled();
  });
});
