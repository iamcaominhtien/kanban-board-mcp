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
