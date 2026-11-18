/**
 * Reading in order (design board "Rich Docs — reading", A, frames 4-9): the chapter list of a book and the footer
 * that leads to the previous and the next chapter, or the next page.
 */

import type { BookInfo, ReadingLink } from './book';
import { chapterLabel } from './book';

/**
 * The chapters of a book, the open one marked.
 * @param props.book - The book.
 * @param props.currentId - The open page.
 * @param props.onOpen - Opens a chapter.
 */
export function ChapterList({
  book,
  currentId,
  onOpen,
}: {
  book: BookInfo;
  currentId: string;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="dk-chapters" data-testid="chapter-list">
      <div className="dk-chapters-book">
        <span className="dk-toc-head">Book</span>
        <button type="button" className="dk-chapters-title" onClick={() => onOpen(book.bookId)}>
          {book.title}
        </button>
        <span className="dk-chapters-count">
          {`${book.chapters.length} ${book.chapters.length === 1 ? 'chapter' : 'chapters'}`}
        </span>
        {book.index >= 0 && (
          <div className="dk-chapters-at">
            <div className="dk-progress dk-chapters-prog" aria-hidden="true">
              <i style={{ width: `${((book.index + 1) / book.chapters.length) * 100}%` }} />
            </div>
            <span>
              Chapter {book.index + 1} of {book.chapters.length}
            </span>
          </div>
        )}
      </div>
      <ol className="dk-chapters-list">
        {book.chapters.map((c) => {
          const on = c.id === currentId;
          return (
            <li key={c.id}>
              <a
                href={`?docs=${c.id}`}
                aria-current={on ? 'page' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  onOpen(c.id);
                }}
              >
                {book.numberChapters && <span className="dk-chapters-n">{c.number}</span>}
                <span style={{ flex: 1 }}>{c.title}</span>
                <span className="dk-chapters-mark" aria-hidden="true">
                  {on && <i />}
                </span>
              </a>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** The 15 px arrow of a footer card. */
function Arrow({ d }: { d: string }) {
  return (
    <svg
      aria-hidden="true"
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}

function FooterCard({
  link,
  side,
  label,
  onOpen,
}: {
  link: ReadingLink;
  side: 'prev' | 'next';
  label: string;
  onOpen: (id: string) => void;
}) {
  return (
    <a
      href={`?docs=${link.id}`}
      className={`dk-readnext dk-readnext-${side}`}
      data-testid={`read-${side}`}
      onClick={(e) => {
        e.preventDefault();
        onOpen(link.id);
      }}
    >
      <span className="dk-readnext-dir">
        {side === 'prev' && <Arrow d="M19 12H5M11 6l-6 6 6 6" />}
        {side === 'prev' ? 'Previous' : 'Next'}
        {side === 'next' && <Arrow d="M5 12h14M13 6l6 6-6 6" />}
      </span>
      <span className="dk-readnext-title">{label}</span>
    </a>
  );
}

/**
 * The footer under a page: the previous and the next chapter of its book, or the next page beside it.
 * @param props.prev - The page before (none: left out).
 * @param props.next - The page after (none: left out).
 * @param props.book - The page's book, for chapter numbers.
 * @param props.onOpen - Opens a page.
 */
export function ReadingFooter({
  prev,
  next,
  book,
  onOpen,
}: {
  prev: ReadingLink | null;
  next: ReadingLink | null;
  book: BookInfo | null;
  onOpen: (id: string) => void;
}) {
  if (!prev && !next) return null;
  const label = (l: ReadingLink) => (book ? chapterLabel(l, book.numberChapters) : l.title);
  return (
    <nav className="dk-readfoot" aria-label={book ? 'Chapters' : 'Next page'} data-testid="reading-footer">
      {prev ? <FooterCard link={prev} side="prev" label={label(prev)} onOpen={onOpen} /> : <span />}
      {next && <FooterCard link={next} side="next" label={label(next)} onOpen={onOpen} />}
    </nav>
  );
}

/** One heading of the touch outline. */
export interface OutlineEntry {
  slug: string;
  text: string;
  /** Heading level, 2 and deeper (indented 12 px a level). */
  level: number;
}

/**
 * The outline on a tablet (a drawer from the right) or a phone (a sheet), with a Chapters tab in a book (Reader 49 and
 * 50): 44 px rows in the drawer, 52 px rows with a tick on the one being read in the sheet, and how long is left.
 * @param props.phone - Phone rows (the sheet) instead of the drawer's.
 * @param props.title - The drawer's title (the book's or the page's).
 * @param props.entries - The page's headings.
 * @param props.activeSlug - The heading being read.
 * @param props.book - The book the page is in, for the Chapters tab; `null` outside a book.
 * @param props.tab - The open tab.
 * @param props.minutesLeft - Reading time left in minutes.
 */
export function TouchOutline({
  phone,
  title,
  entries,
  activeSlug,
  book,
  currentId,
  tab,
  onTab,
  minutesLeft,
  onJump,
  onOpen,
  onClose,
}: {
  phone: boolean;
  title: string;
  entries: OutlineEntry[];
  activeSlug: string | null;
  book: BookInfo | null;
  currentId: string;
  tab: 'outline' | 'chapters';
  onTab: (t: 'outline' | 'chapters') => void;
  minutesLeft: number;
  onJump: (slug: string) => void;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const showChapters = !!book && tab === 'chapters';
  const tick = (
    <svg
      aria-hidden="true"
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
  return (
    <div className={`dk-tout${phone ? ' dk-tout-phone' : ''}`} data-testid="touch-outline" data-popover="">
      {!phone && (
        <div className="dk-tout-head">
          <span>{title}</span>
          <button type="button" className="dk-icobtn" aria-label="Close" onClick={onClose}>
            <svg
              aria-hidden="true"
              width={18}
              height={18}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.9}
              strokeLinecap="round"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      )}
      {book && (
        <div className="dk-tout-tabs" role="tablist">
          {(['outline', 'chapters'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className="dk-tout-tab"
              onClick={() => onTab(t)}
              data-testid={`tout-tab-${t}`}
            >
              {t === 'outline' ? 'On this page' : 'Chapters'}
            </button>
          ))}
        </div>
      )}
      <div className="dk-tout-list">
        {showChapters
          ? book.chapters.map((c) => {
              const on = c.id === currentId;
              return (
                <a
                  key={c.id}
                  href={`?docs=${c.id}`}
                  className="dk-tout-row"
                  aria-current={on ? 'page' : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    onOpen(c.id);
                  }}
                >
                  {book.numberChapters && <span className="dk-tout-n">{c.number}</span>}
                  <span className="dk-tout-text">{c.title}</span>
                  {phone && on && tick}
                </a>
              );
            })
          : entries.map((h) => {
              const on = activeSlug === h.slug;
              return (
                <a
                  key={h.slug}
                  href={`#${h.slug}`}
                  className="dk-tout-row"
                  aria-current={on ? 'location' : undefined}
                  style={h.level > 2 ? { paddingLeft: (phone ? 16 : 12) + (h.level - 2) * 12 } : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    onJump(h.slug);
                  }}
                >
                  <span className="dk-tout-text">{h.text}</span>
                  {phone && on && tick}
                </a>
              );
            })}
      </div>
      <div className="dk-tout-foot" data-testid="minutes-left">
        {book && book.index >= 0 ? `Chapter ${book.index + 1} of ${book.chapters.length} · ` : ''}
        {Math.max(1, minutesLeft)} min left
      </div>
    </div>
  );
}
