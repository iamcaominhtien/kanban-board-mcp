import { toCanvas, toSvg } from 'html-to-image';
import { applyPalette, GIFEncoder, quantize } from 'gifenc';
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
const GIF_FPS = 12;
const GIF_MAX_WIDTH = 720;

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

/**
 * An HTML board's animation as a GIF: the page's CSS and Web Animations are stepped frame by frame (12 a second, at most
 * 6 seconds) and drawn, so the result does not depend on how fast this computer is.
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
    const ratio = Math.min(1, GIF_MAX_WIDTH / b.w);
    const frames = Math.max(2, Math.min(MAX_SECONDS * GIF_FPS, Math.round(info.seconds * GIF_FPS)));
    const step = (info.seconds * 1000) / frames;
    const gif = GIFEncoder();
    let restore: (() => void) | null = null;
    for (let i = 0; i < frames; i++) {
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
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new CaptureError('This browser cannot draw the picture.');
      const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const palette = quantize(data, 256);
      gif.writeFrame(applyPalette(data, palette), width, height, {
        palette,
        delay: Math.round(step),
        repeat: i === 0 ? (info.loops ? 0 : -1) : undefined,
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
