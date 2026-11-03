// @vitest-environment jsdom
/** AI memory made visible (issue #274): what waits for a person, the notes the AIs keep, flags, and what a run used. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Knowledge, Lesson, MemoryNote } from '../../../types/aiKnowledge';
import { memoryUsedLabel } from '../../aiteam/RunDetail';

const http = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));

import { KnowledgeSection, memoryWaiting } from './KnowledgeSection';

const ok = (data: unknown) => Promise.resolve({ data });

const lesson = (o: Partial<Lesson>): Lesson => ({
  id: 'l1',
  text: 'Settings live in server/old_config.py.',
  state: 'kept',
  tokens: 10,
  sourceTicketId: 'KAN-218',
  sourceRunId: null,
  proposedBy: 'model',
  keptBy: 'Tien',
  uses: 4,
  lastUsedAt: null,
  createdAt: '2026-10-31T10:00:00Z',
  updatedAt: '2026-10-31T10:00:00Z',
  ...o,
});

const note = (o: Partial<MemoryNote>): MemoryNote => ({
  id: 'mem_1',
  scope: 'role',
  scopeKey: 'dev',
  scopeLabel: 'Dev',
  text: 'Run the UI tests with npm test -- --run.',
  kind: 'learned',
  tokens: 10,
  writtenBy: 'Dev An',
  sourceRunId: 'run_1',
  sourceTicketId: 'KAN-12',
  uses: 2,
  lastUsedAt: null,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-01T10:00:00Z',
  ...o,
});

const knowledge = (o: Partial<Knowledge> = {}): Knowledge => ({
  projectId: 'p1',
  instructions: '',
  instructionsTokens: 0,
  updatedAt: null,
  updatedBy: null,
  history: [],
  lessons: [],
  lessonsTokens: 0,
  lessonCap: 2000,
  totalTokens: 0,
  budget: 8000,
  unused: [],
  proposals: 0,
  notes: [],
  noteCaps: { role: 30, member: 30, ticket: 15 },
  flags: [],
  ...o,
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <KnowledgeSection projectId="p1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => Object.values(http).forEach((f) => f.mockReset()));
afterEach(cleanup);

describe('what waits for a person', () => {
  it('counts proposals and flagged items once each, and opens on Memory while any wait', async () => {
    const data = knowledge({
      lessons: [lesson({ id: 'p1', state: 'proposed', text: 'Quote CSV commas.', proposedBy: 'Dev An' }), lesson({})],
      flags: [
        { id: 'l1', kind: 'missing_path', text: 'Names `server/old_config.py`, which the repository no longer has.' },
        { id: 'l1', kind: 'newer', text: 'A newer one says something close.' },
      ],
    });
    expect(memoryWaiting(data)).toBe(2);
    http.get.mockReturnValue(ok(data));
    mount();
    expect((await screen.findByTestId('memory-waiting')).textContent).toBe('2 waiting for you');
    // Memory is open without a click, the proposal is on top and says who proposed it
    expect(screen.getByTestId('proposals-waiting').textContent).toBe('1 lesson waiting for you');
    expect(screen.getByText(/Proposed by Dev An while it worked/)).toBeTruthy();
    const flags = screen.getAllByTestId('memory-flag');
    expect(flags.map((f) => f.dataset.kind)).toEqual(['missing_path', 'newer']);
  });

  it('opens on Instructions when nothing waits', async () => {
    http.get.mockReturnValue(ok(knowledge()));
    mount();
    expect((await screen.findByRole('tab', { name: /Instructions/ })).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByTestId('memory-waiting')).toBeNull();
  });
});

describe('notes the AIs keep', () => {
  it('groups notes by whose memory they are in, marks a person’s feedback, edits and deletes', async () => {
    http.get.mockReturnValue(
      ok(
        knowledge({
          notes: [
            note({}),
            note({ id: 'mem_2', kind: 'feedback', text: 'An wants comments in Vietnamese.' }),
            note({
              id: 'mem_3',
              scope: 'ticket',
              scopeKey: 'KAN-12',
              scopeLabel: 'KAN-12 · Fix login',
              text: 'Start from the CSV export.',
            }),
          ],
        }),
      ),
    );
    http.patch.mockReturnValue(ok(note({})));
    http.delete.mockReturnValue(ok(null));
    mount();
    fireEvent.click(await screen.findByRole('tab', { name: /Memory/ }));
    const groups = screen.getAllByTestId('notes-group');
    expect(groups).toHaveLength(2);
    expect(groups[0].textContent).toContain('Role notes · Dev');
    expect(groups[0].textContent).toContain('2 of 30');
    expect(groups[1].textContent).toContain('Ticket notes · KAN-12 · Fix login');
    expect(screen.getAllByTestId('note-feedback')).toHaveLength(1);
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    fireEvent.change(screen.getByTestId('note-editor'), { target: { value: 'Use npm test -- --run.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(http.patch).toHaveBeenCalledWith('/ai/notes/mem_1', { text: 'Use npm test -- --run.' }));
    fireEvent.click(screen.getAllByTestId('note-delete')[2]);
    await waitFor(() => expect(http.delete).toHaveBeenCalledWith('/ai/notes/mem_3'));
  });
});

describe('what a run used', () => {
  it('says how many lessons and notes, and when it was not recorded', () => {
    expect(memoryUsedLabel(null)).toMatch(/not recorded/);
    expect(memoryUsedLabel({ lessons: [], notes: [] })).toMatch(/^none/);
    expect(
      memoryUsedLabel({
        lessons: [
          { id: 'a', text: 'x' },
          { id: 'b', text: 'y' },
          { id: 'c', text: 'z' },
        ],
        notes: [{ id: 'm', scope: 'role', text: 'n' }],
        tokens: 120,
      }),
    ).toBe('Used 3 lessons and 1 note, 120 tokens');
  });
});
