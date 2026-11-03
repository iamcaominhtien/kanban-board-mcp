// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));

import { HandToDialog } from './HandToDialog';

const member = (id: string, name: string, kind = 'ai') => ({
  id,
  name,
  kind,
  provider: 'claude_code',
  color: '#2E6F40',
  glyph: 'A',
});

function setup(members: unknown[], onSubmit = vi.fn().mockResolvedValue(undefined), onClose = vi.fn()) {
  http.get.mockResolvedValue({ data: { members, summary: {}, settings: {} } });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <HandToDialog projectId="p1" currentMemberId="m1" onSubmit={onSubmit} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onSubmit, onClose };
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('HandToDialog', () => {
  it('shows loading, then only the other AI members, and keeps Hand over off until one is picked', async () => {
    setup([member('m1', 'Dev An'), member('m2', 'Dev Binh'), member('m3', 'Gone', 'ai_removed')]);
    expect(screen.getByText('Loading the AI members…')).toBeTruthy();
    await screen.findByText('Dev Binh');
    expect(screen.queryByText('Dev An')).toBeNull();
    expect(screen.queryByText('Gone')).toBeNull();
    expect(http.get).toHaveBeenCalledWith('/projects/p1/ai/overview');
    expect((screen.getByRole('button', { name: 'Hand over' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('hands over to the picked member with a trimmed note, then closes', async () => {
    const { onSubmit, onClose } = setup([member('m2', 'Dev Binh'), member('m4', 'Dev Cuong')]);
    fireEvent.click(await screen.findByText('Dev Cuong'));
    expect(screen.getByRole('button', { name: /Dev Cuong/ }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(screen.getByLabelText('Note for the AI'), { target: { value: '  take over  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hand over' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith('m4', 'take over');
  });

  it('sends no note when it is blank', async () => {
    const { onSubmit } = setup([member('m2', 'Dev Binh')]);
    fireEvent.click(await screen.findByText('Dev Binh'));
    fireEvent.click(screen.getByRole('button', { name: 'Hand over' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('m2', undefined));
  });

  it('says so when there is no other AI member', async () => {
    setup([member('m1', 'Dev An')]);
    expect(await screen.findByText('There is no other AI member in this project.')).toBeTruthy();
  });
});
