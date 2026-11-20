/**
 * Putting a site on the page: a folder, a `.zip` or an `.html` page uploaded to `POST /projects/{id}/docs/sites`
 * becomes an HTML embed that shows it by its address (`src`). While the files go up the embed's `src` is
 * `uploading:<id>` (readers skip it) and the embed shows the progress and Cancel; once the server kept them the
 * address takes its place, and the embed takes the folder's name when it has none. A refusal (no HTML page in it,
 * too large, too many files) stays on the embed with Try again and Remove. A `.zip` without an HTML page is put on
 * the page as a file card instead. Uploading from an embed's own menu keeps the embed and its settings, and Cancel
 * puts back what it showed before.
 */

import type { Editor } from '@tiptap/core';
import { siteProblem, siteTitle, uploadDocsSite, type SiteProblem } from '../../embeds/embedApi';
import { blockKitOf } from './bus';
import { startDocUpload } from './docUpload';

/** Where one site upload is. */
export type SiteUploadStatus = 'uploading' | 'failed';

/** One site on its way to the server. */
export interface SiteUpload {
  id: string;
  files: File[];
  status: SiteUploadStatus;
  /** Bytes sent so far, and in all. */
  loaded: number;
  total: number;
  /** Why it was not kept (`failed`). */
  problem?: SiteProblem;
  /** The embed's attributes before an upload from its own menu, put back on Cancel. */
  previous?: Record<string, unknown>;
  projectId: string;
  abort?: AbortController;
}

const pending = new Map<string, SiteUpload>();
const listeners = new Set<() => void>();
let version = 0;
const notify = () => {
  version += 1;
  listeners.forEach((l) => l());
};

/** Follows the site uploads (for useSyncExternalStore); returns the function that stops it. */
export function subscribeSiteUploads(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** A number that changes whenever a site upload changes. */
export const siteUploadsVersion = () => version;

/** The upload behind an embed's `uploading:<id>` address, if this browser has it. */
export function siteUploadFor(src: string): SiteUpload | undefined {
  return src.startsWith('uploading:') ? pending.get(src.slice('uploading:'.length)) : undefined;
}

function patch(id: string, p: Partial<SiteUpload>) {
  const u = pending.get(id);
  if (!u) return;
  pending.set(id, { ...u, ...p });
  notify();
}

/** Where the HTML embed whose `src` is `src` is, or null. */
function findEmbed(editor: Editor, src: string): number | null {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === 'htmlEmbed' && node.attrs.src === src) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

function setAttrs(editor: Editor, pos: number, attrs: Record<string, unknown>) {
  const node = editor.state.doc.nodeAt(pos);
  if (node) editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }));
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Options of {@link startSiteUpload}. */
export interface SiteUploadOptions {
  /** Where to put the new embed (a document position); the cursor when unset. */
  at?: number;
  /** Upload into the HTML embed at this position instead (its place, title and size stay). */
  replacePos?: number;
}

/**
 * Puts `files` on the page as an HTML embed of a site and sends them.
 * @param files - A folder's files (with their `webkitRelativePath`), or one `.zip` / `.html`.
 * @returns The upload's id, or null when the editor has no project (or `replacePos` is not an HTML embed).
 */
export function startSiteUpload(editor: Editor, files: File[], opts: SiteUploadOptions = {}): string | null {
  const kit = blockKitOf(editor);
  if (!kit?.projectId || !files.length) return null;
  const id = newId();
  const src = `uploading:${id}`;
  let previous: Record<string, unknown> | undefined;
  if (opts.replacePos != null) {
    const node = editor.state.doc.nodeAt(opts.replacePos);
    if (!node || node.type.name !== 'htmlEmbed') return null;
    previous = { ...node.attrs };
    setAttrs(editor, opts.replacePos, { src });
  } else {
    const node = { type: 'htmlEmbed', attrs: { html: '', src, title: siteTitle(files) || null, runScripts: true } };
    const chain = editor.chain().focus();
    (opts.at != null ? chain.insertContentAt(opts.at, node) : chain.insertContent(node)).run();
  }
  pending.set(id, {
    id,
    files,
    status: 'uploading',
    loaded: 0,
    total: files.reduce((n, f) => n + f.size, 0),
    projectId: kit.projectId,
    previous,
  });
  notify();
  void send(editor, id);
  return id;
}

async function send(editor: Editor, id: string) {
  const u = pending.get(id);
  if (!u) return;
  const abort = new AbortController();
  patch(id, { status: 'uploading', loaded: 0, abort, problem: undefined });
  try {
    const site = await uploadDocsSite(u.projectId, u.files, {
      signal: abort.signal,
      onProgress: (loaded, total) => patch(id, { loaded, total }),
    });
    const pos = editor.isDestroyed ? null : findEmbed(editor, `uploading:${id}`);
    if (pos !== null) {
      const node = editor.state.doc.nodeAt(pos);
      const title = node?.attrs.title ? {} : { title: siteTitle(u.files) || null };
      setAttrs(editor, pos, { src: site.url, html: '', runScripts: true, ...title });
    }
    pending.delete(id);
    notify();
  } catch (err) {
    if (abort.signal.aborted) return;
    const problem = siteProblem(err);
    const pos = editor.isDestroyed ? null : findEmbed(editor, `uploading:${id}`);
    // a .zip with no page in it is an ordinary file: it goes on the page as a file card
    if (problem.code === 'no_html_page' && !u.previous && u.files.length === 1 && /\.zip$/i.test(u.files[0].name)) {
      if (pos !== null) {
        const node = editor.state.doc.nodeAt(pos);
        if (node) editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize));
        startDocUpload(editor, u.files[0], { kind: 'file', at: pos });
      }
      pending.delete(id);
      notify();
      return;
    }
    patch(id, { status: 'failed', problem, abort: undefined });
  }
}

/** Sends a failed site upload again. */
export function retrySiteUpload(editor: Editor, id: string): void {
  void send(editor, id);
}

/**
 * Stops a site upload (Cancel) or drops a refused one (Remove): a new embed leaves the page, an embed that was
 * uploading from its own menu gets back what it showed.
 */
export function cancelSiteUpload(editor: Editor, id: string): void {
  const u = pending.get(id);
  u?.abort?.abort();
  const pos = editor.isDestroyed ? null : findEmbed(editor, `uploading:${id}`);
  if (pos !== null) {
    const node = editor.state.doc.nodeAt(pos);
    if (node && u?.previous) setAttrs(editor, pos, u.previous);
    else if (node) editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize));
  }
  pending.delete(id);
  notify();
}

/** Stops a site upload and forgets it, leaving the embed as it is (Back to inline code while it uploads). */
export function dropSiteUpload(id: string): void {
  pending.get(id)?.abort?.abort();
  pending.delete(id);
  notify();
}
