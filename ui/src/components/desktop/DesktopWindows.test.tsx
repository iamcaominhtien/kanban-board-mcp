// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../Toast';
import { AboutWindow, ReportIssueWindow } from './DesktopWindows';

const info = {
  appName: 'Kanban Board',
  version: '3.15.0',
  backendRunning: true,
  osName: 'macOS',
  osVersion: '15.1',
  arch: 'arm64',
  electron: '39',
  chrome: '140',
  language: 'en',
  window: [1400, 900],
};

describe('desktop windows (design desktop-menu E)', () => {
  beforeEach(() => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      platform: 'linux',
      getAppInfo: vi.fn().mockResolvedValue(info),
      openExternal: vi.fn(),
    };
  });
  afterEach(() => {
    cleanup();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('Report an issue shows only the facts, then what is and is never included', async () => {
    render(
      <ToastProvider>
        <ReportIssueWindow onClose={vi.fn()} />
      </ToastProvider>,
    );
    const facts = await screen.findByTestId('report-facts');
    expect(facts.textContent).toContain('App 3.15.0 · Backend running');
    expect(facts.textContent).toContain('macOS 15.1 (arm64) · Electron 39');
    expect(facts.textContent).toContain('Window 1400 × 900 · Language en');
    expect(screen.queryByText(/What happened/)).toBeNull();
    expect(screen.getByText('Included: versions, system, window size')).toBeTruthy();
    expect(screen.getByText('Never included: tickets, Docs, file paths, keys, logs')).toBeTruthy();
    for (const name of ['Cancel', 'Copy text', 'Open GitHub'])
      expect(screen.getByRole('button', { name })).toBeTruthy();
  });

  it('About is titled with the app name and keeps its actions', async () => {
    render(
      <ToastProvider>
        <AboutWindow onClose={vi.fn()} />
      </ToastProvider>,
    );
    expect(screen.getByRole('dialog', { name: 'About Kanban Board' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Kanban Board' })).toBeTruthy();
    await screen.findByText(/Version 3\.15\.0/);
    for (const name of ['Release notes', 'Copy diagnostics']) expect(screen.getByRole('button', { name })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Close' }).length).toBe(2);
  });
});
