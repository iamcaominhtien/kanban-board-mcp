// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BottomSheet, DocsDrawer } from './DocsSheets';

afterEach(cleanup);

describe('DocsDrawer', () => {
  it('closes with a tap on the dimmed page, Esc, or a swipe back to its side', () => {
    const onClose = vi.fn();
    render(
      <DocsDrawer label="Pages" onClose={onClose} testId="tree-drawer">
        <button type="button">Overview</button>
      </DocsDrawer>,
    );
    const drawer = screen.getByRole('dialog', { name: 'Pages' });
    // the focus moves into it
    expect(document.activeElement?.textContent).toBe('Overview');
    fireEvent.click(screen.getByTestId('tree-drawer-overlay').querySelector('.dk-scrim')!);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.touchStart(drawer, { touches: [{ clientX: 300, clientY: 100 }] });
    fireEvent.touchEnd(drawer, { changedTouches: [{ clientX: 200, clientY: 100 }] });
    expect(onClose).toHaveBeenCalledTimes(3);
    // a short move is not a swipe
    fireEvent.touchStart(drawer, { touches: [{ clientX: 300, clientY: 100 }] });
    fireEvent.touchEnd(drawer, { changedTouches: [{ clientX: 280, clientY: 100 }] });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});

describe('BottomSheet', () => {
  it('has a title and a close button and closes when dragged down', () => {
    const onClose = vi.fn();
    render(
      <BottomSheet label="On this page" onClose={onClose} testId="toc-sheet">
        <a href="#a">Smaller batches</a>
      </BottomSheet>,
    );
    expect(screen.getByRole('dialog', { name: 'On this page' }).textContent).toContain('Smaller batches');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    const grab = screen.getByTestId('toc-sheet').querySelector('.dk-sheet-grab')!;
    fireEvent.touchStart(grab, { touches: [{ clientX: 100, clientY: 400 }] });
    fireEvent.touchEnd(grab, { changedTouches: [{ clientX: 100, clientY: 520 }] });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
