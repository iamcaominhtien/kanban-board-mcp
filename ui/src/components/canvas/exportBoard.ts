import { boardFileUrl, boardPictureUrl, type CanvasBoard } from '../../api/canvases';
import { makeSafeHtml } from '../preview/htmlSafe';
import { dataUrl, inlineBoard } from './sourcePreview';

const TEXT = /\.(html?|css|txt|md|json)$/i;

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The picture could not be drawn.'));
    img.src = src;
  });

/**
 * A board as a PNG at 2x, drawn in the browser: a picture, Sketch or Diagram as it is, an HTML page by laying the page
 * out in an SVG `foreignObject` with its own styles and pictures inlined (still without scripts or outside requests).
 * @param canvasId - The canvas.
 * @param b - The board.
 * @param ratio - Pixel ratio (2 for "PNG, 2x").
 */
export async function boardToPng(canvasId: string, b: CanvasBoard, ratio = 2): Promise<Blob> {
  const w = Math.round(b.w * ratio);
  const h = Math.round(b.h * ratio);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot draw the picture.');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  const pic = b.kind === 'html' ? null : boardPictureUrl(canvasId, b);
  if (pic) {
    const img = await loadImage(pic);
    const k = Math.min(w / img.width, h / img.height);
    ctx.drawImage(img, 0, 0, img.width * k, img.height * k);
  } else if (b.kind === 'html' && b.content) {
    const text: Record<string, string> = {};
    const assets: Record<string, string> = {};
    await Promise.all(
      b.content.files.slice(0, 80).map(async (f) => {
        const r = await fetch(boardFileUrl(canvasId, b.id, b.content!.rev, f.path));
        if (!r.ok) return;
        if (TEXT.test(f.path)) text[f.path] = await r.text();
        else
          assets[f.path] = dataUrl(
            await r.arrayBuffer(),
            r.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream',
          );
      }),
    );
    const safe = makeSafeHtml(inlineBoard(b.content.entry, text, assets));
    const parsed = new DOMParser().parseFromString(safe.srcDoc, 'text/html');
    const styles = Array.from(parsed.querySelectorAll('style'))
      .map((s) => s.outerHTML)
      .join('');
    const inner = new XMLSerializer()
      .serializeToString(parsed.body)
      .replace('<body', '<div')
      .replace('</body>', '</div>');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${b.w}px;height:${b.h}px;transform:scale(${ratio});transform-origin:0 0;overflow:hidden;background:#fff">${styles}${inner}</div></foreignObject></svg>`;
    const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    ctx.drawImage(img, 0, 0);
  }
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The picture could not be made.'))), 'image/png'),
  );
}

/**
 * Print the boards of a canvas, one per page, from the browser's print dialog ("Save as PDF"). Each board is a locked
 * frame, so printing runs no script.
 * @param canvasId - The canvas.
 * @param title - Used as the document title.
 * @param boards - The boards, in order.
 */
export function printBoards(canvasId: string, title: string, boards: CanvasBoard[]): boolean {
  const win = window.open('', '_blank');
  if (!win) return false;
  const pages = boards
    .filter((b) => b.kind === 'html' && b.content)
    .map(
      (b) =>
        `<section style="page-break-after:always;break-after:page;width:${Math.round(b.w)}px"><h3 style="font:600 13px sans-serif;margin:0 0 6px">${b.name.replace(/[<&]/g, ' ')}</h3><iframe sandbox="" referrerpolicy="no-referrer" src="${boardFileUrl(canvasId, b.id, b.content!.rev, b.content!.entry)}" style="width:${Math.round(b.w)}px;height:${Math.round(b.h)}px;border:1px solid #ccc"></iframe></section>`,
    )
    .join('');
  const safeTitle = title.replace(/[<&]/g, ' ');
  win.document.write(
    `<!doctype html><title>${safeTitle}</title><style>@page{margin:10mm}body{margin:0}</style>${pages || '<p>No HTML boards to print.</p>'}`,
  );
  win.document.close();
  const frames = Array.from(win.document.querySelectorAll('iframe'));
  void Promise.all(
    frames.map(
      (f) =>
        new Promise<void>((res) => {
          f.addEventListener('load', () => res());
          setTimeout(res, 4000);
        }),
    ),
  ).then(() => win.print());
  return true;
}
