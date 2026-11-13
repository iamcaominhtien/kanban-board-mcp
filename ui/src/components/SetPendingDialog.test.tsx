// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Member, Ticket } from '../types/ticket';
import { SetPendingDialog } from './SetPendingDialog';

afterEach(cleanup);

const ticket = { id: 'ALP-3', title: 'Ship it', status: 'backlog', pending: false } as unknown as Ticket;
const members = [{ id: 'm1', name: 'Ada Lovelace' }] as unknown as Member[];

function openPersonTab() {
  const onConfirm = vi.fn();
  render(<SetPendingDialog ticket={ticket} members={members} onClose={() => {}} onConfirm={onConfirm} />);
  fireEvent.click(screen.getByRole('button', { name: 'Waiting on a person or party' }));
  return onConfirm;
}

describe('SetPendingDialog: waiting on a person or a party', () => {
  it('sends a name typed in as a party, not as a person (the server asks a member id of a person)', () => {
    const onConfirm = openPersonTab();
    fireEvent.change(screen.getByPlaceholderText('Customer, Design team, vendor name...'), {
      target: { value: '  Design team ' },
    });
    fireEvent.submit(screen.getByPlaceholderText('Customer, Design team, vendor name...').closest('form')!);
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ reasonType: 'party', pendingParty: 'Design team', pendingMemberId: undefined }),
    );
  });

  it('sends a member picked from the list as a person', () => {
    const onConfirm = openPersonTab();
    fireEvent.click(screen.getByText('Ada Lovelace'));
    fireEvent.submit(screen.getByPlaceholderText('Customer, Design team, vendor name...').closest('form')!);
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ reasonType: 'person', pendingMemberId: 'm1', pendingParty: undefined }),
    );
  });
});
