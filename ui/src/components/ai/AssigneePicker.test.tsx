// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Member, Ticket } from '../../types';
import type { AiTeam } from '../../types/ai';
import { AssigneePicker } from './AssigneePicker';
import { AiBoardContext } from './aiUi';

const team = {
  id: 't1',
  name: 'Research team',
  kind: 'ai',
  color: '#2E6F40',
  roles: [{ key: 'dev', name: 'Developer' }],
  status: { code: 'idle', label: 'Idle', detail: null },
  slotsInUse: 0,
} as unknown as AiTeam;

const ticket = { id: 'RES-1', title: 'Research the stack' } as Ticket;
const members = [{ id: 'h1', name: 'An', kind: 'human', color: '#336699' }] as Member[];

function open(onPickPerson: (id: string | null, start?: boolean) => void) {
  render(
    <AiBoardContext.Provider
      value={{ projectId: 'p1', members: new Map([[team.id, team]]), runsByTicket: new Map(), settings: null }}
    >
      <AssigneePicker
        ticket={ticket}
        members={members}
        value={null}
        onPickPerson={onPickPerson}
        onAssignedAi={() => {}}
      />
    </AiBoardContext.Provider>,
  );
  fireEvent.click(screen.getByTestId('assignee-picker'));
  fireEvent.click(screen.getByTestId('assign-ai-Research team'));
}

describe('assigning an AI team', () => {
  afterEach(cleanup);

  it('can start the lead now', () => {
    const pick = vi.fn();
    open(pick);
    fireEvent.click(screen.getByTestId('assign-confirm'));
    expect(pick).toHaveBeenCalledWith('t1', true);
  });

  it('can only assign, without starting', () => {
    const pick = vi.fn();
    open(pick);
    expect(screen.getByTestId('assign-start-popover').textContent).toContain('Assign only');
    fireEvent.click(screen.getByTestId('assign-only'));
    expect(pick).toHaveBeenCalledWith('t1', false);
  });

  it('assigns a person straight away', () => {
    const pick = vi.fn();
    render(
      <AiBoardContext.Provider value={{ projectId: 'p1', members: new Map(), runsByTicket: new Map(), settings: null }}>
        <AssigneePicker ticket={ticket} members={members} value={null} onPickPerson={pick} onAssignedAi={() => {}} />
      </AiBoardContext.Provider>,
    );
    fireEvent.click(screen.getByTestId('assignee-picker'));
    fireEvent.click(screen.getByText('An'));
    expect(pick).toHaveBeenCalledWith('h1');
  });
});
