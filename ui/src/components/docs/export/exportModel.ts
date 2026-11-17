/**
 * The export dialog's choices and what they send (design board "Rich Docs — export", A to G): the options of each
 * format, what to export, the file name, the request body of `POST /projects/{id}/docs/exports`, and the ways out of
 * an export that is too big. Pure functions, so the rules can be tested without the dialog.
 */

import type { JSONContent } from '@tiptap/core';
import type { DocsTreeNode } from '../../../types/docs';
import type { ExportFormat } from '../docsExport';

export type { ExportFormat };

/** What to export: one page, a page with its children, the whole space, or a book of chosen pages. */
export type ExportScope = 'page' | 'children' | 'space' | 'book';
export type PageSize = 'a4' | 'letter' | 'fit';
export type Orientation = 'portrait' | 'landscape';
export type MarginSize = 'narrow' | 'normal' | 'wide';

/** Every option of every format; only the chosen format's are sent (see `optionsFor`). */
export interface ExportOptions {
  pageSize: PageSize;
  orientation: Orientation;
  margins: MarginSize;
  /** The header and footer: the page title on top, page numbers at the bottom (PDF, Word). */
  pageNumbers: boolean;
  /** A table of contents (PDF, Word). */
  contents: boolean;
  /** A first page with the page cover and title (PDF, Word). */
  coverPage: boolean;
  /** Readers' highlights, with a marker (every format; off by default). */
  includeHighlights: boolean;
  /** HTML: the page theme (fonts, colours, width) or the browser's own style. */
  look: 'theme' | 'plain';
  /** HTML: one file with pictures inside, or a page with an assets folder (a zip). */
  layout: 'single' | 'folder';
  /** Markdown: pictures in an images folder, inline as base64, or as links. */
  images: 'folder' | 'inline' | 'link';
  /** Markdown: embeds as a link, or as a placeholder. */
  embeds: 'link' | 'placeholder';
}

export const DEFAULT_OPTIONS: ExportOptions = {
  pageSize: 'a4',
  orientation: 'portrait',
  margins: 'normal',
  pageNumbers: true,
  contents: false,
  coverPage: false,
  includeHighlights: false,
  look: 'theme',
  layout: 'single',
  images: 'folder',
  embeds: 'link',
};

/** Book mode's settings (`book` of the request). */
export interface BookSettings {
  title: string;
  subtitle: string;
  author: string;
  date: string;
  /** The cover picture's address; empty for none. */
  coverImage: string;
  cover: boolean;
  titlePage: boolean;
  contents: boolean;
  chapterBreaks: boolean;
  numberChapters: boolean;
}

/** What the dialog sends to start an export. */
export interface ExportBody {
  scope: ExportScope;
  format: ExportFormat;
  pageId?: string;
  /** The pages in order: a book, or a page and its children with some unticked. */
  pageIds?: string[];
  /** Export the caller's draft instead of the published version (editors). */
  draft: boolean;
  /** The file name without its extension. */
  fileName: string;
  options: Partial<ExportOptions>;
  book?: Partial<BookSettings>;
}

/** The format's name in buttons and headings. */
export const FORMAT_LABEL: Record<ExportFormat, string> = { docx: 'Word', pdf: 'PDF', html: 'HTML', md: 'Markdown' };

/** The two formats with pages: page size, orientation, margins, header and footer, contents, cover page. */
export const isPaged = (f: ExportFormat) => f === 'pdf' || f === 'docx';

/**
 * Whether a paged option can be changed: Fit to content makes one long page, so orientation and the page-number
 * footer switch off.
 * @param opts - The options as chosen.
 * @param key - The option.
 */
export function optionDisabled(opts: ExportOptions, key: 'orientation' | 'pageNumbers'): boolean {
  return opts.pageSize === 'fit' && (key === 'orientation' || key === 'pageNumbers');
}

/**
 * The options sent for a format: only the ones that change its file, with Fit to content turning orientation and
 * page numbers off.
 * @param format - The chosen format.
 * @param o - Every option as chosen.
 */
export function optionsFor(format: ExportFormat, o: ExportOptions): Partial<ExportOptions> {
  const hl = { includeHighlights: o.includeHighlights };
  if (isPaged(format)) {
    const fit = o.pageSize === 'fit';
    return {
      pageSize: o.pageSize,
      orientation: fit ? 'portrait' : o.orientation,
      margins: o.margins,
      pageNumbers: fit ? false : o.pageNumbers,
      contents: o.contents,
      coverPage: o.coverPage,
      ...hl,
    };
  }
  if (format === 'html') return { look: o.look, layout: o.layout, ...hl };
  return { images: o.images, embeds: o.embeds, ...hl };
}

/** Characters a file system rejects. */
const BAD_CHARS = /[/\\:*?"<>|]/;
/** The longest file name kept (without the extension). */
export const NAME_MAX = 120;

/** A file name as typed, checked. */
export interface NameCheck {
  /** The name to use (shortened to `NAME_MAX`). */
  name: string;
  /** Why it cannot be used (Export is off); null when it can. */
  error: string | null;
  /** A remark that does not block (it was shortened). */
  note: string | null;
}

/**
 * Checks a file name as it is typed (frame 12): characters a file system rejects are not allowed, an empty name is
 * not allowed, a long one is shortened to 120 characters. Spaces stay.
 * @param raw - The name as typed, without the extension.
 */
export function checkFileName(raw: string): NameCheck {
  const long = raw.length > NAME_MAX;
  const name = long ? raw.slice(0, NAME_MAX) : raw;
  if (BAD_CHARS.test(name)) return { name, error: 'A file name cannot contain / \\ : * ? " < > |', note: null };
  if (!name.trim() || /^\.+$/.test(name.trim())) return { name, error: 'Give the file a name.', note: null };
  return { name, error: null, note: long ? `Shortened to ${NAME_MAX} characters. You can change it.` : null };
}

/**
 * Whether the server sends a zip: a page with its children and the whole space are one file per page; Markdown of
 * several pages is a zip too (the server's rule in `docs_export::start`).
 * @param format - The format.
 * @param scope - What is exported.
 * @param pages - How many pages.
 */
export function isZip(format: ExportFormat, scope: ExportScope, pages: number): boolean {
  return (scope !== 'page' && scope !== 'book') || (format === 'md' && pages > 1);
}

/**
 * The extension the file gets: `.zip` when several files travel together, else the format's.
 * @param format - The format.
 * @param scope - What is exported.
 * @param pages - How many pages.
 */
export function extensionFor(format: ExportFormat, scope: ExportScope, pages: number): string {
  return isZip(format, scope, pages) ? 'zip' : format;
}

/** A name for a file made from a title ("Kanban Board" → "kanban-board"). */
export function slugName(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'docs'
  );
}

/**
 * The file name a scope starts with: the page title, `<project>-docs` for the whole space, the book's title.
 * @param scope - What is exported.
 * @param pageTitle - The page's title.
 * @param projectName - The project's name.
 */
export function defaultFileName(scope: ExportScope, pageTitle: string, projectName: string): string {
  if (scope === 'space') return `${slugName(projectName)}-docs`;
  return checkFileName(pageTitle.replace(/[/\\:*?"<>|]/g, ' ').trim() || 'export').name;
}

/** The pages under `id`, in the order of the tree (depth first, by position). */
export function descendantsInOrder(nodes: readonly DocsTreeNode[], id: string): DocsTreeNode[] {
  const kids = new Map<string | null, DocsTreeNode[]>();
  for (const n of nodes) {
    const list = kids.get(n.parentId) ?? [];
    list.push(n);
    kids.set(n.parentId, list);
  }
  for (const list of kids.values()) list.sort((a, b) => a.position - b.position);
  const out: DocsTreeNode[] = [];
  const walk = (pid: string) => {
    for (const k of kids.get(pid) ?? []) {
      out.push(k);
      walk(k.id);
    }
  };
  walk(id);
  return out;
}

/** The whole tree, flattened in order, with each page's depth (book mode's page list). */
export function flatTree(nodes: readonly DocsTreeNode[]): { node: DocsTreeNode; depth: number }[] {
  const ids = new Set(nodes.map((n) => n.id));
  const roots = nodes.filter((n) => !n.parentId || !ids.has(n.parentId)).sort((a, b) => a.position - b.position);
  const out: { node: DocsTreeNode; depth: number }[] = [];
  for (const r of roots) {
    out.push({ node: r, depth: 0 });
    const base = descendantsInOrder(nodes, r.id);
    const depth = new Map<string, number>([[r.id, 0]]);
    for (const d of base) {
      const dd = (depth.get(d.parentId ?? '') ?? 0) + 1;
      depth.set(d.id, dd);
      out.push({ node: d, depth: dd });
    }
  }
  return out;
}

/** What the dialog's form holds. */
export interface ExportForm {
  format: ExportFormat;
  scope: Exclude<ExportScope, 'book'>;
  pageId: string | null;
  /** The child pages left out (unticked) under "This page and its child pages". */
  unticked: readonly string[];
  draft: boolean;
  /** The file name as typed, without its extension. */
  fileName: string;
  /** Whether the name was typed (else it follows the scope). */
  nameEdited: boolean;
  options: ExportOptions;
}

/**
 * The request for the form.
 * @param f - The form.
 * @param children - The page and its children in tree order (the page first), for a children export.
 */
export function buildExportBody(f: ExportForm, children: readonly string[] = []): ExportBody {
  const body: ExportBody = {
    scope: f.scope,
    format: f.format,
    draft: f.draft,
    fileName: checkFileName(f.fileName).name.trim(),
    options: optionsFor(f.format, f.options),
  };
  if (f.scope !== 'space' && f.pageId) body.pageId = f.pageId;
  if (f.scope === 'children' && f.unticked.length) body.pageIds = children.filter((id) => !f.unticked.includes(id));
  return body;
}

/**
 * The request for a book.
 * @param pageIds - The pages in the book's order.
 * @param format - The format.
 * @param options - Every option as chosen.
 * @param book - The book's settings.
 * @param draft - Export the caller's drafts.
 */
export function buildBookBody(
  pageIds: readonly string[],
  format: ExportFormat,
  options: ExportOptions,
  book: BookSettings,
  draft: boolean,
): ExportBody {
  const strip = (v: string) => v.trim() || undefined;
  return {
    scope: 'book',
    format,
    pageIds: [...pageIds],
    draft,
    fileName: checkFileName(book.title.replace(/[/\\:*?"<>|]/g, ' ')).name.trim() || 'book',
    options: optionsFor(format, options),
    book: {
      title: book.title.trim() || 'Book',
      subtitle: strip(book.subtitle),
      author: strip(book.author),
      date: strip(book.date),
      coverImage: book.cover ? strip(book.coverImage) : undefined,
      cover: book.cover,
      titlePage: book.titlePage,
      contents: book.contents,
      chapterBreaks: book.chapterBreaks,
      numberChapters: book.numberChapters,
    },
  };
}

/** One of the four ways to make an export smaller (frame 17). */
export interface ReduceChoice {
  id: 'fewer' | 'links' | 'plain' | 'markdown';
  title: string;
  hint: string;
  /** Off when it would change nothing. */
  disabled: boolean;
  apply: (f: ExportForm) => ExportForm;
}

/**
 * The ways to make a too-big export smaller: fewer pages, pictures as links, the plain look, Markdown.
 * @param f - The form that was too big.
 */
export function reduceChoices(f: ExportForm): ReduceChoice[] {
  return [
    {
      id: 'fewer',
      title: 'Fewer pages',
      hint: 'Only this page, without its child pages.',
      disabled: f.scope === 'page' || !f.pageId,
      apply: (x) => ({ ...x, scope: 'page', unticked: [] }),
    },
    {
      id: 'links',
      title: 'Pictures as links',
      hint: 'Markdown with links to the pictures instead of the pictures themselves. The smallest file.',
      disabled: f.format === 'md' && f.options.images === 'link',
      apply: (x) => ({ ...x, format: 'md', options: { ...x.options, images: 'link' } }),
    },
    {
      id: 'plain',
      title: 'Plain look',
      hint: 'HTML in the browser’s own style, with pictures in a folder.',
      disabled: f.format === 'html' && f.options.look === 'plain' && f.options.layout === 'folder',
      apply: (x) => ({ ...x, format: 'html', options: { ...x.options, look: 'plain', layout: 'folder' } }),
    },
    {
      id: 'markdown',
      title: 'Markdown',
      hint: 'Plain text with simple marks; pictures go into a folder.',
      disabled: f.format === 'md',
      apply: (x) => ({ ...x, format: 'md', options: { ...x.options, images: 'folder' } }),
    },
  ];
}

/** Embed blocks that PDF and Word write as pictures. */
const EMBEDS = new Set(['diagram', 'sketch', 'canvas', 'htmlEmbed', 'linkEmbed', 'video']);

/** How many embeds a page has (the note "2 embeds are exported as pictures"). */
export function countEmbeds(doc: JSONContent | null | undefined): number {
  if (!doc) return 0;
  let n = EMBEDS.has(doc.type ?? '') ? 1 : 0;
  for (const c of doc.content ?? []) n += countEmbeds(c);
  return n;
}

/** A size in bytes as "1.2 MB" or "340 KB". */
export function fmtSize(bytes: number | null | undefined): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/**
 * When an export was made, as the history lists it: "Today, 10:42", "Yesterday", "Nov 13".
 * @param iso - The time.
 * @param now - The time now.
 */
export function whenText(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return `Today, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** What an export was, for a history row ("This page and child pages", "Whole space"). */
export function scopeText(scope: string): string {
  switch (scope) {
    case 'children':
      return 'This page and child pages';
    case 'space':
      return 'Whole space';
    case 'book':
      return 'Book';
    default:
      return 'This page';
  }
}

/**
 * The steps of the progress list (frame 14): pages collected, pictures drawn (the formats that draw them), the file
 * built.
 * @param format - The format.
 * @param pages - How many pages.
 */
export function progressSteps(format: ExportFormat, pages: number): string[] {
  const steps = [`Collected ${pages} ${pages === 1 ? 'page' : 'pages'}`];
  if (format !== 'md') steps.push('Drawing pictures and diagrams');
  steps.push(`Building the ${format === 'md' ? 'Markdown' : FORMAT_LABEL[format]}`);
  return steps;
}

/** How long each step of the progress list is shown before the next one (ms); the last waits for the server. */
export const STEP_MS = 1200;

/**
 * The step reached after `elapsed` ms, and the percentage shown: the steps count up, the last stays until the file
 * is ready.
 * @param steps - How many steps.
 * @param elapsed - Time since the export started (ms).
 */
export function progressAt(steps: number, elapsed: number): { step: number; percent: number } {
  const step = Math.min(steps - 1, Math.floor(Math.max(0, elapsed) / STEP_MS));
  const within = Math.min(1, (elapsed - step * STEP_MS) / (STEP_MS * 4));
  const percent = Math.round(((step + (step === steps - 1 ? within * 0.9 : 0.5)) / steps) * 100);
  return { step, percent: Math.min(95, Math.max(5, percent)) };
}

const OPTIONS_KEY = 'docsExportOptions';

/** The options used last on this device (the defaults at first). */
export function lastOptions(): ExportOptions {
  try {
    const raw = localStorage.getItem(OPTIONS_KEY);
    if (raw) return { ...DEFAULT_OPTIONS, ...(JSON.parse(raw) as Partial<ExportOptions>) };
  } catch {
    /* storage blocked or corrupt */
  }
  return { ...DEFAULT_OPTIONS };
}

/** Remembers the options for the next export. */
export function rememberOptions(o: ExportOptions): void {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(o));
  } catch {
    /* storage blocked */
  }
}
