// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));
import { KnowledgeBasePanel } from './KnowledgeBasePanel';

const doc = {
  id: 'd1',
  title: 'Billing.pdf',
  summary: 'How billing works.',
  store: 'project',
  kind: 'pdf',
  tokens: 9,
  answers: ['billing'],
};
const detail = {
  ...doc,
  textPreview: 'x',
  keywords: [],
  describedBy: 'model',
  sourceName: null,
  private: false,
  createdBy: 'An',
  createdAt: '2026-10-28T10:00:00Z',
  lastReadAt: null,
};

function wire(documents: unknown[]) {
  http.get.mockImplementation((url: string) => {
    if (url.endsWith('/ai/kb/search'))
      return Promise.resolve({
        data: [
          {
            id: 'd1',
            title: 'Billing.pdf',
            store: 'shared',
            kind: 'pdf',
            summary: 's',
            snippet: 'the [webhook] events',
            score: 1.5,
          },
        ],
      });
    if (url.includes('/ai/kb/d1')) return Promise.resolve({ data: detail });
    if (url.endsWith('/ai/settings')) return Promise.resolve({ data: { ops: { knowledgeShared: true } } });
    return Promise.resolve({ data: { stores: ['project'], documents } });
  });
}
const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <KnowledgeBasePanel projectId="p1" />
    </QueryClientProvider>,
  );

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('KnowledgeBasePanel', () => {
  it('says so when it is empty', async () => {
    wire([]);
    mount();
    expect(await screen.findByText(/Nothing here yet/)).toBeTruthy();
  });

  it('lists documents, searches with the store of each hit, and confirms a move', async () => {
    wire([doc]);
    http.patch.mockResolvedValue({ data: { ...detail, store: 'shared' } });
    mount();
    expect(await screen.findByText('Billing.pdf')).toBeTruthy();
    expect(await screen.findByText(/PDF · added 28 Oct · not read yet/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search the knowledge base'), { target: { value: 'webhook' } });
    fireEvent.click(screen.getByText('Search'));
    expect(await screen.findByText(/from the shared store/)).toBeTruthy();
    expect(screen.getByText('webhook').tagName).toBe('MARK');
    fireEvent.click(screen.getByLabelText('Open Billing.pdf'));
    fireEvent.click(await screen.findByText('Move to the shared store'));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Move to the shared store'));
    await waitFor(() => expect(http.patch).toHaveBeenCalledWith('/ai/kb/d1', { store: 'shared' }));
  });

  it('has a Shared tab that lists the shared store while this project does not search it (WV-7)', async () => {
    http.get.mockImplementation((url: string) => {
      if (url.endsWith('/ai/settings')) return Promise.resolve({ data: { ops: { knowledgeShared: false } } });
      return Promise.resolve({
        data: {
          stores: ['project'],
          documents: [doc],
          sharedDocuments: [{ ...doc, id: 'd2', title: 'Style guide.md', store: 'shared', kind: 'text' }],
        },
      });
    });
    mount();
    expect(await screen.findByText('Billing.pdf')).toBeTruthy();
    // the toggle stays
    expect(screen.getByText('Search the shared store too')).toBeTruthy();
    const shared = screen.getByRole('tab', { name: /Shared/ });
    expect(shared.textContent).toContain('1');
    fireEvent.click(shared);
    expect(await screen.findByText('Style guide.md')).toBeTruthy();
    expect(screen.queryByText('Billing.pdf')).toBeNull();
    expect(screen.getByTestId('kb-shared-off').textContent).toMatch(/does not search the shared store/);
  });
});
