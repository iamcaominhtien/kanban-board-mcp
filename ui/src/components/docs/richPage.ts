/**
 * A Docs page in the rich format (format 1) on the client: which text of a page to show or edit, whether its
 * conversion from Markdown still blocks editing, and the draft copy kept in localStorage while offline.
 */

import { markdownToDoc } from '../../richdoc';
import type { DocsDraft, DocsPage, RichDoc } from '../../types/docs';

/** The version note the server writes on the version a conversion from Markdown made. */
export const CONVERTED_NOTE = 'Converted from Markdown';

/**
 * The published page as rich JSON, or null when it is stored as Markdown (not converted, conversion failed, an older
 * server or a saved copy from before Rich Docs): the caller shows `page.markdown` with the Markdown reader then.
 * @param page - The page.
 */
export function publishedDoc(page: Pick<DocsPage, 'format' | 'content'>): RichDoc | null {
  return page.format === 'rich' && page.content ? page.content : null;
}

/**
 * A draft as rich JSON, or null when it is stored as Markdown.
 * @param draft - The page's draft.
 */
export function draftDoc(draft: Pick<DocsDraft, 'format' | 'content'> | null | undefined): RichDoc | null {
  return draft?.format === 'rich' && draft.content ? draft.content : null;
}

/**
 * What the editor opens: the draft, else the published page, as rich JSON (Markdown is read into a page first, so
 * the next save stores the page in the rich format).
 * @param page - The page being edited.
 */
export function editableDoc(page: DocsPage): RichDoc {
  if (page.draft) return draftDoc(page.draft) ?? markdownToDoc(page.draft.markdown);
  return publishedDoc(page) ?? markdownToDoc(page.markdown);
}

/** Why a page cannot be edited because of its conversion: still converting, or failed (kept read-only). */
export type ConvertLock = 'converting' | 'failed';

/**
 * Whether the conversion of a page to the rich format blocks editing, and why; null when it does not.
 * @param page - The page.
 */
export function convertLock(page: Pick<DocsPage, 'convertState'>): ConvertLock | null {
  if (page.convertState === 'waiting' || page.convertState === 'working') return 'converting';
  if (page.convertState === 'failed') return 'failed';
  return null;
}

/** The text of the disabled Edit button's tooltip for a conversion lock. */
export function convertLockTip(lock: ConvertLock): string {
  return lock === 'converting'
    ? 'Editing comes back when the conversion is done'
    : 'This page could not be converted. Its original text is kept, read-only.';
}

/** The localStorage key of the draft kept on this device while it could not be saved. */
export const localDraftKey = (pageId: string) => `docsOfflineDraft:${pageId}`;

/** A draft kept on this device: the page JSON, its title and when it was kept (ISO time). */
export interface LocalDraft {
  content: RichDoc;
  title: string;
  at: string;
}

/**
 * The draft kept on this device for a page, or null. A copy written before Rich Docs (`{markdown, title, at}`) is
 * read into a page.
 * @param pageId - The page.
 */
export function readLocalDraft(pageId: string): LocalDraft | null {
  try {
    const raw = localStorage.getItem(localDraftKey(pageId));
    if (!raw) return null;
    const v = JSON.parse(raw) as { content?: unknown; markdown?: unknown; title?: unknown; at?: unknown };
    const title = typeof v.title === 'string' ? v.title : '';
    const at = typeof v.at === 'string' ? v.at : '';
    if (v.content && typeof v.content === 'object') return { content: v.content as RichDoc, title, at };
    if (typeof v.markdown === 'string') return { content: markdownToDoc(v.markdown), title, at };
    return null;
  } catch {
    return null;
  }
}

/**
 * Keep a draft on this device (storage full or blocked: nothing is kept, the in-memory copy still exists).
 * @param pageId - The page.
 * @param draft - The page JSON and title.
 */
export function writeLocalDraft(pageId: string, draft: { content: RichDoc; title: string }): void {
  try {
    localStorage.setItem(
      localDraftKey(pageId),
      JSON.stringify({ content: draft.content, title: draft.title, at: new Date().toISOString() }),
    );
  } catch {
    /* storage full or blocked */
  }
}

/** Forget the draft kept on this device for a page. */
export function clearLocalDraft(pageId: string): void {
  try {
    localStorage.removeItem(localDraftKey(pageId));
  } catch {
    /* ignore */
  }
}

/**
 * Point the references to `from.title › from.anchor` in a rich page at section `to` instead (the "Use …" of a stale
 * section reference). Pure; returns null when nothing changed.
 * @param doc - The page JSON.
 * @param from - The page title and the section the references name now.
 * @param to - The section they should name.
 */
export function replaceSectionRefs(doc: RichDoc, from: { title: string; anchor: string }, to: string): RichDoc | null {
  let changed = false;
  const walk = (node: RichDoc): RichDoc => {
    if (node.type === 'docRef' && node.attrs?.page === from.title && node.attrs?.section === from.anchor) {
      changed = true;
      return { ...node, attrs: { ...node.attrs, section: to } };
    }
    return node.content ? { ...node, content: node.content.map(walk) } : node;
  };
  const out = walk(doc);
  return changed ? out : null;
}
