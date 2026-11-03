import { toCanvas, toSvg } from 'html-to-image';
import { GIFEncoder, quantize } from 'gifenc';
import { boardFileUrl, boardPictureUrl, type CanvasBoard } from '../../api/canvases';

/** Thrown for a board that cannot be turned into a picture; the message is safe to show. */
export class CaptureError extends Error {}

/** What a page animates: how many animations, how long one run takes, and whether it loops. */
export interface AnimationInfo {
  count: number;
  /** Seconds one pass of the longest animation takes, capped. */
  seconds: number;
  /** Some animation repeats forever, so a GIF loops. */
  loops: boolean;
}

const MAX_SECONDS = 6;
const GIF_FPS = 15;
const GIF_MAX_WIDTH = 1280;
const GIF_MAX_PIXELS = 1_600_000;

/** A page loaded in a hidden frame at the board's size, ready to be drawn. */
interface OpenPage {
  frame: HTMLIFrameElement;
  doc: Document;
  close: () => void;
}

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new CaptureError('The picture could not be drawn.'));
    img.src = src;
  });

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The address to load a board's page from: a path when it is on the address the app came from, an https address, or an
 * address on this computer (the desktop app talks to its own server over plain http on the loopback). Any other plain
 * http address is refused, so a page is never fetched over an unencrypted connection from another machine.
 * @param url - The page's address.
 */
export function frameSource(url: string): string {
  const target = new URL(url, window.location.href);
  if (target.origin === window.location.origin) return `${target.pathname}${target.search}`;
  if (target.protocol === 'https:') return target.href;
  if (LOOPBACK.has(target.hostname)) return target.href;
  throw new CaptureError('The page is not on a secure address, so it was not loaded.');
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * Load a board's page, laid out at the board's own width and height, in a hidden frame and wait until it has run its
 * scripts and loaded its fonts. The page is the real one (open, with its scripts), so what is drawn is what a person sees.
 * @param canvasId - The canvas.
 * @param b - An HTML board.
 */
async function openPage(canvasId: string, b: CanvasBoard): Promise<OpenPage> {
  if (b.kind !== 'html' || !b.content) throw new CaptureError('Only a page can be drawn this way.');
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  Object.assign(frame.style, {
    position: 'fixed',
    left: '-100000px',
    top: '0',
    width: `${b.w}px`,
    height: `${b.h}px`,
    border: '0',
    opacity: '0',
    pointerEvents: 'none',
  });
  const loaded = new Promise<void>((resolve, reject) => {
    frame.addEventListener('load', () => resolve());
    frame.addEventListener('error', () => reject(new CaptureError('The page could not be loaded.')));
  });
  frame.src = frameSource(boardFileUrl(canvasId, b.id, b.content.rev, b.content.entry));
  document.body.appendChild(frame);
  const close = () => frame.remove();
  try {
    await Promise.race([
      loaded,
      wait(15000).then(() => Promise.reject(new CaptureError('The page took too long to load.'))),
    ]);
    const doc = frame.contentDocument;
    if (!doc) throw new CaptureError('The page could not be read.');
    await (doc.fonts ? doc.fonts.ready.catch(() => undefined) : Promise.resolve());
    await wait(500); // a page that draws itself with a script needs a moment
    return { frame, doc, close };
  } catch (e) {
    close();
    throw e;
  }
}

/** The colour behind the page: the body's, else the root's, else white. */
function backgroundOf(doc: Document): string {
  const win = doc.defaultView;
  if (!win) return '#ffffff';
  for (const el of [doc.body, doc.documentElement]) {
    const c = win.getComputedStyle(el).backgroundColor;
    if (c && c !== 'transparent' && c !== 'rgba(0, 0, 0, 0)') return c;
  }
  return '#ffffff';
}

const optionsFor = (b: CanvasBoard, doc: Document, ratio: number) => ({
  width: Math.round(b.w),
  height: Math.round(b.h),
  pixelRatio: ratio,
  backgroundColor: backgroundOf(doc),
  cacheBust: false,
});

async function render(page: OpenPage, b: CanvasBoard, ratio: number): Promise<HTMLCanvasElement> {
  try {
    return await toCanvas(page.doc.documentElement, optionsFor(b, page.doc, ratio));
  } catch {
    throw new CaptureError('This page could not be drawn as a picture.');
  }
}

const toBlob = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new CaptureError('The picture could not be made.'))),
      'image/png',
    ),
  );

/**
 * A board as a PNG, drawn in the browser: a picture, Sketch or Diagram as it is, an HTML page as it looks once loaded
 * and run (scripts, fonts and pictures included).
 * @param canvasId - The canvas.
 * @param b - The board.
 * @param ratio - Pixel ratio (2 for "PNG, 2x").
 */
export async function boardToPng(canvasId: string, b: CanvasBoard, ratio = 2): Promise<Blob> {
  const pic = b.kind === 'html' ? null : boardPictureUrl(canvasId, b);
  if (pic) {
    const w = Math.round(b.w * ratio);
    const h = Math.round(b.h * ratio);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new CaptureError('This browser cannot draw the picture.');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    const img = await loadImage(pic);
    const k = Math.min(w / img.width, h / img.height);
    ctx.drawImage(img, 0, 0, img.width * k, img.height * k);
    return toBlob(canvas);
  }
  const page = await openPage(canvasId, b);
  try {
    return await toBlob(await render(page, b, ratio));
  } finally {
    page.close();
  }
}

/**
 * An SVG made from a page, with everything that could run when the file is opened on its own taken out: scripts, event
 * handler attributes, frames and `javascript:` links. What is left is the picture.
 * @param svg - The SVG text.
 */
export function cleanSvg(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new CaptureError('This page could not be drawn as an SVG.');
  doc
    .querySelectorAll('script, iframe, frame, object, embed, applet, base, meta[http-equiv]')
    .forEach((e) => e.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
      else if (/^(href|xlink:href|src|action|formaction)$/i.test(attr.name) && /^\s*javascript:/i.test(attr.value))
        el.removeAttribute(attr.name);
    }
  });
  return new XMLSerializer().serializeToString(doc);
}

/**
 * An HTML board as an SVG file: the page as it looks once loaded and run, laid out inside the SVG (a `foreignObject`) with its
 * styles, fonts and pictures embedded. A browser shows it exactly; a vector editor may not.
 * @param canvasId - The canvas.
 * @param b - An HTML board.
 */
export async function boardToSvg(canvasId: string, b: CanvasBoard): Promise<Blob> {
  const page = await openPage(canvasId, b);
  try {
    const url = await toSvg(page.doc.documentElement, optionsFor(b, page.doc, 1));
    const text = decodeURIComponent(url.slice(url.indexOf(',') + 1));
    return new Blob([cleanSvg(text)], { type: 'image/svg+xml' });
  } catch {
    throw new CaptureError('This page could not be drawn as an SVG.');
  } finally {
    page.close();
  }
}

/**
 * What a loaded page animates with CSS or the Web Animations API (not a script that redraws on a timer, which cannot be
 * stepped).
 * @param doc - The page's document.
 */
export function animationInfo(doc: Document): AnimationInfo {
  let anims: Animation[] = [];
  try {
    anims = doc.getAnimations ? doc.getAnimations() : [];
  } catch {
    anims = [];
  }
  let seconds = 0;
  let loops = false;
  let count = 0;
  for (const a of anims) {
    const t = a.effect?.getComputedTiming();
    if (!t) continue;
    const pass = Number(t.duration) || 0;
    if (pass <= 0) continue;
    count++;
    const infinite = t.iterations === Infinity;
    if (infinite) loops = true;
    const end = infinite ? Number(t.delay) + pass : Number(t.endTime);
    seconds = Math.max(seconds, Math.min(MAX_SECONDS, (Number.isFinite(end) ? end : pass) / 1000));
  }
  return { count, seconds, loops };
}

/**
 * Whether a board's live page (when it is drawn live) has an animation; `null` when it is not drawn live and has to be loaded
 * to know.
 * @param frame - The board's frame in the editor, if any.
 */
export function liveAnimation(frame: HTMLIFrameElement | null): AnimationInfo | null {
  try {
    const doc = frame?.contentDocument;
    return doc ? animationInfo(doc) : null;
  } catch {
    return null;
  }
}

const kebab = (name: string) => (name === 'cssFloat' ? 'float' : name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
const SKIP_KEYS = new Set(['offset', 'computedOffset', 'easing', 'composite']);

/**
 * Make what the animations show right now permanent: the animated values are written into each element's own style and its
 * `animation-name` is turned off, so a copy of the page (drawn into an image, where an animation would start over from
 * zero) looks the same as the page at this moment. Returns a function that gives the page its animations back.
 * @param doc - The page's document.
 * @param anims - Its animations, already moved to the time to show.
 */
function freezeAnimations(doc: Document, anims: Animation[]): () => void {
  const win = doc.defaultView;
  const writes: { el: HTMLElement; prop: string; value: string }[] = [];
  const targets = new Set<HTMLElement>();
  for (const a of anims) {
    const effect = a.effect as KeyframeEffect | null;
    const el = effect?.target as HTMLElement | null;
    if (!win || !effect || !el || !el.style || effect.pseudoElement) continue;
    targets.add(el);
    const cs = win.getComputedStyle(el);
    const props = new Set<string>();
    for (const k of effect.getKeyframes())
      for (const key of Object.keys(k)) if (!SKIP_KEYS.has(key)) props.add(kebab(key));
    for (const prop of props) writes.push({ el, prop, value: cs.getPropertyValue(prop) });
  }
  const before = new Map<HTMLElement, { props: Map<string, string>; name: string }>();
  for (const el of targets) before.set(el, { props: new Map(), name: el.style.animationName });
  for (const w of writes) {
    const entry = before.get(w.el)!;
    if (!entry.props.has(w.prop)) entry.props.set(w.prop, w.el.style.getPropertyValue(w.prop));
    w.el.style.setProperty(w.prop, w.value);
  }
  for (const el of targets) el.style.animationName = 'none';
  return () => {
    for (const [el, was] of before) {
      for (const [prop, value] of was.props) {
        if (value) el.style.setProperty(prop, value);
        else el.style.removeProperty(prop);
      }
      el.style.animationName = was.name;
    }
  };
}

/** An 8 x 8 ordered-dither matrix, 0..63. */
const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54,
  22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29,
  53, 21,
];
const DITHER_STRENGTH = 14;
/** A pixel this close to a palette colour (squared distance) is taken as it is, so flat areas stay clean. */
const CLOSE = 3 * 4 * 4;

/**
 * Map a frame's pixels to a palette. A pixel the palette holds (almost) exactly keeps that colour; the rest (soft shadows,
 * gradients, anti-aliased edges) are dithered with a fixed pattern, which looks smoother than 256 flat steps and, because the
 * pattern depends only on the position, does not shimmer from one frame to the next where nothing moves.
 * @param rgba - The frame's pixels.
 * @param width - Its width.
 * @param palette - At most 256 colours `[r, g, b]`.
 * @param cache - Nearest colour per 15-bit colour, shared by all frames of one GIF (`Int16Array(32768)` filled with -1).
 */
export function ditherToPalette(
  rgba: Uint8ClampedArray,
  width: number,
  palette: number[][],
  cache: Int16Array,
): Uint8Array {
  const out = new Uint8Array(rgba.length / 4);
  const nearest = (r: number, g: number, b: number): number => {
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < palette.length; k++) {
      const c = palette[k];
      const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return best;
  };
  const lookup = (r: number, g: number, b: number): number => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let k = cache[key];
    if (k < 0) {
      k = nearest(r, g, b);
      cache[key] = k;
    }
    return k;
  };
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
  for (let i = 0, px = 0; i < rgba.length; i += 4, px++) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    const first = lookup(r, g, b);
    const c = palette[first];
    if ((c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2 <= CLOSE) {
      out[px] = first;
      continue;
    }
    const x = px % width;
    const y = (px - x) / width;
    const t = (BAYER[(y & 7) * 8 + (x & 7)] / 64 - 0.5) * DITHER_STRENGTH;
    out[px] = lookup(Math.trunc(clamp(r + t)), Math.trunc(clamp(g + t)), Math.trunc(clamp(b + t)));
  }
  return out;
}

/**
 * An HTML board's animation as a GIF: the page's CSS and Web Animations are stepped frame by frame (15 a second, at most
 * 6 seconds) and drawn, so the result does not depend on how fast this computer is. Frames are drawn at up to 2x, share one
 * palette (chosen from frames across the animation, so colours do not flicker) and are dithered.
 * @param canvasId - The canvas.
 * @param b - An HTML board.
 * @param onProgress - Called with 0..1 as frames are made.
 * @throws CaptureError when the page animates nothing.
 */
export async function boardToGif(canvasId: string, b: CanvasBoard, onProgress?: (done: number) => void): Promise<Blob> {
  const page = await openPage(canvasId, b);
  try {
    const info = animationInfo(page.doc);
    if (!info.count || info.seconds <= 0) throw new CaptureError('This page has no animation to record.');
    const ratio = Math.min(2, GIF_MAX_WIDTH / b.w, Math.sqrt(GIF_MAX_PIXELS / (b.w * b.h)));
    const frames = Math.max(2, Math.min(MAX_SECONDS * GIF_FPS, Math.round(info.seconds * GIF_FPS)));
    const step = (info.seconds * 1000) / frames;
    let restore = null as (() => void) | null;
    /** The page at frame `i`: the animations moved to its time and their values made permanent, then drawn. */
    const frameAt = async (i: number): Promise<ImageData> => {
      restore?.(); // the animations come back (starting over), to be moved to the time of this frame
      const anims = page.doc.getAnimations();
      for (const a of anims) {
        try {
          a.pause();
          a.currentTime = i * step;
        } catch {
          /* an animation that cannot be moved stays where it is */
        }
      }
      await nextFrame();
      restore = freezeAnimations(page.doc, anims);
      const canvas = await render(page, b, ratio);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new CaptureError('This browser cannot draw the picture.');
      return ctx.getImageData(0, 0, canvas.width, canvas.height);
    };
    // one palette for the whole GIF, from a handful of frames spread over the animation (every 3rd pixel of each)
    const picks = Array.from(
      new Set(
        Array.from({ length: Math.min(5, frames) }, (_, k) =>
          Math.round((k * (frames - 1)) / Math.max(1, Math.min(5, frames) - 1)),
        ),
      ),
    );
    const parts: Uint8ClampedArray[] = [];
    for (const i of picks) {
      const { data } = await frameAt(i);
      const sample = new Uint8ClampedArray(Math.ceil(data.length / 12) * 4);
      for (let src = 0, dst = 0; src < data.length; src += 12, dst += 4) sample.set(data.subarray(src, src + 4), dst);
      parts.push(sample);
    }
    const all = new Uint8ClampedArray(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.length;
    }
    const palette = quantize(all, 256);
    const cache = new Int16Array(32768).fill(-1);
    const gif = GIFEncoder();
    for (let i = 0; i < frames; i++) {
      const { data, width, height } = await frameAt(i);
      const index = ditherToPalette(data, width, palette, cache);
      gif.writeFrame(index, width, height, {
        ...(i === 0 ? { palette, repeat: info.loops ? 0 : -1 } : {}),
        delay: Math.round(step),
      });
      onProgress?.((i + 1) / frames);
    }
    restore?.();
    gif.finish();
    return new Blob([gif.bytes() as BlobPart], { type: 'image/gif' });
  } finally {
    page.close();
  }
}

/**
 * A file name from a board's name: letters, digits and dashes.
 * @param name - The board's name.
 */
export function fileStem(name: string): string {
  return name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'board';
}

/**
 * Hand a blob to the person as a download.
 * @param blob - The file.
 * @param name - Its file name.
 */
export function saveBlob(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
