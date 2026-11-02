// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));

import { OwnPluginsCard, withTick } from './OwnPluginsCard';

const ok = (data: unknown) => Promise.resolve({ data });
let ops: Record<string, unknown>;

const PLUGINS = [
  { name: 'superpowers', scope: 'user', skills: 14, path: '/p/s', loaded: true, reason: null, roles: null },
  {
    name: 'frontend-design',
    scope: 'user',
    skills: 1,
    path: '/p/f',
    loaded: true,
    reason: null,
    roles: ['designer', 'dev'],
  },
  {
    name: 'pdf-viewer',
    scope: 'project',
    skills: 2,
    path: '/p/x',
    loaded: false,
    reason: 'Installed for another project only, and not switched on.',
    roles: null,
  },
];

beforeEach(() => {
  Object.values(http).forEach((f) => f.mockReset());
  ops = { ownClaude: true, ownClaudeRoles: [{ plugin: 'frontend-design', roles: ['designer', 'dev'] }] };
  http.get.mockImplementation((url: string) => {
    if (url === '/projects/p1/ai/own-plugins') return ok({ on: ops.ownClaude, plugins: PLUGINS });
    if (url === '/projects/p1/ai/ops') return ok(ops);
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  http.patch.mockImplementation((_u: string, body: Record<string, unknown>) => ok({ ...ops, ...body }));
});
afterEach(cleanup);

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <OwnPluginsCard projectId="p1" />
    </QueryClientProvider>,
  );
const box = (plugin: string, role: string) =>
  screen.getByRole('checkbox', { name: `${plugin} for ${role}` }) as HTMLInputElement;

describe('withTick', () => {
  it('narrows a plugin on every role, and drops it from the list once every role is back', () => {
    const one = withTick([], 'sp', ['designer'], false);
    expect(one).toEqual([
      {
        plugin: 'sp',
        roles: [
          'triage',
          'pm',
          'ba',
          'dev',
          'qa',
          'user_tester',
          'reviewer',
          'tech_writer',
          'devops',
          'security',
          'data_analyst',
        ],
      },
    ]);
    expect(withTick(one, 'sp', ['designer'], true)).toEqual([]);
    expect(withTick([{ plugin: 'f', roles: ['dev'] }], 'f', ['qa', 'user_tester'], true)).toEqual([
      { plugin: 'f', roles: ['dev', 'qa', 'user_tester'] },
    ]);
  });
});

describe('OwnPluginsCard', () => {
  it('ticks every role for a plugin not narrowed, only its roles otherwise, none for one not loaded', async () => {
    mount();
    await screen.findByTestId('own-plugins-grid');
    await waitFor(() => expect(box('superpowers', 'PM').disabled).toBe(false));
    for (const r of ['PM', 'BA', 'Designer', 'Dev', 'Tester', 'Reviewer', 'More roles'])
      expect(box('superpowers', r).checked).toBe(true);
    expect(box('frontend-design', 'Designer').checked).toBe(true);
    expect(box('frontend-design', 'Dev').checked).toBe(true);
    expect(box('frontend-design', 'PM').checked).toBe(false);
    const off = screen.getByTestId('own-plugin-pdf-viewer');
    expect(off.textContent).toContain('Installed for another project only, and not switched on. Not loaded.');
    within(off)
      .getAllByRole('checkbox')
      .forEach((c) => {
        expect((c as HTMLInputElement).checked).toBe(false);
        expect((c as HTMLInputElement).disabled).toBe(true);
      });
    expect(screen.getByTestId('own-plugin-superpowers').textContent).toContain('user · 14 skills');
  });

  it('saves a tick as the project narrowing', async () => {
    mount();
    await screen.findByTestId('own-plugins-grid');
    await waitFor(() => expect(box('superpowers', 'Designer').disabled).toBe(false));
    fireEvent.click(box('superpowers', 'Designer'));
    await waitFor(() =>
      expect(http.patch).toHaveBeenCalledWith('/projects/p1/ai/ops', {
        ownClaudeRoles: [
          { plugin: 'frontend-design', roles: ['designer', 'dev'] },
          {
            plugin: 'superpowers',
            roles: [
              'triage',
              'pm',
              'ba',
              'dev',
              'qa',
              'user_tester',
              'reviewer',
              'tech_writer',
              'devops',
              'security',
              'data_analyst',
            ],
          },
        ],
      }),
    );
  });

  it('switches the plugins off for every run', async () => {
    mount();
    const sw = await screen.findByTestId('own-plugins-on');
    await waitFor(() => expect((sw as HTMLButtonElement).disabled).toBe(false));
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    await waitFor(() => expect(http.patch).toHaveBeenCalledWith('/projects/p1/ai/ops', { ownClaude: false }));
  });

  it('says when the Claude Code folder cannot be read', async () => {
    http.get.mockImplementation((url: string) =>
      url.endsWith('/ai/ops') ? ok(ops) : Promise.reject({ response: { data: { detail: 'No folder' } } }),
    );
    mount();
    expect((await screen.findByTestId('own-plugins-error')).textContent).toContain('No folder');
  });
});
