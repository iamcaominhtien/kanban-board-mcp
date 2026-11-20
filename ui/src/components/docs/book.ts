/**
 * Books and reading order (design board "Rich Docs — reading", A, frames 4-9): a page whose `book` setting says
 * `isBook` holds its chapters (its child pages, in tree order); a chapter reads in focus with the chapter list
 * beside it and a footer to the next chapter. Any other page's footer leads to the next page under the same parent.
 */

import type { DocsPage, DocsTreeNode } from '../../types/docs';

/** A page in reading order. */
export interface ReadingLink {
  id: string;
  title: string;
  /** The chapter number in its book (1-based), when it is a chapter. */
  number?: number;
}

/** The book a page belongs to (or is). */
export interface BookInfo {
  bookId: string;
  title: string;
  /** Show numbers before the chapter titles. */
  numberChapters: boolean;
  /** The published chapters in order. */
  chapters: ReadingLink[];
  /** The page's place among the chapters (0-based); -1 when the page is the book itself. */
  index: number;
}

const isBookSetting = (v: unknown) => !!v && typeof v === 'object' && (v as { isBook?: unknown }).isBook === true;
const published = (n: DocsTreeNode) => n.version > 0 || n.status === 'published';
const ordered = (nodes: DocsTreeNode[], parentId: string | null) =>
  nodes.filter((n) => n.parentId === parentId && published(n)).sort((a, b) => a.position - b.position);

/**
 * The book of a page: the page itself when its settings say `book.isBook`, or its parent when the parent's do.
 * @param page - The page (its own settings are read, so a change shows before the tree reloads).
 * @param nodes - The space's tree (it carries every page's `book` setting).
 * @returns The book, or `null` for a page outside any book.
 */
export function bookOf(
  page: Pick<DocsPage, 'id' | 'parentId' | 'title' | 'settings'>,
  nodes: DocsTreeNode[],
): BookInfo | null {
  const own = page.settings?.book;
  const parent = page.parentId ? nodes.find((n) => n.id === page.parentId) : undefined;
  let bookId: string;
  let title: string;
  let numbers: boolean;
  if (isBookSetting(own)) {
    bookId = page.id;
    title = page.title;
    numbers = (own as { numberChapters?: boolean }).numberChapters !== false;
  } else if (parent && isBookSetting(parent.book)) {
    bookId = parent.id;
    title = parent.title;
    numbers = parent.book?.numberChapters !== false;
  } else {
    return null;
  }
  const chapters = ordered(nodes, bookId).map((n, i) => ({ id: n.id, title: n.title, number: i + 1 }));
  return {
    bookId,
    title,
    numberChapters: numbers,
    chapters,
    index: bookId === page.id ? -1 : chapters.findIndex((c) => c.id === page.id),
  };
}

/**
 * The pages before and after this one in reading order: the chapters of its book, or else the published pages
 * under the same parent. A book's own page leads to its first chapter.
 * @param page - The page.
 * @param nodes - The space's tree.
 * @param book - The page's book (bookOf).
 */
export function readingNeighbours(
  page: Pick<DocsPage, 'id' | 'parentId'>,
  nodes: DocsTreeNode[],
  book: BookInfo | null,
): { prev: ReadingLink | null; next: ReadingLink | null } {
  if (book) {
    if (book.index === -1) return { prev: null, next: book.chapters[0] ?? null };
    if (book.index < 0) return { prev: null, next: null };
    return { prev: book.chapters[book.index - 1] ?? null, next: book.chapters[book.index + 1] ?? null };
  }
  const siblings = ordered(nodes, page.parentId);
  const i = siblings.findIndex((n) => n.id === page.id);
  if (i < 0) return { prev: null, next: null };
  const link = (n?: DocsTreeNode) => (n ? { id: n.id, title: n.title } : null);
  return { prev: link(siblings[i - 1]), next: link(siblings[i + 1]) };
}

/**
 * A chapter's title as the list and the footer show it: "3. The Long Tide" when the book numbers its chapters.
 * @param link - The chapter.
 * @param numbered - The book numbers its chapters.
 */
export function chapterLabel(link: ReadingLink, numbered: boolean): string {
  return numbered && link.number ? `${link.number}. ${link.title}` : link.title;
}
