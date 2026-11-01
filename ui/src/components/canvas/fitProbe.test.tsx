// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { CanvasBoard } from '../../api/canvases';
import { contentHeight, FitProbe } from './FitProbe';

afterEach(cleanup);

const board = (extra: Partial<CanvasBoard> = {}): CanvasBoard => ({
  id: 'b_aaaaaaaa',
  page: 'p_1',
  name: 'Motion',
  kind: 'html',
  x: 0,
  y: 0,
  w: 1280,
  h: 800,
  order: 0,
  ref: null,
  rev: 2,
  fit: true,
  content: { rev: 2, entry: 'index.html', files: [], bytes: 1, skipped: [], title: 'Motion' },
  ...extra,
});

test('the height of a page is its root element, or the body when that is taller', () => {
  const doc = document.implementation.createHTMLDocument('x');
  vi.spyOn(doc.documentElement, 'getBoundingClientRect').mockReturnValue({ height: 1271.4 } as DOMRect);
  Object.defineProperty(doc.body, 'scrollHeight', { value: 1200, configurable: true });
  expect(contentHeight(doc)).toBe(1272);
  Object.defineProperty(doc.body, 'scrollHeight', { value: 1500, configurable: true });
  expect(contentHeight(doc)).toBe(1500);
});

test('the probe is a hidden, unreachable copy of the page at the board width, and tells the height once loaded', async () => {
  vi.useFakeTimers();
  const onFit = vi.fn();
  const { getByTestId } = render(<FitProbe canvasId="cv_12345678" board={board()} onFit={onFit} />);
  const frame = getByTestId('fit-probe') as HTMLIFrameElement;
  expect(frame.style.width).toBe('1280px');
  expect(frame.style.pointerEvents).toBe('none');
  expect(frame.getAttribute('aria-hidden')).toBe('true');
  expect(frame.getAttribute('src')).toMatch(/\/canvases\/cv_12345678\/boards\/b_aaaaaaaa\/r\/2\/index\.html$/);
  const doc = document.implementation.createHTMLDocument('page');
  vi.spyOn(doc.documentElement, 'getBoundingClientRect').mockReturnValue({ height: 1272 } as DOMRect);
  Object.defineProperty(frame, 'contentDocument', { value: doc, configurable: true });
  fireEvent.load(frame);
  await vi.advanceTimersByTimeAsync(600);
  expect(onFit).toHaveBeenCalledWith(1272);
  vi.useRealTimers();
});

test('only an HTML board with content is measured', () => {
  const { container } = render(<FitProbe canvasId="cv_12345678" board={board({ kind: 'image' })} onFit={vi.fn()} />);
  expect(container.querySelector('iframe')).toBeNull();
});
