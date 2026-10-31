import { createContext, lazy, Suspense, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { uploadUrl } from '../../api/tickets';
import { SketchOwnerContext, type SketchOwner } from '../sketch/SketchContext';
import { CanvasOwnerContext, type CanvasOwner } from '../canvas/CanvasContext';
import { cleanDisplayFileName, getFileExtension } from '../../utils/fileIcons';
import type { PreviewItem } from './types';

const PreviewViewer = lazy(() => import('./PreviewViewer'));

interface Open {
  items: PreviewItem[];
  index: number;
  /** Element to give focus back to when the viewer closes. */
  returnTo: HTMLElement | null;
  /** Where "Draw on it" saves to, when the page that opened the viewer said so. */
  sketchOwner: SketchOwner | null;
  /** Where "Open on a canvas" puts the file as a board, when the page said so. */
  canvasOwner: CanvasOwner | null;
}

interface PreviewApi {
  /** Open the viewer on `items[index]`; next and previous move through `items`. */
  open: (items: PreviewItem[], index?: number) => void;
}

/** The provider's own open: the page's sketch owner rides along, so the viewer can offer "Draw on it". */
interface ProviderApi {
  open: (
    items: PreviewItem[],
    index?: number,
    sketchOwner?: SketchOwner | null,
    canvasOwner?: CanvasOwner | null,
  ) => void;
}

const PreviewContext = createContext<ProviderApi | null>(null);

/** Mounts the one viewer for the whole app. Anything that shows a file only says "open this". */
export function PreviewProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<Open | null>(null);
  const open = useCallback(
    (
      items: PreviewItem[],
      index = 0,
      sketchOwner: SketchOwner | null = null,
      canvasOwner: CanvasOwner | null = null,
    ) => {
      if (!items.length) return;
      setCurrent({
        items,
        index: Math.min(Math.max(index, 0), items.length - 1),
        returnTo: document.activeElement instanceof HTMLElement ? document.activeElement : null,
        sketchOwner,
        canvasOwner,
      });
    },
    [],
  );
  const api = useMemo(() => ({ open }), [open]);
  return (
    <PreviewContext.Provider value={api}>
      {children}
      {current && (
        <Suspense fallback={null}>
          <PreviewViewer
            items={current.items}
            index={current.index}
            sketchOwner={current.sketchOwner}
            canvasOwner={current.canvasOwner}
            onIndex={(i) => setCurrent((c) => (c ? { ...c, index: i } : c))}
            onClose={() => {
              const back = current.returnTo;
              setCurrent(null);
              if (back && document.contains(back)) requestAnimationFrame(() => back.focus());
            }}
          />
        </Suspense>
      )}
    </PreviewContext.Provider>
  );
}

/** Open files in the viewer. Outside the provider it does nothing. */
export function usePreview(): PreviewApi {
  const api = useContext(PreviewContext);
  // The viewer is mounted above every page, so the page's sketch owner is read here, where it is opened from
  const sketchOwner = useContext(SketchOwnerContext);
  const canvasOwner = useContext(CanvasOwnerContext);
  return useMemo(
    () => ({ open: (items: PreviewItem[], index?: number) => api?.open(items, index, sketchOwner, canvasOwner) }),
    [api, sketchOwner, canvasOwner],
  );
}

/**
 * Build a viewer item from a stored upload.
 * @param url - Upload path (`/uploads/...`).
 * @param name - Display name.
 * @param size - Size in bytes, when known.
 * @param extra - More facts for the header and details.
 */
export function itemFromUpload(url: string, name?: string, size?: number, extra?: Partial<PreviewItem>): PreviewItem {
  // Files stored by the app live under /uploads/; anything else (a link to an image elsewhere) is used as is
  const stored = url.includes('/uploads/');
  const path = stored ? url.slice(url.indexOf('/uploads/')) : url;
  let display = cleanDisplayFileName(name || url);
  // A picture's alt text is its name without the extension; the extension decides how the file opens
  const urlExt = getFileExtension(path);
  if (urlExt && !getFileExtension(display)) display = `${display}.${urlExt}`;
  return {
    id: `${url}|${display}`,
    name: display,
    src: stored ? uploadUrl(path, display, false, true) : url,
    downloadUrl: stored ? uploadUrl(path, display, true) : url,
    size,
    uploadPath: stored ? path : undefined,
    ...extra,
  };
}

/** Data attributes that mark an element as a file the viewer can open; the gallery is read from them. */
export function previewAttrs(url: string, name: string, size?: number) {
  return {
    'data-preview-url': url,
    'data-preview-name': name,
    ...(size ? { 'data-preview-size': String(size) } : {}),
  };
}

/**
 * The files around an element: everything marked with `previewAttrs` inside the nearest `data-preview-scope`
 * (a description, a comment, a page), so next and previous always make sense there.
 * @param el - The element that was clicked.
 */
export function galleryAround(el: HTMLElement): { items: PreviewItem[]; index: number } {
  const scope = el.closest<HTMLElement>('[data-preview-scope]') ?? el.parentElement ?? el;
  const nodes = Array.from(scope.querySelectorAll<HTMLElement>('[data-preview-url]'));
  if (!nodes.includes(el) && el.dataset.previewUrl) nodes.push(el);
  const keyOf = (node: HTMLElement) => `${node.dataset.previewUrl}|${node.dataset.previewName || ''}`;
  const clicked = keyOf(el);
  const seen = new Set<string>();
  const items: PreviewItem[] = [];
  let index = 0;
  nodes.forEach((node) => {
    const key = keyOf(node);
    if (seen.has(key)) return;
    seen.add(key);
    if (key === clicked) index = items.length;
    const url = node.dataset.previewUrl!;
    const name = node.dataset.previewName || url.split('/').pop() || 'file';
    const size = node.dataset.previewSize ? Number(node.dataset.previewSize) : undefined;
    const alt = node.tagName === 'IMG' ? (node as HTMLImageElement).alt || undefined : undefined;
    items.push(itemFromUpload(url, name, size, { alt }));
  });
  if (!items.length && el.dataset.previewUrl) {
    return { items: [itemFromUpload(el.dataset.previewUrl, el.dataset.previewName)], index: 0 };
  }
  return { items, index };
}

/**
 * The images inside an editor, with the clicked one first in line. Used by double-click and Space in the Docs editor,
 * where the images are not marked up with `previewAttrs`.
 * @param container - The editor surface.
 * @param clicked - The image that was opened.
 */
export function imagesIn(container: HTMLElement, clicked: HTMLImageElement): { items: PreviewItem[]; index: number } {
  const items: PreviewItem[] = [];
  let index = 0;
  container.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src');
    if (!src) return;
    const alt = img.getAttribute('alt') || undefined;
    if (img === clicked) index = items.length;
    items.push(itemFromUpload(src, alt || src.split('/').pop()?.split('?')[0], undefined, { alt }));
  });
  return { items, index };
}

/**
 * Every stored file in an editor (pictures and links to uploaded files) in page order, with the clicked one marked.
 * @param container - The editor surface.
 * @param clicked - The picture or link that was opened.
 */
export function filesIn(container: HTMLElement, clicked: HTMLElement): { items: PreviewItem[]; index: number } {
  const items: PreviewItem[] = [];
  let index = 0;
  container.querySelectorAll<HTMLElement>('img, a[href*="/uploads/"]').forEach((el) => {
    const isImg = el instanceof HTMLImageElement;
    const src = isImg ? el.getAttribute('src') : el.getAttribute('href');
    if (!src) return;
    const label = (isImg ? el.getAttribute('alt') : el.textContent)?.trim() || undefined;
    if (el === clicked || el.contains(clicked)) index = items.length;
    items.push(
      itemFromUpload(src, label || src.split('/').pop()?.split('?')[0], undefined, { alt: isImg ? label : undefined }),
    );
  });
  return { items, index };
}
