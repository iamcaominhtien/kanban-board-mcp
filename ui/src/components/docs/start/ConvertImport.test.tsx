// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ post: vi.fn(), put: vi.fn() }));
vi.mock('../../../api/client', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, client: { ...(real.client as object), post: api.post, put: api.put } };
});

import { ToastProvider } from '../../Toast';
import { ConvertImport } from './ConvertImport';

const html = (name: string, body: string) => new File([`<h1>${name}</h1><p>${body}</p>`], `${name}.html`);
const big = () => {
  const f = new File(['x'], 'big-report.html');
  Object.defineProperty(f, 'size', { value: 34 * 1024 * 1024 });
  return f;
};
const offline = () => Object.assign(new Error('Network Error'), { isAxiosError: true, code: 'ERR_NETWORK' });

function setup(files: File[]) {
  const onDone = vi.fn();
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <ConvertImport
          projectId="p1"
          nodes={[]}
          source="html"
          onSource={vi.fn()}
          initialFiles={files}
          onClose={onClose}
          onDone={onDone}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onDone, onClose };
}

let made = 0;
beforeEach(() => {
  made = 0;
  api.post.mockReset().mockImplementation(async () => ({ data: { id: `page-${++made}` } }));
  api.put.mockReset().mockResolvedValue({ data: {} });
});
afterEach(cleanup);

describe('importing HTML files', () => {
  it('lists each file with its size, says why one cannot come in, and imports only the rest', async () => {
    setup([html('Overview', 'One'), new File(['x'], 'notes.pages'), big()]);
    expect(screen.getByText('Not supported')).toBeTruthy();
    expect(screen.getByText('Export it from Pages as Word (.docx) and import that.')).toBeTruthy();
    expect(screen.getByText('Too large')).toBeTruthy();
    expect(screen.getByText('34.0 MB')).toBeTruthy();
    expect(screen.getByTestId('import-notes-html').textContent).toMatch(/Left out: Scripts, forms, frames/);
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 file' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/projects/p1/docs/pages', {
      title: 'Overview',
      parentId: null,
      template: 'blank',
    });
    const [url, body, opts] = api.put.mock.calls[0];
    expect(url).toBe('/docs/pages/page-1/draft');
    expect(body.content.type).toBe('doc');
    expect(opts).toEqual({ rawKeys: ['content'] });
  });

  it('shows the reason on a failed file and retries only that one', async () => {
    api.put.mockResolvedValueOnce({ data: {} }).mockRejectedValueOnce({
      response: { status: 500, data: { detail: { code: 'x', message: 'The draft could not be saved.' } } },
    });
    const { onDone } = setup([html('Overview', 'One'), html('Billing', 'Two')]);
    fireEvent.click(screen.getByRole('button', { name: 'Import 2 files' }));
    await screen.findByText('Import finished with a problem');
    expect(screen.getByText('The draft could not be saved.')).toBeTruthy();
    expect(screen.getByTestId('import-summary').textContent).toBe('1 of 2 files were imported. One could not be read.');
    fireEvent.click(screen.getByTestId('import-retry'));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(['page-1', 'page-2']));
    // the page of the failed file was made once; the retry only saved its text again
    expect(api.post).toHaveBeenCalledTimes(2);
    expect(api.put).toHaveBeenCalledTimes(3);
    expect(api.put.mock.calls[2][0]).toBe('/docs/pages/page-2/draft');
  });

  it('imports nothing when the server cannot be reached, and keeps the files chosen', async () => {
    api.post.mockRejectedValue(offline());
    const { onDone } = setup([html('Meeting', 'Notes')]);
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 file' }));
    await screen.findByTestId('import-offline');
    expect(screen.getByText('Import failed')).toBeTruthy();
    expect(screen.getByText('Meeting.html')).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    api.post.mockReset().mockResolvedValue({ data: { id: 'page-9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(['page-9']));
  });
});
