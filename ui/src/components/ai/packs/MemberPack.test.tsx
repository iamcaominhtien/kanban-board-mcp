// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: http }));

import { MemberPackCard, lineDiff } from './MemberPackCard';

const ok = (data: unknown) => Promise.resolve({ data });
let state: Record<string, unknown> | null;
let diff: Record<string, unknown>;

beforeEach(() => {
  Object.values(http).forEach((f) => f.mockReset());
  state = { key: 'designer', name: 'Designer', version: 2, latest: 3, outdated: true, edited: true, history: [] };
  diff = {
    ...state,
    to: 3,
    changes: [
      {
        field: 'persona',
        label: 'Instructions',
        before: 'You are the Designer.\nDesign frames with every state.',
        after: 'You are the Designer.\nDesign frames following the guide.\nLook at your frames in a browser.',
      },
      { field: 'pack_plugins', label: 'Plugins', before: '', after: '["canvas-design"]' },
    ],
    kept: ['name', 'working folder', 'account', 'model', 'MCP servers you added yourself'],
  };
  http.get.mockImplementation((url: string) => {
    if (url === '/ai/members/m1/pack') return ok(state);
    if (url === '/ai/members/m1/pack/diff') return ok(diff);
    if (url === '/projects/p1/ai/packs')
      return ok([
        { key: 'designer', name: 'Designer', glyph: 'DS', tagline: 'Draws before anyone builds', builtin: true },
      ]);
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
});
afterEach(cleanup);

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemberPackCard memberId="m1" memberName="Designer Dao" projectId="p1" />
    </QueryClientProvider>,
  );

describe('lineDiff', () => {
  it('keeps the common lines in place and marks what went and what came', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'out', text: 'b' },
      { kind: 'in', text: 'B' },
      { kind: 'same', text: 'c' },
      { kind: 'in', text: 'd' },
    ]);
    expect(lineDiff('', 'x')).toEqual([{ kind: 'in', text: 'x' }]);
  });
});

describe('MemberPackCard', () => {
  it('draws nothing for a member not made from a pack', async () => {
    state = null;
    const { container } = mount();
    await waitFor(() => expect(http.get).toHaveBeenCalledWith('/ai/members/m1/pack'));
    expect(container.textContent).toBe('');
  });

  it('says a newer version is out', async () => {
    mount();
    expect((await screen.findByTestId('pack-out')).textContent).toBe('v3 is out');
    expect(screen.getByTestId('member-pack').textContent).toContain('made from v2');
    expect(await screen.findByText('Draws before anyone builds')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Update to v3' })).toBeTruthy();
    expect(screen.queryByTestId('pack-updated')).toBeNull();
  });

  it('shows what changes, what stays, and that the member’s own instructions go', async () => {
    mount();
    fireEvent.click(await screen.findByTestId('pack-see'));
    const dlg = await screen.findByTestId('pack-diff');
    await waitFor(() => expect(within(dlg).getByTestId('pack-diff-persona')).toBeTruthy());
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Update Designer Dao to Designer v3');
    const persona = within(dlg).getByTestId('pack-diff-persona');
    expect(persona.querySelectorAll('.pk-diff-out').length).toBe(1);
    expect(persona.querySelectorAll('.pk-diff-in').length).toBe(2);
    expect(persona.querySelectorAll('.pk-diff-same').length).toBe(1);
    expect(within(dlg).getByTestId('pack-diff-kept').textContent).toContain(
      'name, working folder, account, model, and MCP servers you added yourself',
    );
    expect(within(dlg).getByTestId('pack-diff-edited').textContent).toContain('You edited this member’s instructions');
    http.post.mockReturnValue(
      ok({
        ...state,
        version: 3,
        outdated: false,
        edited: false,
        history: [{ version: 2, at: new Date().toISOString(), by: 'You' }],
      }),
    );
    fireEvent.click(within(dlg).getByTestId('pack-diff-update'));
    await waitFor(() => expect(http.post).toHaveBeenCalledWith('/ai/members/m1/pack/update'));
    await waitFor(() => expect(screen.queryByTestId('pack-diff')).toBeNull());
  });

  it('updates, then offers the way back with the version history', async () => {
    mount();
    http.post.mockReturnValue(
      ok({ ...state, version: 3, outdated: false, history: [{ version: 2, at: '2026-11-02T14:02:00Z', by: 'You' }] }),
    );
    fireEvent.click(await screen.findByTestId('pack-update'));
    const done = await screen.findByTestId('pack-updated');
    expect(done.textContent).toContain('Updated to v3');
    expect(done.textContent).toContain('updated by You');
    expect(done.textContent).toContain('The next run starts a new conversation.');
    expect(within(done).getByTestId('pack-history').textContent).toContain('v3 now');
    expect(within(done).getByTestId('pack-history').textContent).toContain('v2 made from, kept 30 days');
    http.post.mockReturnValue(ok({ ...state, history: [] }));
    fireEvent.click(within(done).getByRole('button', { name: 'Go back to v2' }));
    await waitFor(() => expect(http.post).toHaveBeenLastCalledWith('/ai/members/m1/pack/revert'));
    await waitFor(() => expect(screen.queryByTestId('pack-updated')).toBeNull());
  });

  it('shows a refusal from the server', async () => {
    http.post.mockRejectedValue({ response: { data: { detail: 'The pack dev is gone.' } } });
    mount();
    fireEvent.click(await screen.findByTestId('pack-update'));
    expect((await screen.findByRole('alert')).textContent).toBe('The pack dev is gone.');
  });
});
