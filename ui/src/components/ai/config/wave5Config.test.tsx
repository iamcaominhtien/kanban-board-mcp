// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));

import type { AiConfig, AiMember, AiSettings } from '../../../types/ai';
import { ToastProvider } from '../../Toast';
import { RunHistory } from '../AiSettingsSection';
import { CfgContext, type CfgCtx } from './configCtx';
import { ModelCard } from './PermissionsModelCards';
import { OpenFolderButton } from './SyncPreview';

const ok = (data: unknown) => Promise.resolve({ data });

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{node}</ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const f of Object.values(http)) f.mockReset();
  http.get.mockImplementation(() => ok({ models: [] }));
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

function cardWith(cfg: Partial<AiConfig>, setCfg = vi.fn()) {
  const full = { maxTurns: 40, runTimeoutMin: 30, compactAtPct: 60, extraFlags: [], effort: null, ...cfg } as AiConfig;
  const ctx = {
    member: { id: 'm1', provider: 'claude-code', connection: 'local' } as AiMember,
    draft: { workingDir: '/repo', model: 'sonnet', maxRunsPerDay: 10, maxParallel: 1 },
    cfg: full,
    saved: full,
    setCfg,
    setDraft: vi.fn(),
    issues: [],
    status: undefined,
  } as unknown as CfgCtx;
  wrap(
    <CfgContext.Provider value={ctx}>
      <ModelCard />
    </CfgContext.Provider>,
  );
  return setCfg;
}

describe('Claude Code run limits (PC-5)', () => {
  it('a member from before shows no limit, though 40 and 30 are stored', () => {
    cardWith({});
    expect((screen.getByLabelText('Max turns per run') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Run timeout') as HTMLInputElement).value).toBe('');
  });

  it('typing a value turns the limit on; emptying it turns it off again', () => {
    const setCfg = cardWith({});
    fireEvent.change(screen.getByLabelText('Max turns per run'), { target: { value: '12' } });
    expect(setCfg).toHaveBeenLastCalledWith({ maxTurns: 12, cliLimits: ['max_turns'] });
    cleanup();
    const again = cardWith({ maxTurns: 12, cliLimits: ['max_turns', 'run_timeout_min'] });
    expect((screen.getByLabelText('Max turns per run') as HTMLInputElement).value).toBe('12');
    fireEvent.change(screen.getByLabelText('Max turns per run'), { target: { value: '' } });
    expect(again).toHaveBeenLastCalledWith({ cliLimits: ['run_timeout_min'] });
  });
});

describe('Open folder (PC-7)', () => {
  it('is not shown in the web build', () => {
    wrap(<OpenFolderButton dir="/repo" />);
    expect(screen.queryByTestId('open-folder')).toBeNull();
  });

  it('shows the folder in the desktop app', async () => {
    const showItemInFolder = vi.fn(() => Promise.resolve({ success: true, error: null }));
    (window as unknown as { electronAPI: unknown }).electronAPI = { showItemInFolder, platform: 'darwin' };
    wrap(<OpenFolderButton dir="/repo" />);
    fireEvent.click(screen.getByTestId('open-folder'));
    await waitFor(() => expect(showItemInFolder).toHaveBeenCalledWith('/repo'));
  });
});

describe('Run history retention (OPS-7)', () => {
  const settings = { runRetentionDays: null } as unknown as AiSettings;

  it('keeps forever by default; a number of days is saved only after seeing what would go', async () => {
    http.get.mockImplementation(() =>
      ok({ days: 90, wouldRemove: 3, oldest: '2026-05-01T00:00:00Z', keptLinked: 2, keptThisMonth: 0 }),
    );
    http.patch.mockImplementation(() => ok({}));
    const saved = vi.fn();
    wrap(<RunHistory projectId="p1" settings={settings} onSaved={saved} />);
    const select = screen.getByTestId('ops-run-retention') as HTMLSelectElement;
    expect(select.value).toBe('0');
    fireEvent.change(select, { target: { value: '90' } });
    const result = await screen.findByTestId('ops-run-retention-result');
    expect(result.textContent).toContain('3 finished runs would go');
    expect(result.textContent).toContain('2 older runs stay because a record points at them');
    expect(http.get).toHaveBeenCalledWith('/projects/p1/ai/history/retention', { params: { days: 90 } });
    expect(http.patch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('ops-run-retention-save'));
    await waitFor(() => expect(http.patch).toHaveBeenCalledWith('/projects/p1/ai/settings', { runRetentionDays: 90 }));
    await waitFor(() => expect(saved).toHaveBeenCalled());
  });

  it('going back to Keep forever is saved at once', async () => {
    http.patch.mockImplementation(() => ok({}));
    wrap(<RunHistory projectId="p1" settings={{ runRetentionDays: 30 } as unknown as AiSettings} onSaved={() => {}} />);
    fireEvent.change(screen.getByTestId('ops-run-retention'), { target: { value: '0' } });
    await waitFor(() => expect(http.patch).toHaveBeenCalledWith('/projects/p1/ai/settings', { runRetentionDays: 0 }));
  });
});
