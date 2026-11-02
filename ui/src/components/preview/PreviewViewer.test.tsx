// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PreviewViewer from './PreviewViewer';
import { kindLabel } from './kinds';
import type { PreviewItem } from './types';

const items: PreviewItem[] = [
  { id: 'a', name: 'firmware.bin', src: '/uploads/firmware.bin', size: 6_300_000, uploadedBy: 'Tuan Vo' },
  { id: 'b', name: 'notes.bin', src: '/uploads/notes.bin', size: 2048 },
];

function mount(index = 0) {
  const props = { items, index, onIndex: vi.fn(), onClose: vi.fn() };
  render(<PreviewViewer {...props} />);
  return props;
}

describe('PreviewViewer (design preview-viewer B, preview-types M)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('puts ‹ › around the counter and draws the actions as named icon buttons', () => {
    const p = mount();
    expect(screen.getByLabelText('File 1 of 2').textContent).toBe('1 of 2');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(p.onIndex).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(p.onIndex).toHaveBeenLastCalledWith(1);
    // web build: Download and open and Copy link; Open in app only in the desktop app
    expect(screen.getByRole('link', { name: 'Download and open' }).getAttribute('href')).toBe('/uploads/firmware.bin');
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Open in app/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(p.onClose).toHaveBeenCalled();
  });

  it('opens Details with the facts and a full-width Download, and closes it from its own ×', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const panel = screen.getByRole('complementary', { name: 'Details' });
    expect(panel.textContent).toContain('Uploaded by');
    expect(panel.textContent).toContain('Tuan Vo');
    expect(panel.textContent).toContain('6.0 MB');
    expect(screen.getAllByRole('link', { name: /Download/ }).length).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(screen.queryByRole('complementary', { name: 'Details' })).toBeNull();
  });

  it('shows a file without a preview as a neutral tile with its facts and a primary Download', () => {
    mount();
    const panel = screen.getByTestId('no-preview');
    expect(panel.textContent).toContain('BIN');
    expect(panel.textContent).toContain('No preview available.');
    expect(panel.textContent).toContain('Uploaded by');
    expect(panel.querySelector('a[download]')?.textContent).toContain('Download');
  });

  it('reads the size from the server when the opener did not give it', async () => {
    const headers = new Headers({ 'content-range': 'bytes 0-0/10240' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 206, headers })),
    );
    render(
      <PreviewViewer
        items={[{ id: 'x', name: 'blob.bin', src: '/uploads/blob.bin' }]}
        index={0}
        onIndex={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByText(/File · 10\.0 KB/)).toBeTruthy());
  });

  it('names CSV, Markdown, HTML, audio and video in the subtitle', () => {
    expect(kindLabel('a.csv', 'Excel Spreadsheet')).toBe('CSV');
    expect(kindLabel('a.md', 'Plain Text')).toBe('Markdown');
    expect(kindLabel('a.html', 'Source Code')).toBe('HTML');
    expect(kindLabel('a.mp3', 'Media')).toBe('Audio');
    expect(kindLabel('a.mp4', 'Media')).toBe('Video');
    expect(kindLabel('a.sh', 'Source Code')).toBe('Shell');
    expect(kindLabel('a.bin', 'File')).toBe('File');
  });
});
