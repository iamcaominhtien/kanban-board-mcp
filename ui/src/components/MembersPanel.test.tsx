// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Member } from '../types/ticket';

const m = vi.hoisted(() => ({ add: vi.fn(), remove: vi.fn() }));
vi.mock('../api/members', () => ({
  useAddMember: () => ({ mutateAsync: m.add, isPending: false }),
  useRemoveMember: () => ({ mutateAsync: m.remove }),
  useSetMemberRole: () => ({ mutate: vi.fn() }),
}));
vi.mock('../api/ai', () => ({
  useAiOverview: () => ({ data: { members: [], settings: { boardAiId: null } }, isLoading: false, isError: false }),
}));
vi.mock('./ai/AiDialogs', () => ({ BoardAiPicker: () => null }));

import { MembersPanel } from './MembersPanel';

const members = [
  { id: 'm1', name: 'An Nguyen', color: '#2E6F40', kind: 'human' },
  { id: 'm2', name: 'Hoa Mai', color: '#5B5FA8', kind: 'human' },
] as Member[];

const axiosError = (status: number, detail?: string) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: detail ? { detail } : 'boom' },
  });

describe('MembersPanel (design members-view 3, 4)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const mount = () => render(<MembersPanel projectId="p1" members={members} onClose={vi.fn()} />);

  it('says the design sentence when adding fails on the server, and the server reason only for a duplicate', async () => {
    mount();
    m.add.mockRejectedValueOnce(axiosError(500));
    fireEvent.change(screen.getByPlaceholderText('Member name…'), { target: { value: 'Tuan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Failed to add member. Please try again.')).toBeTruthy();
    expect(screen.queryByText(/status code 500/)).toBeNull();

    m.add.mockRejectedValueOnce(axiosError(409, 'A member named Tuan already exists.'));
    fireEvent.change(screen.getByPlaceholderText('Member name…'), { target: { value: 'Tuan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('A member named Tuan already exists.')).toBeTruthy();
  });

  it('shows a blocked remove under its own row, with that row’s remove button tinted', async () => {
    mount();
    m.remove.mockRejectedValueOnce(axiosError(400, 'Cannot remove: assigned to 3 open tickets. Reassign first.'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Hoa Mai' }));
    const msg = await screen.findByTestId('member-remove-error');
    expect(msg.textContent).toBe('Cannot remove: assigned to 3 open tickets. Reassign first.');
    // right after Hoa Mai's row, not under the whole list
    const row = screen.getByRole('button', { name: 'Remove Hoa Mai' }).closest('div');
    expect(row?.nextElementSibling).toBe(msg);
    expect(screen.getByRole('button', { name: 'Remove Hoa Mai' }).className).toMatch(/removeBtnBlocked/);
    expect(screen.getByRole('button', { name: 'Remove An Nguyen' }).className).not.toMatch(/removeBtnBlocked/);
  });
});
