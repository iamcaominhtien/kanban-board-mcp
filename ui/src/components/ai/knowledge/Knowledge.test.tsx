// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Knowledge, Lesson } from '../../../types/aiKnowledge';

const http = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));

/** The calls the screen makes, in the shape the tests read. */
const ok = (data: unknown) => Promise.resolve({ data });
const api = {
  get: {
    mockResolvedValue: (d: unknown) => http.get.mockReturnValue(ok(d)),
    mockRejectedValue: (e: unknown) => http.get.mockRejectedValue(e),
  },
  saveInstructions: {
    mockResolvedValue: (d: unknown) => http.put.mockReturnValue(ok(d)),
    calls: () => http.put.mock.calls,
  },
  addLesson: {
    mockRejectedValueOnce: (e: unknown) => http.post.mockRejectedValueOnce(e),
    mockResolvedValueOnce: (d: unknown) => http.post.mockReturnValueOnce(ok(d)),
  },
  patchLesson: {
    mockResolvedValue: (d: unknown) => http.patch.mockReturnValue(ok(d)),
    mockRejectedValue: (e: unknown) => http.patch.mockRejectedValue(e),
  },
  deleteLesson: { mockResolvedValue: (_: unknown) => http.delete.mockReturnValue(ok(null)) },
};

import { KnowledgeSection } from './KnowledgeSection';
import { TokenMeter } from './TokenMeter';

const lesson = (o: Partial<Lesson>): Lesson => ({
  id: 'l1',
  text: 'Start the dev server in the background.',
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
const knowledge = (o: Partial<Knowledge> = {}): Knowledge => ({
  projectId: 'p1',
  instructions: '# Conventions',
  instructionsTokens: 2180,
  updatedAt: '2026-10-30T10:00:00Z',
  updatedBy: 'Tien',
  history: [{ at: '2026-10-20T10:00:00Z', by: 'Tien', text: 'old text' }],
  lessons: [],
  lessonsTokens: 310,
  lessonCap: 2000,
  totalTokens: 2490,
  budget: 8000,
  unused: [],
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

beforeEach(() => {
  Object.values(http).forEach((f) => f.mockReset());
});
afterEach(cleanup);

describe('TokenMeter', () => {
  it('says the total and the share of the budget', () => {
    render(<TokenMeter total={2490} budget={8000} />);
    expect(screen.getByText('2,490 tokens in every prompt')).toBeTruthy();
    expect(screen.getByTestId('token-meter-share').textContent).toBe('31% of 8k');
  });
  it('caps the bar at full when over budget', () => {
    render(<TokenMeter total={9000} budget={8000} />);
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('100');
    expect(screen.getByTestId('token-meter-share').textContent).toBe('113% of 8k');
  });
});

describe('proposal actions', () => {
  const proposal = lesson({ id: 'p9', state: 'proposed', text: 'Quote CSV commas.', sourceTicketId: 'KAN-211' });
  beforeEach(() => {
    api.get.mockResolvedValue(knowledge({ lessons: [proposal] }));
    api.patchLesson.mockResolvedValue(proposal);
  });

  it('keeps, drops and edits-and-keeps with the right patch', async () => {
    mount();
    fireEvent.click(await screen.findByRole('tab', { name: /Memory/ }));
    expect(screen.getByText(/Proposed by a light model reading the run/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('proposal-keep'));
    await waitFor(() => expect(http.patch).toHaveBeenCalledWith('/ai/lessons/p9', { state: 'kept' }));
    fireEvent.click(screen.getByTestId('proposal-no'));
    await waitFor(() => expect(http.patch).toHaveBeenCalledWith('/ai/lessons/p9', { state: 'dropped' }));
    fireEvent.click(screen.getByTestId('proposal-edit'));
    fireEvent.change(screen.getByTestId('lesson-editor'), { target: { value: 'Quote commas in CSV.' } });
    fireEvent.click(screen.getByTestId('lesson-editor-save'));
    await waitFor(() =>
      expect(http.patch).toHaveBeenCalledWith('/ai/lessons/p9', { text: 'Quote commas in CSV.', state: 'kept' }),
    );
  });

  it('shows the server error inline', async () => {
    api.patchLesson.mockRejectedValue({ response: { data: { detail: 'No such lesson.' } } });
    mount();
    fireEvent.click(await screen.findByRole('tab', { name: /Memory/ }));
    fireEvent.click(screen.getByTestId('proposal-keep'));
    expect((await screen.findByRole('alert')).textContent).toBe('No such lesson.');
  });
});

describe('lesson editor', () => {
  it('adds a lesson, and reports a duplicate', async () => {
    api.get.mockResolvedValue(knowledge({ lessons: [lesson({})], unused: ['l1'] }));
    api.addLesson.mockRejectedValueOnce({ response: { data: { detail: 'This lesson is already there.' } } });
    api.addLesson.mockResolvedValueOnce(lesson({ id: 'n' }));
    mount();
    fireEvent.click(await screen.findByRole('tab', { name: /Memory/ }));
    expect(screen.getByTestId('lesson-unused')).toBeTruthy();
    fireEvent.click(screen.getByTestId('lesson-add'));
    fireEvent.change(screen.getByTestId('lesson-editor'), { target: { value: 'Use uv.' } });
    fireEvent.click(screen.getByTestId('lesson-editor-save'));
    expect((await screen.findByRole('alert')).textContent).toBe('This lesson is already there.');
    fireEvent.click(screen.getByTestId('lesson-editor-save'));
    await waitFor(() => expect(http.post).toHaveBeenCalledTimes(2));
    expect(http.post).toHaveBeenLastCalledWith('/projects/p1/ai/lessons', { text: 'Use uv.' });
  });

  it('edits and deletes a kept lesson', async () => {
    api.get.mockResolvedValue(knowledge({ lessons: [lesson({})] }));
    api.patchLesson.mockResolvedValue(lesson({}));
    api.deleteLesson.mockResolvedValue(undefined);
    mount();
    fireEvent.click(await screen.findByRole('tab', { name: /Memory/ }));
    expect(screen.getByText(/used in 4 runs since/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByTestId('lesson-editor'), { target: { value: 'New words.' } });
    fireEvent.click(screen.getByTestId('lesson-editor-save'));
    await waitFor(() => expect(http.patch).toHaveBeenCalledWith('/ai/lessons/l1', { text: 'New words.' }));
    fireEvent.click(screen.getByTestId('lesson-delete'));
    await waitFor(() => expect(http.delete).toHaveBeenCalledWith('/ai/lessons/l1'));
  });
});

describe('instructions', () => {
  it('saves the edited text and lists history', async () => {
    api.get.mockResolvedValue(knowledge());
    api.saveInstructions.mockResolvedValue(knowledge({ instructions: 'new' }));
    mount();
    expect((await screen.findByTestId('instructions-text')).textContent).toBe('# Conventions');
    fireEvent.click(screen.getByTestId('instructions-history'));
    fireEvent.click(screen.getByText(/Tien$/, { selector: 'button' }));
    expect(screen.getByTestId('instructions-version').textContent).toBe('old text');
    fireEvent.click(screen.getByTestId('instructions-edit'));
    fireEvent.change(screen.getByTestId('instructions-editor'), { target: { value: 'new' } });
    fireEvent.click(screen.getByTestId('instructions-save'));
    await waitFor(() =>
      expect(http.put).toHaveBeenCalledWith('/projects/p1/ai/knowledge/instructions', { instructions: 'new' }),
    );
  });

  it('shows an error state with retry', async () => {
    api.get.mockRejectedValue(new Error('boom'));
    mount();
    expect(await screen.findByText(/boom|Could not|retry/i)).toBeTruthy();
  });
});
