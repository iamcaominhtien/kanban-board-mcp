// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOCS_PHONE_BELOW, DOCS_TABLET_BELOW, docsLayoutFor, useDocsLayout, useKeyboardInset } from './useDocsLayout';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('docsLayoutFor', () => {
  it('splits the Docs area width into phone, tablet and desktop', () => {
    expect(docsLayoutFor(390)).toBe('phone');
    expect(docsLayoutFor(DOCS_PHONE_BELOW - 1)).toBe('phone');
    expect(docsLayoutFor(DOCS_PHONE_BELOW)).toBe('tablet');
    expect(docsLayoutFor(820)).toBe('tablet');
    expect(docsLayoutFor(DOCS_TABLET_BELOW - 1)).toBe('tablet');
    expect(docsLayoutFor(DOCS_TABLET_BELOW)).toBe('desktop');
    // a 1360 window less the 232 px project sidebar
    expect(docsLayoutFor(1128)).toBe('desktop');
  });
});

/** A ResizeObserver whose callback the test calls with a width. */
function stubResizeObserver() {
  const observers: { cb: ResizeObserverCallback; el?: Element }[] = [];
  class RO {
    cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
      observers.push({ cb });
    }
    observe(el: Element) {
      observers.find((o) => o.cb === this.cb)!.el = el;
    }
    disconnect() {}
    unobserve() {}
  }
  vi.stubGlobal('ResizeObserver', RO);
  return (width: number) =>
    observers.forEach((o) => o.cb([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver));
}

function Probe() {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const layout = useDocsLayout(el);
  return (
    <div ref={setEl} data-testid="area">
      {layout}
    </div>
  );
}

describe('useDocsLayout', () => {
  it('follows the width of the Docs area, not the window', () => {
    const resize = stubResizeObserver();
    const { getByTestId } = render(<Probe />);
    act(() => resize(1200));
    expect(getByTestId('area').textContent).toBe('desktop');
    act(() => resize(820));
    expect(getByTestId('area').textContent).toBe('tablet');
    act(() => resize(390));
    expect(getByTestId('area').textContent).toBe('phone');
  });

  it('falls back to the window width without ResizeObserver', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const before = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 500 });
    try {
      const { getByTestId } = render(<Probe />);
      expect(getByTestId('area').textContent).toBe('phone');
      act(() => {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1400 });
        window.dispatchEvent(new Event('resize'));
      });
      expect(getByTestId('area').textContent).toBe('desktop');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: before });
    }
  });
});

describe('useKeyboardInset', () => {
  it('is the part of the window the visual viewport leaves out (the on-screen keyboard)', () => {
    const listeners: Record<string, () => void> = {};
    const vv = {
      height: 800,
      offsetTop: 0,
      addEventListener: (t: string, f: () => void) => (listeners[t] = f),
      removeEventListener: () => undefined,
    };
    vi.stubGlobal('visualViewport', vv);
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    function KB() {
      return <span data-testid="kb">{useKeyboardInset(true)}</span>;
    }
    const { getByTestId } = render(<KB />);
    expect(getByTestId('kb').textContent).toBe('0');
    act(() => {
      vv.height = 500;
      listeners.resize();
    });
    expect(getByTestId('kb').textContent).toBe('300');
  });
});
