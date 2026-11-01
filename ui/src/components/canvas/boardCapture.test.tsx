// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { CanvasBoard } from '../../api/canvases';
import { animationInfo, cleanSvg, ditherToPalette, fileStem, frameSource, liveAnimation } from './boardCapture';
import { BoardMenu } from './EditorParts';

afterEach(cleanup);

const anim = (duration: number, iterations: number, delay = 0) =>
  ({
    effect: {
      getComputedTiming: () => ({
        duration,
        iterations,
        delay,
        endTime: iterations === Infinity ? Infinity : delay + duration * iterations,
      }),
    },
  }) as unknown as Animation;

test('what a page animates: how many, how long one pass is, and whether it loops', () => {
  const doc = document.implementation.createHTMLDocument('x');
  doc.getAnimations = () => [anim(1200, Infinity), anim(500, 2, 100), anim(0, 1)];
  expect(animationInfo(doc)).toEqual({ count: 2, seconds: 1.2, loops: true });
  doc.getAnimations = () => [anim(30000, 1)];
  expect(animationInfo(doc).seconds).toBe(6); // never longer than 6 seconds
  doc.getAnimations = () => [];
  expect(animationInfo(doc)).toEqual({ count: 0, seconds: 0, loops: false });
  expect(liveAnimation(null)).toBeNull(); // a frame that is only a picture is found out on click
});

test('an SVG made from a page keeps the picture and loses everything that could run', () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><foreignObject width="10" height="10">' +
    '<div xmlns="http://www.w3.org/1999/xhtml" onclick="steal()"><script>alert(1)</script><iframe src="x"></iframe>' +
    '<a href="javascript:alert(2)">go</a><a href="https://example.com/ok" onmouseover="x()">ok</a><p>Book dentist</p></div></foreignObject></svg>';
  const out = cleanSvg(svg);
  expect(out).not.toMatch(/<script|<iframe|onclick|onmouseover|javascript:/i);
  expect(out).toContain('Book dentist');
  expect(out).toContain('https://example.com/ok');
  expect(() => cleanSvg('<svg><oops></svg>')).toThrow();
});

test('file names are made from the board name', () => {
  expect(fileStem('Sign in: phone')).toBe('Sign-in-phone');
  expect(fileStem('Màn hình chính')).toBe('Màn-hình-chính');
  expect(fileStem('///')).toBe('board');
});

const board = (extra: Partial<CanvasBoard> = {}): CanvasBoard => ({
  id: 'b_aaaaaaaa',
  page: 'p_1',
  name: 'Today',
  kind: 'html',
  x: 0,
  y: 0,
  w: 390,
  h: 844,
  order: 0,
  ref: null,
  rev: 1,
  content: { rev: 1, entry: 'index.html', files: [], bytes: 1, skipped: [], title: 'Today' },
  ...extra,
});
const noop = () => undefined;
const menu = (b: CanvasBoard, animated: 'yes' | 'no' | 'unknown', onDownloadAs = vi.fn()) =>
  render(
    <BoardMenu
      board={b}
      canEdit
      aiAvailable={false}
      animated={animated}
      onEdit={noop}
      onAskAi={noop}
      onRename={noop}
      onSize={noop}
      onFitHeight={noop}
      onCustom={noop}
      onDuplicate={noop}
      onReplace={noop}
      onDownload={noop}
      onDownloadAs={onDownloadAs}
      onImage={noop}
      onCopyLink={noop}
      onDelete={noop}
    />,
  );

test('Download offers Files, Image, SVG and, for a page that animates, GIF', () => {
  const onDownloadAs = vi.fn();
  menu(board(), 'yes', onDownloadAs);
  expect(screen.queryByTestId('canvas-download-png')).toBeNull(); // folded until asked for
  fireEvent.click(screen.getByTestId('canvas-menu-download'));
  fireEvent.click(screen.getByTestId('canvas-download-png'));
  fireEvent.click(screen.getByTestId('canvas-download-svg'));
  fireEvent.click(screen.getByTestId('canvas-download-gif'));
  expect(onDownloadAs.mock.calls.map((c) => c[0])).toEqual(['png', 'svg', 'gif']);
  expect(screen.getByText('Files')).toBeTruthy();
});

test('no GIF for a page known not to animate, and no SVG or GIF for a picture', () => {
  menu(board(), 'no');
  fireEvent.click(screen.getByTestId('canvas-menu-download'));
  expect(screen.getByTestId('canvas-download-svg')).toBeTruthy();
  expect(screen.queryByTestId('canvas-download-gif')).toBeNull();
  cleanup();
  menu(board({ kind: 'image' }), 'unknown');
  fireEvent.click(screen.getByTestId('canvas-menu-download'));
  expect(screen.getByTestId('canvas-download-png')).toBeTruthy();
  expect(screen.queryByTestId('canvas-download-svg')).toBeNull();
  expect(screen.queryByTestId('canvas-download-gif')).toBeNull();
});

test("a page is loaded from the app's own address, https, or this computer; other plain http is refused", () => {
  const here = window.location.origin;
  expect(frameSource(`${here}/canvases/cv_1/boards/b_1/r/2/index.html?x=1`)).toBe(
    '/canvases/cv_1/boards/b_1/r/2/index.html?x=1',
  );
  expect(frameSource('https://board.example.com/canvases/cv_1/index.html')).toBe(
    'https://board.example.com/canvases/cv_1/index.html',
  );
  expect(frameSource('http://127.0.0.1:8000/canvases/cv_1/index.html')).toBe(
    'http://127.0.0.1:8000/canvases/cv_1/index.html',
  );
  expect(() => frameSource('http://board.example.com/canvases/cv_1/index.html')).toThrow(/secure address/);
});

test('a GIF frame keeps flat colours clean and dithers a gradient the same way every time', () => {
  const palette = [
    [255, 255, 255],
    [0, 0, 0],
    [128, 128, 128],
  ];
  const cache = () => new Int16Array(32768).fill(-1);
  const px = (rows: number[][]) => new Uint8ClampedArray(rows.flatMap(([r, g, b]) => [r, g, b, 255]));
  // flat areas of palette colours are not touched by the dither pattern
  const flat = px([...Array(64).fill([255, 255, 255]), ...Array(64).fill([0, 0, 0])]);
  const out = ditherToPalette(flat, 16, palette, cache());
  expect(Array.from(out.slice(0, 64)).every((i) => i === 0)).toBe(true);
  expect(Array.from(out.slice(64)).every((i) => i === 1)).toBe(true);
  // a colour between two palette colours is spread over both, so the area averages out instead of one flat step
  const mid = px(Array(256).fill([190, 190, 190]));
  const a = ditherToPalette(mid, 16, palette, cache());
  expect(new Set(a).size).toBeGreaterThan(1);
  // the pattern depends on the position only: the same frame twice gives the same result
  expect(Array.from(ditherToPalette(mid, 16, palette, cache()))).toEqual(Array.from(a));
});
