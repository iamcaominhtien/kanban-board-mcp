/**
 * The public view of a page (`/?public=<token>`, design board "Rich Docs — reading", frames 41-46): no app, no tree,
 * no edit, no comments and no highlights. A slim "Public page" bar, the published page drawn with its settings and
 * the reader's own settings ("Aa"), an outline where there is room, and a quiet footer. A link that is off, expired
 * or whose page is gone says so with no hint of what the page was. It asks the server for the page and nothing else.
 */

import { useEffect, useMemo, useState } from 'react';
import { fetchPublicPage, PUBLIC_GONE, type PublicPage } from '../../api/docsPublic';
import { useDocsLayout } from '../../hooks/useDocsLayout';
import { markdownToDoc } from '../../richdoc';
import type { RichDoc } from '../../types/docs';
import { BottomSheet } from './DocsSheets';
import { PageHeader, titleClass } from './PageHeader';
import { lookClass, lookVars, readPageLook, readingMinutes, TEXT_SIZE_PX } from './pageSettings';
import { shortDate } from './pageStatus';
import { docHeadings, publicDoc, setRobots } from './publicView';
import { PlainRefsCtx } from './readerParts';
import { applyReaderLook, readerClass, readerThemeCss, readerVars, useReaderPrefs } from './readerPrefs';
import { AaGlyph, ReaderSettingsPanel, ReaderSettingsPopover } from './ReaderSettings';
import { RichDocView } from './RichDocView';
import { useScrollProgress } from './headerActions';
import { useWideBlocks } from './wideBlocks';
import './docs.css';
import './reader.css';

type Load =
  { state: 'loading' } | { state: 'gone' } | { state: 'error'; message: string } | { state: 'ok'; page: PublicPage };

/** Takes the boot splash of index.html away (the board's Splash component is not used here). */
function dropSplash() {
  const el = document.getElementById('kb-splash');
  if (el) {
    el.remove();
    window.dispatchEvent(new Event('kb-splash-gone'));
  }
}

function initialsOf(name: string): string {
  const w = name.split(/\s+/).filter(Boolean);
  return (w.length > 1 ? w[0][0] + w[w.length - 1][0] : (w[0] ?? '?').slice(0, 2)).toUpperCase();
}

/**
 * The public page app.
 * @param props.token - The link's token from the address.
 */
export function PublicPageApp({ token }: { token: string }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    dropSplash();
    setRobots(false);
  }, []);

  useEffect(() => {
    let live = true;
    setLoad({ state: 'loading' });
    fetchPublicPage(token)
      .then((p) => {
        if (!live) return;
        if (p === PUBLIC_GONE) {
          setRobots(false);
          setLoad({ state: 'gone' });
        } else {
          setRobots(p.allowIndex);
          setLoad({ state: 'ok', page: p });
        }
      })
      .catch((e: unknown) => live && setLoad({ state: 'error', message: e instanceof Error ? e.message : '' }));
    return () => {
      live = false;
    };
  }, [token, attempt]);

  useEffect(() => {
    document.title = load.state === 'ok' ? load.page.title : 'Kanban';
  }, [load]);

  if (load.state === 'ok') return <PublicPageView page={load.page} />;
  return (
    <div className="dk-public docs-root" data-testid="public-page">
      <header className="dk-public-bar">
        <span className="dk-public-brand">Kanban</span>
      </header>
      <main className="dk-public-empty" aria-busy={load.state === 'loading'}>
        {load.state === 'loading' && (
          <div className="dk-public-skel" aria-label="Loading page">
            <div className="skel" style={{ width: '60%', height: 30 }} />
            <div className="skel" style={{ width: 180, height: 12 }} />
            <div className="skel" style={{ width: '100%', height: 11 }} />
            <div className="skel" style={{ width: '92%', height: 11 }} />
            <div className="skel" style={{ width: '70%', height: 11 }} />
          </div>
        )}
        {load.state === 'gone' && (
          <div className="dk-public-gone" data-testid="public-gone">
            <h1>This link is no longer public.</h1>
            <p>The owner may have stopped sharing it, the link may have expired, or the page was unpublished.</p>
          </div>
        )}
        {load.state === 'error' && (
          <div className="dk-public-gone" role="alert">
            <h1>Couldn’t load this page</h1>
            <p>The server didn’t answer. Check your connection and try again.</p>
            <button type="button" className="st-btn st-btn-primary" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

function PublicPageView({ page }: { page: PublicPage }) {
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const readPct = useScrollProgress(scrollEl);
  // a table wider than the column scrolls in its own box and says so (Reader boards, I)
  const [bodyEl, setBodyEl] = useState<HTMLElement | null>(null);
  useWideBlocks(bodyEl, page);
  const layout = useDocsLayout(rootEl);
  const [prefs, setPrefs] = useReaderPrefs();
  const [readerOpen, setReaderOpen] = useState(false);
  const [note, setNote] = useState<'copied' | 'report' | null>(null);
  const doc = useMemo<RichDoc>(
    () => publicDoc(page.format === 'rich' && page.content ? page.content : markdownToDoc(page.markdown)),
    [page],
  );
  const headings = useMemo(() => docHeadings(doc), [doc]);
  const pageLook = readPageLook(page.settings);
  const look = applyReaderLook(pageLook, prefs);
  const minutes = useMemo(() => readingMinutes(page.markdown), [page.markdown]);
  const date = shortDate(page.updatedAt);
  const phone = layout === 'phone';
  const outline = layout === 'desktop' && headings.length >= 2 && pageLook.showOutline;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setNote('copied');
    } catch {
      setNote(null);
    }
  }

  const panel = <ReaderSettingsPanel prefs={prefs} onChange={setPrefs} pagePx={TEXT_SIZE_PX[pageLook.textSize]} />;
  return (
    <div ref={setRootEl} className="dk-public docs-root" data-testid="public-page" data-layout={layout}>
      <style>{readerThemeCss()}</style>
      <header className="dk-public-bar">
        {/* a phone keeps the 22 px mark and drops the name (Reader 43) */}
        {phone && <PublicMark />}
        {!phone && (
          <>
            <PublicMark />
            <span className="dk-public-brand">
              {page.project ?? 'Kanban'}
              <span>· Docs</span>
            </span>
          </>
        )}
        <span className="dk-public-pill" data-testid="public-pill">
          <svg
            aria-hidden="true"
            width={11}
            height={11}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
          </svg>
          Public page
        </span>
        {!phone && date && <span className="dk-public-date">Published {date}</span>}
        <span style={{ marginLeft: 'auto', position: 'relative' }} data-popover>
          <button
            type="button"
            className="dk-icobtn dk-public-ico"
            aria-label="Reading settings"
            title="Reading settings"
            aria-expanded={readerOpen}
            data-testid="reader-button"
            onClick={() => setReaderOpen((v) => !v)}
          >
            <AaGlyph />
          </button>
          {readerOpen && !phone && (
            <ReaderSettingsPopover
              prefs={prefs}
              onChange={setPrefs}
              pagePx={TEXT_SIZE_PX[pageLook.textSize]}
              onClose={() => setReaderOpen(false)}
            />
          )}
        </span>
        {/* Reader board, frame 41: "Sign in" opens the app itself; it says nothing about this page */}
        <a className="dk-public-signin" href="/" data-testid="public-sign-in">
          Sign in
        </a>
      </header>
      <div
        className="dk-progress dk-public-progress"
        role="progressbar"
        aria-label="Reading progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(readPct)}
      >
        <i style={{ width: `${readPct}%` }} />
      </div>
      <div className="dk-public-row">
        <div
          ref={setScrollEl}
          className={`dk-page-scroll ${lookClass(look)} ${readerClass(prefs)}`}
          style={{ ...lookVars(look, layout), ...readerVars(prefs) }}
          data-testid="public-scroll"
        >
          <article className="dk-doc-col" ref={setBodyEl}>
            <PageHeader
              look={look}
              byline={
                page.author
                  ? {
                      name: page.author,
                      initials: initialsOf(page.author),
                      avatar: { background: '#DCEEE1', color: '#1F5A31' },
                      date: page.updatedAt,
                      minutes,
                    }
                  : null
              }
              title={
                <h1 className={titleClass(look)} data-testid="public-title">
                  {page.title}
                </h1>
              }
            />
            {!page.author && look.showByline && (
              <div className="dk-ph-byline" data-testid="public-byline">
                {date && <span>{date}</span>}
                {look.showReadingTime && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{minutes} min read</span>
                  </>
                )}
              </div>
            )}
            <div style={{ height: 8 }} />
            <PlainRefsCtx.Provider value>
              <RichDocView doc={doc} projectId="" />
            </PlainRefsCtx.Provider>
            <footer className="dk-public-foot" data-testid="public-footer">
              <span className="dk-public-from">
                <PublicMark />
                <span>
                  {page.project ? (
                    <>
                      Public page from <b>{page.project}</b>
                    </>
                  ) : (
                    'Public page'
                  )}{' '}
                  · read only
                </span>
              </span>
              <button type="button" className="dk-public-link" onClick={() => void copyLink()}>
                {note === 'copied' ? 'Link copied' : 'Copy link'}
              </button>
              <button type="button" className="dk-public-link" onClick={() => setNote('report')}>
                Report a problem
              </button>
              {note === 'report' && (
                <p role="status" className="dk-public-note" data-testid="public-report-note">
                  Thanks. This page belongs to the people who shared it: tell them what is wrong, and they can fix it or
                  stop sharing it.
                </p>
              )}
            </footer>
          </article>
        </div>
        {outline && (
          <nav aria-label="On this page" className="dk-toc dk-public-toc">
            <span className="dk-toc-head">On this page</span>
            <div className="dk-toc-list">
              {headings.map((h) => (
                <a
                  key={h.id}
                  href={`#${h.id}`}
                  className="dk-toc-link"
                  style={{ paddingLeft: 14 + (h.level - 2) * 12 }}
                  onClick={(e) => {
                    e.preventDefault();
                    document.getElementById(h.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                >
                  {h.text}
                </a>
              ))}
            </div>
            <div className="dk-toc-foot">
              <span>{Math.max(1, Math.round(minutes * (1 - readPct / 100)))} min left</span>
              <button
                type="button"
                className="dk-toc-top"
                onClick={() => scrollEl?.scrollTo({ top: 0, behavior: 'smooth' })}
              >
                <svg
                  aria-hidden="true"
                  width={12}
                  height={12}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 19V5M6 11l6-6 6 6" />
                </svg>
                Back to top
              </button>
            </div>
          </nav>
        )}
      </div>
      {readerOpen && phone && (
        <BottomSheet label="Reading" onClose={() => setReaderOpen(false)} testId="reader-sheet" hideTitle>
          {panel}
        </BottomSheet>
      )}
    </div>
  );
}

/** The board's mark: a 22 px green square with a small white board in it. */
function PublicMark() {
  return (
    <span className="dk-public-mark" aria-hidden="true">
      <span>
        <i style={{ width: '60%' }} />
        <i style={{ width: '85%' }} />
      </span>
    </span>
  );
}
