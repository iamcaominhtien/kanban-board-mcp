// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFaviconDot } from './useFaviconDot';

const ORIGINAL = 'http://localhost/logo.svg';

function installImageAndCanvas() {
  class FakeImage {
    crossOrigin = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_v: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal('Image', FakeImage);
  const draw = { arc: vi.fn(), fill: vi.fn(), beginPath: vi.fn(), drawImage: vi.fn(), fillStyle: '' };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(draw as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,DOT');
  return draw;
}

const link = () => document.querySelector<HTMLLinkElement>('link[rel~="icon"]')!;

describe('useFaviconDot', () => {
  beforeEach(() => {
    document.head.innerHTML = `<link rel="icon" type="image/svg+xml" href="${ORIGINAL}">`;
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (window as { electronAPI?: unknown }).electronAPI;
  });

  it('puts a red dot on the icon while something needs you, and takes it off when nothing does', async () => {
    const draw = installImageAndCanvas();
    const { rerender } = renderHook(({ n }) => useFaviconDot(n), { initialProps: { n: 2 } });
    await waitFor(() => expect(link().href).toBe('data:image/png;base64,DOT'));
    expect(draw.drawImage).toHaveBeenCalled();
    expect(link().type).toBe('image/png');
    rerender({ n: 5 }); // a different count is the same dot
    expect(link().href).toBe('data:image/png;base64,DOT');
    rerender({ n: 0 });
    expect(link().href).toBe(ORIGINAL);
    expect(link().type).toBe('image/svg+xml');
  });

  it('leaves the icon alone when nothing needs you', () => {
    installImageAndCanvas();
    renderHook(() => useFaviconDot(0));
    expect(link().href).toBe(ORIGINAL);
  });

  it('leaves the icon alone in the desktop app', () => {
    installImageAndCanvas();
    (window as unknown as { electronAPI: unknown }).electronAPI = {};
    renderHook(() => useFaviconDot(3));
    expect(link().href).toBe(ORIGINAL);
  });

  it('keeps the icon when it cannot be drawn', async () => {
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_v: string) {
          queueMicrotask(() => this.onerror?.());
        }
      },
    );
    renderHook(() => useFaviconDot(3));
    await Promise.resolve();
    await Promise.resolve();
    expect(link().href).toBe(ORIGINAL);
  });

  it('does nothing on a page without an icon', () => {
    document.head.innerHTML = '';
    expect(() => renderHook(() => useFaviconDot(3))).not.toThrow();
  });
});
