// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import type { Ticket } from '../types';
import { SubTicketsSection } from './SubTicketsSection';

afterEach(cleanup);

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
  it('opens on a click and shows the wave set from Blocked by, read-only (no server field for a pinned wave)', () => {
    mount([child('KAN-2'), child('KAN-3', ['KAN-2'])]);
    const badge = screen.getByTestId('wave-badge-KAN-3');
    expect(badge.textContent).toBe('2');
    fireEvent.click(badge);
    expect(screen.getByTestId('wave-value').textContent).toBe('2');
    const auto = screen.getByRole('checkbox', { name: 'Auto-set from Blocked by' }) as HTMLInputElement;
    expect(auto.checked).toBe(true);
    expect(auto.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Earlier wave' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Later wave' }) as HTMLButtonElement).disabled).toBe(true);
    // the order still follows Blocked by: KAN-2 (wave 1) before KAN-3 (wave 2)
    expect(screen.getByTestId('wave-badge-KAN-2').textContent).toBe('1');
  });
});
