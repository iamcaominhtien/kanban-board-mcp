// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RunDetail } from './RunDetail';
import type { HistoryRow, TranscriptResponse } from '../../types/aiHistory';

const row: HistoryRow = {
  id: 'r1',
  number: 1,
  projectId: 'p',
  ticketId: 'KAN-212',
  ticketTitle: 'Cost badge',
  memberId: 'm',
  memberName: 'Dev An',
  mode: 'work',
  trigger: 'x',
  state: 'failed',
  model: 'sonnet',
  queuedAt: null,
  startedAt: '2026-11-02T11:22:04Z',
  endedAt: '2026-11-02T11:36:40Z',
  durationS: 876,
  costUsd: 0.38,
  tokens: 41000,
  summary: 'It failed.',
  endedReason: 'board fault',
  files: 3,
  skills: [],
  transcript: null,
  diagnosis: null,
};

let data: TranscriptResponse;
vi.mock('../../api/aiHistory', async (orig) => ({
  ...(await orig<typeof import('../../api/aiHistory')>()),
  useTranscript: () => ({ data, isError: false }),
  useRunRecord: () => ({ data: undefined, isLoading: false }),
  usePinRun: () => ({ mutate: vi.fn(), isPending: false }),
}));

function show() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RunDetail runId="r1" onBack={() => undefined} onOpenTicket={() => undefined} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe('RunDetail', () => {
  it('opens a tool step to what was sent and what came back', () => {
    data = {
      run: row,
      available: true,
      transcript: { bytes: 1, events: 2, pinned: false, pinnedBy: null, endedAt: null, removedAt: null },
      entries: [
        {
          type: 'tool',
          at: '2026-11-02T11:22:18Z',
          name: 'Bash',
          input: { command: 'npm test' },
          output: 'FAIL here',
          isError: true,
        },
      ],
    };
    show();
    fireEvent.click(screen.getByText('Ran npm test'));
    expect(screen.getByText('FAIL here')).toBeTruthy();
    expect(screen.getByText(/What came back · error/)).toBeTruthy();
  });

  it('says so when the board has no transcript, and still shows the summary', () => {
    data = { run: row, available: false, transcript: null, entries: [] };
    show();
    expect(screen.getByTestId('hs-no-transcript').textContent).toContain('It failed.');
    expect((screen.getByText('Pin') as HTMLButtonElement).disabled).toBe(true);
  });
});
