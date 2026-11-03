// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry, HistoryRow, TranscriptResponse } from '../../types/aiHistory';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../api/client', () => ({ client: http }));

import { RunDetail } from './RunDetail';

const row = (o: Partial<HistoryRow> = {}): HistoryRow => ({
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
  ...o,
});

const info = { bytes: 1, events: 2, pinned: false, pinnedBy: null, endedAt: null, removedAt: null };
const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');

const entries: Entry[] = [
  {
    type: 'sent',
    at: '2026-11-02T11:22:04Z',
    system: 'be careful',
    prompt: 'do the ticket',
    note: 'mind the badge',
    resume: true,
    args: ['--print', '-p'],
  },
  { type: 'sent', at: '2026-11-02T11:30:00Z', note: 'again', resume: true },
  {
    type: 'init',
    at: '2026-11-02T11:22:05Z',
    model: 'claude-sonnet',
    tools: 12,
    skills: ['tdd'],
    plugins: ['design'],
    mcpServers: [{ name: 'kanban', status: 'connected' }],
  },
  { type: 'say', at: '2026-11-02T11:22:10Z', text: 'Looking at it' },
  { type: 'think', at: '2026-11-02T11:22:11Z', text: 'hmm' },
  {
    type: 'tool',
    at: '2026-11-02T11:22:18Z',
    endedAt: '2026-11-02T11:22:48Z',
    name: 'Bash',
    input: { command: 'npm test' },
    output: long,
  },
  { type: 'tool', at: '2026-11-02T11:22:50Z', name: 'Read', input: undefined, output: '' },
  { type: 'message', at: '2026-11-02T11:23:00Z', text: 'try again' },
  { type: 'note', at: '2026-11-02T11:23:10Z', kind: 'restart', text: 'restarted' },
  { type: 'compact', at: '2026-11-02T11:24:00Z', before: 90000, after: 12000 },
  { type: 'quota', at: '2026-11-02T11:24:30Z', status: 'rejected', windows: { five: 1 } },
  { type: 'output', at: '2026-11-02T11:25:00Z', text: 'printed' },
  { type: 'result', at: '2026-11-02T11:26:00Z', isError: false, text: 'All done', turns: 7, costUsd: 0.5 },
];

let transcript: TranscriptResponse | Error;
let record: unknown;

function setup(onBack = vi.fn(), onOpenTicket = vi.fn()) {
  http.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/transcript')) {
      if (transcript instanceof Error) throw transcript;
      return { data: transcript };
    }
    if (url === '/ai/runs/r1') return { data: record };
    return { data: {} };
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <RunDetail runId="r1" onBack={onBack} onOpenTicket={onOpenTicket} />
    </QueryClientProvider>,
  );
  return { onBack, onOpenTicket };
}

beforeEach(() => {
  vi.clearAllMocks();
  transcript = {
    run: row({
      diagnosis: {
        what: 'The CLI hung',
        means: 'It waited for input',
        tried: ['wait', 'tell'],
      } as HistoryRow['diagnosis'],
    }),
    available: true,
    transcript: info,
    entries,
  };
  record = {
    files: [
      { path: 'src/a.ts', added: 4, removed: 1, new: true },
      { path: 'src/b.ts', added: 0, removed: 9 },
    ],
    report: {
      summary: 'Fixed the badge',
      criteria: [
        { text: 'shows cost', met: true, evidence: 'screenshot' },
        { text: 'is accessible', met: false },
        { text: 'maybe', met: null },
      ],
      tests: { failed: 1, passed: 20 },
    },
  };
});
afterEach(cleanup);

describe('RunDetail (full)', () => {
  it('shows loading and then the error with a way back', async () => {
    transcript = new Error('gone');
    const { onBack } = setup();
    expect(screen.getByText('Loading the run…')).toBeTruthy();
    await screen.findByText(/Couldn.t load this run/);
    fireEvent.click(screen.getByRole('button', { name: 'Back to Run history' }));
    expect(onBack).toHaveBeenCalled();
  });

  it('shows the head, facts, diagnosis and every kind of step', async () => {
    const { onBack, onOpenTicket } = setup();
    await screen.findByTestId('run-detail');
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText('Board fault', { exact: false })).toBeTruthy();
    expect(screen.getByText('$0.38')).toBeTruthy();
    expect(screen.getByText('41k')).toBeTruthy();
    expect(screen.getByText('3 changed')).toBeTruthy();
    expect(screen.getByTestId('hs-diagnosis').textContent).toContain('Tried: wait; tell');
    expect(screen.getByText(/The note it was given: “mind the badge”/)).toBeTruthy();
    expect(screen.getAllByTestId('hs-step')).toHaveLength(10);
    expect(screen.getByText('Compacted its memory: 90,000 → 12,000 tokens')).toBeTruthy();
    expect(screen.getByText('Finished after 7 turns')).toBeTruthy();
    expect(screen.getByText('30 s')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Run history' }));
    expect(onBack).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'KAN-212' }));
    expect(onOpenTicket).toHaveBeenCalledWith('KAN-212');
    expect(screen.getByText('Export as Markdown').getAttribute('href')).toContain('/ai/runs/r1/export?format=md');
    expect(screen.getByText('Export as JSON').getAttribute('href')).toContain('format=json');
  });

  it('opens each step to its body', async () => {
    setup();
    await screen.findByTestId('run-detail');
    const open = (title: string | RegExp) => fireEvent.click(screen.getByRole('button', { name: title }));
    open(/^Ran npm test/);
    expect(screen.getByText('What it sent · Bash')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /lines hidden · show all/ }));
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy();
    open(/^Read$/);
    expect(screen.getByText('(no arguments)')).toBeTruthy();
    expect(screen.getByText('Nothing came back.')).toBeTruthy();
    open(/^Compacted/);
    expect(
      screen.getByText(/The conversation grew too long and was summarised from 90,000 tokens to 12,000/),
    ).toBeTruthy();
    open(/^Usage window: rejected/);
    open(/^Finished after 7 turns/);
    expect(screen.getByText('All done')).toBeTruthy();
    expect(screen.getByText(/7 turns · estimate \$0\.50/)).toBeTruthy();
    open(/^A person wrote/);
    expect(screen.getByText('try again')).toBeTruthy();
    open(/^Output: printed/);
  });

  it('reads what it was given', async () => {
    setup();
    await screen.findByTestId('run-detail');
    fireEvent.click(screen.getByRole('tab', { name: 'What it was given' }));
    const given = screen.getByTestId('hs-given');
    expect(given.textContent).toContain('claude-sonnet');
    expect(given.textContent).toContain('Resumed the CLI’s own conversation');
    expect(given.textContent).toContain('12 tools · kanban (connected)');
    expect(given.textContent).toContain('design');
    expect(given.textContent).toContain('--print -p');
    expect(given.textContent).toContain('sent again: again (resumed)');
    fireEvent.click(screen.getAllByRole('button', { name: /^show · / })[1]);
    expect(screen.getByText('do the ticket')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'hide' }));
  });

  it('lists the files and the report', async () => {
    setup();
    await screen.findByTestId('run-detail');
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }));
    await screen.findByText('src/a.ts');
    expect(screen.getByTestId('hs-files').textContent).toContain('+4');
    expect(screen.getByTestId('hs-files').textContent).toContain('−9');
    fireEvent.click(screen.getByRole('tab', { name: 'Report' }));
    await screen.findByText('Fixed the badge');
    const rep = screen.getByTestId('hs-report').textContent ?? '';
    expect(rep).toContain('shows cost — screenshot');
    expect(rep).toContain('is accessible');
    expect(rep).toContain('maybe');
    expect(screen.getByRole('img', { name: 'Met' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Not met' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Not checked' })).toBeTruthy();
    expect(rep).toContain('Tests: 1 failed, 20 passed');
  });

  it('says so when a run changed no files and left no report', async () => {
    record = { files: [], report: null };
    transcript = { run: row({ summary: null, diagnosis: null }), available: true, transcript: info, entries: [] };
    setup();
    await screen.findByText('No steps were recorded.');
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }));
    await screen.findByText('This run changed no files.');
    fireEvent.click(screen.getByRole('tab', { name: 'Report' }));
    await screen.findByText('This run left no report.');
  });

  it('pins and unpins, and shows a refusal', async () => {
    http.post.mockRejectedValueOnce({ response: { data: { detail: 'Nothing to pin' } } });
    setup();
    await screen.findByTestId('run-detail');
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    await screen.findByText('Nothing to pin');
    expect(http.post).toHaveBeenCalledWith('/ai/runs/r1/pin', { on: true });
  });

  it('shows a pinned run as pinned and unpins it', async () => {
    http.post.mockResolvedValue({ data: info });
    transcript = { run: row(), available: true, transcript: { ...info, pinned: true }, entries: [] };
    setup();
    await screen.findByText('Pinned runs are never deleted.');
    fireEvent.click(screen.getByRole('button', { name: 'Unpin' }));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/ai/runs/r1/pin', { on: false }));
  });

  it('says when the transcript was removed by the retention', async () => {
    transcript = {
      run: row(),
      available: false,
      transcript: { ...info, removedAt: '2026-10-01T00:00:00Z' },
      entries: [],
    };
    setup();
    const warn = await screen.findByTestId('hs-no-transcript');
    expect(warn.textContent).toContain('was removed on');
    expect((screen.getByRole('button', { name: 'Pin' }) as HTMLButtonElement).title).toMatch(/already removed/);
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }));
    await screen.findByTestId('hs-files');
  });

  it('says when the run history retention removed the run details, and that the rest is kept', async () => {
    transcript = {
      run: { ...row(), detailsRemovedAt: '2026-10-01T00:00:00Z' },
      available: false,
      transcript: { ...info, removedAt: '2026-10-01T00:00:00Z' },
      entries: [],
    };
    setup();
    const warn = await screen.findByTestId('hs-no-transcript');
    expect(warn.textContent).toContain('Details removed on');
    expect(warn.textContent).toContain('cost, status, summary and links are kept');
  });

  it('continues a failed run with a note', async () => {
    http.post.mockResolvedValue({ data: {} });
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with a note' }));
    fireEvent.change(screen.getByLabelText('Note for the AI'), { target: { value: ' go on ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/ai/runs/r1/continue', { note: 'go on' }));
  });

  it('offers no continue on a finished run', async () => {
    transcript = {
      run: row({ state: 'finished', endedReason: null, skills: ['tdd'] }),
      available: true,
      transcript: info,
      entries: [],
    };
    setup();
    await screen.findByTestId('run-detail');
    expect(screen.queryByRole('button', { name: 'Continue with a note' })).toBeNull();
    expect(screen.getByText('tdd')).toBeTruthy();
  });
});
