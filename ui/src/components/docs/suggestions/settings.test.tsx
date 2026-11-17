// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocsPage } from '../../../types/docs';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));
const api = vi.hoisted(() => ({ patchPageSettings: vi.fn() }));
vi.mock('../../../api/docs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/docs')>()),
  patchPageSettings: api.patchPageSettings,
}));

import { docsKeys } from '../../../api/docs';
import { ToastProvider } from '../../Toast';
import { AiChangesItems, BlockLockProvider, TeamApplySettings, useBlockLock } from './pageAi';
import { AskTeamButton, AskTeamProvider, teamInstruction } from './AskTeam';
import { LANGUAGES } from '../../../utils/pageAiRules';

const PAGE: DocsPage = {
  id: 'pg',
  projectId: 'proj',
  parentId: null,
  title: 'Roadmap',
  slug: 'roadmap',
  status: 'published',
  version: 3,
  markdown: '',
  format: 'rich',
  content: null,
  settings: {},
  headings: [],
  path: [],
  createdBy: 'Hoa Mai',
  updatedBy: 'Hoa Mai',
  updatedAt: '2026-11-17T10:00:00Z',
  createdAt: '2026-11-01T10:00:00Z',
  hasUnpublishedChanges: false,
  draft: null,
};

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(docsKeys.page(PAGE.id), PAGE);
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
  return qc;
}

beforeEach(() => {
  http.get.mockReset();
  http.post.mockReset();
  http.patch.mockReset();
  api.patchPageSettings.mockReset();
  api.patchPageSettings.mockImplementation(async (_id: string, s: Record<string, unknown>) => ({
    ...PAGE,
    settings: s,
  }));
  http.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/docs/settings')) return { data: { aiApply: { tm_docs: 'direct' } } };
    if (url.includes('/ai/docs') || url.includes('docs-ai') || url.includes('/docs/ai')) return { data: null };
    if (url.endsWith('/members')) return { data: [{ id: 'tm_docs', name: 'Docs team', kind: 'ai' }] };
    if (url.endsWith('/work')) return { data: { tickets: [], active: 0 } };
    return { data: null };
  });
});
afterEach(() => cleanup());

describe('page menu: AI changes and Not for AI teams', () => {
  it('sets Apply directly on the page', async () => {
    wrap(<AiChangesItems page={PAGE} projectId="proj" canEdit />);
    fireEvent.click(screen.getByTestId('menu-ai-changes'));
    expect(screen.getByText('WHEN A TEAM CHANGES THIS PAGE')).toBeTruthy();
    expect(screen.getByTestId('ai-apply-default').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('ai-apply-direct'));
    await waitFor(() => expect(api.patchPageSettings).toHaveBeenCalledWith('pg', { aiApply: 'direct' }));
  });

  it('goes back to the team default', async () => {
    wrap(<AiChangesItems page={{ ...PAGE, settings: { aiApply: 'suggest' } }} projectId="proj" canEdit />);
    fireEvent.click(screen.getByTestId('menu-ai-changes'));
    expect(screen.getByTestId('ai-apply-suggest').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('ai-apply-default'));
    await waitFor(() => expect(api.patchPageSettings).toHaveBeenCalledWith('pg', { aiApply: null }));
  });

  it('toggles Not for AI teams', async () => {
    wrap(<AiChangesItems page={PAGE} projectId="proj" canEdit />);
    fireEvent.click(screen.getByTestId('menu-not-for-ai'));
    await waitFor(() => expect(api.patchPageSettings).toHaveBeenCalledWith('pg', { notForAi: true }));
    cleanup();
    wrap(<AiChangesItems page={{ ...PAGE, settings: { notForAi: true } }} projectId="proj" canEdit />);
    expect(screen.getByTestId('menu-not-for-ai').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('menu-not-for-ai'));
    await waitFor(() => expect(api.patchPageSettings).toHaveBeenLastCalledWith('pg', { notForAi: null }));
  });
});

describe('Settings › Docs AI: how each team changes pages', () => {
  it('shows each team and saves a switch', async () => {
    http.patch.mockResolvedValue({ data: { aiApply: { tm_docs: 'direct', tm_dev: 'direct' } } });
    wrap(
      <TeamApplySettings
        projectId="proj"
        admin
        teams={[
          { id: 'tm_docs', name: 'Docs team' },
          { id: 'tm_dev', name: 'Backend team' },
        ]}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId('team-apply-tm_docs-direct').getAttribute('aria-checked')).toBe('true'),
    );
    expect(screen.getByTestId('team-apply-tm_dev-suggest').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('team-apply-tm_dev-direct'));
    await waitFor(() =>
      expect(http.patch).toHaveBeenCalledWith(
        '/projects/proj/docs/settings',
        { settings: { aiApply: { tm_dev: 'direct' } } },
        { rawKeys: ['settings'], keepKeys: true },
      ),
    );
  });

  it('is read-only for a person who is not an admin', async () => {
    wrap(<TeamApplySettings projectId="proj" admin={false} teams={[{ id: 'tm_docs', name: 'Docs team' }]} />);
    expect((screen.getByTestId('team-apply-tm_docs-direct') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('block lock: Teams cannot change this', () => {
  function Toggle({ id }: { id: string }) {
    const lock = useBlockLock();
    return (
      <button type="button" onClick={() => lock?.toggle(id)}>
        {lock?.locked.includes(id) ? 'locked' : 'open'}
      </button>
    );
  }

  it('adds and removes the block id in lockedBlocks, and marks the block', async () => {
    wrap(
      <BlockLockProvider page={{ ...PAGE, settings: { lockedBlocks: ['b-1'] } }}>
        <Toggle id="b-2" />
      </BlockLockProvider>,
    );
    expect(screen.getByTestId('sg-lock-marks').textContent).toContain('[data-block-id="b-1"]');
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    await waitFor(() => expect(api.patchPageSettings).toHaveBeenCalledWith('pg', { lockedBlocks: ['b-1', 'b-2'] }));
    expect(screen.getByTestId('sg-lock-marks').textContent).toContain('Locked for teams');
    fireEvent.click(screen.getByRole('button', { name: 'locked' }));
    await waitFor(() => expect(api.patchPageSettings).toHaveBeenLastCalledWith('pg', { lockedBlocks: ['b-1'] }));
  });

  it('goes back when the server refuses', async () => {
    api.patchPageSettings.mockRejectedValue(new Error('422'));
    wrap(
      <BlockLockProvider page={PAGE}>
        <Toggle id="b-2" />
      </BlockLockProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'open' })).toBeTruthy());
    expect(await screen.findByText("Couldn't save the page settings")).toBeTruthy();
  });
});

describe('Ask the team', () => {
  function setup(page: DocsPage = PAGE, explain?: () => void) {
    return wrap(
      <AskTeamProvider page={page} projectId="proj" canEdit>
        <AskTeamButton capture={() => ({ quote: 'The first month was the hard one.', blockId: 'b-4', explain })} />
      </AskTeamProvider>,
    );
  }

  it('one purple button; its menu has the verbs first, then Format this as…, Change tone and Translate', async () => {
    const explain = vi.fn();
    setup(PAGE, explain);
    fireEvent.click(await screen.findByTestId('ask-team'));
    const menu = screen.getByTestId('ask-team-menu');
    const rows = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((b) =>
      b.textContent?.replace('›', '').trim(),
    );
    expect(rows).toEqual([
      'Improve',
      'Shorten',
      'Fix spelling',
      'Explain',
      'Ask…',
      'Format this as…',
      'Change tone',
      'Translate',
    ]);
    expect(menu.textContent).toContain('Docs team');
    // the team is set to Apply directly in Settings, and the page has no setting of its own
    expect(menu.textContent).toContain('Changes are saved on the page at once');
    fireEvent.click(screen.getByTestId('ask-team-format'));
    for (const f of ['Table', 'Bulleted list', 'Numbered list', 'Callout', 'Pull quote'])
      expect(screen.getByText(f)).toBeTruthy();
    fireEvent.click(screen.getByText('‹ Back'));
    fireEvent.click(screen.getByTestId('ask-team-tone'));
    for (const t of ['Friendly', 'Formal', 'Plain', 'Confident', 'Shorter sentences'])
      expect(screen.getByText(t)).toBeTruthy();
    fireEvent.click(screen.getByText('‹ Back'));
    fireEvent.click(screen.getByTestId('ask-team-translate'));
    for (const l of LANGUAGES) expect(screen.getByText(l)).toBeTruthy();
    fireEvent.click(screen.getByText('‹ Back'));
    fireEvent.click(screen.getByTestId('ask-team-explain'));
    expect(explain).toHaveBeenCalled();
  });

  it('sends a job to the team as Give to an AI team does, with the passage quoted, and marks the block', async () => {
    http.post.mockResolvedValue({ data: { ticket: { id: 'KAN-172', title: 'Write' }, run: { id: 'r9' } } });
    setup();
    fireEvent.click(await screen.findByTestId('ask-team'));
    fireEvent.click(screen.getByTestId('ask-team-shorten'));
    await waitFor(() => expect(http.post).toHaveBeenCalled());
    const [url, body] = http.post.mock.calls[0];
    expect(url).toBe('/docs/pages/pg/assign');
    expect(body).toMatchObject({ member_id: 'tm_docs', kind: 'write' });
    expect(body.instruction).toBe(
      teamInstruction('Make this passage shorter and keep what matters.', {
        quote: 'The first month was the hard one.',
        blockId: 'b-4',
      }),
    );
    expect(body.instruction).toContain('“The first month was the hard one.”');
    expect(await screen.findByText(/Sent to Docs team · KAN-172/)).toBeTruthy();
    expect(screen.getByTestId('sg-hold-marks').textContent).toContain('Docs team has it · KAN-172');
  });

  it('says changes arrive as suggestions when the page is set to Suggest first', async () => {
    setup({ ...PAGE, settings: { aiApply: 'suggest' } });
    fireEvent.click(await screen.findByTestId('ask-team'));
    expect(screen.getByTestId('ask-team-menu').textContent).toContain('Changes arrive as suggestions here');
  });

  it('is not offered on a page that is not for AI teams', async () => {
    setup({ ...PAGE, settings: { notForAi: true } });
    await waitFor(() => expect(http.get).toHaveBeenCalled());
    expect(screen.queryByTestId('ask-team')).toBeNull();
  });
});
