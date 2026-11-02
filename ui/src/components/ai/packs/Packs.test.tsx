// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pack, Scan, ScanJob, TrialRun } from '../../../types/aiPacks';

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

const run = (command: string, status: TrialRun['status'], o: Partial<TrialRun> = {}): TrialRun => ({
  command,
  status,
  ok: status === 'works',
  exitCode: status === 'works' ? 0 : 1,
  seconds: 4,
  tail: [],
  reason: null,
  ...o,
});
const NO_TRIAL = { prepare: null, test: null, lint: null, build: null };
const FAILS_TAIL = [
  'FAIL  src/cities.test.ts > saves in order',
  'Test Files  2 failed | 41 passed (43)',
  'Tests  2 failed | 212 passed (214)',
];
const GOOD_TRIAL = {
  prepare: run('npm ci', 'works', { seconds: 42 }),
  test: run('npm test', 'works', { seconds: 31, tail: ['Tests  3 passed (3)'] }),
  lint: run('npm run lint', 'works', { seconds: 9 }),
  build: run('npm run build', 'works', { seconds: 64 }),
};
const proposed = (command: string, source = 'ui/package.json › scripts', note = '') => ({ command, source, note });
const PROPOSAL = {
  commands: {
    prepare: proposed('npm ci', 'ci.yml · jobs backend and ui', 'npm is in /opt/homebrew/bin, not on the app’s PATH.'),
    test: proposed('npm test', 'ui/package.json › scripts.test'),
    lint: proposed('npm run lint', 'ui/package.json › scripts.lint'),
    build: proposed('npm run build', 'ci.yml · job ui'),
  },
  envPath: [{ path: '/opt/homebrew/bin', by: 'ai' as const, why: 'npm was found here' }],
  notes: 'Read ci.yml and ui/package.json.',
};
const job = (o: Partial<ScanJob> = {}): ScanJob => ({
  mode: 'ai',
  state: 'done',
  startedAt: '2026-11-01T10:01:00Z',
  endedAt: '2026-11-01T10:02:52Z',
  elapsedS: 112,
  hint: '',
  steps: [],
  log: [],
  error: null,
  ...o,
});
/** The AI finished; test fails inside the repository and lint points at a script that is not there. */
const PROBLEMS = {
  job: job(),
  proposal: {
    ...PROPOSAL,
    commands: { ...PROPOSAL.commands, lint: proposed('npm run lint:ci', 'the README (“lint before you push”)') },
  },
  trial: {
    ...GOOD_TRIAL,
    test: run('npm test', 'fails', { seconds: 31, tail: FAILS_TAIL }),
    lint: run('npm run lint:ci', 'wrong', { exitCode: 1, tail: ['npm error Missing script: "lint:ci"'] }),
  },
};

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
  trial: NO_TRIAL,
  aiAvailable: true,
  aiUnavailableWhy: null,
  basePath: '/usr/bin:/bin:/usr/sbin:/sbin',
  job: {},
  proposal: {},
  appliedAt: null,
  createdAt: '2026-11-01T10:00:00Z',
  ...o,
});

function route(extra: Record<string, unknown> = {}) {
  http.get.mockImplementation((url: string) => {
    if (url in extra) return ok(extra[url]);
    if (url === '/projects/p1/ai/scans/latest') return ok(null);
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
  const SLOW = { timeout: 4000 };

  async function toTeam(o: Partial<Scan> = {}, extra: Record<string, unknown> = {}) {
    route(extra);
    http.post.mockReturnValueOnce(ok(scan(o)));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Set up the AI team' }));
    fireEvent.change(await screen.findByLabelText('Repository folder'), { target: { value: '/repo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Read the repository' }));
    return screen.findByTestId('wizard-step-2');
  }
  async function toCommands(o: Partial<Scan> = {}, extra: Record<string, unknown> = {}) {
    await toTeam(o, extra);
    fireEvent.click(screen.getByRole('button', { name: 'Next: commands' }));
    return screen.findByTestId('wizard-step-3');
  }
  /** The AI has finished and the result is on screen, by continuing a scan left earlier. */
  async function toResult(o: Partial<Scan>) {
    route({ '/projects/p1/ai/scans/latest': scan(o) });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Set up the AI team' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Continue it' }));
    return screen.findByTestId('cmd-result');
  }
  const confirm = async () => {
    fireEvent.click(screen.getByRole('button', { name: /^Continue/ }));
    return screen.findByTestId('wizard-step-4');
  };
  const created = {
    created: [{ id: 'm1', name: 'Dev', pack: 'dev' }],
    skipped: [],
    plugins: [],
    pluginFailures: [],
    settings: {},
  };

  it('names the four steps and reads files only in step 1', async () => {
    await toTeam();
    expect(http.post).toHaveBeenCalledWith('/projects/p1/ai/scan', { folder: '/repo', trial: false, refine: false });
    const steps = screen.getByLabelText('Steps').textContent;
    for (const t of ['Read the repository', 'The team', 'Commands', 'Confirm']) expect(steps).toContain(t);
  });

  it('step 2 is the team and the rest, without the commands', async () => {
    await toTeam();
    expect(screen.getByText('It has a UI, so a Designer and a User tester.')).toBeTruthy();
    expect(screen.queryByLabelText('Prepare command')).toBeNull();
    expect(screen.queryByLabelText('Test command')).toBeNull();
    expect((screen.getByLabelText(/Ports: first port/) as HTMLInputElement).value).toBe('3100');
    expect(screen.getByLabelText('Hand over by')).toBeTruthy();
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
    await toTeam();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Designer' }));
    const note = screen.getByTestId('workflow-note');
    expect(note.textContent).toContain('Standard feature');
    expect(note.textContent).toContain('Designer');
    expect((screen.getByRole('button', { name: 'Remove Triage' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers to continue a scan whose job is running or finished, and jumps to the commands', async () => {
    route({ '/projects/p1/ai/scans/latest': scan({ ...PROBLEMS }) });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Set up the AI team' }));
    const notice = await screen.findByTestId('resume-scan');
    expect(notice.textContent).toContain('/repo');
    fireEvent.click(within(notice).getByRole('button', { name: 'Continue it' }));
    expect(await screen.findByTestId('wizard-step-3')).toBeTruthy();
    expect((screen.getByLabelText('Lint command') as HTMLInputElement).value).toBe('npm run lint:ci');
    expect(http.post).not.toHaveBeenCalled();
  });

  it('does not offer a scan that was applied or has no job', async () => {
    route({ '/projects/p1/ai/scans/latest': scan({ appliedAt: '2026-11-01T11:00:00Z', ...PROBLEMS }) });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Set up the AI team' }));
    await screen.findByTestId('wizard-step-1');
    await waitFor(() => expect(http.get).toHaveBeenCalledWith('/projects/p1/ai/scans/latest'));
    expect(screen.queryByTestId('resume-scan')).toBeNull();
  });

  describe('choose', () => {
    it('recommends the AI, with the permission wording, and starts it with the hint', async () => {
      await toCommands();
      const ai = screen.getByTestId('choose-ai');
      expect(within(ai).getByText('Recommended')).toBeTruthy();
      expect(ai.textContent).toContain('The AI only reads files itself.');
      expect(ai.textContent).toContain('runs the repository’s own install and test scripts in a temporary copy');
      expect(ai.textContent).toContain('Usually 1 to 3 minutes.');
      expect(screen.getByTestId('choose-type').textContent).toContain('Four empty boxes');
      http.post.mockReturnValueOnce(ok(scan({ job: job({ state: 'running', elapsedS: 1 }) })));
      fireEvent.change(screen.getByLabelText('Anything it should know?'), { target: { value: 'uses pnpm' } });
      fireEvent.click(within(ai).getByRole('button', { name: 'Start' }));
      expect(await screen.findByTestId('ai-work')).toBeTruthy();
      expect(http.post).toHaveBeenLastCalledWith('/ai/scans/s1/ai', { hint: 'uses pnpm' });
    });

    it('says why the AI is not available, disables Start and puts the typed way first', async () => {
      await toCommands({ aiAvailable: false, aiUnavailableWhy: 'Claude Code is not signed in on this computer.' });
      const ai = screen.getByTestId('choose-ai');
      expect(within(ai).getByText('Not available')).toBeTruthy();
      expect(within(ai).getByTestId('ai-unavailable').textContent).toContain(
        'Claude Code is not signed in on this computer.',
      );
      expect((within(ai).getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true);
      expect(within(screen.getByTestId('choose-type')).getByText('Use this for now')).toBeTruthy();
    });

    it('typing yourself shows four rows: Not tried yet for a command, Empty for none', async () => {
      await toCommands();
      fireEvent.click(screen.getByRole('button', { name: 'Type the commands' }));
      const result = await screen.findByTestId('cmd-result');
      for (const n of ['prepare', 'test', 'lint', 'build'])
        expect(within(screen.getByTestId(`row-${n}`)).getByText('Empty')).toBeTruthy();
      fireEvent.change(screen.getByLabelText('Prepare command'), { target: { value: 'npm ci' } });
      fireEvent.change(screen.getByLabelText('Test command'), { target: { value: 'npm test' } });
      expect(within(screen.getByTestId('row-prepare')).getByText('Not tried yet')).toBeTruthy();
      expect(within(screen.getByTestId('row-lint')).getByText('Empty')).toBeTruthy();
      for (const b of ['Try them', 'Skip trying', 'Let the AI do it instead', 'Back'])
        expect(screen.getByRole('button', { name: b })).toBeTruthy();
      http.post.mockReturnValueOnce(ok(scan({ job: job({ mode: 'try', state: 'running' }) })));
      fireEvent.click(screen.getByRole('button', { name: 'Try them' }));
      await waitFor(() =>
        expect(http.post).toHaveBeenLastCalledWith('/ai/scans/s1/try', {
          commands: { prepare: 'npm ci', test: 'npm test', lint: '', build: '' },
          envPath: [],
        }),
      );
    });
  });

  describe('the AI at work', () => {
    const working = scan({
      job: job({
        state: 'running',
        elapsedS: 48,
        steps: [
          {
            key: 'ci',
            label: 'Read the CI workflow',
            detail: '3 jobs: backend tests, UI checks',
            state: 'done',
            atS: 6,
          },
          { key: 'prepare', label: 'Running prepare', detail: 'step 2 of 2', state: 'running', atS: 48 },
          { key: 'test', label: 'Test', detail: '', state: 'waiting', atS: null },
        ],
        log: ['$ which npm', 'npm not found on PATH=/usr/bin', '/opt/homebrew/bin/npm'],
      }),
    });

    it('shows the timer, the steps and the log while the job runs, then the result when it is done', async () => {
      await toCommands();
      http.post.mockReturnValueOnce(ok(working));
      fireEvent.click(within(screen.getByTestId('choose-ai')).getByRole('button', { name: 'Start' }));
      const work = await screen.findByTestId('ai-work');
      expect(screen.getByTestId('work-clock').textContent).toBe('0:48');
      expect(within(screen.getByTestId('work-steps')).getByText('Read the CI workflow')).toBeTruthy();
      expect(screen.getByTestId('work-log').textContent).toContain('/opt/homebrew/bin/npm');
      expect(work.textContent).toContain('Usually 1 to 3 minutes. It stops by itself after 10.');
      expect(work.textContent).toContain('You can close this window.');
      expect(work.textContent).toContain('These are the repository’s own scripts.');
      fireEvent.click(screen.getByRole('button', { name: 'Hide the log' }));
      expect(screen.queryByTestId('work-log')).toBeNull();
      // every second the scan is read again; the finished job turns it into the result
      route({ '/ai/scans/s1': scan({ job: job(), proposal: PROPOSAL, trial: GOOD_TRIAL }) });
      const result = await screen.findByTestId('cmd-result', undefined, SLOW);
      expect(http.get).toHaveBeenCalledWith('/ai/scans/s1');
      expect(screen.getByTestId('banner-ok').textContent).toContain(
        'The AI finished in 1 min 52 s — all four commands work',
      );
      // the AI's commands are in the boxes, with where each came from and its note
      expect((within(result).getByLabelText('Prepare command') as HTMLInputElement).value).toBe('npm ci');
      expect(within(screen.getByTestId('row-prepare')).getByText('From ci.yml · jobs backend and ui')).toBeTruthy();
      expect(screen.getByTestId('note-prepare').textContent).toContain('npm is in /opt/homebrew/bin');
      expect(within(screen.getByTestId('row-build')).getByText('Works · 1 min 04 s')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
    });

    it('cancels the job', async () => {
      await toCommands();
      http.post.mockReturnValueOnce(ok(working));
      fireEvent.click(within(screen.getByTestId('choose-ai')).getByRole('button', { name: 'Start' }));
      await screen.findByTestId('ai-work');
      http.post.mockReturnValueOnce(ok(scan({ job: job({ state: 'cancelled' }) })));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(http.post).toHaveBeenLastCalledWith('/ai/scans/s1/cancel'));
      expect(await screen.findByTestId('cmd-choose')).toBeTruthy();
      expect(screen.getByTestId('ai-stopped').textContent).toContain('The AI was stopped.');
    });
  });

  describe('the result', () => {
    it('opens the environment by itself when the AI added a folder, and lists the base PATH read-only', async () => {
      await toResult({ job: job(), proposal: PROPOSAL, trial: GOOD_TRIAL });
      const env = screen.getByTestId('env-block');
      expect(within(env).getByText('Added by the AI · npm was found here')).toBeTruthy();
      expect((within(env).getByLabelText('The app’s own PATH') as HTMLInputElement).value).toBe(
        '/usr/bin:/bin:/usr/sbin:/sbin',
      );
      expect(env.textContent).toContain('What the app was started with · not editable');
      expect(env.textContent).toContain('Changing it runs the commands again.');
      expect(env.textContent).toContain('Used by everything this project runs:');
      fireEvent.click(within(env).getByTestId('env-toggle'));
      expect(within(env).getByTestId('env-summary').textContent).toContain(
        'PATH has 1 extra folder: /opt/homebrew/bin · added by the AI · used only by this project',
      );
    });

    it('removing a folder runs the commands again with the new PATH', async () => {
      await toResult({ job: job(), proposal: PROPOSAL, trial: GOOD_TRIAL });
      http.post.mockReturnValueOnce(ok(scan({ job: job({ mode: 'try', state: 'running' }), trial: GOOD_TRIAL })));
      fireEvent.click(screen.getByRole('button', { name: 'Remove /opt/homebrew/bin' }));
      await waitFor(() =>
        expect(http.post).toHaveBeenLastCalledWith('/ai/scans/s1/try', {
          commands: { prepare: 'npm ci', test: 'npm test', lint: 'npm run lint', build: 'npm run build' },
          envPath: [],
        }),
      );
    });

    it('tells a failing repository from a wrong command and defaults a failing check to not a check yet', async () => {
      await toResult(PROBLEMS);
      expect(screen.getByTestId('banner-problems').textContent).toContain(
        'Two things need a look — and they are not the same kind of problem',
      );
      const test = within(screen.getByTestId('row-test'));
      expect(test.getByText('Runs · the repo’s own tests fail')).toBeTruthy();
      expect(test.getByText('The command is right. 2 of 214 tests fail inside the repository.')).toBeTruthy();
      expect(test.getByTestId('row-output').textContent).toContain('FAIL  src/cities.test.ts');
      expect((test.getByRole('radio', { name: 'Keep test, but not as a check yet' }) as HTMLInputElement).checked).toBe(
        true,
      );
      expect((test.getByRole('radio', { name: 'Use test as a check' }) as HTMLInputElement).checked).toBe(false);
      expect(test.getByText('Suggested.')).toBeTruthy();
      const lint = within(screen.getByTestId('row-lint'));
      expect(lint.getByText('Command is wrong · exit 1')).toBeTruthy();
      expect(lint.getByText('This is a mistake in the command, not in the repo.')).toBeTruthy();
      expect(lint.getByRole('button', { name: 'Ask the AI to fix' })).toBeTruthy();
      expect(lint.getByRole('button', { name: 'Leave lint empty for now' })).toBeTruthy();
      expect(screen.getByTestId('cmd-summary').textContent).toBe('1 needs a choice · 1 needs fixing');
      expect(screen.getByRole('button', { name: 'Continue anyway' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Ask the AI to check again' })).toBeTruthy();
      expect(within(screen.getByTestId('ask-fix')).getByText('Ask the AI to fix what is wrong')).toBeTruthy();
      // choosing is a decision: the summary no longer counts it
      fireEvent.click(test.getByRole('radio', { name: 'Use test as a check' }));
      expect(screen.getByTestId('cmd-summary').textContent).toBe('1 needs fixing');
    });

    it('asks the AI to fix what is wrong, keeping the commands that work', async () => {
      await toResult(PROBLEMS);
      http.post.mockReturnValueOnce(ok(scan({ ...PROBLEMS, job: job({ state: 'running' }) })));
      fireEvent.change(screen.getByLabelText('What the AI should know'), { target: { value: 'the app is in ui/' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() =>
        expect(http.post).toHaveBeenLastCalledWith('/ai/scans/s1/ai', {
          hint: 'the app is in ui/',
          commands: { prepare: 'npm ci', test: 'npm test', lint: 'npm run lint:ci', build: 'npm run build' },
          keep: ['prepare', 'build'],
          envPath: ['/opt/homebrew/bin'],
        }),
      );
    });

    it('does not offer the AI box when the AI is not available', async () => {
      await toResult({ ...PROBLEMS, aiAvailable: false, aiUnavailableWhy: 'Claude Code is not installed' });
      expect(screen.queryByTestId('ask-fix')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Ask the AI to fix' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Ask the AI to check again' })).toBeNull();
    });

    it('marks a box edited after the last run as changed, until it is run again', async () => {
      await toResult({ job: job(), proposal: PROPOSAL, trial: GOOD_TRIAL });
      const box = screen.getByLabelText('Test command') as HTMLInputElement;
      fireEvent.change(box, { target: { value: 'npm run t' } });
      const row = within(screen.getByTestId('row-test'));
      expect(row.getByText('Changed since the last run')).toBeTruthy();
      expect(box.className).toContain('pk-in-changed');
      expect(row.getByText('Typed by you')).toBeTruthy();
      http.post.mockReturnValueOnce(ok(scan({ job: job({ mode: 'try', state: 'running' }), trial: GOOD_TRIAL })));
      fireEvent.click(row.getByRole('button', { name: 'Run test' }));
      await waitFor(() =>
        expect(http.post).toHaveBeenLastCalledWith('/ai/scans/s1/try', {
          commands: { prepare: 'npm ci', test: 'npm run t', lint: 'npm run lint', build: 'npm run build' },
          envPath: ['/opt/homebrew/bin'],
          only: ['test'],
        }),
      );
      // back to what was proved: no longer changed
      fireEvent.change(box, { target: { value: 'npm test' } });
      expect(row.queryByText('Changed since the last run')).toBeNull();
    });

    it('folds the output of a command that works behind a button', async () => {
      await toResult({ job: job(), proposal: PROPOSAL, trial: GOOD_TRIAL });
      const test = within(screen.getByTestId('row-test'));
      expect(test.queryByTestId('row-output')).toBeNull();
      fireEvent.click(test.getByRole('button', { name: 'Output' }));
      expect(test.getByTestId('row-output').textContent).toContain('Tests  3 passed (3)');
    });

    it('E1: the AI ran out of time with some commands', async () => {
      await toResult({
        job: job({ state: 'timeout', elapsedS: 600 }),
        proposal: { ...PROPOSAL, commands: { prepare: PROPOSAL.commands.prepare, test: PROPOSAL.commands.test } },
        trial: {
          prepare: GOOD_TRIAL.prepare,
          test: GOOD_TRIAL.test,
          lint: run('', 'not_run', { reason: 'timed out' }),
          build: null,
        },
      });
      const banner = screen.getByTestId('banner-timeout');
      expect(banner.textContent).toContain('The AI stopped after 10 minutes with 2 of 4 commands');
      expect(banner.textContent).toContain('It found prepare and test and proved both.');
      for (const b of ['Try the missing ones', 'Start over', 'Type the rest'])
        expect(screen.getByRole('button', { name: b })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Type the rest' }));
      expect(document.activeElement).toBe(screen.getByLabelText('Lint command'));
      expect(screen.queryByRole('button', { name: 'Start over' })).toBeNull(); // the usual buttons are back
      expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
    });

    it('E2: the AI found nothing', async () => {
      await toResult({
        job: job(),
        proposal: {
          commands: {
            prepare: proposed(''),
            test: proposed(''),
            lint: proposed(''),
            build: proposed(''),
          },
          envPath: [],
          notes: '',
        },
      });
      expect(screen.getByTestId('banner-nothing').textContent).toContain('The AI looked and found no commands');
      expect(screen.getByLabelText('Test command').getAttribute('placeholder')).toBe('The command that runs the tests');
      expect(within(screen.getByTestId('row-lint')).getByText('Empty')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Continue with these empty' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Let the AI look again' })).toBeTruthy();
    });
  });

  describe('confirm and create', () => {
    it('lists the commands with what the board found, and the environment', async () => {
      await toResult(PROBLEMS);
      await confirm();
      const list = screen.getByTestId('confirm-commands');
      expect(within(list).getByTestId('confirm-prepare').textContent).toContain('works · 42 s');
      expect(within(list).getByTestId('confirm-test').textContent).toContain(
        'repo tests fail (2 of 214) · saved, not a check yet',
      );
      expect(within(list).getByTestId('confirm-lint').textContent).toContain(
        'command is wrong · saved, not a check yet',
      );
      expect(within(list).getByTestId('confirm-build').textContent).toContain('works · 1 min 04 s');
      expect(screen.getByTestId('confirm-env').textContent).toContain(
        'Environment: PATH + /opt/homebrew/bin, for this project only',
      );
    });

    it('warns that two commands would stop tickets, and Keep both saves them as not checks', async () => {
      await toResult(PROBLEMS);
      await confirm();
      const banner = screen.getByTestId('confirm-stop-banner');
      expect(banner.textContent).toContain('Two commands would stop tickets if they were checks');
      for (const b of ['Keep both saved, not checks yet', 'Leave lint empty for now', 'Use test as a check anyway'])
        expect(within(banner).getByRole('button', { name: b })).toBeTruthy();
      fireEvent.click(within(banner).getByRole('button', { name: 'Keep both saved, not checks yet' }));
      expect(screen.queryByTestId('confirm-stop-banner')).toBeNull();
      http.post.mockReturnValueOnce(ok(created));
      fireEvent.click(screen.getByRole('button', { name: 'Create the team' }));
      await screen.findByTestId('apply-result');
      const [url, body] = http.post.mock.calls[0];
      expect(url).toBe('/ai/scans/s1/apply');
      expect(body).toMatchObject({
        commands: { test: 'npm test', lint: 'npm run lint:ci', build: 'npm run build' },
        prepare: 'npm ci',
        envPath: ['/opt/homebrew/bin'],
        checksOff: ['test', 'lint'],
        basePort: 3100,
        workflowDefault: 'feature_ui',
        handover: 'pr',
        accountId: null,
      });
      expect(body.team).toHaveLength(7);
    });

    it('Use test as a check anyway turns the test check on; Leave lint empty drops the lint command', async () => {
      await toResult(PROBLEMS);
      await confirm();
      const banner = screen.getByTestId('confirm-stop-banner');
      fireEvent.click(within(banner).getByRole('button', { name: 'Use test as a check anyway' }));
      expect(screen.getByTestId('confirm-test').textContent).toContain('used as a check anyway');
      fireEvent.click(
        within(screen.getByTestId('confirm-stop-banner')).getByRole('button', { name: 'Leave lint empty for now' }),
      );
      expect(screen.queryByTestId('confirm-stop-banner')).toBeNull();
      expect(screen.getByTestId('confirm-lint').textContent).toContain('empty');
      http.post.mockReturnValueOnce(ok(created));
      fireEvent.click(screen.getByRole('button', { name: 'Create the team' }));
      await screen.findByTestId('apply-result');
      expect(http.post.mock.calls[0][1]).toMatchObject({
        commands: { test: 'npm test', lint: null, build: 'npm run build' },
        checksOff: [],
      });
    });

    it('no banner when everything works, and nothing is switched off', async () => {
      await toResult({ job: job(), proposal: PROPOSAL, trial: GOOD_TRIAL });
      await confirm();
      expect(screen.queryByTestId('confirm-stop-banner')).toBeNull();
      http.post.mockReturnValueOnce(ok(created));
      fireEvent.click(screen.getByRole('button', { name: 'Create the team' }));
      await screen.findByTestId('apply-result');
      expect(http.post.mock.calls[0][1]).toMatchObject({ checksOff: [], envPath: ['/opt/homebrew/bin'] });
    });

    it('keeps the typed commands through the steps, and creates only on Create', async () => {
      await toCommands();
      fireEvent.click(screen.getByRole('button', { name: 'Type the commands' }));
      fireEvent.change(await screen.findByLabelText('Prepare command'), { target: { value: 'npm --prefix ui ci' } });
      fireEvent.change(screen.getByLabelText('Test command'), { target: { value: 'npm run t' } });
      fireEvent.click(screen.getByRole('button', { name: 'Skip trying' }));
      expect((await screen.findByTestId('wizard-step-4')).textContent).toContain('npm --prefix ui ci');
      expect(screen.getByTestId('confirm-test').textContent).toContain('not tried');
      expect(http.post).toHaveBeenCalledTimes(1); // only the scan so far
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Back' })); // the typed look goes back to the choice
      fireEvent.click(await screen.findByRole('button', { name: 'Back' }));
      expect(await screen.findByTestId('wizard-step-2')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Next: commands' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Type the commands' }));
      expect((screen.getByLabelText('Test command') as HTMLInputElement).value).toBe('npm run t');
      fireEvent.click(screen.getByRole('button', { name: 'Skip trying' }));
      await screen.findByTestId('wizard-step-4');
      http.post.mockReturnValueOnce(ok({ ...created, skipped: [{ name: 'QA', why: 'already exists' }] }));
      fireEvent.click(screen.getByRole('button', { name: 'Create the team' }));
      const res = await screen.findByTestId('apply-result');
      expect(http.post.mock.calls[1][0]).toBe('/ai/scans/s1/apply');
      expect(http.post.mock.calls[1][1]).toMatchObject({
        commands: { test: 'npm run t', lint: null, build: null },
        prepare: 'npm --prefix ui ci',
        envPath: [],
        checksOff: [],
      });
      expect(res.textContent).toContain('Skipped QA: already exists');
    });
  });
});
