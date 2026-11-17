import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DocsPage } from '../../types/docs';
import { useDocsAiState } from '../../api/docsAi';
import { aiGate } from '../../utils/docsAiRules';
import { actorInitials, actorName, relativeTime } from '../../utils/relativeTime';
import { DocsMarkdown, type DocsMarkdownProps } from './DocsMarkdown';
import { RichDocView } from './RichDocView';
import { ConvertBar, ConvertedNotice } from './ConvertBanners';
import { convertLock, convertLockTip, draftDoc, publishedDoc } from './richPage';
import { OfflineBanner } from './DocsStates';
import { DocsAiBanners } from './ai/DocsAiBanners';
import { ExplainCard } from './ai/ExplainCard';
import { PageAiMenu } from './ai/PageAiMenu';
import { SelectionAi } from './ai/SelectionAi';
import { SummaryBlock } from './ai/SummaryBlock';
import { TranslateBanner, useTranslatedMarkdown } from './ai/TranslateView';
import { usePageAiView } from './ai/usePageAiView';
import { FollowBell } from '../notifications-follow/FollowBell';
import { CommentsPanel } from './comments/CommentsPanel';
import { PageComments } from './comments/PageComments';
import { ComposePopover, SelectionToolbar, type Pick } from './comments/SelectionComment';
import { personOf } from './comments/people';
import { useCommentsController } from './comments/useCommentsController';
import { useCommentHighlights } from './comments/useCommentHighlights';
import { PageSettledContext } from './pageSettled';
import './comments/comments.css';
import { avatarColors, pageFullTime } from './docsUi';
import { useMembers } from '../../api/members';
import { getAvatarColors } from '../MemberAvatar';
import { Icon } from './Icon';
import { PageInfoPopover } from './PageInfoPopover';
import { PageMenu, type PageMenuAction } from './PageMenu';
import { PageWork } from './PageWork';
import { ReferencedBy } from './ReferencedBy';
import { SharePopover } from './SharePopover';
import { AiChangedBar } from './AiChangedBar';
import { SinceViewedBanner, useSinceViewed } from './SinceViewedBanner';
import { useCommentSuggest } from './comments/commentAi';
import type { DocsLayout } from '../../hooks/useDocsLayout';
import { BottomSheet, DocsDrawer } from './DocsSheets';
import { PageHeader, titleClass } from './PageHeader';
import { foldCrumbs, isWidePage, lookClass, lookVars, readPageLook, readingMinutes } from './pageSettings';

export type PageAction = PageMenuAction | 'edit' | 'share';

interface Props {
  page: DocsPage;
  projectId: string;
  projectName: string;
  narrow: boolean;
  /** Showing a saved copy while offline: editing is off. */
  offline?: { savedAt: string; version?: number | null } | null;
  /** Why the reader can't edit this space (the edit policy), shown on the disabled Edit button. */
  readOnly?: string | null;
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
  /** Desktop, tablet or phone (useDocsLayout): what the page bar holds and where the outline and menus open. */
  layout?: DocsLayout;
  /** Opens the project sidebar (tablet and phone, where it is hidden); no menu button without it. */
  onOpenSidebar?: () => void;
  /** Opens the page tree (phone: the Pages button). */
  onOpenTree?: () => void;
  /** Opens search (phone: the search button in the page bar). */
  onSearch?: () => void;
}

function initials(actor: string): string {
  if (actor === 'user' || actor === 'agent') return actorInitials(actor);
  const words = actorName(actor).split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : (words[0] ?? '?').slice(0, 2)).toUpperCase();
}

/** Short stable key for a Markdown string (djb2), so a change of content remounts the rendered page. */
function contentKey(md: string): string {
  let h = 5381;
  for (let i = 0; i < md.length; i += 1) h = ((h << 5) + h + md.charCodeAt(i)) | 0;
  return `${md.length}:${h >>> 0}`;
}

const crumb = { fontSize: 12.5, fontWeight: 500, color: '#5B6B60', whiteSpace: 'nowrap' } as const;

/**
 * Read view of a page: header, content, "On this page" and "Referenced by".
 * @param props.page - Page to show.
 * @param props.projectId - Project the page belongs to.
 * @param props.projectName - Space name shown in the header.
 * @param props.narrow - Use the compact layout (no side panel).
 * @param props.offline - Set when showing a saved copy while offline; editing is off.
 * @param props.readOnly - Set when the space's edit policy doesn't let the reader edit; the text explains why.
 * @param props.onTryAgain - Called to retry loading the live page.
 * @param props.onAction - Called with the chosen page menu action.
 * @param props.onOpenPage - Called with page id and anchor when a page reference is opened.
 * @param props.onOpenTicket - Called with a ticket id when a ticket reference is opened.
 * @param props.onCompare - Called with two version numbers to open their diff.
 * @param props.onCreatePage - Called with a title when a missing page reference is created.
 * @param props.onRestorePage - Called with a page id when a deleted referenced page is restored.
 * @param props.onReplaceSection - Called when a stale section reference is replaced.
 * @param props.onBodyRef - Receives the element holding the rendered body (for find-in-page).
 * @param props.layout - Desktop, tablet or phone: the page bar folds (breadcrumb middle, Share and the rest into the
 *   menu), the outline becomes a button, and on a phone Edit floats and the menus are bottom sheets.
 * @param props.onOpenSidebar - Opens the hidden project sidebar (menu button).
 * @param props.onOpenTree - Opens the page tree (phone Pages button).
 * @param props.onSearch - Opens search (phone search button).
 */
export function DocsPageView({
  page,
  projectId,
  projectName,
  narrow,
  offline,
  readOnly,
  onTryAgain,
  onAction,
  onOpenPage,
  onOpenTicket,
  onCompare,
  onCreatePage,
  onRestorePage,
  onReplaceSection,
  onBodyRef,
  layout = 'desktop',
  onOpenSidebar,
  onOpenTree,
  onSearch,
}: Props) {
  const since = useSinceViewed(page, !offline);
  const { data: members = [] } = useMembers(projectId);
  const [menu, setMenu] = useState(false);
  const [share, setShare] = useState(false);
  const [info, setInfo] = useState(false);
  const [toc, setToc] = useState(false);
  const [timeTip, setTimeTip] = useState(false);
  const [editTip, setEditTip] = useState(false);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  // the page whose content is all on screen: the panels around it ask the server only then (pageSettled.ts)
  // The page whose content has been all on screen once. Until then a long page comes in piece by piece and the panels
  // around it wait (pageSettled.ts); after, a new text of the same page (a new version, the translated view) renders
  // at once, so the reader keeps their place and the panels stay on.
  const [renderedKey, setRenderedKey] = useState<string | null>(null);
  const onRendered = useCallback(() => setRenderedKey(page.id), [page.id]);
  const tocNavRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null);
  const [compose, setCompose] = useState<Pick | null>(null);
  const cc = useCommentsController(page.id);
  const aiView = usePageAiView(page.id);
  const aiState = useDocsAiState(projectId);
  const aiNow = aiGate(aiState.data);
  const aiOn = !offline && page.version > 0 && aiNow.show && aiNow.reason === null;
  const translated = useTranslatedMarkdown(aiView);
  const commentsData = cc.query.data;
  const inlineThreads = useMemo(() => (commentsData?.threads ?? []).filter((t) => t.kind === 'inline'), [commentsData]);
  const suggest = useCommentSuggest(commentsData);
  const commentTotal = commentsData ? commentsData.counts.all + commentsData.counts.page : 0;
  const anyUnread = !!commentsData?.threads.some((t) => t.unread);
  const canComment = !offline && commentsData?.role !== 'viewer' && page.version > 0;
  const headings = page.headings.filter((h) => h.level <= 3);
  // a page converting to the rich format cannot be edited yet; one whose conversion failed stays read-only
  const lock = offline ? null : convertLock(page);
  const editBlocked = offline ? 'Reconnect to edit' : readOnly || (lock ? convertLockTip(lock) : null);

  const setBody = useCallback(
    (el: HTMLDivElement | null) => {
      bodyRef.current = el;
      setBodyEl(el);
      onBodyRef?.(el);
    },
    [onBodyRef],
  );

  useCommentHighlights({
    root: bodyEl,
    threads: inlineThreads,
    activeId: cc.activeId,
    revision: page.markdown + page.version,
    onSelect: cc.activate,
    pending: compose?.range ?? null,
  });

  function onPick(p: Pick) {
    if (cc.reattachId) {
      const threadId = cc.reattachId;
      void cc.actions.reattach.mutateAsync({ threadId, anchor: p.anchor }).then(() => {
        cc.setReattachId(null);
        cc.activate(threadId);
      });
      return;
    }
    setCompose(p);
  }

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
    // again once a long page has all its headings (it comes in piece by piece)
  }, [page.id, page.markdown, renderedKey]);

  // a long "On this page" list scrolls on its own: keep the section in view visible in it
  useEffect(() => {
    const nav = tocNavRef.current;
    const cur = nav?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!nav || !cur) return;
    const top = cur.offsetTop - nav.offsetTop;
    if (top < nav.scrollTop + 40) nav.scrollTop = Math.max(0, top - 40);
    else if (top + cur.offsetHeight > nav.scrollTop + nav.clientHeight - 24)
      nav.scrollTop = top + cur.offsetHeight - nav.clientHeight + 24;
  }, [activeSlug]);

  function jump(slug: string) {
    // a heading further down a long page may not be on it yet (it comes in piece by piece): look again for ~3 s
    let tries = 0;
    const go = () => {
      const el = document.getElementById(`docs-${slug}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      else if (++tries < 30) setTimeout(go, 100);
    };
    go();
    setActiveSlug(slug);
    setToc(false);
  }

  useEffect(() => {
    const hash = window.location.hash.replace('#', '');
    if (hash) setTimeout(() => jump(hash), 80);
  }, [page.id]);

  const published = page.version > 0;
  // the published page, or an unpublished draft's preview, when it is stored in the rich format
  const richDoc = published ? publishedDoc(page) : draftDoc(page.draft);
  const richKey = useMemo(() => (richDoc ? contentKey(JSON.stringify(richDoc)) : ''), [richDoc]);
  const settled = !(published || page.draft) || renderedKey === page.id;
  const showDraft = page.hasUnpublishedChanges && !!page.draft;
  const who = showDraft ? page.draft!.author : page.updatedBy;
  const whenIso = showDraft ? page.draft!.updatedAt : page.updatedAt;
  const lead = showDraft ? 'Draft edited by' : published ? 'Edited by' : 'Created by';
  // a member's own colour, as their comments and the rest of the board show them; a hashed one for anyone else
  const member = members.find((m) => m.name.toLowerCase() === actorName(who).toLowerCase());
  const mc = member?.color ? getAvatarColors(member.color) : null;
  const av = mc ? { background: mc.bg, color: mc.color } : avatarColors(actorName(who));
  const canShare = published && !offline;
  const phone = layout === 'phone';
  const touch = layout !== 'desktop';
  const look = readPageLook(page.settings);
  // Wide and Full pages fold "On this page" to a button, as a tablet or a phone does
  const inlineOutline = layout === 'desktop' && !narrow && !isWidePage(look) && !cc.open;
  const outlineOn = look.showOutline && headings.length > 0;
  const minutes = useMemo(
    () => readingMinutes(published ? page.markdown : (page.draft?.markdown ?? '')),
    [published, page.markdown, page.draft?.markdown],
  );
  const authorName = actorName(page.createdBy);
  const authorMember = members.find((m) => m.name.toLowerCase() === authorName.toLowerCase());
  const authorColors = authorMember?.color ? getAvatarColors(authorMember.color) : null;
  const byline =
    published || page.draft
      ? {
          name: authorName,
          initials: initials(page.createdBy),
          avatar: authorColors ? { background: authorColors.bg, color: authorColors.color } : avatarColors(authorName),
          date: published ? page.updatedAt : page.createdAt,
          minutes,
        }
      : null;
  // the path folds its middle to "…" when there is little room (tablet, phone) or it is long
  const [crumbsOpen, setCrumbsOpen] = useState(false);
  const shownPath = crumbsOpen ? page.path : foldCrumbs(page.path, phone ? 1 : touch ? 2 : 3);

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

  const statusChips = (
    <>
      {published ? (
        <span className="mc-chip" style={{ background: '#DCEEE1', color: '#1F5A31' }} data-testid="status-badge">
          <span className="mc-dot" style={{ background: '#2E6F40' }} />
          Published · v{page.version}
        </span>
      ) : (
        <span className="mc-chip" style={{ background: '#FCEFD9', color: '#7A4F08' }} data-testid="status-badge">
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
    </>
  );

  const pageInfo = (
    <div
      data-popover
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 12.5,
        color: 'var(--dp-muted, #5B6B60)',
        minWidth: 0,
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
        className="dk-page-info"
      >
        {lead} <b style={{ color: 'var(--dp-ink, #1E2A22)', fontWeight: 600 }}>{actorName(who)}</b> ·{' '}
        <span
          onMouseEnter={() => setTimeTip(true)}
          onMouseLeave={() => setTimeTip(false)}
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
          onOpenReferences={() =>
            scrollRef.current
              ?.querySelector('[data-testid="referenced-by"]')
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
        />
      )}
    </div>
  );

  const outlineButton =
    outlineOn && !inlineOutline ? (
      <div data-popover style={{ position: 'relative' }}>
        <button
          type="button"
          className={phone ? 'dk-icobtn dk-bar-ico' : 'st-btn st-btn-sm'}
          aria-expanded={toc}
          aria-label={phone ? 'On this page' : undefined}
          title={phone ? 'On this page' : undefined}
          onClick={() => setToc((v) => !v)}
          data-testid="toc-button"
        >
          <Icon name="i42" size={phone ? 18 : 14} strokeWidth={1.9} />
          {!phone && (
            <>
              On this page
              <Icon name="chevronDown" size={11} strokeWidth={2.3} style={{ color: '#9AA8A0' }} />
            </>
          )}
        </button>
        {toc && !phone && (
          <div
            className="dk-menu"
            style={{
              position: 'absolute',
              right: 0,
              top: 'calc(100% + 6px)',
              zIndex: 40,
              width: 240,
              padding: '10px 12px',
              // a long list scrolls inside the popover instead of running off the window
              maxHeight: 'min(60vh, 420px)',
              overflowY: 'auto',
            }}
          >
            <span className="dk-toc-head">On this page</span>
            {tocList}
          </div>
        )}
      </div>
    ) : null;

  const menuButton = (
    <div data-popover style={{ position: 'relative' }}>
      <button
        type="button"
        className="dk-icobtn dk-bar-more"
        aria-label="Page actions"
        aria-expanded={menu}
        data-testid="page-menu"
        onClick={() => setMenu((v) => !v)}
      >
        <Icon name="more" size={16} strokeWidth={1.8} />
      </button>
      {menu && !phone && (
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
  );

  const editLabel = page.draft ? 'Continue editing' : 'Edit';

  return (
    <PageSettledContext.Provider value={settled}>
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
        className="dk-find-push"
        data-testid="docs-page"
        data-layout={layout}
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
            className={`dk-page-scroll ${lookClass(look)}`}
            style={{
              flex: 1,
              minWidth: 0,
              overflowY: 'auto',
              boxSizing: 'border-box',
              position: 'relative',
              ...lookVars(look, layout),
            }}
            data-page-width={look.width}
            data-page-bg={look.background}
          >
            {/* The page bar: where you are, the status and the page actions; it stays while the page scrolls */}
            <div className="dk-pagebar" data-testid="page-bar">
              {onOpenSidebar && (
                <button
                  type="button"
                  className="dk-icobtn dk-bar-ico"
                  aria-label="Open the project sidebar"
                  title="Projects"
                  data-testid="open-sidebar"
                  onClick={onOpenSidebar}
                >
                  <MenuGlyph />
                </button>
              )}
              {phone && onOpenTree && (
                <button
                  type="button"
                  className="dk-icobtn dk-bar-ico"
                  aria-label="Pages"
                  title="Pages"
                  data-testid="open-tree"
                  onClick={onOpenTree}
                >
                  <Icon name="sidePanel" size={18} strokeWidth={1.8} />
                </button>
              )}
              <nav aria-label="Breadcrumb" className="dk-crumbs">
                {!phone && (
                  <>
                    <Icon name="folder" size={13} strokeWidth={1.8} style={{ color: '#9AA8A0', flexShrink: 0 }} />
                    <span style={crumb}>{projectName}</span>
                    <Icon name="chevronRight" size={10} strokeWidth={2.4} style={{ color: '#C7D2CB', flexShrink: 0 }} />
                  </>
                )}
                {shownPath.map((p, i) =>
                  p ? (
                    <span key={p.id} style={{ display: 'contents' }}>
                      <button type="button" className="dk-crumb" onClick={() => onOpenPage(p.id)} style={crumb}>
                        {p.title}
                      </button>
                      <Icon
                        name="chevronRight"
                        size={10}
                        strokeWidth={2.4}
                        style={{ color: '#C7D2CB', flexShrink: 0 }}
                      />
                    </span>
                  ) : (
                    <span key={`fold-${i}`} style={{ display: 'contents' }}>
                      <button
                        type="button"
                        className="dk-crumb"
                        aria-label="Show the whole path"
                        title={page.path.map((x) => x.title).join(' › ')}
                        onClick={() => setCrumbsOpen(true)}
                        style={crumb}
                        data-testid="crumbs-fold"
                      >
                        …
                      </button>
                      <Icon
                        name="chevronRight"
                        size={10}
                        strokeWidth={2.4}
                        style={{ color: '#C7D2CB', flexShrink: 0 }}
                      />
                    </span>
                  ),
                )}
                <span className="dk-crumb-here">{page.title}</span>
              </nav>
              <div className="dk-pagebar-actions">
                {outlineButton}
                {phone && onSearch && (
                  <button
                    type="button"
                    className="dk-icobtn dk-bar-ico"
                    aria-label="Search pages"
                    title="Search pages"
                    onClick={onSearch}
                  >
                    <Icon name="search" size={18} strokeWidth={1.8} />
                  </button>
                )}
                {!phone && !offline && (
                  <PageAiMenu
                    projectId={projectId}
                    page={page}
                    canEdit={!readOnly}
                    view={aiView}
                    onEdit={() => onAction('edit')}
                    onOpenTicket={onOpenTicket}
                  />
                )}
                {!phone && !offline && <FollowBell scope="page" scopeId={page.id} projectId={projectId} />}
                {!phone && !offline && (
                  <button
                    type="button"
                    className="st-btn"
                    aria-pressed={cc.open}
                    data-testid="comments-button"
                    onClick={() => cc.setOpen((v) => !v)}
                  >
                    <Icon name="comment" size={14} strokeWidth={1.9} />
                    Comments
                    <span className="dc-btn-count" data-testid="comments-count">
                      {commentTotal}
                    </span>
                    {anyUnread && <span className="dc-btn-dot" data-testid="comments-unread" />}
                  </button>
                )}
                {!phone && (
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
                )}
                {!phone && (
                  <div
                    style={{ position: 'relative' }}
                    onMouseEnter={() => editBlocked && setEditTip(true)}
                    onMouseLeave={() => setEditTip(false)}
                  >
                    <button
                      type="button"
                      className={editBlocked ? 'st-btn' : 'st-btn st-btn-primary'}
                      disabled={!!editBlocked}
                      onClick={() => onAction('edit')}
                      data-testid="edit-page"
                    >
                      <Icon name={lock ? 'lock' : 'i15'} size={14} strokeWidth={1.9} />
                      {editLabel}
                    </button>
                    {editTip && editBlocked && (
                      <div
                        className="dk-tt"
                        role="tooltip"
                        style={{ position: 'absolute', right: 0, top: 'calc(100% + 10px)', zIndex: 3 }}
                      >
                        {editBlocked}
                      </div>
                    )}
                  </div>
                )}
                {menuButton}
              </div>
            </div>
            <div className="dk-statusrow">
              {statusChips}
              {pageInfo}
            </div>
            <div className="dk-doc-col" data-testid="page-column">
              {lock && <ConvertBar lock={lock} />}
              {!offline && <ConvertedNotice page={page} onViewOriginal={() => onAction('history')} />}
              {!offline && (
                <AiChangedBar
                  page={page}
                  projectId={projectId}
                  members={members}
                  canEdit={!readOnly}
                  onCompare={onCompare}
                />
              )}
              {!offline && (
                <div style={{ marginBottom: 16 }}>
                  <SinceViewedBanner page={page} since={since} onCompare={onCompare ?? (() => undefined)} />
                </div>
              )}
              {!offline && (
                <DocsAiBanners projectId={projectId} page={page} canEdit={!readOnly} onOpenTicket={onOpenTicket} />
              )}
              <PageHeader
                look={look}
                byline={byline}
                fallbackEyebrow={page.path[page.path.length - 1]?.title}
                title={
                  <h1 data-testid="page-title" className={titleClass(look)}>
                    {page.title}
                  </h1>
                }
              />
              <div className="dk-doc-rule" />
              {!offline && aiOn && (
                <div style={{ marginTop: 16 }}>
                  <SummaryBlock view={aiView} />
                  <TranslateBanner view={aiView} markdown={published ? page.markdown : (page.draft?.markdown ?? '')} />
                </div>
              )}
              {!offline && published && (
                <div style={{ marginTop: 16 }}>
                  <PageWork pageId={page.id} onOpenTicket={onOpenTicket} />
                </div>
              )}
              <div ref={setBody} data-testid="page-body" style={{ position: 'relative' }}>
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
                  <div
                    style={{ display: 'contents' }}
                    data-idea-source={JSON.stringify({ source: 'doc', id: page.id, label: page.title })}
                  >
                    {richDoc && !translated ? (
                      <RichDocView
                        // keyed by what it shows: the comment numbers are placed inline in this DOM
                        // (useCommentHighlights), so new text gets fresh nodes instead of edits to split ones
                        key={richKey}
                        doc={richDoc}
                        projectId={projectId}
                        projectName={projectName}
                        onOpenPage={onOpenPage}
                        onOpenTicket={onOpenTicket}
                        onCreatePage={onCreatePage}
                        onRestorePage={onRestorePage}
                        onReplaceSection={published ? onReplaceSection : undefined}
                        changedIn={published && since.behind && since.marks ? since.changedIn : undefined}
                        progressive={renderedKey !== page.id}
                        onRendered={onRendered}
                      />
                    ) : (
                      <DocsMarkdown
                        // keyed by what it shows (see above)
                        key={contentKey(translated ?? (published ? page.markdown : page.draft!.markdown))}
                        projectId={projectId}
                        projectName={projectName}
                        onOpenPage={onOpenPage}
                        onOpenTicket={onOpenTicket}
                        onCreatePage={onCreatePage}
                        onRestorePage={onRestorePage}
                        onReplaceSection={published && !translated ? onReplaceSection : undefined}
                        changedIn={
                          published && since.behind && since.marks && !translated ? since.changedIn : undefined
                        }
                        progressive={renderedKey !== page.id}
                        onRendered={onRendered}
                      >
                        {translated ?? (published ? page.markdown : page.draft!.markdown)}
                      </DocsMarkdown>
                    )}
                  </div>
                )}
              </div>
              {!offline && <PageComments projectId={projectId} data={commentsData} actions={cc.actions} />}
              <ReferencedBy pageId={page.id} onOpenPage={onOpenPage} onOpenTicket={onOpenTicket} />
            </div>
          </div>
          {cc.open && !offline && !touch && (
            <CommentsPanel
              pageId={page.id}
              projectId={projectId}
              version={page.version}
              data={commentsData}
              loading={cc.query.isLoading}
              error={cc.query.isError}
              onRetry={() => void cc.query.refetch()}
              actions={cc.actions}
              tab={cc.tab}
              onTab={cc.setTab}
              activeId={cc.activeId}
              onActivate={cc.activate}
              reattachId={cc.reattachId}
              onReattach={cc.setReattachId}
              onClose={() => cc.setOpen(false)}
            />
          )}
          {inlineOutline && outlineOn && (
            <nav
              aria-label="On this page"
              className="dk-toc"
              ref={tocNavRef}
              // as tall as the pane (a flex child of it): a list taller than that scrolls here, so its end can be reached
              style={{
                width: 200,
                flexShrink: 0,
                padding: '30px 20px 24px 8px',
                boxSizing: 'border-box',
                maxHeight: '100%',
                overflowY: 'auto',
                overscrollBehavior: 'contain',
              }}
            >
              <div>
                <span className="dk-toc-head" style={{ marginBottom: 10 }}>
                  On this page
                </span>
                {tocList}
              </div>
            </nav>
          )}
        </div>
        {cc.open && !offline && touch && (
          <DocsDrawer
            side="right"
            width={420}
            label="Comments"
            onClose={() => cc.setOpen(false)}
            testId="comments-drawer"
          >
            <CommentsPanel
              pageId={page.id}
              projectId={projectId}
              version={page.version}
              data={commentsData}
              loading={cc.query.isLoading}
              error={cc.query.isError}
              onRetry={() => void cc.query.refetch()}
              actions={cc.actions}
              tab={cc.tab}
              onTab={cc.setTab}
              activeId={cc.activeId}
              onActivate={cc.activate}
              reattachId={cc.reattachId}
              onReattach={cc.setReattachId}
              onClose={() => cc.setOpen(false)}
            />
          </DocsDrawer>
        )}
        {phone && !offline && (
          <button
            type="button"
            className="dk-fab"
            disabled={!!editBlocked}
            title={editBlocked ?? undefined}
            onClick={() => onAction('edit')}
            data-testid="edit-page"
          >
            <Icon name={lock ? 'lock' : 'i15'} size={18} strokeWidth={1.9} />
            {editLabel}
          </button>
        )}
        {phone && toc && (
          <BottomSheet label="On this page" onClose={() => setToc(false)} testId="toc-sheet">
            <div data-popover className="dk-toc-sheet">
              {tocList}
            </div>
          </BottomSheet>
        )}
        {phone && menu && (
          <BottomSheet label={page.title} onClose={() => setMenu(false)} testId="page-menu-sheet">
            <div data-popover>
              <div className="dk-menu-sheet">
                <button
                  type="button"
                  className="dk-mi"
                  data-testid="sheet-share"
                  onClick={() => {
                    setMenu(false);
                    onAction(canShare ? 'share' : 'copy-link');
                  }}
                >
                  <Icon name="link" size={15} strokeWidth={1.8} />
                  <span>{canShare ? 'Share' : 'Copy link'}</span>
                </button>
                {!offline && (
                  <button
                    type="button"
                    className="dk-mi"
                    data-testid="sheet-comments"
                    onClick={() => {
                      setMenu(false);
                      cc.setOpen(true);
                    }}
                  >
                    <Icon name="comment" size={15} strokeWidth={1.8} />
                    <span>Comments</span>
                    <span className="dc-btn-count" style={{ marginLeft: 'auto' }}>
                      {commentTotal}
                    </span>
                  </button>
                )}
              </div>
              <PageMenu
                variant="sheet"
                page={page}
                onAction={(a) => {
                  setMenu(false);
                  onAction(a);
                }}
                onClose={() => setMenu(false)}
              />
            </div>
          </BottomSheet>
        )}
        <SelectionToolbar
          root={bodyEl}
          label={cc.reattachId ? 'Attach here' : 'Comment'}
          enabled={(canComment || aiOn) && !compose}
          onPick={onPick}
          hideComment={!canComment}
          extra={
            aiOn ? (pick, close) => <SelectionAi pick={pick} pageId={page.id} view={aiView} done={close} /> : undefined
          }
        />
        {aiOn && <ExplainCard view={aiView} />}
        {compose && (
          <ComposePopover
            pick={compose}
            projectId={projectId}
            members={suggest}
            me={commentsData ? personOf(commentsData.me, commentsData.members, commentsData.me) : undefined}
            onCancel={() => setCompose(null)}
            onSubmit={async (text) => {
              const t = await cc.actions.createThread.mutateAsync({
                kind: 'inline',
                body: text,
                anchor: compose.anchor,
              });
              setCompose(null);
              window.getSelection()?.removeAllRanges();
              cc.created(t);
            }}
          />
        )}
      </div>
    </PageSettledContext.Provider>
  );
}

/** Three lines: the menu button that opens the project sidebar. */
function MenuGlyph() {
  return (
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
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}
