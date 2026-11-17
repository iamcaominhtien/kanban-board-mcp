/**
 * Putting a video or a file on the page (design "Embeds", frames 16, 44-47, 74): the block goes in at once with the
 * address `uploading:<id>` (the readers skip it) and shows the upload's name, progress and Cancel; once every byte is
 * sent the server scans it ("Scanning for viruses…"); when it is kept its address takes the place of the placeholder.
 * A file over the project's limit is not sent; the server's refusals (too large, a program or script, a virus, the
 * scan could not run) stay on the block with "Choose another" and "Remove". Replace keeps the block and its settings,
 * and Cancel puts the old file back. Uploads go to `POST /projects/{id}/docs/uploads`.
 */

import type { Editor } from '@tiptap/core';
import {
  limitSentence,
  uploadDocsFile,
  uploadProblem,
  type DocsUpload,
  type UploadProblem,
} from '../../embeds/embedApi';
import { blockKitOf } from './bus';
import { uploadedSrc } from './imageUpload';

/** What is uploaded: a video block or a file card. */
export type DocUploadKind = 'video' | 'file';

/** Where one upload is. */
export type DocUploadStatus = 'uploading' | 'scanning' | 'failed' | 'refused';

/** One video or file on its way to the server. */
export interface DocUpload {
  id: string;
  file: File;
  kind: DocUploadKind;
  status: DocUploadStatus;
  /** Bytes sent so far. */
  loaded: number;
  /** When sending started (ms), for the time left. */
  startedAt: number;
  /** Why it was refused (`refused`). */
  problem?: UploadProblem;
  /** The block's attributes before a Replace, put back on Cancel. */
  previous?: Record<string, unknown>;
  limitMb: number;
  projectId: string;
  abort?: AbortController;
}

const NODE: Record<DocUploadKind, string> = { video: 'video', file: 'fileCard' };
const pending = new Map<string, DocUpload>();
const listeners = new Set<() => void>();
let version = 0;
const notify = () => {
  version += 1;
  listeners.forEach((l) => l());
};

/** Follows the uploads (for useSyncExternalStore); returns the function that stops it. */
export function subscribeDocUploads(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** A number that changes whenever an upload changes. */
export const docUploadsVersion = () => version;

/** The upload behind an `uploading:<id>` address, if this browser has it. */
export function docUploadFor(src: string): DocUpload | undefined {
  return src.startsWith('uploading:') ? pending.get(src.slice('uploading:'.length)) : undefined;
}

function update(id: string, patch: Partial<DocUpload>) {
  const u = pending.get(id);
  if (!u) return;
  pending.set(id, { ...u, ...patch });
  notify();
}

/** Where the block with address `src` is, or null. */
export function findBySrc(editor: Editor, src: string): number | null {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if ((node.type.name === 'video' || node.type.name === 'fileCard') && node.attrs.src === src) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function setAttrs(editor: Editor, pos: number, attrs: Record<string, unknown>) {
  const node = editor.state.doc.nodeAt(pos);
  if (node) editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }));
}

/** The attributes a stored upload gives its block. */
function storedAttrs(kind: DocUploadKind, res: DocsUpload, file: File): Record<string, unknown> {
  if (kind === 'video') return { src: uploadedSrc(res.src), provider: 'file' };
  return {
    src: res.src,
    name: res.name || file.name,
    size: res.size ?? file.size,
    mime: res.mime || file.type || null,
  };
}

/** Options of {@link startDocUpload}. */
export interface DocUploadOptions {
  kind: DocUploadKind;
  /** Where to put the block (a document position); the cursor when unset. */
  at?: number;
  /** Replace the file of the block at this position instead (its place and settings stay). */
  replacePos?: number;
}

/**
 * Puts `file` on the page as an uploading video or file card and sends it (unless it is over the project's limit).
 * @returns The upload's id, or null when the editor has no block layer storage (no project).
 */
export function startDocUpload(editor: Editor, file: File, opts: DocUploadOptions): string | null {
  const kit = blockKitOf(editor);
  if (!kit?.projectId) return null;
  const id = newId();
  const limitMb = opts.kind === 'video' ? kit.videoLimitMb : kit.fileLimitMb;
  const tooLarge = file.size > limitMb * 1024 * 1024;
  const src = `uploading:${id}`;
  let previous: Record<string, unknown> | undefined;
  const fileAttrs = opts.kind === 'file' ? { name: file.name, size: file.size, mime: file.type || null } : {};
  if (opts.replacePos != null) {
    const node = editor.state.doc.nodeAt(opts.replacePos);
    if (!node || node.type.name !== NODE[opts.kind]) return null;
    previous = { ...node.attrs };
    setAttrs(editor, opts.replacePos, { src, ...fileAttrs });
  } else {
    const node = { type: NODE[opts.kind], attrs: { src, ...fileAttrs } };
    const chain = editor.chain().focus();
    (opts.at != null ? chain.insertContentAt(opts.at, node) : chain.insertContent(node)).run();
  }
  pending.set(id, {
    id,
    file,
    kind: opts.kind,
    status: tooLarge ? 'refused' : 'uploading',
    loaded: 0,
    startedAt: Date.now(),
    limitMb,
    projectId: kit.projectId,
    previous,
    problem: tooLarge
      ? {
          code: 'too_large',
          title: 'Too large',
          text: `Too large. ${limitSentence(opts.kind, limitMb)}`,
          limitMb,
        }
      : undefined,
  });
  notify();
  if (!tooLarge) void send(editor, id);
  return id;
}

async function send(editor: Editor, id: string) {
  const u = pending.get(id);
  if (!u) return;
  const abort = new AbortController();
  update(id, { status: 'uploading', loaded: 0, startedAt: Date.now(), abort, problem: undefined });
  try {
    const res = await uploadDocsFile(u.projectId, u.file, u.kind, {
      signal: abort.signal,
      onProgress: (loaded, total) => update(id, { loaded, status: loaded >= total ? 'scanning' : 'uploading' }),
    });
    const pos = editor.isDestroyed ? null : findBySrc(editor, `uploading:${id}`);
    if (pos !== null) setAttrs(editor, pos, storedAttrs(u.kind, res, u.file));
    pending.delete(id);
    notify();
  } catch (err) {
    if (abort.signal.aborted) return;
    const problem = uploadProblem(err, u.kind, u.limitMb);
    update(id, { status: problem.code === 'failed' ? 'failed' : 'refused', problem, abort: undefined });
  }
}

/** Sends a failed upload again. */
export function retryDocUpload(editor: Editor, id: string): void {
  void send(editor, id);
}

/**
 * Stops an upload (Cancel) or drops a refused one (Remove): a new block leaves the page, a replaced one gets its old
 * file back.
 */
export function cancelDocUpload(editor: Editor, id: string): void {
  const u = pending.get(id);
  u?.abort?.abort();
  const pos = editor.isDestroyed ? null : findBySrc(editor, `uploading:${id}`);
  if (pos !== null) {
    const node = editor.state.doc.nodeAt(pos);
    if (node && u?.previous) setAttrs(editor, pos, u.previous);
    else if (node) editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize));
  }
  pending.delete(id);
  notify();
}

/** Sends another file in place of a refused one (Choose another), keeping the block where it is. */
export function chooseAnotherFile(editor: Editor, id: string, file: File): void {
  const u = pending.get(id);
  const pos = findBySrc(editor, `uploading:${id}`);
  if (!u || pos === null) return;
  pending.delete(id);
  const next = startDocUpload(editor, file, { kind: u.kind, replacePos: pos });
  const n = next ? pending.get(next) : undefined;
  // Cancel on the new upload still puts back what was there before the first one
  if (n && u.previous) pending.set(n.id, { ...n, previous: u.previous });
  notify();
}

/** "About 40 seconds left", from the bytes sent so far. */
export function timeLeft(u: DocUpload, now = Date.now()): string | null {
  const spent = (now - u.startedAt) / 1000;
  if (u.loaded <= 0 || spent < 1) return null;
  const rate = u.loaded / spent;
  const left = Math.max(0, (u.file.size - u.loaded) / rate);
  if (left < 5) return 'A few seconds left';
  if (left < 90) return `About ${Math.round(left / 5) * 5} seconds left`;
  return `About ${Math.round(left / 60)} minutes left`;
}
