import { boardFileUrl, type CanvasBoard } from '../../api/canvases';

/**
 * Print the boards of a canvas, one per page, from the browser's print dialog ("Save as PDF"). Each board is an open
 * frame, so a page that draws itself with a script prints as it looks.
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
        `<section style="page-break-after:always;break-after:page;width:${Math.round(b.w)}px"><h3 style="font:600 13px sans-serif;margin:0 0 6px">${b.name.replace(/[<&]/g, ' ')}</h3><iframe src="${boardFileUrl(canvasId, b.id, b.content!.rev, b.content!.entry)}" style="width:${Math.round(b.w)}px;height:${Math.round(b.h)}px;border:1px solid #ccc"></iframe></section>`,
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
