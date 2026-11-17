/**
 * Printing a page (design board "Rich Docs — reading", G, frames 52-55): the page and nothing around it. A sheet
 * is built next to the app — the title, author and date, a copy of the page's content and a footer — and while it
 * is there the print style sheet (reader.css) hides everything else. The page's own colours print (or dark text on
 * white); the reader's Sepia and Night never do. Page size, margins and the running footer with page numbers come
 * from an `@page` rule.
 */

/** The choices of the print panel. */
export interface PrintOptions {
  /** Title, author and date above the content. */
  meta: boolean;
  /** The cover picture above the title. */
  cover: boolean;
  /** Colours and backgrounds; off prints dark text on white. */
  colours: boolean;
  /** Web addresses after each outside link. */
  urls: boolean;
  /** Everyone's highlights with a marker (none to print until highlights exist). */
  highlights: boolean;
  /** A running footer with the page title, the date and the page count. */
  headerFooter: boolean;
  /** A book chapter starts on a new page. */
  chapterBreak: boolean;
  paper: 'a4' | 'letter';
  margins: 'narrow' | 'normal' | 'wide';
}

export const DEFAULT_PRINT: PrintOptions = {
  meta: true,
  cover: true,
  colours: false,
  urls: false,
  highlights: false,
  headerFooter: true,
  chapterBreak: true,
  paper: 'a4',
  margins: 'normal',
};

/** What the sheet is made of. */
export interface PrintParts {
  title: string;
  /** "Hoa Mai · Updated Oct 5, 2026 · v15"; null leaves it out. */
  meta: string | null;
  /** The small line above the title (a book's name, an eyebrow). */
  eyebrow?: string | null;
  /** The last line: "Kanban Board · Rate limiting · Printed Nov 17, 2026". */
  footer: string;
  /** The element holding the rendered page; it is copied, not moved. */
  body: HTMLElement | null;
  /** The cover picture's address. */
  coverSrc?: string | null;
  /** The page's own CSS custom properties (lookVars of the author's settings, never a reading theme). */
  vars?: Record<string, string>;
  /** The page's own classes (lookClass). */
  className?: string;
  /** The page is a chapter of a book. */
  chapter?: boolean;
}

const MARGIN_MM: Record<PrintOptions['margins'], number> = { narrow: 10, normal: 18, wide: 25 };

function cssString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
}

/**
 * The `@page` rule of a print: paper, margins and, when asked, the running footer and page numbers.
 * @param opts - The print choices.
 * @param footer - The running footer's text.
 */
export function pageCss(opts: PrintOptions, footer: string): string {
  const size = opts.paper === 'letter' ? 'letter' : 'A4';
  const boxes = opts.headerFooter
    ? `@bottom-left{content:${cssString(footer)};font:9pt sans-serif;color:#5b6b60}` +
      '@bottom-right{content:counter(page) " of " counter(pages);font:9pt sans-serif;color:#5b6b60}'
    : '';
  return `@page{size:${size};margin:${MARGIN_MM[opts.margins]}mm;${boxes}}`;
}

/**
 * Builds the print sheet (not yet in the document).
 * @param opts - The print choices.
 * @param parts - What it is made of.
 */
export function buildPrintSheet(opts: PrintOptions, parts: PrintParts): HTMLElement {
  const doc = document;
  const sheet = doc.createElement('div');
  sheet.className = ['dk-print-sheet', parts.className ?? 'dk-paged dk-bg-white'].join(' ');
  sheet.dataset.testid = 'print-sheet';
  sheet.dataset.colours = opts.colours ? 'on' : 'off';
  sheet.dataset.urls = opts.urls ? 'on' : 'off';
  sheet.dataset.highlights = opts.highlights ? 'on' : 'off';
  if (parts.chapter && opts.chapterBreak) sheet.dataset.chapter = 'break';
  for (const [k, v] of Object.entries(parts.vars ?? {})) sheet.style.setProperty(k, v);
  if (opts.cover && parts.coverSrc) {
    const cover = doc.createElement('div');
    cover.className = 'dk-print-cover';
    cover.style.backgroundImage = `url("${parts.coverSrc}")`;
    sheet.appendChild(cover);
  }
  const head = doc.createElement('header');
  head.className = 'dk-print-head';
  if (parts.eyebrow) {
    const eb = doc.createElement('div');
    eb.className = 'dk-print-eyebrow';
    eb.textContent = parts.eyebrow;
    head.appendChild(eb);
  }
  const h1 = doc.createElement('h1');
  h1.className = 'dk-print-title';
  h1.textContent = parts.title;
  head.appendChild(h1);
  if (opts.meta && parts.meta) {
    const meta = doc.createElement('p');
    meta.className = 'dk-print-meta';
    meta.textContent = parts.meta;
    head.appendChild(meta);
  }
  sheet.appendChild(head);
  const body = doc.createElement('div');
  body.className = 'dk-print-body';
  if (parts.body) {
    const copy = parts.body.cloneNode(true) as HTMLElement;
    copy.removeAttribute('data-testid');
    copy.querySelectorAll('[data-testid]').forEach((el) => el.removeAttribute('data-testid'));
    copy.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    body.appendChild(copy);
  }
  sheet.appendChild(body);
  const foot = doc.createElement('footer');
  foot.className = 'dk-print-foot';
  foot.textContent = parts.footer;
  sheet.appendChild(foot);
  return sheet;
}

let active: (() => void) | null = null;

/** Whether a print sheet is in the document now. */
export function isPrinting(): boolean {
  return active !== null;
}

/**
 * Puts the sheet in the document and the `@page` rule in the head, hides the app for print, and takes it all away
 * when the browser says the print is over (`afterprint`).
 * @param opts - The print choices.
 * @param parts - What the sheet is made of.
 * @returns A function that takes the sheet away (also called on `afterprint`).
 */
export function mountPrintSheet(opts: PrintOptions, parts: PrintParts): () => void {
  active?.();
  const sheet = buildPrintSheet(opts, parts);
  const style = document.createElement('style');
  style.dataset.docsPrint = '';
  style.textContent = pageCss(opts, parts.footer);
  document.head.appendChild(style);
  document.body.appendChild(sheet);
  document.body.classList.add('dk-printing');
  const done = () => {
    sheet.remove();
    style.remove();
    document.body.classList.remove('dk-printing');
    window.removeEventListener('afterprint', done);
    if (active === done) active = null;
  };
  window.addEventListener('afterprint', done);
  active = done;
  return done;
}

/**
 * Prints the page: mounts the sheet and opens the browser's print dialog.
 * @param opts - The print choices.
 * @param parts - What the sheet is made of.
 */
export function printPage(opts: PrintOptions, parts: PrintParts): void {
  mountPrintSheet(opts, parts);
  try {
    window.print();
  } catch {
    // no print here (a test, an embedded view): take the sheet away again
    active?.();
  }
}
