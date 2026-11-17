/**
 * The Book and Access tabs of Page settings (design "Rich Docs — organising pages", A 6 and G 66-67): turning a page
 * into a book whose child pages are its chapters, and who can read the page, "Not for AI teams" and Highlights.
 */

import { useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { docsKeys } from '../../../api/docs';
import { useDocsSpaceSettings } from '../../../api/docsSpace';
import type { DocsPage, DocsTreeNode } from '../../../types/docs';
import { childrenMap } from './treeModel';

/** A change of page settings (any key of the contract; `null` puts a key back to its default). */
export type AnyPatch = Record<string, unknown>;

/** The page's `book` setting. */
export function readBook(settings: Record<string, unknown> | undefined): { isBook: boolean; numberChapters: boolean } {
  const b = settings?.book as { isBook?: unknown; numberChapters?: unknown } | null | undefined;
  return { isBook: b?.isBook === true, numberChapters: b?.numberChapters !== false };
}

function Toggle({
  label,
  hint,
  on,
  onChange,
  testId,
  disabled,
}: {
  label: string;
  hint?: ReactNode;
  on: boolean;
  onChange: (v: boolean) => void;
  testId: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className="dk-switch-row"
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span className="dk-switch-text">
        <span>{label}</span>
        {hint && <span className="st-hint">{hint}</span>}
      </span>
      <span className="st-toggle-track" style={{ background: on ? '#2E6F40' : '#C7D2CB' }} aria-hidden="true">
        <span className="st-toggle-dot" style={{ left: on ? 17 : 2 }} />
      </span>
    </button>
  );
}

/**
 * Keeps the tree's row of the page in step with a `book` change, so the tree numbers the chapters at once.
 * @returns `apply(book)` for the tree cache.
 */
function useTreeBook(page: DocsPage) {
  const qc = useQueryClient();
  return (book: DocsTreeNode['book']) =>
    qc.setQueryData<DocsTreeNode[]>(docsKeys.tree(page.projectId), (old) =>
      old?.map((n) => (n.id === page.id ? { ...n, book } : n)),
    );
}

/**
 * The Book tab: the page is a book, its child pages are chapters (numbered in tree order when it says so).
 * @param props.set - Saves a change of the page's settings.
 * @param props.nodes - The tree, for the number of chapters.
 */
export function BookTab({ page, nodes, set }: { page: DocsPage; nodes: DocsTreeNode[]; set: (p: AnyPatch) => void }) {
  const book = readBook(page.settings);
  const apply = useTreeBook(page);
  const chapters = (childrenMap(nodes).get(page.id) ?? []).length;
  const change = (next: { isBook: boolean; numberChapters: boolean } | null) => {
    set({ book: next });
    apply(next);
  };
  return (
    <>
      <p className="st-hint" style={{ margin: 0, lineHeight: 1.5 }}>
        Child pages become chapters: they are numbered in tree order, get a chapter list at the end of each page, and
        previous / next links.
      </p>
      <Toggle
        label="This page is a book"
        hint={
          chapters
            ? `${chapters} child ${chapters === 1 ? 'page becomes a chapter' : 'pages become chapters'}.`
            : 'Add child pages to write its chapters.'
        }
        on={book.isBook}
        testId="ps-book"
        onChange={(v) => change(v ? { isBook: true, numberChapters: book.numberChapters } : null)}
      />
      <Toggle
        label="Number the chapters"
        hint="“3. The Long Tide” in the tree and above each chapter title."
        on={book.isBook && book.numberChapters}
        disabled={!book.isBook}
        testId="ps-book-numbers"
        onChange={(v) => change({ isBook: true, numberChapters: v })}
      />
    </>
  );
}

/**
 * The Access tab: who can read the page (a fact of the project, shown), "Not for AI teams", and whether readers can
 * highlight on this page (off when the project turned highlights off).
 * @param props.notForAiCount - Pages of the project marked "Not for AI teams", when known.
 */
export function AccessTab({
  page,
  set,
  notForAiCount,
}: {
  page: DocsPage;
  set: (p: AnyPatch) => void;
  notForAiCount?: number | null;
}) {
  const space = useDocsSpaceSettings(page.projectId);
  const projectOff = space.data?.highlights === 'off';
  const notForAi = page.settings?.notForAi === true;
  const highlights = page.settings?.highlights === 'off' ? 'off' : 'comment';
  const published = page.version > 0 && page.status === 'published';
  return (
    <>
      <div className="dk-ps-field">
        <span className="st-field-label">Who can read this page</span>
        <div
          role="radiogroup"
          aria-label="Who can read this page"
          className="dk-seg"
          style={{ flexDirection: 'column' }}
        >
          {[
            { on: published, label: 'Everyone with project access', sub: 'The default for published pages.' },
            {
              on: !published,
              label: 'Only people who can edit',
              sub: 'Hidden from viewers. Drafts are always like this.',
            },
          ].map((o) => (
            <span
              key={o.label}
              role="radio"
              aria-checked={o.on}
              aria-disabled="true"
              className={`dk-seg-btn${o.on ? ' dk-seg-on' : ''}`}
              style={{ cursor: 'default' }}
            >
              <span>{o.label}</span>
              <span className="dk-seg-sub">{o.sub}</span>
            </span>
          ))}
        </div>
        <span className="st-hint">Publishing a page makes it readable by everyone in the project.</span>
      </div>
      <Toggle
        label="Not for AI teams"
        hint={
          <>
            Teams can’t read, search or change this page. People can.
            {notForAiCount != null &&
              ` ${notForAiCount} ${notForAiCount === 1 ? 'page is' : 'pages are'} marked in this project. They are listed in Settings › Docs › Docs AI.`}
          </>
        }
        on={notForAi}
        testId="ps-not-for-ai"
        onChange={(v) => set({ notForAi: v ? true : null })}
      />
      <div className="dk-ps-field">
        <span className="st-field-label">Highlights</span>
        <div role="radiogroup" aria-label="Highlights" className="dk-seg">
          {(
            [
              ['comment', 'People who can comment can highlight'],
              ['off', 'Off for this page'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={!projectOff && highlights === v}
              disabled={projectOff}
              className={`dk-seg-btn${!projectOff && highlights === v ? ' dk-seg-on' : ''}`}
              data-testid={`ps-highlights-${v}`}
              onClick={() => set({ highlights: v === 'off' ? 'off' : null })}
            >
              <span>{label}</span>
            </button>
          ))}
        </div>
        <span className="st-hint">
          {projectOff
            ? 'An admin turned highlights off for this project.'
            : 'Off hides the highlights on this page; they stay saved. AI teams can read the highlights on this page but never add one.'}
        </span>
      </div>
    </>
  );
}
