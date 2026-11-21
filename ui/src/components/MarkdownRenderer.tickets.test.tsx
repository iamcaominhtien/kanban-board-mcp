// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocsRefRequest } from '../types/docs';

vi.mock('../api/docs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/docs')>()),
  useResolveRefs: (_projectId: string, list: DocsRefRequest[]) => ({
    data: list.map((r) => {
      if (r.kind !== 'ticket') return { kind: 'page', status: 'missing' };
      return r.key.startsWith('MH-') || r.key === 'KAN-999'
        ? { kind: 'ticket', status: 'missing', key: r.key }
        : { kind: 'ticket', status: 'ok', key: r.key, title: `Ticket ${r.key}`, ticketStatus: 'todo' };
    }),
  }),
}));

vi.mock('../api/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/projects')>()),
  useProjectPrefixes: () => new Set(['KAN']),
}));

import { MarkdownRenderer } from './MarkdownRenderer';
import { ToastProvider } from './Toast';

afterEach(cleanup);

describe('MarkdownRenderer: ticket keys in text', () => {
  // Bug: a screen id like MH-005 has the shape of a ticket key and was drawn as a red "not found" chip.
  it('chips a real ticket, flags a missing one with a project prefix and leaves any other key as text', () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <MarkdownRenderer docs={{ projectId: 'p1' }}>
            {'Dialog MH-005 is shown by KAN-7 and KAN-999.'}
          </MarkdownRenderer>
        </ToastProvider>
      </QueryClientProvider>,
    );
    expect(container.textContent).toContain('MH-005');
    expect(container.querySelectorAll('.dk-chip-missing')).toHaveLength(1);
    expect(container.querySelector('.dk-chip-missing')?.textContent).toContain('KAN-999');
    expect(container.querySelector('[data-testid="ref-ticket-KAN-7"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="ref-ticket-MH-005"]')).toBeNull();
  });
});
