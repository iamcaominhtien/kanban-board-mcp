// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const c = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: c }));

import { moveKey, type DatabaseInfo, type MoveJob } from '../../../api/database';
import { MoveDatabaseDialog, stageOf } from './MoveDatabaseDialog';
import { splitStatements } from './MoveStopped';
import { job, okReport, sqliteDb, stoppedJob } from './testData';

let qc: QueryClient;

function setup(db: DatabaseInfo, move: MoveJob | null = null) {
  let current = move;
  c.get.mockImplementation(async (url: string) => {
    if (url === '/database/move') return { data: current };
    if (url === '/database/command')
      return {
        data: { dryRun: 'kanban-db migrate --dry-run', run: 'kanban-db migrate', passwordEnv: 'KANBAN_DB_PASSWORD' },
      };
    return { data: db };
  });
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <MoveDatabaseDialog db={{ ...db, move }} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose, setMove: (j: MoveJob | null) => (current = j) };
}

describe('MoveDatabaseDialog', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('step 1: the current engine cannot be chosen; Next waits for an engine, then for a test with no red line', async () => {
    setup(sqliteDb());
    expect((screen.getByTestId('engine-sqlite') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('engine-sqlite').textContent).toContain('Current');
    const next = () => screen.getByTestId('move-next') as HTMLButtonElement;
    expect(next().disabled).toBe(true);
    fireEvent.click(screen.getByTestId('engine-postgresql'));
    expect(next().disabled).toBe(false);
    fireEvent.click(next());

    // the form, with the engine's port
    expect(screen.getByTestId('connection-form')).toBeTruthy();
    expect((screen.getByLabelText('Port') as HTMLInputElement).value).toBe('5432');
    expect(screen.getByText("Encrypted with this app's key, which lives in your system keychain.")).toBeTruthy();
    expect(next().disabled).toBe(true);

    // a red line keeps Next off, and its fix can be copied
    c.post.mockResolvedValueOnce({
      data: okReport({
        ok: false,
        findings: [
          {
            key: 'create',
            level: 'error',
            title: 'Cannot create tables · kanban has no CREATE privilege',
            detail: '',
            fix: 'GRANT CREATE ON kanban.* TO kanban;',
            fixLabel: 'Copy the statement',
          },
        ],
      }),
    });
    fireEvent.click(screen.getByTestId('move-test'));
    await screen.findByText('Cannot create tables');
    expect(screen.getByText('GRANT CREATE ON kanban.* TO kanban;')).toBeTruthy();
    expect(screen.getByText('Copy the statement')).toBeTruthy();
    expect(screen.getByText('Next is off until every line is green or amber.')).toBeTruthy();
    expect(next().disabled).toBe(true);

    // a passing test turns Next on; Next checks the target and shows step 2
    c.post.mockResolvedValueOnce({ data: okReport() });
    fireEvent.click(screen.getByTestId('move-test'));
    await screen.findByText('Reached the server');
    await waitFor(() => expect(next().disabled).toBe(false));
    c.post.mockResolvedValueOnce({ data: job() });
    fireEvent.click(next());
    await screen.findByTestId('move-step-check');
    expect(c.post).toHaveBeenLastCalledWith(
      '/database/move/check',
      expect.objectContaining({ engine: 'postgresql', host: '127.0.0.1', port: 5432, name: 'kanban' }),
    );
    expect(screen.getByText('From: SQLite')).toBeTruthy();
    expect(screen.getByText('To: PostgreSQL 16.2')).toBeTruthy();
    expect(screen.getByText('Docs search is rebuilt')).toBeTruthy();
  });

  it('editing the form after a test turns Next off again', async () => {
    setup(sqliteDb());
    fireEvent.click(screen.getByTestId('engine-mysql'));
    fireEvent.click(screen.getByTestId('move-next'));
    expect((screen.getByLabelText('Port') as HTMLInputElement).value).toBe('3306');
    c.post.mockResolvedValueOnce({ data: okReport() });
    fireEvent.click(screen.getByTestId('move-test'));
    await waitFor(() => expect((screen.getByTestId('move-next') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'other.host' } });
    expect((screen.getByTestId('move-next') as HTMLButtonElement).disabled).toBe(true);
  });

  it('step 2: a database that is not empty asks to type its name before emptying it', async () => {
    setup(sqliteDb(), null);
    fireEvent.click(screen.getByTestId('engine-postgresql'));
    fireEvent.click(screen.getByTestId('move-next'));
    c.post.mockResolvedValueOnce({ data: okReport() });
    fireEvent.click(screen.getByTestId('move-test'));
    await waitFor(() => expect((screen.getByTestId('move-next') as HTMLButtonElement).disabled).toBe(false));
    c.post.mockResolvedValueOnce({ data: job({ report: okReport({ state: 'board', tables: 14, tickets: 2310 }) }) });
    fireEvent.click(screen.getByTestId('move-next'));
    const box = await screen.findByTestId('move-not-empty');
    expect(box.textContent).toContain('kanban on db.internal already has 14 tables');
    expect((screen.getByTestId('move-start') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Empty it first…'));
    const go = screen.getByTestId('move-empty-first') as HTMLButtonElement;
    fireEvent.change(screen.getByTestId('move-confirm-input'), { target: { value: 'kan' } });
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('move-confirm-input'), { target: { value: 'kanban' } });
    expect(go.disabled).toBe(false);
    c.post.mockResolvedValueOnce({ data: job({ state: 'copying' }) });
    fireEvent.click(go);
    await waitFor(() =>
      expect(c.post).toHaveBeenLastCalledWith('/database/move/start', {
        mode: 'copy',
        emptyFirst: true,
        confirm: 'kanban',
      }),
    );
  });

  it('a stopped copy: what the board knows, then the AI is asked, proposes, and the board applies', async () => {
    const { setMove } = setup(sqliteDb(), stoppedJob());
    await screen.findByTestId('move-stopped');
    expect(screen.getByText('The copy stopped at table idea_ticket')).toBeTruthy();
    const facts = screen.getByTestId('move-stop-facts').textContent ?? '';
    expect(facts).toContain("Data too long for column 'body' at row 213");
    expect(facts).toContain('idea_ticket.body');
    expect(facts).toContain('6,412 characters');
    expect(facts).toContain('MariaDB 10.11');
    expect(screen.getByTestId('move-ai-chip').textContent).toBe('Not run yet');

    const asking = stoppedJob({ ai: { state: 'asking', question: null } });
    setMove(asking);
    c.post.mockResolvedValueOnce({ data: asking });
    fireEvent.click(screen.getByTestId('move-ask'));
    await screen.findByText(/Asking the AI/);
    expect(c.post).toHaveBeenLastCalledWith('/database/move/ask', {});

    const answered = stoppedJob({
      ai: {
        state: 'answered',
        proposal: {
          cause: 'Plain text fields become VARCHAR(255) on MariaDB.',
          statements: ['ALTER TABLE idea_ticket MODIFY body LONGTEXT'],
          affects: 'This column only.',
          otherColumns: ['ticket.description'],
          confidence: 'high',
          answer: '',
          applicable: true,
          refused: null,
          member: 'Ada',
          elapsedS: 9.4,
          cost: null,
          shown: { table: 'idea_ticket' },
        },
      },
    });
    act(() => {
      qc.setQueryData(moveKey, answered);
    });
    await screen.findByText('Plain text fields become VARCHAR(255) on MariaDB.');
    expect(screen.getByTestId('move-ai-script').textContent).toContain('ALTER TABLE idea_ticket MODIFY body LONGTEXT;');
    expect(screen.getByTestId('move-ai-member').textContent).toContain('Answered by Ada in 9 s');
    expect(screen.getByText('ticket.description')).toBeTruthy();
    expect(screen.getByText('The AI proposes; the board applies.')).toBeTruthy();

    c.post.mockResolvedValueOnce({ data: stoppedJob({ state: 'copying', stop: null }) });
    fireEvent.click(screen.getByTestId('move-apply'));
    await waitFor(() =>
      expect(c.post).toHaveBeenLastCalledWith('/database/move/apply', {
        statements: ['ALTER TABLE idea_ticket MODIFY body LONGTEXT'],
      }),
    );
  });

  it('a refused proposal cannot be applied as is, but can be edited', async () => {
    const refused = stoppedJob({
      ai: {
        state: 'answered',
        proposal: {
          cause: 'x',
          statements: ['DROP TABLE idea_ticket'],
          affects: '',
          otherColumns: [],
          confidence: 'low',
          answer: '',
          applicable: false,
          refused: 'Only ALTER TABLE on the target is allowed.',
          member: 'Ada',
          elapsedS: 3,
          cost: null,
          shown: {},
        },
      },
    });
    setup(sqliteDb(), refused);
    await screen.findByTestId('move-ai-refused');
    expect(screen.getByText(/Only ALTER TABLE on the target is allowed/)).toBeTruthy();
    expect((screen.getByTestId('move-apply') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('Edit it myself'));
    fireEvent.change(screen.getByTestId('move-edit-statements'), {
      target: { value: 'ALTER TABLE idea_ticket\n  MODIFY body LONGTEXT;\n-- a comment' },
    });
    c.post.mockResolvedValueOnce({ data: stoppedJob({ state: 'copying', stop: null }) });
    fireEvent.click(screen.getByTestId('move-apply-edited'));
    await waitFor(() =>
      expect(c.post).toHaveBeenLastCalledWith('/database/move/apply', {
        statements: ['ALTER TABLE idea_ticket\n  MODIFY body LONGTEXT'],
      }),
    );
  });

  it('when no AI member can answer, the message shows', async () => {
    setup(sqliteDb(), stoppedJob({ ai: { state: 'failed', message: 'No AI member is set up on this board.' } }));
    expect((await screen.findByTestId('move-ai-failed')).textContent).toContain('No AI member is set up');
  });

  it('step 4: counts per table and the checks, then Switch', async () => {
    const verified = job({
      state: 'verified',
      mode: 'copy',
      elapsedS: 221,
      verify: {
        ok: true,
        checks: [{ key: 'counts', ok: true, title: 'Row counts · equal in all 8 tables' }],
        tables: Array.from({ length: 8 }, (_, i) => ({ name: `t${i}`, source: i, target: i, same: true })),
        rows: 28,
        differ: [],
        elapsedS: 3,
      },
    });
    setup(sqliteDb(), verified);
    expect((await screen.findByTestId('move-verified')).textContent).toContain('8 tables · 28 rows · 3 min 41 s');
    expect(screen.getByTestId('move-verify-table').textContent).toContain('… 2 more tables');
    expect(screen.getByText('Row counts')).toBeTruthy();
    c.post.mockResolvedValueOnce({ data: { move: { ...verified, state: 'switched' }, database: sqliteDb() } });
    fireEvent.click(screen.getByTestId('move-switch'));
    expect((await screen.findByTestId('move-switched')).textContent).toContain('The board now uses PostgreSQL');
  });
});

describe('move helpers', () => {
  it('stageOf follows the move on the server', () => {
    expect(stageOf(null, false)).toBe('where');
    expect(stageOf(job(), false)).toBe('check');
    expect(stageOf(job(), true)).toBe('where');
    expect(stageOf(job({ state: 'copying' }), false)).toBe('copy');
    expect(stageOf(job({ state: 'stopped' }), false)).toBe('copy');
    expect(stageOf(job({ state: 'verified' }), false)).toBe('verify');
    expect(stageOf(job({ state: 'switched' }), false)).toBe('done');
  });

  it('splitStatements splits on semicolons, or lines when there are none, and drops comments', () => {
    expect(splitStatements('-- 1 column\nALTER TABLE a MODIFY b TEXT;\nALTER TABLE c MODIFY d TEXT;')).toEqual([
      'ALTER TABLE a MODIFY b TEXT',
      'ALTER TABLE c MODIFY d TEXT',
    ]);
    expect(splitStatements('ALTER TABLE a MODIFY b TEXT\nALTER TABLE c MODIFY d TEXT')).toEqual([
      'ALTER TABLE a MODIFY b TEXT',
      'ALTER TABLE c MODIFY d TEXT',
    ]);
  });
});
