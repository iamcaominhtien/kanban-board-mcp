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
import { MemberPluginsCard, roleOfConfig } from './MemberPluginsCard';

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
    render(wrap(<CatalogueTab projectId="pr" plugins={[]} />));
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
    render(wrap(<CatalogueTab projectId="pr" plugins={[]} />));
    expect(await screen.findByText(/Couldn't load the catalogue: catalogue offline/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(http.get).toHaveBeenCalledTimes(2));
  });

  it('installs a plugin and says so', async () => {
    http.get.mockResolvedValue({ data: catalogue });
    http.post.mockResolvedValue({ data: { plugin: plugin({ name: 'tdd-kit' }) } });
    render(wrap(<CatalogueTab projectId="pr" plugins={[]} />));
    const card = await screen.findByTestId('cat-tdd');
    fireEvent.click(card.querySelector('button') as HTMLButtonElement);
    expect(await screen.findByText('Installed.')).toBeTruthy();
    expect(http.post).toHaveBeenCalledWith('/projects/pr/ai/catalogue/tdd/install', {});
  });

  it('adds an MCP server to members and counts them', async () => {
    http.get.mockResolvedValue({ data: catalogue });
    http.post.mockResolvedValue({ data: { mcpAddedTo: ['m1'] } });
    render(wrap(<CatalogueTab projectId="pr" plugins={[]} />));
    const card = await screen.findByTestId('cat-figma');
    fireEvent.click(card.querySelector('button') as HTMLButtonElement);
    expect(await screen.findByText('Added to 1 member.')).toBeTruthy();
  });

  it('shows plain Installed for an installed plugin, and the error of a failed install', async () => {
    http.get.mockResolvedValue({ data: catalogue });
    http.post.mockRejectedValue({ response: { data: { detail: 'clone failed' } } });
    render(wrap(<CatalogueTab projectId="pr" plugins={[plugin({ name: 'tdd-kit' })]} />));
    const done = await screen.findByTestId('cat-tdd');
    expect(done.textContent).toContain('Installed');
    expect(done.querySelector('button')).toBeNull();
    fireEvent.click(screen.getByTestId('cat-figma').querySelector('button') as HTMLButtonElement);
    expect((await screen.findByRole('alert')).textContent).toBe('clone failed');
  });
});

describe('MemberPluginsCard', () => {
  function setup(
    opts: {
      plugins?: Plugin[] | 'error';
      cfg?: unknown;
      catalogue?: CatalogueEntry[];
      boardSkills?: { skill: string; on?: boolean; membersOn?: string[]; membersOff?: string[] }[];
    } = {},
  ) {
    http.get.mockImplementation((url: string) => {
      if (url === '/ai/board-skills')
        return Promise.resolve({
          data: [
            { name: 'canvas-design', description: 'The design guide.' },
            { name: 'repo-and-machine', description: 'Git and processes.' },
          ],
        });
      if (url === '/projects/pr/ai/ops') return Promise.resolve({ data: { boardSkills: opts.boardSkills ?? [] } });
      if (url.endsWith('/ai/plugins'))
        return opts.plugins === 'error'
          ? Promise.reject({ response: { data: { detail: 'plugins down' } } })
          : Promise.resolve({ data: opts.plugins ?? [] });
      if (url === '/ai/catalogue') return Promise.resolve({ data: opts.catalogue ?? [] });
      if (url.endsWith('/base-prompt'))
        return Promise.resolve({ data: { memberId: 'm1', tokens: 3140, parts: {}, skills: [] } });
      if (url.startsWith('/ai/members/'))
        return Promise.resolve({ data: { id: 'm1', kind: 'ai', config: opts.cfg ?? { role: 'designer' } } });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    http.put.mockResolvedValue({ data: plugin() });
    http.post.mockResolvedValue({ data: {} });
  }
  const renderIt = () => render(wrap(<MemberPluginsCard memberId="m1" projectId="pr" />));

  it("switches one of the board's skills for this member only, and back to the project's default", async () => {
    setup({ boardSkills: [{ skill: 'repo-and-machine', on: false }] });
    http.patch.mockResolvedValue({ data: { boardSkills: [] } });
    renderIt();
    const row = await screen.findByTestId('bs-repo-and-machine');
    expect(row.textContent).toContain('Off for this project.');
    fireEvent.click(within(row).getByRole('switch'));
    await waitFor(() =>
      expect(http.patch).toHaveBeenCalledWith('/projects/pr/ai/ops', {
        boardSkills: [{ skill: 'repo-and-machine', on: false, membersOn: ['m1'], membersOff: [] }],
      }),
    );
  });

  it('reads the role from the config', () => {
    expect(roleOfConfig({ role: 'dev' })).toBe('dev');
    expect(roleOfConfig({ pack: { key: 'qa' } })).toBe('qa');
    expect(roleOfConfig(null)).toBeNull();
  });

  it('loads, then shows the role and an empty hint', async () => {
    setup();
    renderIt();
    expect(screen.getByLabelText('Loading')).toBeTruthy();
    expect(await screen.findByText('No plugin is installed on this project.')).toBeTruthy();
    expect(await screen.findByText('Role: Designer.')).toBeTruthy();
  });

  it('shows the size of the base prompt next to the title', async () => {
    setup();
    renderIt();
    expect((await screen.findByTestId('base-prompt')).textContent).toBe('base prompt 3,140 tokens');
  });

  it('says so when the member has no role pack', async () => {
    setup({ cfg: {} });
    renderIt();
    expect(await screen.findByText('This member has no role pack.')).toBeTruthy();
  });

  it('shows the error with Try again', async () => {
    setup({ plugins: 'error' });
    renderIt();
    expect(await screen.findByText(/Couldn't load the plugins: plugins down/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(http.get.mock.calls.filter((c) => String(c[0]).endsWith('/ai/plugins')).length).toBe(2));
  });

  it('shows the project default note, and switches a plugin for this member', async () => {
    setup({ plugins: [plugin({ used: { uses: 4, byMember: [{ memberId: 'm1', uses: 4 } as never], last: null } })] });
    renderIt();
    const row = await screen.findByTestId('mp-design');
    expect(row.textContent).toContain('Project default is on (suggested for this role).');
    expect(row.textContent).toContain('2 skills');
    expect(row.textContent).toContain('used 4 times by this member');
    const sw = screen.getByRole('switch', { name: 'design' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    await waitFor(() => expect(http.put).toHaveBeenCalledWith('/ai/plugins/p1/members/m1', { on: false }));
  });

  it('shows Switched here and Follow the default for an own switch', async () => {
    setup({ plugins: [plugin({ members: [{ memberId: 'm1', on: false }], defaultOn: true })] });
    renderIt();
    const row = await screen.findByTestId('mp-design');
    expect(row.textContent).toContain('Switched here.');
    fireEvent.click(screen.getByRole('button', { name: 'Follow the default' }));
    await waitFor(() => expect(http.put).toHaveBeenCalledWith('/ai/plugins/p1/members/m1', { on: null }));
  });

  it('shows the error of a failed switch', async () => {
    setup({ plugins: [plugin()] });
    http.put.mockRejectedValue({ response: { data: { detail: 'locked' } } });
    renderIt();
    fireEvent.click(await screen.findByRole('switch', { name: 'design' }));
    expect((await screen.findByRole('alert')).textContent).toBe('locked');
  });

  it('suggests a role plugin that is not installed, and installs it for this member', async () => {
    setup({
      plugins: [],
      catalogue: [
        entry({ key: 'figma', name: 'figma-kit', roles: ['designer'] }),
        entry({ key: 'tdd', roles: ['dev'] }),
      ],
    });
    renderIt();
    expect(await screen.findByText(/Suggested for the Designer role\./)).toBeTruthy();
    expect(screen.queryByText('tdd-kit')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() =>
      expect(http.post).toHaveBeenCalledWith('/projects/pr/ai/catalogue/figma/install', { memberIds: ['m1'] }),
    );
  });

  it('shows the error of a failed install', async () => {
    setup({ plugins: [], catalogue: [entry({ key: 'figma', name: 'figma-kit', roles: ['designer'] })] });
    http.post.mockRejectedValue({ response: { data: { detail: 'no network' } } });
    renderIt();
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }));
    expect((await screen.findByRole('alert')).textContent).toBe('no network');
  });
});

describe('InstalledTab actions', () => {
  const renderIt = (plugins: Plugin[]) => render(wrap(<InstalledTab projectId="pr" plugins={plugins} usage={[]} />));

  it('says nothing is installed, and when a filter matches nothing', () => {
    renderIt([]);
    expect(screen.getByTestId('installed-empty').textContent).toMatch(/Nothing installed yet/);
    cleanup();
    renderIt([plugin()]);
    fireEvent.click(screen.getByRole('button', { name: /^Skills/ }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/ai/plugins/p1/reload'));
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/ai/plugins/p1/reset'));
    fireEvent.click(screen.getByRole('button', { name: 'Pin v2.4.0' }));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/ai/plugins/p1/pin'));
    fireEvent.click(screen.getByRole('button', { name: 'Roll back' }));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/ai/plugins/p1/rollback'));
  });

  it('shows the error of a failed action', async () => {
    http.post.mockRejectedValue({ response: { data: { detail: 'git said no' } } });
    renderIt([plugin()]);
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect((await screen.findByTestId('plugin-error')).textContent).toBe('git said no');
  });

  it('checks for an update: up to date', async () => {
    http.get.mockResolvedValue({ data: { update: false } });
    renderIt([plugin()]);
    fireEvent.click(screen.getByRole('button', { name: 'Check for update' }));
    expect(await screen.findByText('Up to date.')).toBeTruthy();
    expect(http.get).toHaveBeenCalledWith('/ai/plugins/p1/update');
  });

  it('checks for an update: shows the new version, what changed, and updates', async () => {
    http.get.mockImplementation((url: string) =>
      url.endsWith('/update')
        ? Promise.resolve({ data: { update: true, latest: 'v2.5.0' } })
        : Promise.resolve({ data: { commit: '1234567890', added: ['a.md'], removed: ['b.md'], changed: ['c.md'] } }),
    );
    http.post.mockResolvedValue({ data: plugin() });
    renderIt([plugin()]);
    fireEvent.click(screen.getByRole('button', { name: 'Check for update' }));
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
    http.get.mockImplementation((url: string) =>
      url.endsWith('/update')
        ? Promise.resolve({ data: { update: true, latest: 'v3' } })
        : Promise.resolve({ data: { commit: null, added: [], removed: [], changed: [] } }),
    );
    renderIt([plugin()]);
    fireEvent.click(screen.getByRole('button', { name: 'Check for update' }));
    fireEvent.click(await screen.findByRole('button', { name: 'See what changed' }));
    expect(await screen.findByText('No file changed.')).toBeTruthy();
  });

  it('asks before removing, can keep, and removes with DELETE', async () => {
    http.delete.mockResolvedValue({});
    renderIt([plugin()]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText('Remove design?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.queryByText('Remove design?')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByTestId('confirm-remove'));
    await waitFor(() => expect(http.delete).toHaveBeenCalledWith('/ai/plugins/p1'));
  });

  it('opens the detail: switch for every member and role checkboxes', async () => {
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
    expect(detail.textContent).toContain('Used by 2 members.');
    fireEvent.click(screen.getByRole('switch', { name: 'On for every member' }));
    await waitFor(() => expect(http.patch).toHaveBeenCalledWith('/ai/plugins/p1', { defaultOn: true }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Dev' }));
    await waitFor(() => expect(http.patch).toHaveBeenCalledWith('/ai/plugins/p1', { roles: ['designer', 'dev'] }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Designer' }));
    await waitFor(() => expect(http.patch).toHaveBeenCalledWith('/ai/plugins/p1', { roles: [] }));
  });
});
