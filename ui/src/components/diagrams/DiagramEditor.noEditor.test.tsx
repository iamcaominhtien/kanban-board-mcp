// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  settings: {
    mode: 'self-hosted',
    url: '',
    effectiveUrl: 'http://localhost:8080',
    defaultSelfHostedUrl: 'http://localhost:8080',
    publicUrl: 'https://embed.diagrams.net',
    sendsDrawingsToThirdParty: false,
  },
  checkDiagramEditor: vi.fn(),
  saveDiagramSettings: vi.fn(),
}));

vi.mock('../../api/diagrams', async (orig) => ({
  ...(await orig<typeof import('../../api/diagrams')>()),
  useDiagramSettings: () => ({ data: api.settings }),
  checkDiagramEditor: api.checkDiagramEditor,
  saveDiagramSettings: api.saveDiagramSettings,
}));

import { ToastProvider } from '../Toast';
import { DiagramEditor } from './DiagramEditor';

function open() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <DiagramEditor request={{ projectId: 'p1', onSaved: () => undefined }} onClose={() => undefined} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('DiagramEditor without a draw.io editor', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('says at once that no editor runs at the address, instead of spinning for 20 seconds', async () => {
    api.checkDiagramEditor.mockResolvedValue({ mode: 'self-hosted', url: 'http://localhost:8080', reachable: false });
    open();
    const card = await screen.findByTestId('diagram-editor-unreachable');
    expect(card.textContent).toContain('No draw.io editor is running');
    expect(card.textContent).toContain('http://localhost:8080');
    expect(screen.queryByTitle('draw.io editor')).toBeNull();
  });

  it('switches to the public editor in one click and tries again', async () => {
    api.checkDiagramEditor.mockResolvedValue({ mode: 'self-hosted', url: 'http://localhost:8080', reachable: false });
    api.saveDiagramSettings.mockImplementation(async () => {
      Object.assign(api.settings, { mode: 'public', effectiveUrl: 'https://embed.diagrams.net' });
      return api.settings;
    });
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Use the public editor' }));
    await waitFor(() => expect(api.saveDiagramSettings).toHaveBeenCalledWith({ mode: 'public', url: '' }));
    await waitFor(() => expect(screen.queryByText('No draw.io editor is running')).toBeNull());
    expect(screen.getByTitle('draw.io editor').getAttribute('src')).toContain('embed.diagrams.net');
    Object.assign(api.settings, { mode: 'self-hosted', effectiveUrl: 'http://localhost:8080' });
  });

  it('opens the editor as before when one answers', async () => {
    api.checkDiagramEditor.mockResolvedValue({ mode: 'self-hosted', url: 'http://localhost:8080', reachable: true });
    open();
    await waitFor(() => expect(api.checkDiagramEditor).toHaveBeenCalled());
    expect(screen.getByTitle('draw.io editor')).toBeTruthy();
    expect(screen.queryByTestId('diagram-editor-unreachable')).toBeNull();
  });
});

describe('DiagramEditor with the editor built into the app', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    Object.assign(api.settings, {
      mode: 'self-hosted',
      effectiveUrl: 'http://localhost:8080',
      builtInAvailable: undefined,
    });
  });

  it('opens the built-in editor from the board itself, with every internet service off', async () => {
    Object.assign(api.settings, {
      mode: 'built-in',
      effectiveUrl: 'http://127.0.0.1:5123/drawio',
      builtInAvailable: true,
    });
    open();
    const src = screen.getByTitle('draw.io editor').getAttribute('src') ?? '';
    expect(src.startsWith('http://127.0.0.1:5123/drawio/?')).toBe(true);
    expect(new URL(src).searchParams.get('stealth')).toBe('1');
    expect(new URL(src).searchParams.get('embed')).toBe('1');
    expect(api.checkDiagramEditor).not.toHaveBeenCalled();
  });

  it('offers the built-in editor when a self-hosted address does not answer', async () => {
    Object.assign(api.settings, { builtInAvailable: true });
    api.checkDiagramEditor.mockResolvedValue({ mode: 'self-hosted', url: 'http://localhost:8080', reachable: false });
    api.saveDiagramSettings.mockResolvedValue(api.settings);
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Use the built-in editor' }));
    await waitFor(() => expect(api.saveDiagramSettings).toHaveBeenCalledWith({ mode: 'built-in', url: '' }));
    expect(screen.queryByRole('button', { name: 'Use the public editor' })).toBeNull();
  });
});
