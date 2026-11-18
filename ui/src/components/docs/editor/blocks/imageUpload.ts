/**
 * Putting a picture on the page (board D 14–21): the image goes in at once as `uploading:<id>` (the readers skip that
 * address) and draws its local preview with the progress and Cancel; when the upload is done its address takes the
 * place of the placeholder. A failed upload keeps the picture in this browser with Try again; a file over the
 * project's limit is not sent and says by how much (Shrink and insert makes a smaller copy). Uploads go to the
 * project's Docs uploads (`POST /projects/{id}/docs/uploads`, kind `image`), which hold the project's limit and scan
 * the file; an editor without a project (no block layer yet) uses `POST /uploads/images`.
 */

import type { Editor } from '@tiptap/core';
import { client } from '../../../../api/client';
import { resolveOrigin } from '../../../../api/resolveOrigin';
import { blockKitOf } from './bus';
import type { Placement } from './commands';

/** Where one upload is; `waiting`: offline, sent by itself when the connection returns (Docs states C 14). */
export type UploadStatus = 'uploading' | 'failed' | 'tooLarge' | 'waiting';

/** One picture on its way to the server. */
export interface PendingUpload {
  id: string;
  file: File;
  /** A local address of the picture (an object URL) to draw while it uploads. */
  preview: string;
  status: UploadStatus;
  /** Bytes sent so far. */
  loaded: number;
  /** The image limit in MB the file was checked against. */
  limitMb: number;
  abort?: AbortController;
  /** The editor the picture is in (a waiting upload is sent there when the connection returns). */
  editor?: Editor;
}

const pending = new Map<string, PendingUpload>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Follows the uploads (for useSyncExternalStore); returns the function that stops it. */
export function subscribeUploads(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The upload behind an `uploading:<id>` address, if this browser has it. */
export function uploadFor(src: string): PendingUpload | undefined {
  return src.startsWith('uploading:') ? pending.get(src.slice('uploading:'.length)) : undefined;
}

let version = 0;
/** A number that changes whenever an upload changes (the store's snapshot). */
export const uploadsVersion = () => version;

function update(id: string, patch: Partial<PendingUpload>) {
  const u = pending.get(id);
  if (!u) return;
  pending.set(id, { ...u, ...patch });
  version += 1;
  notify();
}

/** The picture types the image upload takes. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];

/** True for a file the image upload takes. */
export const isImageFile = (f: File) => IMAGE_TYPES.includes(f.type);

/** Where the `image` node with address `src` is, or null. */
export function findImage(editor: Editor, src: string): number | null {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === 'image' && node.attrs.src === src) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** The absolute address of a stored upload (`/uploads/…` from the server). */
export const uploadedSrc = (url: string) => (url.startsWith('/uploads/') ? `${resolveOrigin()}${url}` : url);

/** Options of {@link startImageUpload}. */
export interface StartOptions {
  /** Where to put the image (a document position); the cursor when unset. */
  at?: number;
  /** Replace the picture of the image at this position instead (its place, size and caption stay). */
  replacePos?: number;
  /** The image's place (`floatLeft` when a file is dropped beside the text). */
  placement?: Placement;
  /** The project's image limit in MB. */
  limitMb: number;
}

/**
 * Puts `file` on the page as an uploading image and sends it (unless it is over the limit).
 * @returns The upload's id.
 */
export function startImageUpload(editor: Editor, file: File, opts: StartOptions): string {
  const id = newId();
  const tooLarge = file.size > opts.limitMb * 1024 * 1024;
  pending.set(id, {
    id,
    file,
    preview: URL.createObjectURL(file),
    status: tooLarge ? 'tooLarge' : 'uploading',
    loaded: 0,
    limitMb: opts.limitMb,
  });
  version += 1;
  const src = `uploading:${id}`;
  if (opts.replacePos != null) {
    const node = editor.state.doc.nodeAt(opts.replacePos);
    if (node?.type.name === 'image')
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(opts.replacePos, undefined, { ...node.attrs, src, crop: null }),
      );
  } else {
    const node = {
      type: 'image',
      attrs: { src, alt: file.name.replace(/\.[^.]+$/, ''), ...(opts.placement ? { placement: opts.placement } : {}) },
    };
    const chain = editor.chain().focus();
    (opts.at != null ? chain.insertContentAt(opts.at, node) : chain.insertContent(node)).run();
  }
  notify();
  if (!tooLarge) void send(editor, id);
  return id;
}

async function send(editor: Editor, id: string) {
  const u = pending.get(id);
  if (!u) return;
  if (!navigator.onLine) {
    update(id, { status: 'waiting', editor, abort: undefined });
    return;
  }
  const abort = new AbortController();
  update(id, { status: 'uploading', loaded: 0, abort });
  const projectId = blockKitOf(editor)?.projectId;
  const form = new FormData();
  if (projectId) form.append('kind', 'image');
  form.append('file', u.file);
  try {
    const res = await client.post<{ src?: string; url?: string }>(
      projectId ? `/projects/${projectId}/docs/uploads` : '/uploads/images',
      form,
      {
        signal: abort.signal,
        onUploadProgress: (e) => update(id, { loaded: e.loaded }),
      },
    );
    const stored = res.data.src ?? res.data.url ?? '';
    const pos = editor.isDestroyed ? null : findImage(editor, `uploading:${id}`);
    if (pos !== null) {
      const node = editor.state.doc.nodeAt(pos);
      if (node)
        editor.view.dispatch(
          editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: uploadedSrc(stored) }),
        );
    }
    URL.revokeObjectURL(u.preview);
    pending.delete(id);
    version += 1;
    notify();
  } catch (err) {
    if (abort.signal.aborted) return;
    // the server's own limit (it may be lower than the one this page knew)
    const status = (err as { response?: { status?: number } })?.response?.status;
    // the connection went while it was on its way: it waits and goes when the browser is back online
    const waits = status == null && !navigator.onLine;
    update(id, { status: status === 413 ? 'tooLarge' : waits ? 'waiting' : 'failed', abort: undefined, editor });
  }
}

/** The pictures that wait for the connection (the list of changes waiting, Docs states D 24). */
export function waitingUploads(): { name: string; size: number }[] {
  return [...pending.values()]
    .filter((u) => u.status === 'waiting')
    .map((u) => ({ name: u.file.name, size: u.file.size }));
}

if (typeof window !== 'undefined')
  window.addEventListener('online', () => {
    for (const u of pending.values())
      if (u.status === 'waiting' && u.editor && !u.editor.isDestroyed) void send(u.editor, u.id);
  });

/** Sends a failed upload again. */
export function retryUpload(editor: Editor, id: string): void {
  void send(editor, id);
}

/** Stops an upload (Cancel) or drops a failed one (Remove): the image leaves the page. */
export function cancelUpload(editor: Editor, id: string): void {
  const u = pending.get(id);
  u?.abort?.abort();
  const pos = editor.isDestroyed ? null : findImage(editor, `uploading:${id}`);
  if (pos !== null) {
    const node = editor.state.doc.nodeAt(pos);
    if (node) editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize));
  }
  if (u) URL.revokeObjectURL(u.preview);
  pending.delete(id);
  version += 1;
  notify();
}

/** Puts another file in place of a refused one (Choose another), keeping the image where it is. */
export function replaceUploadFile(editor: Editor, id: string, file: File): void {
  const pos = findImage(editor, `uploading:${id}`);
  const u = pending.get(id);
  if (pos === null || !u) return;
  URL.revokeObjectURL(u.preview);
  pending.delete(id);
  startImageUpload(editor, file, { replacePos: pos, limitMb: u.limitMb });
}

/**
 * A smaller copy of a picture that fits in `maxBytes`: drawn again at a smaller size as JPEG (PNG keeps its
 * transparency only while it fits). Throws when the browser cannot read the picture.
 */
export async function shrinkImage(file: File, maxBytes: number): Promise<File> {
  const bitmap = await createImageBitmap(file);
  let scale = Math.min(1, Math.sqrt(maxBytes / file.size) * 0.95);
  for (let i = 0; i < 6; i += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) break;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/jpeg', 0.85));
    if (blob && blob.size <= maxBytes) {
      return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
    }
    scale *= 0.75;
  }
  throw new Error('could not shrink the picture');
}

/** Shrinks a refused picture and sends the smaller copy (Shrink and insert). */
export async function shrinkAndUpload(editor: Editor, id: string): Promise<boolean> {
  const u = pending.get(id);
  if (!u) return false;
  try {
    const small = await shrinkImage(u.file, u.limitMb * 1024 * 1024);
    replaceUploadFile(editor, id, small);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where a file dropped at `x` lands: beside the text (the outer fifth of the column) floats it on that side.
 * @param x - The drop's clientX.
 * @param column - The text column's rect.
 */
export function dropPlacement(x: number, column: DOMRect): Placement | undefined {
  if (column.width < 400) return undefined;
  if (x < column.left + column.width * 0.2) return 'floatLeft';
  if (x > column.right - column.width * 0.2) return 'floatRight';
  return undefined;
}
