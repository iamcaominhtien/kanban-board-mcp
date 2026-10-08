import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocsPage } from '../../types/docs';
import { absoluteTime, actorInitials, actorName, relativeTime } from '../../utils/relativeTime';
import { DocsMarkdown, type DocsMarkdownProps } from './DocsMarkdown';
import { OfflineBanner } from './DocsStates';
import { avatarColors, pageFullTime } from './docsUi';
import { Icon } from './Icon';
import { PageInfoPopover } from './PageInfoPopover';
import { PageMenu, type PageMenuAction } from './PageMenu';
import { ReferencedBy } from './ReferencedBy';
import { SharePopover } from './SharePopover';
import { SinceViewedBanner } from './SinceViewedBanner';

export type PageAction = PageMenuAction | 'edit' | 'share';

interface Props {
  page: DocsPage;
  projectId: string;
  projectName: string;
  narrow: boolean;
  /** Showing a saved copy while offline: editing is off. */
  offline?: { savedAt: string; version?: number | null } | null;
  onTryAgain?: () => void;
  onAction: (action: PageAction) => void;
  onOpenPage: (pageId: string, anchor?: string | null) => void;
  onOpenTicket: (ticketId: string) => void;
  onCompare?: (from: number, to: number) => void;
  onCreatePage?: DocsMarkdownProps['onCreatePage'];
  onRestorePage?: DocsMarkdownProps['onRestorePage'];
  onReplaceSection?: DocsMarkdownProps['onReplaceSection'];
  /** The element holding the rendered body (for find-in-page). */
  onBodyRef?: (el: HTMLElement | null) => void;
}

function initials(actor: string): string {
  if (actor === 'user' || actor === 'agent') return actorInitials(actor);
  const words = actorName(actor).split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] ?? '?').slice(0, 2)).toUpperCase();
}

const crumb = { fontSize: 12.5, fontWeight: 500, color: '#5B6B60', whiteSpace: 'nowrap' } as const;

export function DocsPageView({
  page,
  projectId,
  projectName,
  narrow,
  offline,
  onTryAgain,
  onAction,
  onOpenPage,
  onOpenTicket,
  onCompare,
  onCreatePage,
  onRestorePage,
  onReplaceSection,
  onBodyRef,
}: Props) {
  const [menu, setMenu] = useState(false);
  const [share, setShare] = useState(false);
  const [info, setInfo] = useState(false);
  const [toc, setToc] = useState(false);
  const [timeTip, setTimeTip] = useState(false);
  const [editTip, setEditTip] = useState(false);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const headings = page.headings.filter((h) => h.level <= 3);

  const setBody = useCallback(
    (el: HTMLDivElement | null) => {
      bodyRef.current = el;
      onBodyRef?.(el);
    },
    [onBodyRef],
  );

  // close popovers on outside click
  useEffect(() => {
    if (!menu && !toc && !share && !info) return;
    const close = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest('[data-popover]')) return;
      setMenu(false);
      setToc(false);
      setShare(false);
      setInfo(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(new MouseEvent('click'));
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu, toc, share, info]);

  // highlight the section currently in view in "On this page"
  useEffect(() => {
    const root = scrollRef.current;
    const body = bodyRef.current;
    if (!root || !body) return;
    const els = Array.from(body.querySelectorAll<HTMLElement>('h2[id],h3[id]'));
    if (!els.length) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const hit = entries.find((e) => e.isIntersecting);
        if (hit) setActiveSlug(hit.target.id.replace(/^docs-/, ''));
      },
      { root, rootMargin: '0px 0px -70% 0px' },
    );
    els.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [page.id, page.markdown]);

  function jump(slug: string) {
    document.getElementById(`docs-${slug}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveSlug(slug);
    setToc(false);
  }

  useEffect(() => {
    const hash = window.location.hash.replace('#', '');
    if (hash) setTimeout(() => jump(hash), 80);
  }, [page.id]);

  const published = page.version > 0;
  const showDraft = page.hasUnpublishedChanges && !!page.draft;
  const who = showDraft ? page.draft!.author : page.updatedBy;
  const whenIso = showDraft ? page.draft!.updatedAt : page.updatedAt;
  const lead = showDraft ? 'Draft edited by' : published ? 'Edited by' : 'Created by';
  const av = avatarColors(actorName(who));
  const canShare = published && !offline;

  const tocList = (
    <div style={{ borderLeft: '1px solid #E3E8E5', marginLeft: 1 }}>
      {headings.map((h) => {
        const on = activeSlug === h.slug;
        return (
          <a
            key={h.slug}
            href={`#${h.slug}`}
            className="dk-toc-link"
            aria-current={on ? 'location' : undefined}
            onClick={(e) => {
              e.preventDefault();
              jump(h.slug);
            }}
            style={{
              display: 'block',
              padding: `5px 0 5px ${12 + (h.level - 2) * 12}px`,
              marginLeft: -1,
              borderLeft: `2px solid ${on ? '#2E6F40' : 'transparent'}`,
              fontSize: 12.5,
              fontWeight: on ? 700 : 500,
              color: on ? '#1E2A22' : '#5B6B60',
              lineHeight: 1.35,
              cursor: 'pointer',
              textDecoration: 'none',
            }}
          >
            {h.text}
          </a>
        );
      })}
    </div>
  );

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        background: '#FFFFFF',
      }}
      data-testid="docs-page"
    >
      {offline && (
        <OfflineBanner
          pageTitle={page.title}
          savedAt={offline.savedAt}
          version={offline.version ?? page.version}
          onTryAgain={onTryAgain}
        />
      )}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            minWidth: 0,
            overflowY: 'auto',
            padding: narrow ? '28px 40px 40px' : '28px 44px 40px',
            boxSizing: 'border-box',
            position: 'relative',
          }}
        >
          <div style={{ maxWidth: 640, margin: '0 auto' }}>
            {!offline && <SinceViewedBanner page={page} onCompare={onCompare ?? (() => undefined)} />}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' }}>
                <nav aria-label="Breadcrumb" style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                  <Icon name="folder" size={13} strokeWidth={1.8} style={{ color: '#9AA8A0' }} />
                  <span style={crumb}>{projectName}</span>
                  <Icon name="chevronRight" size={10} strokeWidth={2.4} style={{ color: '#C7D2CB' }} />
                  {page.path.map((p) => (
                    <span key={p.id} style={{ display: 'contents' }}>
                      <button
                        type="button"
                        onClick={() => onOpenPage(p.id)}
                        style={{
                          ...crumb,
                          border: 'none',
                          background: 'none',
                          padding: 0,
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        {p.title}
                      </button>
                      <Icon name="chevronRight" size={10} strokeWidth={2.4} style={{ color: '#C7D2CB' }} />
                    </span>
                  ))}
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: '#1E2A22', whiteSpace: 'nowrap' }}>
                    {page.title}
                  </span>
                </nav>
                {narrow && headings.length > 0 && (
                  <div data-popover style={{ position: 'relative', marginLeft: 'auto' }}>
                    <button
                      type="button"
                      className="st-btn st-btn-sm"
                      aria-expanded={toc}
                      onClick={() => setToc((v) => !v)}
                      data-testid="toc-button"
                    >
                      <Icon name="i42" size={14} strokeWidth={1.9} />
                      On this page
                      <Icon name="chevronDown" size={11} strokeWidth={2.3} style={{ color: '#9AA8A0' }} />
                    </button>
                    {toc && (
                      <div
                        className="dk-menu"
                        style={{
                          position: 'absolute',
                          right: 0,
                          top: 'calc(100% + 6px)',
                          zIndex: 40,
                          width: 220,
                          padding: '10px 12px',
                        }}
                      >
                        <span
                          style={{
                            display: 'block',
                            fontSize: 11,
                            fontWeight: 700,
                            textTransform: 'uppercase',
                            letterSpacing: '0.06em',
                            color: '#5B6B60',
                            marginBottom: 6,
                          }}
                        >
                          On this page
                        </span>
                        {tocList}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <h1
                    data-testid="page-title"
                    style={{
                      margin: 0,
                      fontSize: 32,
                      fontWeight: 800,
                      lineHeight: 1.15,
                      color: '#1E2A22',
                      letterSpacing: '-0.01em',
                    }}
                  >
                    {page.title}
                  </h1>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    {published ? (
                      <span
                        className="mc-chip"
                        style={{ background: '#DCEEE1', color: '#1F5A31' }}
                        data-testid="status-badge"
                      >
                        <span className="mc-dot" style={{ background: '#2E6F40' }} />
                        Published · v{page.version}
                      </span>
                    ) : (
                      <span
                        className="mc-chip"
                        style={{ background: '#FCEFD9', color: '#7A4F08' }}
                        data-testid="status-badge"
                      >
                        <span className="mc-dot" style={{ background: '#B4791E' }} />
                        Draft
                      </span>
                    )}
                    {showDraft && published && (
                      <span className="mc-chip" style={{ background: '#E1EEFB', color: '#1F5A8E' }}>
                        <span className="mc-dot" style={{ background: '#2F6FB0' }} />
                        Unpublished changes
                      </span>
                    )}
                    {offline && (
                      <span className="mc-chip" style={{ background: '#F1F3F1', color: '#3A4A3E' }}>
                        Offline copy
                      </span>
                    )}
                    <div
                      data-popover
                      style={{
                        position: 'relative',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        fontSize: 12.5,
                        color: '#5B6B60',
                      }}
                    >
                      <span
                        title={actorName(who)}
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: '50%',
                          ...av,
                          fontSize: 11,
                          fontWeight: 700,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        {initials(who)}
                      </span>
                      <button
                        type="button"
                        onClick={() => setInfo((v) => !v)}
                        aria-expanded={info}
                        data-testid="page-info"
                        style={{
                          border: 'none',
                          background: 'none',
                          padding: 0,
                          font: 'inherit',
                          color: 'inherit',
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        {lead} <b style={{ color: '#1E2A22', fontWeight: 600 }}>{actorName(who)}</b> ·{' '}
                        <span
                          onMouseEnter={() => setTimeTip(true)}
                          onMouseLeave={() => setTimeTip(false)}
                          title={absoluteTime(whenIso)}
                          style={{ borderBottom: '1px dotted #9AA8A0', cursor: 'default' }}
                        >
                          {relativeTime(whenIso)}
                        </span>
                      </button>
                      {timeTip && !info && (
                        <div
                          className="dk-tt"
                          role="tooltip"
                          style={{ position: 'absolute', left: 150, top: 30, zIndex: 3, pointerEvents: 'none' }}
                        >
                          {pageFullTime(whenIso, actorName(who), published ? page.version : 0)}
                        </div>
                      )}
                      {info && (
                        <PageInfoPopover
                          page={page}
                          onClose={() => setInfo(false)}
                          onOpenHistory={() => {
                            setInfo(false);
                            onAction('history');
                          }}
                        />
                      )}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 2 }}>
                  <div data-popover style={{ position: 'relative' }}>
                    <button
                      type="button"
                      className="st-btn"
                      onClick={() => (canShare ? setShare((v) => !v) : onAction('copy-link'))}
                      data-testid="share"
                      aria-expanded={share}
                    >
                      <Icon name="link" size={14} strokeWidth={1.9} />
                      {canShare ? 'Share' : 'Copy link'}
                    </button>
                    {share && <SharePopover page={page} onClose={() => setShare(false)} />}
                  </div>
                  <div
                    style={{ position: 'relative' }}
                    onMouseEnter={() => offline && setEditTip(true)}
                    onMouseLeave={() => setEditTip(false)}
                  >
                    <button
                      type="button"
                      className={offline ? 'st-btn' : 'st-btn st-btn-primary'}
                      disabled={!!offline}
                      onClick={() => onAction('edit')}
                      data-testid="edit-page"
                    >
                      <Icon name="i15" size={14} strokeWidth={1.9} />
                      {page.draft ? 'Continue editing' : 'Edit'}
                    </button>
                    {editTip && (
                      <div
                        className="dk-tt"
                        role="tooltip"
                        style={{ position: 'absolute', right: 0, top: 'calc(100% + 10px)', zIndex: 3 }}
                      >
                        Reconnect to edit
                      </div>
                    )}
                  </div>
                  <div data-popover style={{ position: 'relative' }}>
                    <button
                      type="button"
                      className="dk-icobtn"
                      aria-label="Page actions"
                      aria-expanded={menu}
                      data-testid="page-menu"
                      onClick={() => setMenu((v) => !v)}
                      style={{ border: '1px solid #E3E8E5', width: 34, height: 34, borderRadius: 8 }}
                    >
                      <Icon name="more" size={16} strokeWidth={1.8} />
                    </button>
                    {menu && (
                      <PageMenu
                        page={page}
                        onAction={(a) => {
                          setMenu(false);
                          onAction(a);
                        }}
                        onClose={() => setMenu(false)}
                      />
                    )}
                  </div>
                </div>
              </div>
            </div>
            <div style={{ height: 1, background: '#E3E8E5', margin: '20px 0 4px' }} />
            <div ref={setBody} data-testid="page-body">
              {!published && (
                <div
                  style={{
                    margin: '24px 0',
                    padding: '16px 18px',
                    borderRadius: 10,
                    border: '1px dashed #C7D2CB',
                    background: '#F6FAF7',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    fontSize: 13.5,
                    color: '#5B6B60',
                  }}
                >
                  <strong style={{ color: '#1E2A22' }}>This page has not been published yet.</strong>
                  <span>
                    {page.draft
                      ? 'Continue editing to finish your draft, then publish it so everyone can read it. Below is a preview of the draft.'
                      : 'Edit the page and publish it so everyone can read it.'}
                  </span>
                </div>
              )}
              {(published || page.draft) && (
                <DocsMarkdown
                  projectId={projectId}
                  projectName={projectName}
                  onOpenPage={onOpenPage}
                  onOpenTicket={onOpenTicket}
                  onCreatePage={onCreatePage}
                  onRestorePage={onRestorePage}
                  onReplaceSection={published ? onReplaceSection : undefined}
                >
                  {published ? page.markdown : page.draft!.markdown}
                </DocsMarkdown>
              )}
            </div>
            <ReferencedBy pageId={page.id} onOpenPage={onOpenPage} onOpenTicket={onOpenTicket} />
          </div>
        </div>
        {!narrow && headings.length > 0 && (
          <nav
            aria-label="On this page"
            className="dk-toc"
            style={{ width: 200, flexShrink: 0, padding: '30px 20px 0 8px', boxSizing: 'border-box' }}
          >
            <div style={{ position: 'sticky', top: 0 }}>
              <span
                style={{
                  display: 'block',
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: '#5B6B60',
                  marginBottom: 10,
                }}
              >
                On this page
              </span>
              {tocList}
            </div>
          </nav>
        )}
      </div>
    </div>
  );
}
