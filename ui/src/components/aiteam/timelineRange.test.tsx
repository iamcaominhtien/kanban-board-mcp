// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Timeline } from '../../types/aiTeam';
import { ToastProvider } from '../Toast';
import { TimelineTab } from './TimelineTab';

const calls: unknown[] = [];

function empty(range: Timeline['range']): Timeline {
  const now = new Date('2026-10-30T12:00:00').toISOString();
  return {
    range,
    since: new Date('2026-10-30T00:00:00').toISOString(),
    until: now,
    now,
    following: false,
    scope: { kind: 'team', ticketId: null },
    lifelines: [],
    bars: [],
    arrows: [],
    waits: [],
    touches: [],
    docs: [],
    pauses: [],
    pausedAll: false,
    pausedAt: null,
    pausedBy: null,
    live: [],
    density: [],
    truncated: false,
    lastEndedAt: null,
    tickets: {},
    autopilot: { on: false, delegate: null, graceMin: null },
  };
}

vi.mock('../../api/aiTeam', () => ({
  useTimeline: (_p: string, q: { range: Timeline['range'] }) => {
    calls.push(q);
    return { data: empty(q.range), isError: false };
  },
}));

function show() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <TimelineTab projectId="p1" actions={{ onOpenTicket: () => {}, onOpenDocsPage: () => {} }} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('Timeline range button', () => {
  beforeEach(() => {
    calls.length = 0;
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it('picks a preset from the menu', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Range' }));
    fireEvent.click(screen.getByRole('option', { name: 'Last 24 h' }));
    expect(calls.at(-1)).toMatchObject({ range: '24h' });
  });

  it('Custom… opens a two-day popover and asks for that window', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Range' }));
    fireEvent.click(screen.getByRole('option', { name: 'Custom…' }));
    const dialog = screen.getByTestId('tl-custom-range');
    const [from, to] = dialog.querySelectorAll('input');
    fireEvent.change(from, { target: { value: '2026-10-20' } });
    fireEvent.change(to, { target: { value: '2026-10-22' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show this range' }));
    const q = calls.at(-1) as { range: string; since: string; until: string };
    expect(q.range).toBe('custom');
    expect(new Date(q.since).getTime()).toBe(new Date(2026, 9, 20).getTime());
    expect(new Date(q.until).getTime()).toBe(new Date(2026, 9, 23).getTime());
    expect(screen.queryByTestId('tl-custom-range')).toBeNull();
  });

  it('will not apply a range that ends before it starts', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Range' }));
    fireEvent.click(screen.getByRole('option', { name: 'Custom…' }));
    const [from, to] = screen.getByTestId('tl-custom-range').querySelectorAll('input');
    fireEvent.change(from, { target: { value: '2026-10-22' } });
    fireEvent.change(to, { target: { value: '2026-10-20' } });
    expect(screen.getByRole('alert').textContent).toMatch(/after the last/);
    expect((screen.getByRole('button', { name: 'Show this range' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

afterEach(cleanup);
