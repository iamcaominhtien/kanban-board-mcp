// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ticket } from '../types';

const http = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../api/client', () => ({ client: http }));

import { SubTicketsSection } from './SubTicketsSection';

afterEach(cleanup);
beforeEach(() => {
  http.patch.mockReset();
  http.patch.mockImplementation((_url: string, data: object) =>
    Promise.resolve({ data: { ...child('KAN-3'), ...data } }),
  );
});

const child = (id: string, blockedBy: string[] = [], wavePin: number | null = null): Ticket =>
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
    wavePin,
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

describe('wave badge popover (Ticket Detail with Sub-tickets 7, TDP-1)', () => {
  it('opens on a click and shows the wave set from Blocked by, with Auto-set checked', () => {
    mount([child('KAN-2'), child('KAN-3', ['KAN-2'])]);
    const badge = screen.getByTestId('wave-badge-KAN-3');
    expect(badge.textContent).toBe('2');
    fireEvent.click(badge);
    expect(screen.getByTestId('wave-value').textContent).toBe('2');
    const auto = screen.getByRole('checkbox', { name: 'Auto-set from Blocked by' }) as HTMLInputElement;
    expect(auto.checked).toBe(true);
    expect(auto.disabled).toBe(false);
    // the order follows Blocked by: KAN-2 (wave 1) before KAN-3 (wave 2)
    expect(screen.getByTestId('wave-badge-KAN-2').textContent).toBe('1');
    expect(http.patch).not.toHaveBeenCalled();
  });

  it('a step pins the wave and saves it', async () => {
    mount([child('KAN-2'), child('KAN-3', ['KAN-2'])]);
    fireEvent.click(screen.getByTestId('wave-badge-KAN-3'));
    fireEvent.click(screen.getByRole('button', { name: 'Earlier wave' }));
    await waitFor(() => expect(http.patch).toHaveBeenCalledWith('/tickets/KAN-3', { wavePin: 1 }));
  });

  it('unchecking Auto-set pins the wave where it is; checking it again drops the pin', async () => {
    mount([child('KAN-2'), child('KAN-3', ['KAN-2'])]);
    fireEvent.click(screen.getByTestId('wave-badge-KAN-3'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Auto-set from Blocked by' }));
    await waitFor(() => expect(http.patch).toHaveBeenCalledWith('/tickets/KAN-3', { wavePin: 2 }));
    cleanup();
    mount([child('KAN-2'), child('KAN-3', ['KAN-2'], 4)]);
    fireEvent.click(screen.getByTestId('wave-badge-KAN-3'));
    const auto = screen.getByRole('checkbox', { name: 'Auto-set from Blocked by' }) as HTMLInputElement;
    expect(auto.checked).toBe(false);
    fireEvent.click(auto);
    await waitFor(() => expect(http.patch).toHaveBeenLastCalledWith('/tickets/KAN-3', { wavePin: null }));
  });

  it('a pinned wave is used for the badge and the order, and the tickets it blocks follow it', () => {
    mount([child('KAN-2', [], 3), child('KAN-3'), child('KAN-4', ['KAN-2'])]);
    expect(screen.getByTestId('wave-badge-KAN-2').textContent).toBe('3');
    expect(screen.getByTestId('wave-badge-KAN-3').textContent).toBe('1');
    expect(screen.getByTestId('wave-badge-KAN-4').textContent).toBe('4');
    const order = screen.getAllByTestId(/^wave-badge-/).map((b) => b.getAttribute('data-testid'));
    expect(order).toEqual(['wave-badge-KAN-3', 'wave-badge-KAN-2', 'wave-badge-KAN-4']);
  });

  it('shows the server error when the pin cannot be saved', async () => {
    http.patch.mockRejectedValueOnce({ response: { data: { detail: 'wave_pin must be between 1 and 99, or null' } } });
    mount([child('KAN-2'), child('KAN-3', ['KAN-2'])]);
    fireEvent.click(screen.getByTestId('wave-badge-KAN-3'));
    fireEvent.click(screen.getByRole('button', { name: 'Later wave' }));
    expect((await screen.findByRole('alert')).textContent).toContain('between 1 and 99');
  });
});
