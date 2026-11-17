/**
 * The run of a Word, HTML or paste import: one file after the other, each converted in the browser and saved as a
 * new page (design frames 29, 30, 32, 52). Stop keeps what is in; a failed file keeps its reason and can be tried
 * again alone; when the server cannot be reached the run stops where it is.
 */

import type { JSONContent } from '@tiptap/core';
import { docsErrorDetail } from '../../../api/docs';
import {
  ImportError,
  fileToDoc,
  pasteToDoc,
  saveImportedPage,
  titleFromName,
  unreachable,
  type ConvertedPage,
  type FileProblem,
  type PasteKind,
  type PictureUpload,
} from './importConvert';

/** Where a row of the import stands. */
export type RowStatus = 'ready' | 'waiting' | 'working' | 'done' | 'failed';

/** One file (or the pasted text) of an import. */
export interface ImportRow {
  key: string;
  /** The file's name (with its folder), or the title of a paste. */
  name: string;
  size: number;
  file?: File;
  paste?: { text: string; kind: PasteKind; title: string };
  /** Why it cannot be imported at all (not supported, too large); such a row is never sent. */
  problem: FileProblem | null;
  status: RowStatus;
  /** Progress of a working row (0-100). */
  pct?: number;
  /** Why it failed. */
  reason?: string;
  /** The page made for it (also set when the page was created but its text could not be saved). */
  pageId?: string;
  /** Pictures that could not be kept. */
  dropped?: number;
}

/** What a run came to. */
export interface RunResult {
  /** Ids of the pages this run created, in order. */
  created: string[];
  failed: number;
  /** Stopped by the person before the last file. */
  stopped: boolean;
  /** The server could not be reached; the rows after the failed one were not tried. */
  offline: boolean;
}

/** What the run needs from the dialog. */
export interface RunContext {
  projectId: string;
  parentId: string | null;
  upload?: PictureUpload;
  /** True once Stop was pressed: the run ends before the next file. */
  stopped: () => boolean;
  /** Called with each change to a row. */
  update: (key: string, patch: Partial<ImportRow>) => void;
  /** Called after each page is saved (the tree fills in as pages arrive). */
  onPage?: (pageId: string) => void;
}

/** The reason a failed row shows. */
export function failureReason(err: unknown): string {
  if (err instanceof ImportError) return err.message;
  if (unreachable(err)) return 'We could not reach the server. Try again when you are back online.';
  return docsErrorDetail(err)?.message ?? 'This file could not be imported.';
}

async function convert(row: ImportRow, upload?: PictureUpload): Promise<ConvertedPage> {
  if (row.paste) return pasteToDoc(row.paste.text, row.paste.kind, upload);
  if (row.file) return fileToDoc(row.file, upload);
  throw new ImportError('Nothing to import.');
}

function titleOf(row: ImportRow, converted: ConvertedPage): string {
  if (row.paste) return row.paste.title.trim() || converted.title || 'Pasted page';
  return converted.title || titleFromName(row.name);
}

/**
 * Imports the rows that are `waiting`, one by one, in order.
 * @param rows - The rows to import (rows with a problem are skipped).
 * @param ctx - The project, parent, picture upload, stop flag and the row updates.
 */
export async function runImport(rows: ImportRow[], ctx: RunContext): Promise<RunResult> {
  const out: RunResult = { created: [], failed: 0, stopped: false, offline: false };
  for (const row of rows) {
    if (row.problem) continue;
    if (ctx.stopped()) {
      out.stopped = true;
      break;
    }
    ctx.update(row.key, { status: 'working', pct: 15, reason: undefined });
    let doc: JSONContent;
    let title: string;
    let dropped = 0;
    try {
      const converted = await convert(row, ctx.upload);
      doc = converted.doc;
      title = titleOf(row, converted);
      dropped = converted.droppedPictures;
      ctx.update(row.key, { pct: 70 });
    } catch (err) {
      out.failed += 1;
      ctx.update(row.key, { status: 'failed', pct: undefined, reason: failureReason(err) });
      continue;
    }
    try {
      const id = await saveImportedPage(ctx.projectId, { title, parentId: ctx.parentId, doc, pageId: row.pageId });
      out.created.push(id);
      ctx.update(row.key, { status: 'done', pct: 100, pageId: id, dropped });
      ctx.onPage?.(id);
    } catch (err) {
      const pageId = (err as { pageId?: string }).pageId;
      out.failed += 1;
      ctx.update(row.key, { status: 'failed', pct: undefined, reason: failureReason(err), pageId });
      if (unreachable(err)) {
        out.offline = true;
        break;
      }
    }
  }
  return out;
}
