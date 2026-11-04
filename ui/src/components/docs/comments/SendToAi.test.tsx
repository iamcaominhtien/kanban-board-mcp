// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));

import { sentWords } from '../../../api/docsComments';
import type { DocsCommentThread, SendToAiResult, SendToAiTargets, SendToAiTicket } from '../../../types/docs';
import { SendToAiBox, defaultTicket } from './SendToAi';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const dev = { id: 'm1', name: 'Dev AI', working: false };
const ba = { id: 'm2', name: 'BA', working: false };
const tickets: SendToAiTicket[] = [
  { id: 'KAN-1', title: 'No AI here', status: 'todo', ais: [], heldBy: null },
  { id: 'KAN-2', title: 'Second', status: 'todo', ais: [dev], heldBy: null },
  { id: 'KAN-3', title: 'Third', status: 'todo', ais: [{ ...dev, working: true }, ba], heldBy: 'Dev AI' },
];
const thread = (id: string, body: string, extra: Partial<DocsCommentThread> = {}) =>
  ({
    id,
    number: 1,
    kind: 'inline',
    status: 'open',
    anchor: null,
    comments: [{ body, ai: null }],
    ...extra,
  }) as unknown as DocsCommentThread;
const threads = [
  thread('t1', 'one'),
  thread('t2', 'two'),
  // a page comment already sent: not ticked again
  thread('p1', 'page', {
    kind: 'page',
    comments: [
      { body: 'page', ai: null },
      { body: 'Sent to BA on KAN-3: a new run, #2.', ai: null },
    ],
  } as unknown as Partial<DocsCommentThread>),
];

const renderBox = (targets: SendToAiTargets, onSent = vi.fn()) => {
  http.get.mockResolvedValue({ data: targets });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SendToAiBox pageId="pg1" threads={threads} onClose={vi.fn()} onSent={onSent} />
    </QueryClientProvider>,
  );
  return onSent;
};

describe('defaultTicket', () => {
  it('takes the ticket most chosen threads default to, else the first ticket with an AI', () => {
    expect(defaultTicket(['a', 'b', 'c'], { a: 'KAN-3', b: 'KAN-2', c: 'KAN-3' }, tickets)).toBe('KAN-3');
    expect(defaultTicket(['a', 'b'], { a: null }, tickets)).toBe('KAN-2');
  });
});

describe('SendToAiBox', () => {
  it('lists the threads checked, preselects the default ticket and posts them', async () => {
    const result: SendToAiResult = {
      delivered: 'run',
      runId: 'r1',
      runNumber: 4,
      ticketId: 'KAN-3',
      memberName: 'Dev AI',
      threads: 2,
    };
    http.post.mockResolvedValue({ data: result });
    const onSent = renderBox({ tickets, defaults: { t1: 'KAN-3', t2: 'KAN-3' } });
    const select = (await screen.findByTestId('send-to-ai-ticket')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('KAN-3'));
    expect((screen.getByTestId('send-to-ai-thread-t1') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('send-to-ai-thread-t2') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('send-to-ai-thread-p1') as HTMLInputElement).checked).toBe(false);
    // the AI holding the ticket by default; BA can be chosen instead
    const member = screen.getByTestId('send-to-ai-member') as HTMLSelectElement;
    await waitFor(() => expect(member.value).toBe('m1'));
    fireEvent.change(member, { target: { value: 'm2' } });
    expect(screen.getByText("BA starts a run on KAN-3 after Dev AI's run ends.")).toBeTruthy();
    fireEvent.click(screen.getByTestId('send-to-ai-go'));
    await waitFor(() => expect(onSent).toHaveBeenCalledWith(sentWords(result)));
    expect(http.post).toHaveBeenCalledWith('/docs/pages/pg1/send-to-ai', {
      threadIds: ['t1', 't2'],
      ticketId: 'KAN-3',
      memberId: 'm2',
    });
  });

  it('disables the send button when the chosen ticket has no AI', async () => {
    renderBox({ tickets, defaults: {} });
    const select = (await screen.findByTestId('send-to-ai-ticket')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('KAN-2'));
    expect((screen.getByTestId('send-to-ai-go') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(select, { target: { value: 'KAN-1' } });
    expect((screen.getByTestId('send-to-ai-go') as HTMLButtonElement).disabled).toBe(true);
  });
});
