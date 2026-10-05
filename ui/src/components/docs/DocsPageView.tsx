import { useEffect, useRef, useState } from 'react';
import { useDocsBacklinks } from '../../api/docs';
import type { DocsPage } from '../../types/docs';
import { absoluteTime, actorInitials, actorName, relativeTime } from '../../utils/relativeTime';
import { MarkdownRenderer } from '../MarkdownRenderer';
import styles from './DocsPageView.module.css';

export type PageAction = 'share' | 'edit' | 'history' | 'rename' | 'add-child' | 'duplicate' | 'copy-link' | 'copy-markdown' | 'move' | 'export' | 'delete';

interface Props {
  page: DocsPage;
  projectName: string;
  narrow: boolean;
  onAction: (action: PageAction) => void;
  onOpenPage: (pageId: string, anchor?: string | null) => void;
  onOpenTicket: (ticketId: string) => void;
  onRootClick?: () => void;
}

export function DocsPageView({ page, projectName, narrow, onAction, onOpenPage, onOpenTicket }: Props) {
  const { data: backlinks } = useDocsBacklinks(page.id);
  const [menu, setMenu] = useState(false);
  const [toc, setToc] = useState(false);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const headings = page.headings.filter((h) => h.level <= 3);

  useEffect(() => {
    if (!menu && !toc) return;
    const close = () => {
      setMenu(false);
      setToc(false);
    };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menu, toc]);

  // highlight the section currently in view in "On this page"
  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    const els = Array.from(root.querySelectorAll<HTMLElement>('h2[id],h3[id]'));
    if (!els.length) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const hit = entries.find((e) => e.isIntersecting);
        if (hit) setActiveSlug(hit.target.id.replace(/^docs-/, ''));
      },
      { rootMargin: '0px 0px -70% 0px' },
    );
    els.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [page.id, page.markdown]);

  function jump(slug: string) {
    document.getElementById(`docs-${slug}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveSlug(slug);
  }

  useEffect(() => {
    const hash = window.location.hash.replace('#', '');
    if (hash) setTimeout(() => jump(hash), 50);
  }, [page.id]);

  const unpublished = page.hasUnpublishedChanges;
  const published = page.version > 0;
  const tocList = (
    <ul className={styles.tocList}>
      {headings.map((h) => (
        <li key={h.slug} style={{ paddingLeft: (h.level - 2) * 12 }}>
          <button type="button" className={activeSlug === h.slug ? styles.tocOn : ''} onClick={() => jump(h.slug)}>
            {h.text}
          </button>
        </li>
      ))}
    </ul>
  );

  const hasRefs = (backlinks?.pages.length ?? 0) + (backlinks?.tickets.length ?? 0) > 0;

  return (
    <div className={styles.view}>
      <div className={styles.main}>
        <header className={styles.header}>
          <div className={styles.crumbs}>
            <span>{projectName}</span>
            {page.path.map((p) => (
              <span key={p.id}>
                {' › '}
                <button type="button" onClick={() => onOpenPage(p.id)}>{p.title}</button>
              </span>
            ))}
            {' › '}
            <b>{page.title}</b>
          </div>
          <div className={styles.titleRow}>
            <h1 data-testid="page-title">{page.title}</h1>
            <div className={styles.buttons}>
              {narrow && headings.length > 0 && (
                <div className={styles.menuWrap}>
                  <button type="button" className={styles.ghost} onClick={(e) => { e.stopPropagation(); setToc((v) => !v); }}>On this page</button>
                  {toc && <div className={styles.popover} onClick={(e) => e.stopPropagation()}>{tocList}</div>}
                </div>
              )}
              <button type="button" className={styles.ghost} onClick={() => onAction(published ? 'share' : 'copy-link')} data-testid="share">
                {published ? 'Share' : 'Copy link'}
              </button>
              <button type="button" className={styles.primary} onClick={() => onAction('edit')} data-testid="edit-page">
                {page.draft ? 'Continue editing' : 'Edit'}
              </button>
              <div className={styles.menuWrap}>
                <button
                  type="button"
                  className={styles.ghost}
                  aria-label="Page actions"
                  data-testid="page-menu"
                  onClick={(e) => { e.stopPropagation(); setMenu((v) => !v); }}
                >
                  ···
                </button>
                {menu && (
                  <div className={styles.menu} role="menu" onClick={(e) => e.stopPropagation()}>
                    {([
                      ['edit', 'Edit'],
                      ['rename', 'Rename'],
                      ['add-child', 'Add child page'],
                      ['duplicate', 'Duplicate'],
                      ['copy-link', 'Copy link'],
                      ['copy-markdown', 'Copy as Markdown'],
                      ['move', 'Move to…'],
                      ['history', 'Page history'],
                      ['export', 'Export as Markdown'],
                    ] as [PageAction, string][]).map(([a, label]) => (
                      <button key={a} type="button" role="menuitem" onClick={() => { setMenu(false); onAction(a); }} data-testid={`menu-${a}`}>
                        {label}
                      </button>
                    ))}
                    <div className={styles.sep} />
                    <button type="button" role="menuitem" className={styles.del} onClick={() => { setMenu(false); onAction('delete'); }} data-testid="menu-delete">
                      Delete page
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className={styles.status}>
            <span className={`${styles.badge} ${published ? styles.pub : styles.draft}`}>
              {published ? `Published · v${page.version}` : 'Draft'}
            </span>
            {unpublished && <span className={`${styles.badge} ${styles.unpub}`}>Unpublished changes</span>}
            <span className={styles.avatar} aria-hidden="true">{actorInitials(page.updatedBy)}</span>
            <span title={absoluteTime(page.updatedAt)}>
              {published ? 'Edited' : 'Created'} by {actorName(page.updatedBy)} · {relativeTime(page.updatedAt)}
            </span>
            <button type="button" className={styles.link} onClick={() => onAction('history')} data-testid="open-history">History</button>
          </div>
        </header>

        <div className={styles.body} ref={bodyRef} data-testid="page-body">
          {published ? (
            <MarkdownRenderer docs={{ projectId: page.projectId, onOpenPage, onOpenTicket }}>{page.markdown}</MarkdownRenderer>
          ) : (
            <div className={styles.unpubNote}>
              <strong>This page has not been published yet.</strong>
              <span>
                {page.draft ? 'Continue editing to finish your draft, then publish it so everyone can read it.' : 'Edit the page and publish it so everyone can read it.'}
              </span>
            </div>
          )}
        </div>

        {hasRefs && (
          <section className={styles.refs} aria-label="Referenced by" data-testid="referenced-by">
            <h2>Referenced by <small>Where this page is linked from</small></h2>
            {backlinks!.pages.length > 0 && (
              <div>
                <h3>Pages · {backlinks!.pages.length}</h3>
                {backlinks!.pages.map((p) => (
                  <button key={p.pageId + (p.in ?? '')} type="button" className={styles.refRow} onClick={() => onOpenPage(p.pageId)}>
                    <b>{p.title}</b>
                    {p.in && <span>in {p.in}</span>}
                  </button>
                ))}
              </div>
            )}
            {backlinks!.tickets.length > 0 && (
              <div>
                <h3>Tickets · {backlinks!.tickets.length}</h3>
                {backlinks!.tickets.map((t) => (
                  <button key={t.ticketId} type="button" className={styles.refRow} onClick={() => onOpenTicket(t.ticketId)}>
                    <b className={styles.key}>{t.ticketId}</b>
                    <span>{t.title}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
      </div>

      {!narrow && headings.length > 0 && (
        <nav className={styles.toc} aria-label="On this page">
          <div className={styles.tocHead}>On this page</div>
          {tocList}
        </nav>
      )}
    </div>
  );
}
