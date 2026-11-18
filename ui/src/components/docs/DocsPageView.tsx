import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { DocsPage, DocsTreeNode, DocsVersionDetail } from '../../types/docs';
import { docsErrorDetail, docsKeys, patchPageSettings } from '../../api/docs';
import { extractError } from '../../api/extractError';
import { resolveOrigin } from '../../api/resolveOrigin';
import { useFollow, useSetFollow } from '../../api/notificationSettings';
import { useDocsAiState } from '../../api/docsAi';
import { aiGate } from '../../utils/docsAiRules';
import { actorInitials, actorName, relativeTime } from '../../utils/relativeTime';
import { DocsMarkdown, type DocsMarkdownProps } from './DocsMarkdown';
import { RichDocView } from './RichDocView';
import { ConvertBar, ConvertedNotice } from './ConvertBanners';
import { convertLock, convertLockTip, draftDoc, publishedDoc } from './richPage';
import { ViewerNote } from './states/ViewerNote';
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
import { MarginMarks } from './comments/MarginMarks';
import { PhoneComments } from './comments/PhoneComments';
import { PageComments } from './comments/PageComments';
import { ComposePopover, SelectionToolbar, type Pick } from './comments/SelectionComment';
import { personOf } from './comments/people';
import { useCommentsController } from './comments/useCommentsController';
import { useCommentHighlights } from './comments/useCommentHighlights';
import './comments/comments.css';
import { avatarColors, pageFullTime } from './docsUi';
import { useMembers } from '../../api/members';
import { getAvatarColors } from '../MemberAvatar';
import { Icon } from './Icon';
import { PageInfoPopover } from './PageInfoPopover';
import { PageMenu, type PageMenuAction } from './PageMenu';
import { PageWork } from './PageWork';
import {
  AiChangesItems,
  AskTeamButton,
  LockMarks,
  PageTeamHost,
  ReviewBar,
  SuggestionChip,
  TeamRunEndings,
  lockedBlocks,
  topBlockIdOf,
  usePageSuggestions,
} from './suggestions';
import { notForAi } from './suggestions/pageAi';
import { ReferencedBy } from './ReferencedBy';
import { BlockRefBadges, RefsButton } from './links/RefsButton';
import { ArrivalBanner } from './links/ArrivalBanner';
import { SharePopover } from './SharePopover';
import { AiEditedChip, aiWriter } from './AiChangedBar';
import { useToast } from '../Toast';
import { bookOf, readingNeighbours } from './book';
import { ChapterList, ReadingFooter, TouchOutline } from './BookReading';
import { ExportMenu, type ExportFormat } from './docsExport';
import { headerPlan, useElementWidth, useScrollProgress } from './headerActions';
import { OlderVersionBar, OutdatedNote, VersionBadge } from './PageStatus';
import { outdatedOf, shortDate } from './pageStatus';
import { PrintDialog } from './PrintDialog';
import { openDocsFind } from './FindInPage';
import { DEFAULT_PRINT, isPrinting, mountPrintSheet, printPage, type PrintOptions, type PrintParts } from './printPage';
import { AskAiButton } from '../assist/AssistEntry';
import { NotificationBellButton } from '../notifications/NotificationsHost';
import { applyReaderLook, readerClass, readerThemeCss, readerVars, useReaderPrefs } from './readerPrefs';
import { AaGlyph, ReaderSettingsPanel, ReaderSettingsPopover } from './ReaderSettings';
import { useWideBlocks } from './wideBlocks';
import { useReaderHighlights } from './highlights/ReaderHighlights';
import './reader.css';
import { SinceViewedBanner, useSinceViewed } from './SinceViewedBanner';
import { useCommentSuggest } from './comments/commentAi';
import type { DocsLayout } from '../../hooks/useDocsLayout';
import { BottomSheet, DocsDrawer } from './DocsSheets';
import { PageHeader, titleClass } from './PageHeader';
import {
  coverUrl,
  foldCrumbs,
  isWidePage,
  lookClass,
  lookVars,
  readPageLook,
  readingMinutes,
  TEXT_SIZE_PX,
} from './pageSettings';
import { blockOfAnchor, noteOpenPage, revealBlock } from './links/blockAnchor';

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
  /** The reader's role and the project admins, for the role chip beside a greyed Edit (Docs states H 57). */
  viewer?: { role: 'viewer' | 'member' | 'admin'; admins: string[] } | null;
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
  /** The space's tree: the book the page is in, and the next page to read. */
  nodes?: DocsTreeNode[];
  /** An older version opened from History: shown read-only instead of the current page. */
  olderVersion?: OlderVersion | null;
  /** Asks for the export dialog with a format chosen (`null`: the last one used). */
  onExport?: (format: ExportFormat | null) => void;
  /**
   * Set while the page reads in focus, without the app's chrome (Reader 1, 4 and the phone frames): the bar leads
   * with "← {label}", which brings the chrome back, and carries the app's Ask AI and notification bell.
   */
  focus?: { label: string; onLeave: () => void } | null;
}

/** An older version of the page, read from History. */
export interface OlderVersion {
  version: number;
  /** The version's text; null while it loads. */
  detail: DocsVersionDetail | null;
  /** Back to the current page. */
  onBack: () => void;
  /** Restores it as a new version (editors only). */
  onRestore?: () => void;
  restoring?: boolean;
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

const crumb = { fontSize: 12.5, fontWeight: 400, color: 'var(--dp-muted, #5B6B60)', whiteSpace: 'nowrap' } as const;

/** The "›" between the parts of the path (Reader boards: a muted character, not an icon). */
function CrumbSep() {
  return (
    <span aria-hidden="true" className="dk-crumb-sep">
      ›
    </span>
  );
}

/**
 * Read view of a page: header, content, "On this page" and "Referenced by".
 * @param props.page - Page to show.
 * @param props.projectId - Project the page belongs to.
 * @param props.projectName - Space name shown in the header.
 * @param props.narrow - Use the compact layout (no side panel).
 * @param props.offline - Set when showing a saved copy while offline; editing is off.
 * @param props.readOnly - Set when the space's edit policy doesn't let the reader edit; the text explains why.
 * @param props.viewer - The reader's role and the admins: a read-only reader gets the role chip and its note.
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
 * @param props.nodes - The space's tree (book chapters, the next page).
 * @param props.olderVersion - An older version opened from History, shown read-only with a way back.
 * @param props.onExport - Asks for the export dialog with a format.
 * @param props.focus - Set while the page reads in focus: the bar's way back to the app and its label.
 */
export function DocsPageView({
  page,
  projectId,
  projectName,
  narrow,
  offline,
  readOnly,
  viewer,
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
  nodes,
  olderVersion,
  onExport,
  focus = null,
}: Props) {
  const since = useSinceViewed(page, !offline);
  const qc = useQueryClient();
  const toast = useToast();
  const older = olderVersion ?? null;
  const [prefs, setPrefs] = useReaderPrefs();
  const [readerOpen, setReaderOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [shareSheet, setShareSheet] = useState(false);
  const [chaptersOpen, setChaptersOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const paneWidth = useElementWidth(scrollEl);
  // how far down the page the reader is, 0-100 (the progress bar under the page bar, "N min left")
  const readPct = useScrollProgress(scrollEl, page.id);
  const { data: members = [] } = useMembers(projectId);
  const [menu, setMenu] = useState(false);
  const [share, setShare] = useState(false);
  const [info, setInfo] = useState(false);
  const [toc, setToc] = useState(false);
  const [toutTab, setToutTab] = useState<'outline' | 'chapters'>('outline');
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
  const scrollRef = useRef<HTMLDivElement | null>(null);
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
  const canComment = !offline && !older && commentsData?.role !== 'viewer' && page.version > 0;
  const headings = page.headings.filter((h) => h.level <= 3);
  // a page converting to the rich format cannot be edited yet; one whose conversion failed stays read-only
  const lock = offline ? null : convertLock(page);
  const editBlocked = offline
    ? 'Reconnect to edit'
    : older
      ? 'Edit is off while you read an older version'
      : readOnly || (lock ? convertLockTip(lock) : null);

  const setScroll = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setScrollEl(el);
  }, []);
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
  // a link followed from this page names it in the other page's arrival banner (RichDocsLinks D 25)
  useEffect(() => {
    noteOpenPage(page.title);
  }, [page.title]);
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
    // a link to a heading or block of a rich page (`#block-b-…`): scroll to the block and mark it
    const linked = blockOfAnchor(slug);
    if (linked) {
      revealBlock(linked);
      return;
    }
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
  // the published page, or an unpublished draft's preview, when it is stored in the rich format; an older version
  // opened from History instead of either (versions from before the rich format are Markdown)
  const olderDetail = older?.detail ?? null;
  const richDoc = older
    ? olderDetail?.format === 'rich'
      ? (olderDetail.content ?? null)
      : null
    : published
      ? publishedDoc(page)
      : draftDoc(page.draft);
  const richKey = useMemo(() => (richDoc ? contentKey(JSON.stringify(richDoc)) : ''), [richDoc]);
  const settled = !(published || page.draft) || renderedKey === page.id;
  // AI teams' suggestions on the published page (suggestions/), drawn on its blocks by the reader
  const sg = usePageSuggestions({
    page,
    projectId,
    doc: !older && published ? richDoc : null,
    enabled: published && !offline && !older && !!richDoc && settled,
    canEdit: !readOnly && !offline,
    layout,
    onOpenTicket,
    onCompare,
    onHistory: () => onAction('history'),
  });
  const askable = !readOnly && !offline && !older && published && !notForAi(page.settings);
  const showDraft = !older && page.hasUnpublishedChanges && !!page.draft;
  const who = older ? (olderDetail?.author ?? page.updatedBy) : showDraft ? page.draft!.author : page.updatedBy;
  const whenIso = older
    ? (olderDetail?.createdAt ?? page.updatedAt)
    : showDraft
      ? page.draft!.updatedAt
      : page.updatedAt;
  const lead = showDraft ? 'Draft edited by' : published ? 'Edited by' : 'Created by';
  // a member's own colour, as their comments and the rest of the board show them; a hashed one for anyone else
  const member = members.find((m) => m.name.toLowerCase() === actorName(who).toLowerCase());
  const mc = member?.color ? getAvatarColors(member.color) : null;
  const av = mc ? { background: mc.bg, color: mc.color } : avatarColors(actorName(who));
  // the latest version was written by an AI team of the project: its line says so (AiEditedChip's rule)
  const aiTeam = !older && published && !showDraft ? aiWriter(page, members) : null;
  const canShare = published && !offline;
  const phone = layout === 'phone';
  const touch = layout !== 'desktop';
  const look = readPageLook(page.settings);
  // the reader's own font and width over the page's (their theme and size are a class and a variable)
  const readerLook = applyReaderLook(look, prefs);
  const plan = headerPlan(paneWidth, layout);
  const outdated = older || offline ? null : outdatedOf(page);
  const book = useMemo(() => (nodes ? bookOf(page, nodes) : null), [page, nodes]);
  const around = useMemo(
    () => (nodes ? readingNeighbours(page, nodes, book) : { prev: null, next: null }),
    [page, nodes, book],
  );
  const chapterSide = !!book && book.chapters.length > 0 && layout === 'desktop' && !narrow;
  // Wide and Full pages fold "On this page" to a button, as a tablet or a phone does
  const inlineOutline = layout === 'desktop' && !narrow && !isWidePage(readerLook) && !cc.open;
  // with fewer than two headings a page has no outline at all
  const outlineOn = look.showOutline && headings.length >= 2;
  // shared highlights while reading (highlights/): the layer, the colours in the selection bar, the list
  const hl = useReaderHighlights({
    page,
    bodyEl,
    scrollEl,
    layout,
    rich: !!richDoc && !translated && (published || !!older),
    older: !!older,
    offline: !!offline,
    revision: `${richKey}:${renderedKey ?? ''}`,
    comments: commentsData,
    canEdit: !readOnly && !offline,
    commentsOpen: cc.open,
    setCommentsOpen: cc.setOpen,
    activateThread: cc.activate,
    startComment: setCompose,
    outlineBeside: inlineOutline && outlineOn,
  });
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

  async function markReviewed() {
    setReviewing(true);
    try {
      // the review starts the 6-month clock again, and clears an Outdated status
      const saved = await patchPageSettings(page.id, { reviewedAt: new Date().toISOString(), status: null });
      qc.setQueryData<DocsPage>(docsKeys.page(page.id), (old) => (old ? { ...old, ...saved } : saved));
      toast.success('Marked as reviewed', 'The page no longer shows as outdated.');
    } catch (e) {
      toast.error("Couldn't mark the page as reviewed", docsErrorDetail(e)?.message ?? extractError(e));
    } finally {
      setReviewing(false);
    }
  }

  // what a print is made of: the page as its author set it (a reading theme never prints) and the shown text
  const printParts = useRef<() => PrintParts>(() => ({ title: page.title, meta: null, footer: '', body: null }));
  // what a print is made of for these choices; the preview uses the same, so it shows what will print. Shared
  // highlights print only with "Include highlights" (highlights/hlPrint.ts); the reader's markers never print.
  const hlPrintCopy = useRef(hl.printCopy);
  hlPrintCopy.current = hl.printCopy;
  const printFor = useCallback((opts: PrintOptions): PrintParts => {
    const parts = printParts.current();
    return { ...parts, body: hlPrintCopy.current(parts.body, opts.highlights) };
  }, []);
  printParts.current = () => ({
    title: page.title,
    meta: [actorName(who), `Updated ${shortDate(whenIso)}`, published ? `v${older?.version ?? page.version}` : 'Draft']
      .filter(Boolean)
      .join(' · '),
    eyebrow: book && book.index >= 0 ? book.title : look.eyebrow,
    footer: `${projectName} · ${page.title} · Printed ${shortDate(new Date().toISOString())}`,
    body: bodyRef.current,
    coverSrc: look.cover ? coverUrl(look.cover.src, resolveOrigin()) : null,
    vars: lookVars(look, 'desktop') as Record<string, string>,
    className: lookClass(look),
    chapter: !!book && book.index >= 0,
  });

  // Ctrl/Cmd+P opens the print panel; a print started from the browser's own menu still prints only the page
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'p') return;
      const t = e.target as HTMLElement | null;
      if (t?.isContentEditable) return;
      e.preventDefault();
      setPrintOpen(true);
    };
    const onBefore = () => {
      if (!isPrinting()) mountPrintSheet(DEFAULT_PRINT as PrintOptions, printParts.current());
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeprint', onBefore);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeprint', onBefore);
    };
  }, []);

  useWideBlocks(bodyEl, `${richKey}:${renderedKey}:${older?.version ?? ''}`);

  const tocList = (
    <div className="dk-toc-list">
      {headings.map((h) => {
        // before any heading has scrolled into view the first one is the current one (Reader boards 1, 4)
        const on = (activeSlug ?? headings[0]?.slug) === h.slug;
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
            style={{ paddingLeft: 14 + (h.level - 2) * 12 }}
          >
            {h.text}
          </a>
        );
      })}
    </div>
  );

  const statusChips = (
    <>
      {older ? (
        <>
          <span className="mc-chip dk-schip dk-schip-green" data-testid="status-badge">
            <span className="mc-dot" />
            Published · v{older.version}
          </span>
          <span className="mc-chip dk-schip dk-schip-blue" data-testid="older-chip">
            Older version
          </span>
        </>
      ) : published ? (
        <VersionBadge
          version={page.version}
          publishedAt={page.updatedAt}
          by={page.updatedBy}
          onHistory={() => onAction('history')}
          onCompare={onCompare}
        />
      ) : (
        <span className="mc-chip dk-schip dk-schip-amber" data-testid="status-badge">
          <span className="mc-dot" />
          Draft
        </span>
      )}
      {showDraft && published && (
        <span className="mc-chip dk-schip dk-schip-blue">
          <span className="mc-dot" />
          Unpublished changes
        </span>
      )}
      {outdated && (
        <span className="mc-chip dk-schip dk-schip-amber" data-testid="outdated-chip">
          <Icon name="i39" size={11} strokeWidth={2.2} />
          May be outdated
        </span>
      )}
      {offline && <span className="mc-chip dk-schip dk-schip-grey">Offline copy</span>}
    </>
  );

  const pageInfo = (
    <div data-popover className="dk-page-line">
      <span
        title={aiTeam ? `${aiTeam.name}, an AI team` : actorName(who)}
        className={aiTeam ? 'dk-ai-avatar' : undefined}
        data-testid={aiTeam ? 'ai-edited' : undefined}
        style={{
          width: 22,
          height: 22,
          borderRadius: '50%',
          ...av,
          fontSize: 9,
          fontWeight: 700,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {aiTeam ? 'AI' : initials(who)}
      </span>
      <button
        type="button"
        onClick={() => setInfo((v) => !v)}
        aria-expanded={info}
        data-testid="page-info"
        className="dk-page-info"
      >
        {lead} <b style={{ color: 'var(--dp-ink, #1E2A22)', fontWeight: 700 }}>{actorName(who)}</b> ·{' '}
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

  // the outline on a tablet (drawer) and a phone (sheet), with a Chapters tab in a book (Reader 49-50)
  const touchOutline = (
    <TouchOutline
      phone={phone}
      title={book?.title ?? page.title}
      entries={headings}
      activeSlug={activeSlug}
      book={book}
      currentId={page.id}
      tab={toutTab}
      onTab={setToutTab}
      minutesLeft={Math.round(minutes * (1 - readPct / 100))}
      onJump={(slug) => {
        setToc(false);
        jump(slug);
      }}
      onOpen={(id) => {
        setToc(false);
        onOpenPage(id);
      }}
      onClose={() => setToc(false)}
    />
  );

  // on a phone the outline is in the bottom bar; on a tablet it is a pill over the page (Reader boards, A)
  const outlineButton =
    outlineOn && !inlineOutline && !phone ? (
      <div data-popover style={{ position: 'relative' }} className={touch ? 'dk-outline-float' : undefined}>
        <button
          type="button"
          className="st-btn dk-hbtn"
          aria-expanded={toc}
          onClick={() => setToc((v) => !v)}
          data-testid="toc-button"
        >
          <Icon name="i42" size={14} strokeWidth={1.9} />
          {touch ? (
            'Outline'
          ) : (
            <>
              On this page
              <Icon name="chevronDown" size={11} strokeWidth={2.3} style={{ color: 'var(--dp-muted, #9AA8A0)' }} />
            </>
          )}
        </button>
        {toc && !touch && (
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

  // the phone's bottom bar: the four things a reader reaches for (Reader boards, A: Outline, Find, Text, Share)
  const readBar = phone ? (
    // fixed to the bottom of the screen, edge to edge (Reader boards K 78: five 78 px items on 390), whatever margins
    // the app puts around the Docs area
    <nav className="dk-readbar" aria-label="Reading" data-testid="read-bar">
      {outlineOn && (
        <button
          type="button"
          className="dk-readbar-btn"
          aria-expanded={toc}
          onClick={() => setToc((v) => !v)}
          data-testid="toc-button"
        >
          <Icon name="i42" size={20} strokeWidth={1.8} />
          Outline
        </button>
      )}
      <button type="button" className="dk-readbar-btn" onClick={() => openDocsFind(false)} data-testid="read-find">
        <Icon name="search" size={20} strokeWidth={1.8} />
        Find
      </button>
      {hl.readBarButton}
      <button
        type="button"
        className="dk-readbar-btn"
        aria-expanded={readerOpen}
        onClick={() => setReaderOpen(true)}
        data-testid="read-text"
      >
        <AaGlyph />
        Text
      </button>
      <button
        type="button"
        className="dk-readbar-btn"
        onClick={() => (canShare ? setShareSheet(true) : onAction('copy-link'))}
        data-testid="read-share"
      >
        <Icon name="link" size={20} strokeWidth={1.8} />
        {canShare ? 'Share' : 'Copy link'}
      </button>
    </nav>
  ) : null;

  // Export and Print sit in More when the header has no room for them (headerActions.ts)
  const moreHidden: PageMenuAction[] = plan.export === 'open' ? ['export'] : [];
  const moreExtra: PageMenuAction[] = plan.print === 'open' ? [] : ['print'];
  function menuAction(a: PageMenuAction) {
    setMenu(false);
    if (a === 'print') setPrintOpen(true);
    else if (a === 'export' && onExport) onExport(null);
    else onAction(a);
  }

  const aiItems =
    published && !offline && !older && !readOnly ? (
      <AiChangesItems page={page} projectId={projectId} canEdit={!readOnly} onClose={() => setMenu(false)} />
    ) : null;

  const menuButton = (
    <div data-popover style={{ position: 'relative' }}>
      <button
        type="button"
        className="dk-icobtn dk-bar-more dk-hico"
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
          hidden={moreHidden}
          extra={moreExtra}
          onAction={menuAction}
          onClose={() => setMenu(false)}
          aiItems={aiItems}
        />
      )}
    </div>
  );

  const editLabel = page.draft ? 'Continue editing' : 'Edit';

  return (
    <PageTeamHost
      settled={settled}
      review={sg.review}
      page={page}
      projectId={projectId}
      askable={askable}
      layout={layout}
      onOpenTicket={onOpenTicket}
    >
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
        {prefs.theme !== 'white' && <style>{readerThemeCss()}</style>}
        {!readOnly && !older && <LockMarks ids={lockedBlocks(page.settings)} />}
        {/* the page bar spans the page and the outline beside it (Reader boards, A); the page's colours and the
            reader's theme are set here, so the bar, the outline and the side panels take them too */}
        <div
          className={`dk-page-frame ${lookClass(readerLook)} ${readerClass(prefs)}`.trim()}
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            ...lookVars(readerLook, layout),
            ...readerVars(prefs),
          }}
          data-reader-theme={prefs.theme}
        >
          {/* The page bar: where you are, the status and the page actions; it stays while the page scrolls */}
          <div
            className={`dk-pagebar${focus ? ' dk-pagebar-focus' : ''}`}
            data-testid="page-bar"
            role="banner"
            aria-label="Page header"
          >
            {focus && (
              <button
                type="button"
                className={phone ? 'dk-icobtn dk-bar-ico' : 'st-btn dk-hbtn dk-focus-back'}
                aria-label={`Back to ${focus.label}`}
                title={`Back to ${focus.label}`}
                data-testid="focus-back"
                onClick={focus.onLeave}
              >
                <svg
                  aria-hidden="true"
                  width={phone ? 20 : 14}
                  height={phone ? 20 : 14}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0 }}
                >
                  <path d="M19 12H5M11 6l-6 6 6 6" />
                </svg>
                {!phone && <span className="dk-focus-back-label">{focus.label}</span>}
              </button>
            )}
            {onOpenSidebar && !focus && (
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
              {/* in focus "← Kanban Board" already names the space (Reader 1, 4) */}
              {!phone && !focus && (
                <>
                  <Icon
                    name="folder"
                    size={13}
                    strokeWidth={1.8}
                    style={{ color: 'var(--dp-muted, #9AA8A0)', flexShrink: 0 }}
                  />
                  <span style={crumb}>{projectName}</span>
                  <CrumbSep />
                </>
              )}
              {/* a phone in focus has no path: back, Edit and More (Reader 1, 3, 6, 9) */}
              {!(phone && focus) &&
                shownPath.map((p, i) =>
                  p ? (
                    <span key={p.id} style={{ display: 'contents' }}>
                      <button type="button" className="dk-crumb" onClick={() => onOpenPage(p.id)} style={crumb}>
                        {p.title}
                      </button>
                      <CrumbSep />
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
                      <CrumbSep />
                    </span>
                  ),
                )}
              {!(phone && focus) && <span className="dk-crumb-here">{page.title}</span>}
            </nav>
            <div className="dk-pagebar-actions">
              {readOnly && viewer && !phone && !older && (
                <ViewerNote
                  projectId={projectId}
                  projectName={projectName}
                  role={viewer.role}
                  reason={readOnly}
                  admins={viewer.admins}
                />
              )}
              {book && !chapterSide && book.chapters.length > 0 && (
                <button
                  type="button"
                  className={phone ? 'dk-icobtn dk-bar-ico' : 'st-btn dk-hbtn'}
                  aria-label="Chapters"
                  title="Chapters"
                  aria-expanded={chaptersOpen}
                  data-testid="chapters-button"
                  onClick={() => setChaptersOpen(true)}
                >
                  <Icon name="page" size={phone ? 18 : 14} strokeWidth={1.9} />
                  {!phone && 'Chapters'}
                </button>
              )}
              {!touch && outlineButton}
              {/* reading in focus the app header is gone: its Ask AI and bell come into the page bar */}
              {focus && <AskAiButton compact={touch} />}
              {focus && (
                <span className="dk-focus-bell">
                  <NotificationBellButton />
                </span>
              )}
              {phone && onSearch && !focus && (
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
              {!phone && !offline && !older && (
                <PageAiMenu
                  projectId={projectId}
                  page={page}
                  canEdit={!readOnly}
                  view={aiView}
                  onEdit={() => onAction('edit')}
                  onOpenTicket={onOpenTicket}
                />
              )}
              {!offline && hl.headerButton}
              {!phone && !offline && !older && (
                <RefsButton pageId={page.id} onOpenPage={onOpenPage} onOpenTicket={onOpenTicket} />
              )}
              {!phone && !offline && plan.comments !== 'more' && (
                <button
                  type="button"
                  className={plan.comments === 'icon' ? 'st-btn dk-hbtn dk-hico' : 'st-btn dk-hbtn'}
                  aria-pressed={cc.open}
                  aria-label={plan.comments === 'icon' ? `Comments, ${commentTotal}` : undefined}
                  title={plan.comments === 'icon' ? 'Comments' : undefined}
                  data-testid="comments-button"
                  onClick={() => cc.setOpen((v) => !v)}
                >
                  <Icon name="comment" size={14} strokeWidth={1.9} />
                  {plan.comments === 'open' && 'Comments'}
                  <span className="dc-btn-count" data-testid="comments-count">
                    {commentTotal}
                  </span>
                  {anyUnread && <span className="dc-btn-dot" data-testid="comments-unread" />}
                </button>
              )}
              {!phone && plan.reader !== 'more' && (
                <div data-popover style={{ position: 'relative' }}>
                  <button
                    type="button"
                    className="dk-icobtn dk-hico"
                    aria-label="Reading settings"
                    title="Reading settings"
                    aria-expanded={readerOpen}
                    data-testid="reader-button"
                    onClick={() => setReaderOpen((v) => !v)}
                  >
                    <AaGlyph />
                  </button>
                  {readerOpen && (
                    <ReaderSettingsPopover
                      prefs={prefs}
                      onChange={setPrefs}
                      pagePx={TEXT_SIZE_PX[look.textSize]}
                      onClose={() => setReaderOpen(false)}
                    />
                  )}
                </div>
              )}
              {!phone && !offline && (
                <FollowBell scope="page" scopeId={page.id} projectId={projectId} className="dk-hico" />
              )}
              {!phone && (
                <div data-popover style={{ position: 'relative' }}>
                  <button
                    type="button"
                    className={plan.share === 'icon' ? 'st-btn dk-hbtn dk-hico' : 'st-btn dk-hbtn'}
                    onClick={() => (canShare ? setShare((v) => !v) : onAction('copy-link'))}
                    data-testid="share"
                    aria-expanded={share}
                    aria-label={plan.share === 'icon' ? (canShare ? 'Share' : 'Copy link') : undefined}
                    title={plan.share === 'icon' ? (canShare ? 'Share' : 'Copy link') : undefined}
                  >
                    <Icon name="link" size={14} strokeWidth={1.9} />
                    {plan.share === 'open' && (canShare ? 'Share' : 'Copy link')}
                  </button>
                  {share && (
                    <SharePopover page={page} onClose={() => setShare(false)} publicLinks={{ canEdit: !readOnly }} />
                  )}
                </div>
              )}
              {!phone && plan.export === 'open' && (
                <div data-popover style={{ position: 'relative' }}>
                  <button
                    type="button"
                    className="st-btn dk-hbtn"
                    aria-haspopup="menu"
                    aria-expanded={exportOpen}
                    data-testid="export-button"
                    onClick={() => setExportOpen((v) => !v)}
                  >
                    <Icon name="i43" size={14} strokeWidth={1.9} />
                    Export
                    <Icon name="chevronDown" size={11} strokeWidth={2.3} />
                  </button>
                  {exportOpen && (
                    <ExportMenu
                      onPick={(f) => (onExport ? onExport(f) : onAction('export'))}
                      onClose={() => setExportOpen(false)}
                    />
                  )}
                </div>
              )}
              {!phone && plan.print === 'open' && (
                <button
                  type="button"
                  className="dk-icobtn dk-hico"
                  aria-label="Print"
                  title="Print"
                  data-testid="print-button"
                  onClick={() => setPrintOpen(true)}
                >
                  <Icon name="page" size={15} strokeWidth={1.9} />
                </button>
              )}
              {(!phone || !offline) && (
                <div
                  style={{ position: 'relative' }}
                  onMouseEnter={() => editBlocked && setEditTip(true)}
                  onMouseLeave={() => setEditTip(false)}
                >
                  <button
                    type="button"
                    // a reader who cannot edit sees it greyed, still green (Reader boards, J: frame 66)
                    className="st-btn st-btn-primary dk-hbtn dk-hbtn-primary"
                    disabled={!!editBlocked}
                    aria-description={editBlocked ?? undefined}
                    onClick={() => onAction('edit')}
                    data-testid="edit-page"
                  >
                    {/* a phone's bar has room for the word only (Reader boards, C: "Edit", "Continue") */}
                    {!phone && <Icon name={lock ? 'lock' : 'i15'} size={14} strokeWidth={1.9} />}
                    {phone && page.draft ? 'Continue' : editLabel}
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
            {/* how far the page is read: 3 px under the bar, the only thing that sticks (Reader boards, A) */}
            <div
              className="dk-progress"
              role="progressbar"
              aria-label="Reading progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(readPct)}
              data-testid="read-progress"
            >
              <i style={{ width: `${readPct}%` }} />
            </div>
          </div>
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            {chapterSide && book && (
              <nav aria-label="Chapters" className="dk-chapters-side">
                <ChapterList book={book} currentId={page.id} onOpen={(id) => onOpenPage(id)} />
              </nav>
            )}
            <div
              ref={setScroll}
              className={`dk-page-scroll ${lookClass(readerLook)} ${readerClass(prefs)}`.trim()}
              style={{
                flex: 1,
                minWidth: 0,
                overflowY: 'auto',
                boxSizing: 'border-box',
                position: 'relative',
                ...lookVars(readerLook, layout),
                ...readerVars(prefs),
                ...(paneWidth ? { '--dp-pane-w': `${Math.max(0, paneWidth - 32)}px` } : {}),
              }}
              data-page-width={look.width}
              data-page-bg={look.background}
              data-reader-theme={prefs.theme}
            >
              {hl.strips}
              {touch && outlineButton}
              <div
                className="dk-doc-col"
                data-testid="page-column"
                id="dk-page-main"
                role="main"
                aria-label="The page"
                tabIndex={-1}
              >
                {older && (
                  <OlderVersionBar
                    version={older.version}
                    current={page.version}
                    currentAt={page.updatedAt}
                    onBack={older.onBack}
                    onRestore={readOnly ? undefined : older.onRestore}
                    restoring={older.restoring}
                  />
                )}
                {outdated && (
                  <OutdatedNote
                    outdated={outdated}
                    canEdit={!readOnly}
                    busy={reviewing}
                    onReviewed={() => void markReviewed()}
                  />
                )}
                {lock && <ConvertBar lock={lock} />}
                {!offline && !older && <ConvertedNotice page={page} onViewOriginal={() => onAction('history')} />}
                {!offline && !older && (
                  <div style={{ marginBottom: 16 }}>
                    <SinceViewedBanner page={page} since={since} onCompare={onCompare ?? (() => undefined)} />
                  </div>
                )}
                {!offline && !older && (
                  <DocsAiBanners projectId={projectId} page={page} canEdit={!readOnly} onOpenTicket={onOpenTicket} />
                )}
                {book && book.index >= 0 && (
                  <div className="dk-chapter-line" data-testid="chapter-line">
                    {book.title} · Chapter {book.index + 1} of {book.chapters.length}
                  </div>
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
                {/* the status: a quiet line under the title (Reader boards, D) */}
                <div className="dk-statusrow">
                  {statusChips}
                  {pageInfo}
                  {/* a phone has no room in the bar: "N references" joins the status line, its list a sheet (Links F 33) */}
                  {phone && !offline && !older && (
                    <RefsButton pageId={page.id} onOpenPage={onOpenPage} onOpenTicket={onOpenTicket} />
                  )}
                  <SuggestionChip />
                  {!offline && !older && !sg.review?.list.length && (
                    <AiEditedChip
                      page={page}
                      projectId={projectId}
                      members={members}
                      canEdit={!readOnly}
                      onCompare={onCompare}
                    />
                  )}
                </div>
                <ReviewBar />
                {!offline && !older && aiOn && (
                  <div style={{ marginTop: 16 }}>
                    <SummaryBlock view={aiView} />
                    <TranslateBanner
                      view={aiView}
                      markdown={published ? page.markdown : (page.draft?.markdown ?? '')}
                    />
                  </div>
                )}
                {!offline && !older && published && (
                  <div style={{ marginTop: 16 }}>
                    <PageWork pageId={page.id} onOpenTicket={onOpenTicket} />
                    <TeamRunEndings
                      page={page}
                      onOpenTicket={onOpenTicket}
                      onCompare={onCompare}
                      onReview={sg.review?.list.length ? () => sg.review?.focus(sg.review.list[0].id) : undefined}
                    />
                  </div>
                )}
                <ArrivalBanner />
                <div ref={setBody} data-testid="page-body" style={{ position: 'relative' }}>
                  {!published && !older && (
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
                  {older && !olderDetail && (
                    <div aria-busy="true" aria-label="Loading the version" style={{ display: 'grid', gap: 10 }}>
                      <div className="skel" style={{ width: '100%', height: 11 }} />
                      <div className="skel" style={{ width: '92%', height: 11 }} />
                      <div className="skel" style={{ width: '64%', height: 11 }} />
                    </div>
                  )}
                  {older && olderDetail && !richDoc && (
                    <DocsMarkdown
                      key={contentKey(olderDetail.markdown)}
                      projectId={projectId}
                      projectName={projectName}
                      onOpenPage={onOpenPage}
                      onOpenTicket={onOpenTicket}
                      progressive={renderedKey !== page.id}
                      onRendered={onRendered}
                    >
                      {olderDetail.markdown}
                    </DocsMarkdown>
                  )}
                  {older && richDoc && (
                    <RichDocView
                      key={richKey}
                      doc={richDoc}
                      projectId={projectId}
                      projectName={projectName}
                      onOpenPage={onOpenPage}
                      onOpenTicket={onOpenTicket}
                      progressive={renderedKey !== page.id}
                      onRendered={onRendered}
                    />
                  )}
                  {!older && (published || page.draft) && (
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
                          blockWrap={sg.wrap}
                          lead={sg.lead}
                          tail={sg.tail}
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
                  {!older && !offline && published && richDoc && !translated && (
                    <BlockRefBadges root={bodyEl} pageId={page.id} revision={richKey} onOpenPage={onOpenPage} />
                  )}
                  {!older && !offline && published && commentsData && (
                    <MarginMarks
                      root={bodyEl}
                      doc={richDoc && !translated ? richDoc : null}
                      threads={inlineThreads}
                      panelOpen={cc.open}
                      activeId={cc.activeId}
                      layout={layout}
                      revision={richKey || page.markdown}
                      canComment={canComment}
                      onSelect={cc.activate}
                      onComment={setCompose}
                    />
                  )}
                </div>
                {!older && (
                  <ReadingFooter prev={around.prev} next={around.next} book={book} onOpen={(id) => onOpenPage(id)} />
                )}
                {!offline && !older && <PageComments projectId={projectId} data={commentsData} actions={cc.actions} />}
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
                doc={!older && published && !translated ? richDoc : null}
              />
            )}
            {hl.rail}
            {!hl.rail && inlineOutline && outlineOn && (
              <nav
                aria-label="On this page"
                className="dk-toc"
                ref={tocNavRef}
                // as tall as the pane (a flex child of it): a list taller than that scrolls here, so its end can be reached
              >
                <div>
                  {hl.outlineTabs}
                  <span className="dk-toc-head">On this page</span>
                  {tocList}
                  <div className="dk-toc-foot">
                    <span data-testid="minutes-left">
                      {Math.max(1, Math.round(minutes * (1 - readPct / 100)))} min left
                    </span>
                    <button
                      type="button"
                      className="dk-toc-top"
                      onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
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
                </div>
              </nav>
            )}
          </div>
        </div>
        {cc.open && !offline && phone && (
          <PhoneComments
            projectId={projectId}
            version={page.version}
            data={commentsData}
            loading={cc.query.isLoading}
            actions={cc.actions}
            tab={cc.tab}
            onTab={cc.setTab}
            activeId={cc.activeId}
            onActivate={cc.activate}
            reattachId={cc.reattachId}
            onReattach={cc.setReattachId}
            onClose={() => cc.setOpen(false)}
            doc={!older && published && !translated ? richDoc : null}
          />
        )}
        {cc.open && !offline && touch && !phone && (
          <DocsDrawer
            side="right"
            width={380}
            label="Comments"
            onClose={() => cc.setOpen(false)}
            testId="comments-drawer"
            look="read"
            scrim={0.18}
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
              doc={!older && published && !translated ? richDoc : null}
            />
          </DocsDrawer>
        )}
        {readBar}
        {touch &&
          toc &&
          (phone ? (
            <BottomSheet label="On this page" onClose={() => setToc(false)} testId="toc-sheet" look="read" hideTitle>
              <div data-popover className="dk-toc-sheet">
                {touchOutline}
              </div>
            </BottomSheet>
          ) : (
            <DocsDrawer
              side="right"
              width={340}
              label="Outline"
              onClose={() => setToc(false)}
              testId="toc-drawer"
              look="read"
            >
              {touchOutline}
            </DocsDrawer>
          ))}
        {phone && menu && (
          <BottomSheet label={page.title} onClose={() => setMenu(false)} testId="page-menu-sheet" look="read" eyebrow>
            <div data-popover>
              <div className="dk-menu-sheet">
                <button
                  type="button"
                  className="dk-mi"
                  data-testid="sheet-share"
                  onClick={() => {
                    setMenu(false);
                    if (canShare) setShareSheet(true);
                    else onAction('copy-link');
                  }}
                >
                  <Icon name="link" size={15} strokeWidth={1.8} />
                  <span>{canShare ? 'Share' : 'Copy link'}</span>
                </button>
                {!offline && <FollowMenuItem pageId={page.id} projectId={projectId} />}
                <button
                  type="button"
                  className="dk-mi"
                  data-testid="sheet-reader"
                  onClick={() => {
                    setMenu(false);
                    setReaderOpen(true);
                  }}
                >
                  <AaGlyph />
                  <span>Text and theme</span>
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
                hidden={moreHidden}
                extra={moreExtra}
                onAction={menuAction}
                onClose={() => setMenu(false)}
                aiItems={aiItems}
              />
            </div>
          </BottomSheet>
        )}
        {phone && readerOpen && (
          <BottomSheet label="Reading" onClose={() => setReaderOpen(false)} testId="reader-sheet" hideTitle look="read">
            <div data-popover>
              <ReaderSettingsPanel prefs={prefs} onChange={setPrefs} pagePx={TEXT_SIZE_PX[look.textSize]} />
            </div>
          </BottomSheet>
        )}
        {phone && shareSheet && (
          <BottomSheet
            label="Share page"
            onClose={() => setShareSheet(false)}
            testId="share-sheet"
            hideTitle
            look="read"
          >
            <SharePopover
              page={page}
              variant="sheet"
              onClose={() => setShareSheet(false)}
              publicLinks={{ canEdit: !readOnly }}
            />
          </BottomSheet>
        )}
        {chaptersOpen &&
          book &&
          (phone ? (
            <BottomSheet label="Chapters" onClose={() => setChaptersOpen(false)} testId="chapters-sheet" look="read">
              <ChapterList
                book={book}
                currentId={page.id}
                onOpen={(id) => {
                  setChaptersOpen(false);
                  onOpenPage(id);
                }}
              />
            </BottomSheet>
          ) : (
            <DocsDrawer
              side="left"
              width={320}
              label="Chapters"
              onClose={() => setChaptersOpen(false)}
              testId="chapters-drawer"
              look="read"
            >
              <div style={{ padding: 16 }}>
                <ChapterList
                  book={book}
                  currentId={page.id}
                  onOpen={(id) => {
                    setChaptersOpen(false);
                    onOpenPage(id);
                  }}
                />
              </div>
            </DocsDrawer>
          ))}
        {printOpen && (
          <PrintDialog
            hasCover={!!look.cover}
            inBook={!!book && book.index >= 0}
            onPrint={(opts) => {
              setPrintOpen(false);
              printPage(opts, printFor(opts));
            }}
            onClose={() => setPrintOpen(false)}
            preview={printFor}
          />
        )}
        <SelectionToolbar
          root={bodyEl}
          label={cc.reattachId ? 'Attach here' : 'Comment'}
          enabled={(canComment || aiOn || askable || hl.selectable) && !compose}
          onPick={onPick}
          hideComment={!canComment}
          lead={hl.selectionLead}
          extra={
            aiOn || askable
              ? (pick, close) => (
                  <>
                    {aiOn && <SelectionAi pick={pick} pageId={page.id} view={aiView} done={close} noAsk={askable} />}
                    <AskTeamButton
                      capture={() => ({
                        quote: pick.anchor.quote,
                        blockId: topBlockIdOf(pick.range?.startContainer),
                      })}
                      onOpened={close}
                    />
                  </>
                )
              : undefined
          }
        />
        {aiOn && <ExplainCard view={aiView} />}
        {hl.overlays}
        {compose && (
          <ComposePopover
            pick={compose}
            projectId={projectId}
            members={suggest}
            me={commentsData ? personOf(commentsData.me, commentsData.members, commentsData.me) : undefined}
            onCancel={() => {
              setCompose(null);
              hl.threadCreated(null);
            }}
            onSubmit={async (text) => {
              const t = await cc.actions.createThread.mutateAsync({
                kind: 'inline',
                body: text,
                anchor: compose.anchor,
              });
              setCompose(null);
              window.getSelection()?.removeAllRanges();
              cc.created(t);
              hl.threadCreated(t.id);
            }}
          />
        )}
      </div>
    </PageTeamHost>
  );
}

/**
 * "Follow this page" in a phone's More sheet, where the bell does not fit: follows, or stops following or muting.
 * @param props.pageId - The page.
 * @param props.projectId - Its project.
 */
function FollowMenuItem({ pageId, projectId }: { pageId: string; projectId: string }) {
  const q = useFollow('page', pageId);
  const set = useSetFollow('page', pageId);
  const level = q.data?.level ?? null;
  const label = level === 'mute' ? 'Muted · Unmute' : level ? 'Following · Stop following' : 'Follow this page';
  return (
    <button
      type="button"
      className="dk-mi"
      data-testid="sheet-follow"
      aria-pressed={!!level && level !== 'mute'}
      disabled={set.isPending}
      onClick={() => set.mutate({ level: level ? null : 'follow', projectId })}
    >
      <Icon name="i44" size={15} strokeWidth={1.8} />
      <span>{label}</span>
    </button>
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
