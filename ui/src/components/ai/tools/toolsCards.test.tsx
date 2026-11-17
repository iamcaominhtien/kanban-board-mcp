// @vitest-environment jsdom
import { ROLES } from './pluginLogic';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogueEntry, Plugin } from '../../../types/aiPlugins';

const http = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));

import { CatalogueTab, isInstalled } from './CatalogueTab';
import { InstalledTab } from './InstalledTab';

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
  description: 'Design helpers',
  skills: ['a', 'b'],
  hooks: [],
  mcp: [],
  sizeBytes: 2048,
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
const entry = (o: Partial<CatalogueEntry> = {}): CatalogueEntry => ({
  key: 'tdd',
  name: 'tdd-kit',
  kind: 'plugin',
  source: 'github.com/x/tdd',
  roles: ['dev', 'qa'],
  what: 'Test-first helpers',
  ...o,
});

const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {ui}
  </QueryClientProvider>
);

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

// The role filter is the design's dropdown chip: open it and pick
const pickRole = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name: 'Role' }));
  fireEvent.click(screen.getByRole('option', { name }));
};

describe('CatalogueTab', () => {
  const catalogue = [
    entry(),
    entry({
      key: 'figma',
      name: 'figma-mcp',
      kind: 'mcp',
      source: undefined,
      roles: ['designer'],
      what: 'Figma access',
    }),
  ];

  it('isInstalled matches by name or by the plugin name inside a marketplace', () => {
    expect(isInstalled(entry(), [plugin({ name: 'tdd-kit' })])).toBe(true);
    expect(isInstalled(entry({ plugin: 'inner' }), [plugin({ name: 'inner' })])).toBe(true);
    expect(isInstalled(entry(), [plugin()])).toBe(false);
  });

  it('shows a skeleton, then entries; filters by role; shows empty state', async () => {
    http.get.mockResolvedValue({ data: catalogue });
    render(wrap(<CatalogueTab plugins={[]} />));
    expect(screen.getByLabelText('Loading')).toBeTruthy();
    expect(await screen.findByTestId('cat-tdd')).toBeTruthy();
    expect(screen.getByText('MCP server')).toBeTruthy();
    expect(screen.getByText(/Suggested for Dev, QA · github.com\/x\/tdd/)).toBeTruthy();
    pickRole(ROLES.designer);
    expect(screen.queryByTestId('cat-tdd')).toBeNull();
    expect(screen.getByTestId('cat-figma')).toBeTruthy();
    pickRole(ROLES.triage);
    expect(screen.getByText('Nothing is suggested for this role.')).toBeTruthy();
  });

  it('shows an error with Try again', async () => {
    http.get.mockRejectedValue({ response: { data: { detail: 'catalogue offline' } } });
    render(wrap(<CatalogueTab plugins={[]} />));
    expect(await screen.findByText(/Couldn't load the catalogue: catalogue offline/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(http.get).toHaveBeenCalledTimes(2));
  });

  it('shows plain Installed for an installed plugin and nothing to press', async () => {
    http.get.mockResolvedValue({ data: catalogue });
    render(wrap(<CatalogueTab plugins={[plugin({ name: 'tdd-kit' })]} />));
    const done = await screen.findByTestId('cat-tdd');
    expect(done.textContent).toContain('Installed');
    expect(done.querySelector('button')).toBeNull();
  });
});

describe('InstalledTab actions', () => {
  const renderIt = (plugins: Plugin[]) => render(wrap(<InstalledTab projectId="pr" plugins={plugins} />));
  // each GET gets data of its own shape: the tab also shows the board's skills, which read the teams and settings
  const wireGet = (plugins: Record<string, unknown> = {}) =>
    http.get.mockImplementation((url: string) => {
      if (url in plugins) return Promise.resolve({ data: plugins[url] });
      if (url === '/ai/board-skills') return Promise.resolve({ data: [] });
      if (url === '/projects/pr/ai/teams') return Promise.resolve({ data: [] });
      if (url === '/projects/pr/ai/settings') return Promise.resolve({ data: { ops: { boardSkills: [] } } });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
  beforeEach(() => {
    wireGet();
  });
  // the actions of a plugin from git or a marketplace are in its "⋯" menu
  const fromMenu = async (item: string) => {
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'More actions for design' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'More actions for design' }));
    fireEvent.click(screen.getByRole('menuitem', { name: item }));
  };

  it('says nothing is installed, and when a filter matches nothing', () => {
    renderIt([]);
    expect(screen.getByTestId('installed-empty').textContent).toMatch(/Nothing installed yet/);
    cleanup();
    renderIt([plugin()]);
    fireEvent.click(screen.getByRole('button', { name: /^Never used/ }));
    expect(screen.getByTestId('installed-empty').textContent).toBe('Nothing matches this filter.');
  });

  it('describes the plugin: source, version, pin, usage and defaults', () => {
    renderIt([plugin({ pinned: true, roles: ['designer', 'dev'], updatedAt: '2026-01-01T10:00:00' })]);
    expect(screen.getByText(/Git URL · 2 skills · Design helpers/)).toBeTruthy();
    expect(screen.getByTestId('version').textContent).toBe('v2.4.0 · abcdef12 · pinned');
    expect(screen.getByTestId('used').textContent).toBe('used 3 times');
    expect(screen.getByText(/On by default: Designer, Dev/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unpin' })).toBeTruthy();
  });

  it('reloads, resets, pins and rolls back through the action endpoint', async () => {
    http.post.mockResolvedValue({ data: plugin() });
    renderIt([plugin({ hasPrevious: true })]);
    await fromMenu('Reload');
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/ai/plugins/p1/reload'));
    await fromMenu('Reset');
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/ai/plugins/p1/reset'));
    await fromMenu('Pin v2.4.0');
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/ai/plugins/p1/pin'));
    await fromMenu('Roll back');
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/ai/plugins/p1/rollback'));
    expect(screen.queryByRole('menu')).toBeNull(); // a pick closes the menu
  });

  it('keeps Reload and Check for update as buttons for a plugin imported from a folder', async () => {
    http.post.mockResolvedValue({ data: plugin() });
    wireGet({ '/ai/plugins/p1/update': { update: false } });
    renderIt([plugin({ sourceKind: 'folder' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/ai/plugins/p1/reload'));
    fireEvent.click(screen.getByRole('button', { name: 'Check for update' }));
    expect(await screen.findByText('Up to date.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'More actions for design' }));
    expect(screen.queryByRole('menuitem', { name: 'Reload' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Check for update' })).toBeNull();
  });

  it('shows the error of a failed action', async () => {
    http.post.mockRejectedValue({ response: { data: { detail: 'git said no' } } });
    renderIt([plugin()]);
    await fromMenu('Reload');
    expect((await screen.findByTestId('plugin-error')).textContent).toBe('git said no');
  });

  it('checks for an update: up to date', async () => {
    wireGet({ '/ai/plugins/p1/update': { update: false } });
    renderIt([plugin()]);
    await fromMenu('Check for update');
    expect(await screen.findByText('Up to date.')).toBeTruthy();
    expect(http.get).toHaveBeenCalledWith('/ai/plugins/p1/update');
  });

  it('checks for an update: shows the new version, what changed, and updates', async () => {
    wireGet({
      '/ai/plugins/p1/update': { update: true, latest: 'v2.5.0' },
      '/ai/plugins/p1/changes': { commit: '1234567890', added: ['a.md'], removed: ['b.md'], changed: ['c.md'] },
    });
    http.post.mockResolvedValue({ data: plugin() });
    renderIt([plugin()]);
    await fromMenu('Check for update');
    fireEvent.click(await screen.findByRole('button', { name: 'See what changed' }));
    const box = await screen.findByTestId('plugin-changes');
    expect(box.textContent).toContain('Changes in 12345678');
    expect(box.textContent).toContain('+ a.md');
    expect(box.textContent).toContain('− b.md');
    expect(box.textContent).toContain('~ c.md');
    expect(screen.getByTestId('version').textContent).toContain('→ v2.5.0');
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/ai/plugins/p1/update'));
    await waitFor(() => expect(screen.queryByTestId('plugin-changes')).toBeNull());
  });

  it('says no file changed for an empty change list', async () => {
    wireGet({
      '/ai/plugins/p1/update': { update: true, latest: 'v3' },
      '/ai/plugins/p1/changes': { commit: null, added: [], removed: [], changed: [] },
    });
    renderIt([plugin()]);
    await fromMenu('Check for update');
    fireEvent.click(await screen.findByRole('button', { name: 'See what changed' }));
    expect(await screen.findByText('No file changed.')).toBeTruthy();
  });

  it('asks before removing, can keep, and removes with DELETE', async () => {
    http.delete.mockResolvedValue({});
    renderIt([plugin()]);
    await fromMenu('Remove');
    expect(screen.getByText('Remove design?')).toBeTruthy();
    expect(http.delete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.queryByText('Remove design?')).toBeNull();
    await fromMenu('Remove');
    fireEvent.click(screen.getByTestId('confirm-remove'));
    await waitFor(() => expect(http.delete).toHaveBeenCalledWith('/ai/plugins/p1'));
  });

  it('opens the detail: switch for every team and the suggested roles', async () => {
    http.patch.mockResolvedValue({ data: plugin() });
    renderIt([
      plugin({
        used: {
          uses: 2,
          byMember: [
            { memberId: 'a', uses: 1 },
            { memberId: 'b', uses: 1 },
          ] as never,
          last: null,
        },
      }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const detail = screen.getByTestId('plugin-detail');
    expect(detail.textContent).toContain('2 skills: a, b');
    expect(detail.textContent).toContain('0 hooks');
    expect(detail.textContent).toContain('Used by 2 teams.');
    fireEvent.click(screen.getByRole('switch', { name: 'On for every team' }));
    await waitFor(() => expect(http.patch).toHaveBeenCalledWith('/ai/plugins/p1', { defaultOn: true }));
    const dev = within(detail).getByRole('button', { name: 'Dev' });
    expect(dev.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(dev);
    await waitFor(() => expect(http.patch).toHaveBeenCalledWith('/ai/plugins/p1', { roles: ['designer', 'dev'] }));
    const designer = within(detail).getByRole('button', { name: 'Designer' });
    expect(designer.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(designer);
    await waitFor(() => expect(http.patch).toHaveBeenCalledWith('/ai/plugins/p1', { roles: [] }));
  });
});
