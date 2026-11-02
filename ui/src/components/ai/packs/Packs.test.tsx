// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pack, Scan } from '../../../types/aiPacks';

const http = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));

import { TeamSection } from './TeamSection';

const ok = (data: unknown) => Promise.resolve({ data });
const pack = (o: Partial<Pack>): Pack => ({
  id: 'builtin:dev',
  key: 'dev',
  name: 'Dev (TDD)',
  glyph: 'DV',
  tagline: 'A failing test before the fix',
  model: 'sonnet',
  retryModel: 'opus',
  effort: 'medium',
  template: 'developer',
  ceiling: 'review',
  writes: 'worktree',
  handsIn: 'A red run, then a green one',
  allow: ['Bash(npm test:*)'],
  plugins: ['tdd'],
  mcp: [],
  limits: { maxParallel: 1, maxRunsPerDay: 10 },
  persona: 'Writes the failing test first.',
  version: 1,
  builtin: true,
  ...o,
});
const PACKS = [
  pack({
    id: 'builtin:triage',
    key: 'triage',
    name: 'Triage',
    glyph: 'TR',
    model: 'haiku',
    retryModel: null,
    writes: 'ticket',
    ceiling: 'none',
    allow: [],
    plugins: [],
  }),
  pack({ id: 'builtin:pm', key: 'pm', name: 'PM', glyph: 'PM' }),
  pack({ id: 'builtin:ba', key: 'ba', name: 'BA', glyph: 'BA' }),
  pack({ id: 'builtin:designer', key: 'designer', name: 'Designer', glyph: 'DS', mcp: ['figma'] }),
  pack({}),
  pack({
    id: 'builtin:reviewer',
    key: 'reviewer',
    name: 'Reviewer',
    glyph: 'RV',
    retryModel: null,
    depthModels: { light: 'haiku', standard: 'sonnet', deep: 'opus' },
  }),
  pack({ id: 'builtin:qa', key: 'qa', name: 'QA', glyph: 'QA' }),
  pack({
    id: 'builtin:user_tester',
    key: 'user_tester',
    name: 'User tester',
    glyph: 'UT',
    mcp: ['playwright'],
    personas: ['in a hurry', 'on a phone'],
  }),
];

const scan = (o: Partial<Scan> = {}): Scan => ({
  id: 's1',
  projectId: 'p1',
  folder: '/repo',
  found: {
    languages: ['TypeScript'],
    frameworks: ['Next.js'],
    packages: [{ path: '', kind: 'npm' }],
    ciCommands: ['npm ci', 'npm test'],
    agentFiles: [],
    monorepo: false,
    tests: null,
    ui: true,
    git: true,
    remote: 'GitHub',
    files: 120,
    docker: false,
    makefileTargets: [],
    readmeLines: 40,
  },
  suggested: {
    commands: { test: 'npm test', lint: 'npm run lint', build: null },
    prepare: 'npm ci',
    basePort: 3100,
    workflowDefault: 'feature_ui',
    team: [
      { pack: 'triage', name: 'Triage' },
      { pack: 'ba', name: 'BA' },
      { pack: 'designer', name: 'Designer' },
      { pack: 'dev', name: 'Dev' },
      { pack: 'qa', name: 'QA' },
      { pack: 'user_tester', name: 'User tester' },
      { pack: 'reviewer', name: 'Reviewer' },
    ],
    plugins: ['playwright'],
    handover: 'pr',
    worktrees: true,
    why: { team: 'It has a UI, so a Designer and a User tester.', commands: 'Taken from the CI workflow.' },
  },
  trial: {
    prepare: { command: 'npm ci', ok: true, exitCode: 0, seconds: 4, tail: [] },
    test: { command: 'npm test', ok: false, exitCode: 1, seconds: 2, tail: ['FAIL src/a.test.ts'] },
  },
  appliedAt: null,
  createdAt: '2026-11-01T10:00:00Z',
  ...o,
});

function route(extra: Record<string, unknown> = {}) {
  http.get.mockImplementation((url: string) => {
    if (url in extra) return ok(extra[url]);
    if (url.endsWith('/ai/packs')) return ok(PACKS);
    if (url === '/ai/windows')
      return ok({
        accounts: [
          { key: 'local', name: 'This computer', status: 'ok', running: [] },
          { key: 'a1', name: 'Work', email: 'w@x.io', status: 'ok', running: [] },
        ],
      });
    if (url === '/ai/catalogue')
      return ok([
        { key: 'playwright', name: 'Playwright', kind: 'mcp', roles: ['user_tester'], what: 'A real browser' },
      ]);
    return Promise.reject(new Error('unexpected ' + url));
  });
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TeamSection projectId="p1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.values(http).forEach((f) => f.mockReset());
  route();
});
afterEach(cleanup);

describe('pack library', () => {
  it('lists the eight roles with their glyphs, model and tools', async () => {
    mount();
    const table = await screen.findByTestId('pack-table');
    for (const g of ['TR', 'PM', 'BA', 'DS', 'DV', 'RV', 'QA', 'UT'])
      expect(within(table).getAllByText(g).length).toBeGreaterThan(0);
    expect(within(table).getAllByText('Sonnet · medium, Opus on a retry').length).toBeTruthy();
    expect(within(table).getByText('By depth: Haiku / Sonnet / Opus')).toBeTruthy();
    expect(within(table).getAllByText(/Figma MCP/).length).toBeTruthy();
    for (const l of ['Model', 'Writes', 'Hands in', 'Ceiling', 'Tools'])
      expect(within(table).getAllByText(l).length).toBe(8);
  });

  it('shows an error with a retry', async () => {
    http.get.mockRejectedValue(new Error('down'));
    mount();
    expect(await screen.findByTestId('load-error')).toBeTruthy();
  });

  it('opens a pack detail', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('pack-row-dev'));
    const d = await screen.findByTestId('pack-detail');
    expect(within(d).getByText('Dev (TDD) — what is in the pack')).toBeTruthy();
    expect(within(d).getByText('A red run, then a green one')).toBeTruthy();
    expect(within(d).getByText(/1 run at a time, 10 runs a day/)).toBeTruthy();
    expect(d.textContent).toContain(
      'and no further. Changing an assignee needs approval; deleting a ticket is never allowed.',
    );
    const names = within(d)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(names.indexOf('Export')).toBeLessThan(names.indexOf('Make a member from it'));
  });

  it('edits a pack and saves it as a new version', async () => {
    http.put.mockReturnValue(ok(pack({ builtin: false, id: 'p1:dev', version: 2, model: 'opus' })));
    mount();
    fireEvent.click(await screen.findByTestId('pack-row-dev'));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const dlg = await screen.findByRole('dialog');
    fireEvent.change(within(dlg).getByLabelText('Model'), { target: { value: 'opus' } });
    fireEvent.click(within(dlg).getByRole('button', { name: /Save as the project/ }));
    await waitFor(() => expect(http.put).toHaveBeenCalled());
    const [url, body] = http.put.mock.calls[0];
    expect(url).toBe('/projects/p1/ai/packs/dev');
    expect(body.model).toBe('opus');
    expect(body.allow).toEqual(['Bash(npm test:*)']);
    expect(await screen.findByText(/saved as version 2/)).toBeTruthy();
  });

  it('shows a refusal from the server while editing', async () => {
    http.put.mockRejectedValue({ response: { data: { detail: 'Unknown effort' } } });
    mount();
    fireEvent.click(await screen.findByTestId('pack-row-dev'));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /Save as/ }));
    expect(await screen.findByText('Unknown effort')).toBeTruthy();
  });

  it('imports a pack and lists what it could not find', async () => {
    http.post.mockReturnValue(ok({ pack: pack({ builtin: false }), missing: ['figma'] }));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Import' }));
    const dlg = await screen.findByRole('dialog');
    fireEvent.change(within(dlg).getByLabelText('Pack JSON'), { target: { value: 'nope' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Import' }));
    expect(await within(dlg).findByRole('alert')).toBeTruthy();
    fireEvent.change(within(dlg).getByLabelText('Pack JSON'), {
      target: { value: JSON.stringify({ format: 'kanban-role-pack/1', key: 'dev', version: 1, pack: {} }) },
    });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Import' }));
    expect((await screen.findByTestId('import-missing')).textContent).toContain('figma');
  });

  it('makes a member from a pack, with the persona for the User tester', async () => {
    http.post.mockReturnValue(ok({ id: 'm1', name: 'Tester' }));
    mount();
    fireEvent.click(await screen.findByTestId('pack-row-user_tester'));
    fireEvent.click(await screen.findByRole('button', { name: 'Make a member from it' }));
    const dlg = await screen.findByRole('dialog');
    fireEvent.change(within(dlg).getByLabelText('Plays'), { target: { value: 'keyboard only' } });
    await waitFor(() => expect(within(dlg).getAllByRole('option').length).toBe(2));
    fireEvent.change(within(dlg).getByLabelText('Runs as'), { target: { value: 'a1' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Make member' }));
    await waitFor(() => expect(http.post).toHaveBeenCalled());
    expect(http.post.mock.calls[0][0]).toBe('/projects/p1/ai/packs/user_tester/member');
    expect(http.post.mock.calls[0][1]).toMatchObject({ plays: 'keyboard only', accountId: 'a1' });
    expect(await screen.findByText('Tester is on the team.')).toBeTruthy();
  });
});

describe('permission mode per pack', () => {
  const overview = {
    members: [
      { id: 'm1', name: 'Reviewer Binh', kind: 'ai', config: { role: 'reviewer', permissionMode: 'allowlist' } },
      { id: 'm2', name: 'Dev Khoa', kind: 'ai', config: { role: 'dev', permissionMode: 'bypass' } },
      { id: 'm3', name: 'Dev Lan', kind: 'ai', config: { pack: { key: 'dev' } } },
    ],
    settings: {},
    summary: {},
  };
  const withReviewer = PACKS.map((p) => (p.key === 'reviewer' ? { ...p, permissionMode: 'allowlist' } : p));

  it('shows each pack’s mode, Triage on the allow list, and how many members were made from it', async () => {
    route({ '/projects/p1/ai/overview': overview, '/projects/p1/ai/packs': withReviewer });
    mount();
    expect((await screen.findByTestId('pack-mode-triage')).textContent).toBe('Allow list only');
    expect(screen.getByTestId('pack-mode-dev').textContent).toBe('Bypass permissions');
    expect(screen.getByTestId('pack-mode-reviewer').textContent).toBe('Allow list only');
    await waitFor(() => expect(screen.getByTestId('pack-members-dev').textContent).toBe('2'));
    expect(screen.getByTestId('pack-members-reviewer').textContent).toBe('1');
    expect(screen.getByTestId('pack-members-pm').textContent).toBe('0');
  });

  it('lets only the owner turn Bypass on', async () => {
    route({ '/projects/p1/ai/me': { role: 'member' }, '/projects/p1/ai/packs': withReviewer });
    mount();
    const chip = (await screen.findByTestId('pack-mode-reviewer')) as HTMLButtonElement;
    await waitFor(() => expect(chip.title).toBe('Only the project owner can turn on Bypass permissions.'));
    expect(chip.disabled).toBe(true);
  });

  it('turns Bypass on for a pack after the warning and the typed phrase', async () => {
    route({
      '/projects/p1/ai/me': { role: 'owner' },
      '/projects/p1/ai/overview': overview,
      '/projects/p1/ai/packs': withReviewer,
    });
    http.put.mockReturnValue(ok({ ...withReviewer[5], version: 2, permissionMode: 'bypass' }));
    mount();
    const chip = (await screen.findByTestId('pack-mode-reviewer')) as HTMLButtonElement;
    await waitFor(() => expect(chip.disabled).toBe(false));
    fireEvent.click(chip);
    const dlg = await screen.findByTestId('pack-bypass');
    expect(dlg.getAttribute('aria-label')).toBe('Turn on Bypass permissions for the Reviewer pack');
    expect(within(dlg).getByTestId('pack-bypass-warning').textContent).toContain(
      'Bypass permissions runs shell commands and edits files on this computer without asking.',
    );
    await waitFor(() => expect(dlg.textContent).toContain('Reviewer Binh is on the allow list now'));
    const on = within(dlg).getByTestId('pack-bypass-on') as HTMLButtonElement;
    fireEvent.change(within(dlg).getByTestId('pack-bypass-confirm'), { target: { value: 'bypass perm' } });
    expect(on.disabled).toBe(true);
    fireEvent.change(within(dlg).getByTestId('pack-bypass-confirm'), { target: { value: 'Bypass permissions' } });
    fireEvent.click(on);
    await waitFor(() => expect(http.put).toHaveBeenCalled());
    const [url, body] = http.put.mock.calls[0];
    expect(url).toBe('/projects/p1/ai/packs/reviewer');
    expect(body).toMatchObject({ name: 'Reviewer', permissionMode: 'bypass', limits: { maxParallel: 1 } });
    expect(await screen.findByText(/Reviewer is on Bypass permissions from version 2/)).toBeTruthy();
    expect(screen.queryByTestId('pack-bypass')).toBeNull();
  });

  it('puts a pack back on the allow list without the warning', async () => {
    route({ '/projects/p1/ai/me': { role: 'owner' } });
    http.put.mockReturnValue(ok({ ...PACKS[4], version: 2, permissionMode: 'allowlist' }));
    mount();
    fireEvent.click(await screen.findByTestId('pack-mode-dev'));
    await waitFor(() => expect(http.put).toHaveBeenCalled());
    expect(http.put.mock.calls[0][1]).toMatchObject({ permissionMode: 'allowlist' });
    expect(screen.queryByTestId('pack-bypass')).toBeNull();
  });
});

describe('team wizard', () => {
  async function toReview() {
    http.post.mockReturnValueOnce(ok(scan()));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Set up the AI team' }));
    fireEvent.change(await screen.findByLabelText('Repository folder'), { target: { value: '/repo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Read the repository' }));
    return screen.findByTestId('wizard-step-2');
  }

  it('scans, then shows the suggestion with its reasons', async () => {
    await toReview();
    expect(http.post).toHaveBeenCalledWith('/projects/p1/ai/scan', { folder: '/repo', trial: true });
    expect(screen.getByText('It has a UI, so a Designer and a User tester.')).toBeTruthy();
    expect((screen.getByLabelText('Prepare command') as HTMLInputElement).value).toBe('npm ci');
    expect(within(screen.getByTestId('plugins-box')).getByText('Playwright')).toBeTruthy();
  });

  it('shows a scan failure and stays on step 1', async () => {
    http.post.mockRejectedValueOnce({ response: { data: { detail: 'Folder not found' } } });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Set up the AI team' }));
    fireEvent.change(await screen.findByLabelText('Repository folder'), { target: { value: '/x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Read the repository' }));
    expect(await screen.findByText('Folder not found')).toBeTruthy();
    expect(screen.getByTestId('wizard-step-1')).toBeTruthy();
  });

  it('removing a role changes the workflow and says which steps go', async () => {
    await toReview();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Designer' }));
    const note = screen.getByTestId('workflow-note');
    expect(note.textContent).toContain('Standard feature');
    expect(note.textContent).toContain('Designer');
    expect((screen.getByRole('button', { name: 'Remove Triage' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('without an edit, Next shows the trial the scan already ran', async () => {
    await toReview();
    fireEvent.click(screen.getByRole('button', { name: 'Next: try the commands' }));
    const failing = await screen.findByTestId('trial-test');
    expect(failing.textContent).toContain('failed (exit 1)');
    expect(failing.textContent).toContain('FAIL src/a.test.ts');
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('keeps edits through the steps, tries the edited commands, and creates only on Create', async () => {
    await toReview();
    fireEvent.change(screen.getByLabelText('Prepare command'), { target: { value: 'npm --prefix ui ci' } });
    fireEvent.change(screen.getByLabelText('Test command'), { target: { value: 'npm run t' } });
    // the edited commands are what gets tried, not the scan's suggestion
    http.post.mockReturnValueOnce(
      ok(
        scan({
          trial: {
            prepare: { command: 'npm --prefix ui ci', ok: true, exitCode: 0, seconds: 3, tail: [] },
            test: { command: 'npm run t', ok: false, exitCode: 1, seconds: 2, tail: ['FAIL src/b.test.ts'] },
          },
        }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next: try the commands' }));
    const failing = await screen.findByTestId('trial-test');
    expect(http.post).toHaveBeenLastCalledWith('/projects/p1/ai/scan', {
      folder: '/repo',
      trial: true,
      prepare: 'npm --prefix ui ci',
      test: 'npm run t',
      refine: false,
    });
    expect(failing.textContent).toContain('npm run t');
    expect(failing.textContent).toContain('FAIL src/b.test.ts');
    expect(failing.textContent).not.toContain('You changed this command');
    expect(screen.getByTestId('trial-prepare').textContent).toContain('passed');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect((screen.getByLabelText('Test command') as HTMLInputElement).value).toBe('npm run t');
    fireEvent.click(screen.getByRole('button', { name: 'Next: try the commands' })); // unchanged since: no new trial
    fireEvent.click(screen.getByRole('button', { name: 'Next: confirm' }));
    expect((await screen.findByTestId('wizard-step-4')).textContent).toContain('prepare: npm --prefix ui ci');
    expect(http.post).toHaveBeenCalledTimes(2); // the scan and the trial of the edits so far

    http.post.mockReturnValueOnce(
      ok({
        created: [{ id: 'm1', name: 'Dev', pack: 'dev' }],
        skipped: [{ name: 'QA', why: 'already exists' }],
        plugins: ['playwright'],
        plugin_failures: [],
        pluginFailures: [{ plugin: 'design', why: 'offline' }],
        settings: {},
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create the team' }));
    const res = await screen.findByTestId('apply-result');
    expect(http.post.mock.calls[2][0]).toBe('/ai/scans/s1/apply');
    expect(http.post.mock.calls[2][1]).toMatchObject({
      commands: { test: 'npm run t', lint: 'npm run lint', build: null },
      prepare: 'npm --prefix ui ci',
      basePort: 3100,
      workflowDefault: 'feature_ui',
      handover: 'pr',
      accountId: null,
    });
    expect(http.post.mock.calls[2][1].team).toHaveLength(7);
    expect(res.textContent).toContain('Skipped QA: already exists');
    expect(res.textContent).toContain('design could not be attached');
  });
});
