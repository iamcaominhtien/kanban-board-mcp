// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const c = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: c }));

import type { DatabaseInfo, MoveJob } from '../../../api/database';
import { DatabaseCard } from './DatabaseCard';
import { job, okReport, postgresDb, sqliteDb } from './testData';

function setup(db: DatabaseInfo, move: MoveJob | null = null) {
  c.get.mockImplementation(async (url: string) => {
    if (url === '/database/move') return { data: move };
    if (url === '/database') return { data: db };
    return { data: null };
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DatabaseCard db={db} />
    </QueryClientProvider>,
  );
}

describe('DatabaseCard', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('on SQLite: a local file, Move to another database… and Why only these?', async () => {
    setup(sqliteDb());
    expect(screen.getByTestId('db-title').textContent).toBe('SQLite · local file');
    expect(screen.getByTestId('db-chip').textContent).toContain('Local file');
    expect(screen.getByText('/Users/minh/kanban-data/kanban.db')).toBeTruthy();
    const facts = screen.getByTestId('db-facts').textContent ?? '';
    expect(facts).toContain('48 MB');
    expect(facts).toContain('87 tables');
    expect(facts).toContain('1,204 tickets in 3 projects');
    expect(screen.getByTestId('db-move').className).toMatch(/btnPrimary/);
    expect(screen.queryByText('Edit connection…')).toBeNull();
    expect(screen.queryByTestId('why-only-these')).toBeNull();
    fireEvent.click(screen.getByText('Why only these?'));
    expect(screen.getByTestId('why-only-these').textContent).toContain('Redis and MongoDB are not offered');
  });

  it('on PostgreSQL: connected, SSL, Edit connection, Test connection with findings, the SQLite file again', async () => {
    setup(postgresDb({ otherApps: 1 }));
    expect(screen.getByTestId('db-title').textContent).toBe('PostgreSQL 16.2 · db.internal');
    expect(screen.getByText('kanban@db.internal:5432/kanban · SSL on')).toBeTruthy();
    expect(screen.getByTestId('db-chip').textContent).toContain('Connected');
    expect(screen.getByTestId('db-facts').textContent).toContain('Connected · 12 ms · 87 tables');
    expect(screen.getByTestId('db-facts').textContent).toContain('password in your system keychain');
    expect(screen.getByText('Edit connection…')).toBeTruthy();
    expect(screen.getByTestId('db-other-apps').textContent).toContain('Another app is connected');

    c.post.mockResolvedValueOnce({ data: okReport() });
    fireEvent.click(screen.getByText('Test connection'));
    await screen.findByTestId('test-findings');
    expect(c.post).toHaveBeenCalledWith(
      '/database/test',
      expect.objectContaining({ engine: 'postgresql', host: 'db.internal', keepPassword: true }),
    );
    expect(screen.getByTestId('finding-reach').textContent).toContain('Reached the server');

    fireEvent.click(screen.getByText('Use the SQLite file again'));
    const confirm = screen.getByRole('alertdialog', { name: 'Use the SQLite file again' });
    expect(confirm.textContent).toContain('Anything done since is only in PostgreSQL');
    expect(c.post).toHaveBeenCalledTimes(1); // nothing happens before the confirmation
    c.post.mockResolvedValueOnce({ data: sqliteDb() });
    fireEvent.click(screen.getByText('Use the SQLite file'));
    await waitFor(() => expect(c.post).toHaveBeenLastCalledWith('/database/use-sqlite'));
  });

  it('locked by KANBAN_DATABASE_URL: read-only, Test connection only', async () => {
    setup(postgresDb({ locked: true, source: 'environment' }));
    expect(screen.getByTestId('db-chip').textContent).toContain('Locked');
    expect(screen.getByTestId('db-title').textContent).toBe('PostgreSQL · set by the environment');
    expect(screen.getByTestId('db-locked').textContent).toContain('cannot be changed from here');
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeTruthy();
    expect(screen.queryByText('Edit connection…')).toBeNull();
    expect(screen.queryByTestId('db-move')).toBeNull();
    expect(screen.queryByText('Use the SQLite file again')).toBeNull();
  });

  it('cannot connect: the chip says so', () => {
    setup(postgresDb({ reachable: false }));
    expect(screen.getByTestId('db-chip').textContent).toContain('Cannot connect');
  });

  it('a paused copy shows a strip that reopens the wizard', async () => {
    setup(sqliteDb(), job({ state: 'paused', resumeAt: 'ticket', current: 'ticket' }));
    const strip = await screen.findByTestId('db-move-strip');
    expect(strip.textContent).toContain('A copy to PostgreSQL is paused');
    fireEvent.click(screen.getByText('Open'));
    expect(await screen.findByTestId('move-paused')).toBeTruthy();
  });
});
