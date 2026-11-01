// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiRun, RunDiagnosis } from '../../../types/ai';

const api = vi.hoisted(() => ({
  trouble: vi.fn(),
  continueWith: vi.fn(),
  handTo: vi.fn(),
  tell: vi.fn(),
}));
const openRun = vi.hoisted(() => vi.fn());
vi.mock('../../../api/aiOps', async (orig) => ({
  ...(await orig<typeof import('../../../api/aiOps')>()),
  aiOpsApi: api,
}));
vi.mock('../../../api/ai', () => ({
  aiApi: { retry: vi.fn() },
  aiKeys: { all: ['ai'] },
  useAiOverview: () => ({ data: { members: [] }, isLoading: false }),
}));
vi.mock('../../aiteam/runLink', () => ({ openRun }));

import { TellBox } from './TellBox';
import { TroubleCard } from './TroubleCard';
import { liveDiagnosis, troubleTitle } from './troubleUi';

const diagnosis: RunDiagnosis = {
  at: '2026-11-02T10:28:00Z',
  by: 'code',
  cause: 'foreground_server',
  trigger: 'No output for 22 minutes',
  what: 'The last step ran npm run dev in the foreground.',
  means: 'A dev server does not end by itself.',
  tried: [],
  actions: ['stop_child', 'tell_ai', 'wait', 'cancel'],
  quietS: 1320,
  process: { alive: true, cpu: 0, rssMb: 80 },
};

const run = (over: Partial<AiRun> = {}) =>
  ({
    id: 'run_1',
    ticketId: 'KAN-218',
    projectId: 'p1',
    memberId: 'm1',
    memberName: 'Dev An',
    state: 'running',
    steps: new Array(14).fill({ at: '', kind: 'say', text: '' }),
    diagnosis,
    ...over,
  }) as unknown as AiRun;

function wrap(ui: React.ReactElement) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('TroubleCard', () => {
  it('shows the diagnosis and the actions it allows', () => {
    wrap(<TroubleCard run={run()} />);
    expect(screen.getByText('Dev An has produced nothing for 22 minutes')).toBeTruthy();
    expect(screen.getByText(/ran npm run dev in the foreground/)).toBeTruthy();
    expect(screen.getByText(/first time this run stopped moving/)).toBeTruthy();
    for (const label of [
      'Stop that command, keep the run',
      'Tell the AI to run it in the background',
      'Wait, tell me again at 30 min',
      'Cancel the run',
    ])
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue with a note' })).toBeNull();
  });

  it('is not shown without a diagnosis or once it has cleared', () => {
    const { container, rerender } = wrap(<TroubleCard run={run({ diagnosis: null })} />);
    expect(container.textContent).toBe('');
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <TroubleCard run={run({ diagnosis: { ...diagnosis, clearedAt: '2026-11-02T10:40:00Z' } })} />
      </QueryClientProvider>,
    );
    expect(container.textContent).toBe('');
  });

  it('labels a board fault', () => {
    wrap(<TroubleCard run={run({ diagnosis: { ...diagnosis, boardFault: true } })} />);
    expect(screen.getByText('Board fault')).toBeTruthy();
  });

  it('calls the trouble endpoint and says what the board did', async () => {
    api.trouble.mockResolvedValue({ done: true, text: 'Stopped npm run dev.' });
    wrap(<TroubleCard run={run()} />);
    fireEvent.click(screen.getByTestId('trouble-stop_child'));
    expect(api.trouble).toHaveBeenCalledWith('run_1', 'stop_child');
    expect(await screen.findByText('Stopped npm run dev.')).toBeTruthy();
  });

  it('shows an error inline', async () => {
    api.trouble.mockRejectedValue(new Error('boom'));
    wrap(<TroubleCard run={run()} />);
    fireEvent.click(screen.getByTestId('trouble-wait'));
    expect((await screen.findByRole('alert')).textContent).toContain('boom');
  });

  it('opens the run', async () => {
    wrap(<TroubleCard run={run()} />);
    fireEvent.click(screen.getByTestId('trouble-open'));
    expect(openRun).toHaveBeenCalledWith('run_1');
  });

  it('asks for a note before continuing', async () => {
    api.continueWith.mockResolvedValue({});
    wrap(<TroubleCard run={run({ diagnosis: { ...diagnosis, actions: ['continue_note'] } })} />);
    fireEvent.click(screen.getByTestId('trouble-continue_note'));
    const confirm = screen.getByRole('button', { name: 'Continue' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Note for the AI'), { target: { value: 'use port 5174' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.continueWith).toHaveBeenCalledWith('run_1', 'use port 5174'));
  });

  it('titles a stopped run by its trigger', () => {
    expect(troubleTitle({ ...diagnosis, quietS: undefined, trigger: 'The run stopped' }, 'Dev An')).toBe(
      'Dev An: the run stopped',
    );
    expect(liveDiagnosis({ diagnosis: null })).toBeNull();
  });
});

describe('TellBox', () => {
  it('sends a sentence and says which way it went', async () => {
    api.tell.mockResolvedValue({ delivered: 'next_board_call' });
    wrap(<TellBox run={run()} />);
    fireEvent.change(screen.getByLabelText('Send to the AI'), { target: { value: 'use the cache' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(api.tell).toHaveBeenCalledWith('run_1', 'use the cache');
    expect(await screen.findByText(/with its next board call/)).toBeTruthy();
  });

  it('says it was read at the next turn when it went into the input, and shows errors', async () => {
    api.tell.mockResolvedValueOnce({ delivered: 'input' }).mockRejectedValueOnce(new Error('no'));
    wrap(<TellBox run={run()} />);
    const box = screen.getByLabelText('Send to the AI');
    fireEvent.change(box, { target: { value: 'a' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText(/reads it at its next turn/)).toBeTruthy();
    fireEvent.change(box, { target: { value: 'b' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect((await screen.findByRole('alert')).textContent).toContain('no');
  });

  it('is only offered on a running run', () => {
    const { container } = wrap(<TellBox run={run({ state: 'queued' })} />);
    expect(container.textContent).toBe('');
  });
});
