// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../../types/ticket';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn(), patch: vi.fn() }));
vi.mock('../../../api/client', () => ({ client: api }));

import { ToastProvider } from '../../Toast';
import { DocsSpaceSettings, SPACE_DEFAULTS } from './DocsSpaceSettings';

const PROJECT = { id: 'p1', name: 'Kanban Board', docsEnabled: true } as Project;

function setup(o: { role?: 'admin' | 'member'; project?: Project } = {}) {
  api.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/docs/settings')) return { data: { ...SPACE_DEFAULTS, aiApply: { tm_1: 'direct' } } };
    if (url.endsWith('/docs/access'))
      return {
        data: { access: true, role: o.role ?? 'admin', canEdit: true, policy: 'members', me: 'An', admins: ['Hoa'] },
      };
    if (url.endsWith('/docs/gallery'))
      return {
        data: {
          builtin: [
            { id: 'blank', name: 'Blank', description: '', category: 'work', settings: {}, preview: '' },
            {
              id: 'blog-post',
              name: 'Blog post',
              description: 'Cover, centred title',
              category: 'writing',
              settings: {},
              preview: '',
            },
          ],
          yours: [],
          project: [],
          defaultTemplate: 'blank',
          hidden: [],
        },
      };
    if (url.endsWith('/docs/ai'))
      return {
        data: { candidates: [{ id: 'tm_1', name: 'Docs team', provider: 'claude', connection: 'ok', model: null }] },
      };
    if (url.endsWith('/docs/tree')) return { data: [] };
    return { data: null };
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <DocsSpaceSettings project={o.project ?? PROJECT} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const disabled = (el: Element) => el.matches(':disabled');

beforeEach(() => Object.values(api).forEach((f) => f.mockReset()));
afterEach(cleanup);

describe('Settings › Docs', () => {
  it('an admin’s change is sent as it is made, keys as the contract names them', async () => {
    setup();
    await screen.findByTestId('ds-tpl-blog-post');
    api.patch.mockResolvedValue({ data: { ...SPACE_DEFAULTS, newPage: { ...SPACE_DEFAULTS.newPage, width: 'wide' } } });
    const width = screen.getByRole('radiogroup', { name: 'Page width' });
    await act(async () => {
      fireEvent.click(within(width).getByRole('radio', { name: 'Wide' }));
    });
    expect(api.patch).toHaveBeenCalledWith(
      '/projects/p1/docs/settings',
      { settings: { newPage: { width: 'wide' } } },
      { rawKeys: ['settings'], keepKeys: true },
    );
    expect(screen.getByTestId('ds-preview')).toBeTruthy();
  });

  it('sends the switches, the gallery choice and the limits', async () => {
    setup();
    await screen.findByTestId('ds-tpl-blog-post');
    api.patch.mockResolvedValue({ data: SPACE_DEFAULTS });
    const sent = () => api.patch.mock.calls.map((c) => c[1].settings);
    await act(async () => {
      fireEvent.click(screen.getByTestId('ds-public-links'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('ds-tpl-blog-post'));
    });
    const image = screen.getByLabelText('Image size in MB');
    fireEvent.change(image, { target: { value: '20' } });
    await act(async () => {
      fireEvent.blur(image);
    });
    // the HTML embed size is the server's limit (10 MB), not the old 512 KB
    expect(screen.getByText('10.0 MB')).toBeTruthy();
    expect(screen.queryByText('512 KB')).toBeNull();
    // the per-team "How … changes pages" lives in the AI in Docs card, not here
    expect(screen.queryByRole('radiogroup', { name: /changes pages/ })).toBeNull();
    expect(sent()).toEqual([
      { allowPublicLinks: false },
      { hiddenTemplates: ['blog-post'] },
      { uploads: { imageMb: 20 } },
    ]);
  });

  it('someone who is not an admin can read it but not change it, and is told why', async () => {
    setup({ role: 'member' });
    await screen.findByText('Only project admins can change these settings.');
    const width = screen.getByRole('radiogroup', { name: 'Page width' });
    expect(disabled(within(width).getByRole('radio', { name: 'Wide' }))).toBe(true);
    expect(disabled(screen.getByTestId('ds-public-links'))).toBe(true);
    fireEvent.click(within(width).getByRole('radio', { name: 'Wide' }));
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('while Docs is off everything is dimmed and nothing is asked of the server', () => {
    setup({ project: { ...PROJECT, docsEnabled: false } });
    expect(screen.getByTestId('docs-settings-why').textContent).toContain('Docs is off for this project.');
    expect(screen.getByTestId('docs-space-settings').className).toContain('ds-off');
    expect(api.get).not.toHaveBeenCalled();
  });

  it('a save that fails goes back, and the card says why', async () => {
    setup();
    await screen.findByTestId('ds-tpl-blog-post');
    api.patch.mockRejectedValue({
      response: { status: 500, data: { detail: { code: 'boom', message: 'The server didn’t answer.' } } },
    });
    const expiry = screen.getByRole('radiogroup', { name: 'New public links expire' });
    await act(async () => {
      fireEvent.click(within(expiry).getByRole('radio', { name: '30 days' }));
    });
    await waitFor(() => expect(screen.getByTestId('docs-settings-error')).toBeTruthy());
    expect(screen.getByTestId('docs-settings-error').textContent).toContain(
      'Couldn’t save “Expire: 30 days”. The server didn’t answer. The setting is still “Never”.',
    );
    expect(within(expiry).getByRole('radio', { name: 'Never' }).getAttribute('aria-checked')).toBe('true');
  });
});
