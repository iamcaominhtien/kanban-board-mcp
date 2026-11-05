// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Plugin } from '../../../types/aiPlugins';

const http = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));

import { AddFromSource, NO_REVIEW } from './AddFromSource';
import { InstalledTab } from './InstalledTab';
import { SkillsPluginsSection } from './SkillsPluginsSection';
import { applyFilter, buildRows, effective, followed } from './pluginLogic';

const plugin = (o: Partial<Plugin> = {}): Plugin => ({
  id: 'p1',
  projectId: 'pr',
  name: 'design',
  sourceKind: 'git',
  source: 'github.com/anthropics/skills',
  ref: null,
  plugin: null,
  commit: 'abcdef123456',
  version: '2.4.0',
  description: null,
  skills: ['a', 'b'],
  hooks: [],
  mcp: [],
  sizeBytes: 1000,
  pinned: false,
  defaultOn: false,
  roles: ['designer'],
  members: [],
  hasPrevious: false,
  installedBy: null,
  installedAt: null,
  updatedAt: null,
  used: { uses: 3, byMember: [], last: null },
  ...o,
});

const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {ui}
  </QueryClientProvider>
);

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('effective switch', () => {
  it('own switch wins over everything', () => {
    expect(effective(plugin({ defaultOn: true, members: [{ memberId: 'm1', on: false }] }), 'm1', 'designer')).toEqual({
      on: false,
      why: 'own',
    });
    expect(effective(plugin({ members: [{ memberId: 'm1', on: true }] }), 'm1', null)).toEqual({
      on: true,
      why: 'own',
    });
  });
  it('then the project default, then the role, else off', () => {
    expect(effective(plugin({ defaultOn: true }), 'm1', null)).toEqual({ on: true, why: 'default' });
    expect(effective(plugin(), 'm1', 'designer')).toEqual({ on: true, why: 'role' });
    expect(effective(plugin(), 'm1', 'dev')).toEqual({ on: false, why: 'off' });
    expect(effective(plugin(), 'm1', undefined).on).toBe(false);
  });
  it('reads a member id exactly as the server sent it (a list, never a camel-cased key)', () => {
    expect(effective(plugin({ members: [{ memberId: 'ai1_b2-c3', on: false }] }), 'ai1_b2-c3', 'designer').on).toBe(
      false,
    );
  });
  it('followed ignores own switches', () => {
    expect(followed(plugin({ members: [{ memberId: 'm1', on: false }], defaultOn: true }), null)).toBe(true);
  });
});

describe('filters', () => {
  const rows = buildRows([plugin(), plugin({ id: 'p2', name: 'idle', used: { uses: 0, byMember: [], last: null } })]);
  it('splits by kind and never used', () => {
    expect(rows).toHaveLength(2);
    expect(applyFilter(rows, 'plugins').map((r) => r.name)).toEqual(['design', 'idle']);
    expect(applyFilter(rows, 'never').map((r) => r.name)).toEqual(['idle']);
  });
  it('the filter buttons narrow the installed list', () => {
    render(
      wrap(
        <InstalledTab
          projectId="pr"
          plugins={[plugin(), plugin({ id: 'p2', name: 'idle', used: { uses: 0, byMember: [], last: null } })]}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /^Never used/ }));
    expect(screen.queryByTestId('plugin-design')).toBeNull();
    expect(screen.getByTestId('plugin-idle')).toBeTruthy();
  });
});

describe('install dialog', () => {
  it('previews, warns there is no review step, then installs', async () => {
    http.post.mockImplementation((url: string) =>
      url.endsWith('/preview')
        ? Promise.resolve({
            data: {
              name: 'design',
              version: '2.4.0',
              description: null,
              skills: ['x', 'y'],
              hooks: [],
              mcp: [],
              sizeBytes: 2048,
              commit: 'abcdef1234',
            },
          })
        : Promise.resolve({ data: plugin() }),
    );
    const done = vi.fn();
    render(wrap(<AddFromSource projectId="pr" onInstalled={done} />));
    expect(screen.queryByTestId('install-confirm')).toBeNull();
    fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'https://github.com/a/b' } });
    fireEvent.click(screen.getByLabelText('Designer'));
    fireEvent.click(screen.getByTestId('preview-source'));
    await screen.findByTestId('install-preview');
    expect(screen.getByTestId('install-counts').textContent).toContain('2 skills · 0 hooks · 0 MCP servers');
    expect(screen.getByTestId('no-review').textContent).toBe(NO_REVIEW);
    fireEvent.click(screen.getByTestId('install-confirm'));
    await waitFor(() => expect(done).toHaveBeenCalled());
    const [url, body] = http.post.mock.calls[1];
    expect(url).toBe('/projects/pr/ai/plugins');
    expect(body).toMatchObject({
      sourceKind: 'git',
      source: 'https://github.com/a/b',
      roles: ['designer'],
      defaultOn: false,
    });
  });
  it('lets the person choose a plugin from a marketplace, and shows a 422 message', async () => {
    http.post.mockResolvedValueOnce({ data: { choices: [{ name: 'one', description: 'first' }] } });
    http.post.mockRejectedValueOnce({ isAxiosError: true, response: { data: { detail: 'Nothing found there' } } });
    render(wrap(<AddFromSource projectId="pr" onInstalled={() => {}} />));
    fireEvent.click(screen.getByRole('tab', { name: 'Marketplace' }));
    fireEvent.change(screen.getByLabelText('Marketplace'), { target: { value: 'x/y' } });
    fireEvent.click(screen.getByTestId('preview-source'));
    await screen.findByTestId('plugin-choices');
    fireEvent.click(screen.getByRole('button', { name: 'Preview one' }));
    await screen.findByTestId('source-error');
    expect(http.post.mock.calls[1][1]).toMatchObject({ plugin: 'one' });
    expect(screen.getByTestId('source-error').textContent).toContain('Nothing found there');
  });
});

describe('the page actions', () => {
  it('reloads every plugin from its source and says it takes effect from the next run', async () => {
    http.get.mockImplementation((url: string) =>
      Promise.resolve({ data: url.endsWith('/plugins') ? [plugin(), plugin({ id: 'p2', name: 'idle' })] : [] }),
    );
    http.post.mockResolvedValue({ data: plugin() });
    render(wrap(<SkillsPluginsSection projectId="pr" />));
    await screen.findByTestId('installed-tab');
    expect(screen.getByRole('button', { name: 'Add from a source' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reset all to the catalogue' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reload all' }));
    await screen.findByText(/Reloaded 2 from the source/);
    expect(http.post).toHaveBeenCalledWith('/ai/plugins/p1/reload');
    expect(http.post).toHaveBeenCalledWith('/ai/plugins/p2/reload');
  });
});
