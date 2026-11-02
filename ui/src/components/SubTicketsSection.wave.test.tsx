// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import type { Ticket } from '../types';
import { SubTicketsSection } from './SubTicketsSection';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const child = (id: string, blockedBy: string[] = []): Ticket =>
  ({
    id,
    projectId: 'p',
    title: `Child ${id}`,
    description: '',
    type: 'task',
    status: 'todo',
    priority: 'medium',
    estimate: null,
    dueDate: null,
    startDate: null,
    tags: [],
    parentId: 'KAN-1',
    comments: [],
    acceptanceCriteria: [],
    subTasks: [],
    activityLog: [],
    workLog: [],
    testCases: [],
    wontDoReason: null,
    createdBy: null,
    assignee: null,
    blocks: [],
    blockedBy,
    blockDoneIfAcsIncomplete: false,
    blockDoneIfTcsIncomplete: false,
    links: [],
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  }) as Ticket;

function mount(children: Ticket[]) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SubTicketsSection
        childTickets={children}
        allTickets={children}
        currentTicketId="KAN-1"
        projectId="p"
        onOpenTicket={() => {}}
        onLinkChild={() => {}}
        onUnlinkChild={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe('wave badge popover (Ticket Detail with Sub-tickets 7)', () => {
  it('opens on a click, pins a wave with the stepper and re-sorts; Auto-set gives the computed wave back', () => {
    mount([child('KAN-2'), child('KAN-3', ['KAN-2'])]);
    const badge = screen.getByTestId('wave-badge-KAN-3');
    expect(badge.textContent).toBe('2');
    fireEvent.click(badge);
    const auto = screen.getByRole('checkbox', { name: 'Auto-set from Blocked by' }) as HTMLInputElement;
    expect(auto.checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Earlier wave' }));
    expect(screen.getByTestId('wave-badge-KAN-3').textContent).toBe('1');
    expect((screen.getByRole('checkbox', { name: 'Auto-set from Blocked by' }) as HTMLInputElement).checked).toBe(
      false,
    );
    expect(JSON.parse(localStorage.getItem('kanban.subticketWaves.KAN-1') ?? '{}')).toEqual({ 'KAN-3': 1 });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Auto-set from Blocked by' }));
    expect(screen.getByTestId('wave-badge-KAN-3').textContent).toBe('2');
    expect(localStorage.getItem('kanban.subticketWaves.KAN-1')).toBeNull();
  });
});
