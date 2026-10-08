import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useDocsPage } from '../../api/docs';
import { useTicket } from '../../api/tickets';
import type { DocsHeading, DocsPage, DocsRefResult } from '../../types/docs';
import { actorInitials, actorName, relativeTime } from '../../utils/relativeTime';
import { slugify } from '../../utils/docsMarkdown';
import { avatarColors, ticketStatus } from './docsUi';
import './docs.css';
import { TicketDeletedCard, TicketPageCard } from './RefCardsTicket';
import { Icon } from './Icon';

export interface RefChipProps {
  kind: 'page' | 'ticket';
  /** Text as written in the markdown (custom label, or "Page › Section", or the ticket key). */
  label: string;
  result?: DocsRefResult;
  projectId?: string;
  projectName?: string;
  /** Page references: the page title and optional section parsed from `[[Page#Section|label]]`. */
  pageTitle?: string;
  anchor?: string | null;
  /** true when the author wrote `[[Page|custom text]]`. */
  custom?: boolean;
  onOpenPage?: (pageId: string, anchor?: string | null) => void;
  onOpenTicket?: (ticketId: string) => void;
  /** Where the chip sits: in Docs pages (default) or inside a ticket (opens the side panel, ticket-style cards). */
  surface?: 'docs' | 'ticket';
  /** Ticket surface: open the 480px side panel. */
  onPeek?: (pageId: string, anchor?: string | null, hint?: { deleted?: boolean; title?: string }) => void;
  /** Ticket surface: leave the ticket for the page in Docs. */
  onOpenInDocs?: (pageId: string, anchor?: string | null) => void;
  /** A plain pill with no hover card or click (lists, diffs). */
  staticPill?: boolean;
  /** "Create it" on a missing page. */
  onCreatePage?: (title: string) => void;
  /** "Restore" on a page in the Recycle Bin. */
  onRestorePage?: (pageId: string) => void;
  /** "Use \"Authentication\"" on a missing section: rewrite the stored reference. */
  onReplaceSection?: (from: { title: string; anchor: string }, to: string) => void;
}

/* ---------- hover plumbing: 400 ms open, 250 ms close, Esc closes ---------- */

function useHoverCard(openDelay = 400, closeDelay = 250) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const openT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (openT.current) clearTimeout(openT.current);
    if (closeT.current) clearTimeout(closeT.current);
    openT.current = null;
  };
  useEffect(() => clear, []);
  const enter = useCallback(
    (el: HTMLElement | null, delay = openDelay) => {
      if (closeT.current) clearTimeout(closeT.current);
      if (open || openT.current) return;
      openT.current = setTimeout(() => {
        openT.current = null;
        if (el) setRect(el.getBoundingClientRect());
        setOpen(true);
      }, delay);
    },
    [open, openDelay],
  );
  const leave = useCallback(() => {
    if (openT.current) clearTimeout(openT.current);
    openT.current = null;
    if (closeT.current) clearTimeout(closeT.current);
    closeT.current = setTimeout(() => setOpen(false), closeDelay);
  }, [closeDelay]);
  const keep = useCallback(() => {
    if (closeT.current) clearTimeout(closeT.current);
  }, []);
  const close = useCallback(() => {
    clear();
    setOpen(false);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);
  return { open, rect, enter, leave, keep, close };
}

interface FloatInfo {
  arrowLeft: number;
  flipped: boolean;
}

function Floating({
  rect,
  width,
  onEnter,
  onLeave,
  children,
  role = 'dialog',
  label,
  ticket,
}: {
  rect: DOMRect;
  width: number;
  onEnter: () => void;
  onLeave: () => void;
  children: ReactNode | ((i: FloatInfo) => ReactNode);
  role?: string;
  label?: string;
  ticket?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const gap = ticket ? 9 : 6;
  const [pos, setPos] = useState<{ left: number; top: number; flipped: boolean }>({
    left: rect.left,
    top: rect.bottom + gap,
    flipped: false,
  });
  useEffect(() => {
    const h = ref.current?.offsetHeight ?? 0;
    let top = rect.bottom + gap;
    let flipped = false;
    if (top + h > window.innerHeight - 8 && rect.top - gap - h > 8) {
      top = rect.top - gap - h;
      flipped = true;
    }
    const left = Math.max(ticket ? 16 : 8, Math.min(rect.left, window.innerWidth - width - (ticket ? 16 : 8)));
    setPos({ left, top, flipped });
  }, [rect, width, gap, ticket]);
  const info: FloatInfo = {
    arrowLeft: Math.max(14, Math.min(width - 28, rect.left + rect.width / 2 - pos.left - 6)),
    flipped: pos.flipped,
  };
  return createPortal(
    <div
      className="docs-root"
      ref={ref}
      role={role}
      aria-label={label}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{ position: 'fixed', left: pos.left, top: pos.top, width, zIndex: 1500 }}
    >
      {typeof children === 'function' ? children(info) : children}
    </div>,
    document.body,
  );
}

/** A small dark tooltip with an optional action: "Page not found — Create it". */
function ChipTip({
  rect,
  icon,
  text,
  action,
  onAction,
  onEnter,
  onLeave,
}: {
  rect: DOMRect;
  icon?: ReactNode;
  text: string;
  action?: string;
  onAction?: () => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  return createPortal(
    <div
      className="docs-root dk-tt"
      role="tooltip"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{
        position: 'fixed',
        left: rect.left,
        top: rect.bottom + 6,
        zIndex: 1500,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      {icon}
      <span>{text}</span>
      {action && onAction && (
        <>
          <span style={{ color: '#9AA8A0' }}>—</span>
          <span
            role="button"
            tabIndex={0}
            onClick={onAction}
            onKeyDown={(e) => e.key === 'Enter' && onAction()}
            style={{
              color: '#CFFFDC',
              fontWeight: 700,
              textDecoration: 'underline',
              textUnderlineOffset: 2,
              cursor: 'pointer',
            }}
          >
            {action}
          </span>
        </>
      )}
    </div>,
    document.body,
  );
}

/* ---------- text helpers for the preview cards ---------- */

function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[!\w+\]\s*/g, '')
    .replace(/\[\[([^\]|#]+?)(?:#[^\]|]+?)?(?:\|([^\]]+?))?\]\]/g, (_m, t, l) => l || t)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function excerptOf(markdown: string, anchor?: string | null): string {
  if (anchor) {
    const lines = markdown.split('\n');
    const want = slugify(anchor);
    let at = -1;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
      if (m && slugify(m[1].replace(/[*_`~]/g, '')) === want) {
        at = i;
        break;
      }
    }
    if (at >= 0) {
      const body: string[] = [];
      for (let i = at + 1; i < lines.length && !/^#{1,6}\s/.test(lines[i]); i++) body.push(lines[i]);
      const t = plain(body.join('\n'));
      if (t) return t;
    }
  }
  const body = markdown
    .split('\n')
    .filter((l) => !/^#{1,6}\s/.test(l))
    .join('\n');
  return plain(body).slice(0, 320);
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

export function closestHeading(headings: DocsHeading[], wanted: string): DocsHeading | null {
  const w = slugify(wanted);
  let best: DocsHeading | null = null;
  let score = Infinity;
  for (const h of headings) {
    const s = h.slug;
    let d = levenshtein(w, s);
    if (s.startsWith(w) || w.startsWith(s) || s.includes(w) || w.includes(s)) d = Math.min(d, 1);
    if (d < score) {
      score = d;
      best = h;
    }
  }
  return best && score <= Math.max(4, Math.floor(w.length / 2)) ? best : null;
}

/* ---------- the chip bodies ---------- */

const sage = { color: '#68BA7F', fontWeight: 500 } as const;

function PageChipBody({
  title,
  anchor,
  section,
  custom,
  label,
  color,
}: {
  title?: string;
  anchor?: string | null;
  section?: string;
  custom?: boolean;
  label: string;
  color?: string;
}) {
  if (!title) return <>{label}</>;
  if (custom) {
    return <span style={{ borderBottom: `1px dotted ${color ?? '#68BA7F'}` }}>{label}</span>;
  }
  const slash = title.lastIndexOf('/');
  return (
    <>
      {slash >= 0 ? (
        <>
          <span style={sage}>{title.slice(0, slash).trim()} /</span>
          {title.slice(slash + 1).trim()}
        </>
      ) : (
        title
      )}
      {anchor && (
        <>
          <span style={color ? { color, fontWeight: 500 } : sage}>›</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            <Icon name="hash" size={11} strokeWidth={2.2} />
            {section ?? anchor}
          </span>
        </>
      )}
    </>
  );
}

export function RefChip(props: RefChipProps) {
  const { kind, label, result, onOpenPage, onOpenTicket } = props;
  const ticketSurface = props.surface === 'ticket';
  const hover = useHoverCard(ticketSurface ? 300 : 400, ticketSurface ? 150 : 250);
  const ref = useRef<HTMLElement | null>(null);
  const status = result?.status ?? 'ok';
  const ticketKey = kind === 'ticket' ? (result?.key ?? label) : '';

  if (props.staticPill) {
    if (kind === 'ticket') {
      const st = ticketStatus(result?.ticketStatus);
      return (
        <span className="dk-chip dk-chip-ticket" data-testid="ref-static" style={{ cursor: 'default' }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: st.color,
              flexShrink: 0,
              display: 'inline-block',
            }}
          />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600 }}>{ticketKey}</span>
        </span>
      );
    }
    return (
      <span
        className={status === 'section_missing' ? 'dk-chip' : 'dk-chip dk-chip-page'}
        data-testid="ref-static"
        style={{
          cursor: 'default',
          ...(status === 'section_missing'
            ? { background: '#FEF6E7', border: '1px dashed #E3C27A', color: '#7A4F08' }
            : {}),
        }}
      >
        <Icon name="page" size={13} strokeWidth={1.9} />
        <PageChipBody
          title={props.pageTitle}
          anchor={props.anchor}
          section={result?.section}
          custom={props.custom}
          label={label}
        />
      </span>
    );
  }

  // ---------- tickets ----------
  if (kind === 'ticket') {
    if (result && result.status !== 'ok') {
      return (
        <>
          <span
            ref={ref as React.RefObject<HTMLSpanElement>}
            className="dk-chip dk-chip-missing"
            tabIndex={0}
            onMouseEnter={() => hover.enter(ref.current, 150)}
            onMouseMove={() => hover.enter(ref.current, 150)}
            onMouseLeave={() => {
              if (!ref.current?.matches(':hover')) hover.leave();
            }}
            onFocus={() => hover.enter(ref.current, 0)}
            onBlur={hover.leave}
          >
            <Icon name="i22" size={13} strokeWidth={2} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600 }}>{label}</span>
          </span>
          {hover.open && hover.rect && (
            <ChipTip
              rect={hover.rect}
              text="Ticket not found, or in another project"
              onEnter={hover.keep}
              onLeave={hover.leave}
            />
          )}
        </>
      );
    }
    const st = ticketStatus(result?.ticketStatus);
    return (
      <>
        <span
          ref={ref as React.RefObject<HTMLSpanElement>}
          role="link"
          tabIndex={0}
          className="dk-chip dk-chip-ticket"
          data-testid={`ref-ticket-${ticketKey}`}
          onClick={() => onOpenTicket?.(ticketKey)}
          onKeyDown={(e) => e.key === 'Enter' && onOpenTicket?.(ticketKey)}
          onMouseEnter={() => hover.enter(ref.current)}
          onMouseMove={() => hover.enter(ref.current)}
          onMouseLeave={() => {
            if (!ref.current?.matches(':hover')) hover.leave();
          }}
          onFocus={() => hover.enter(ref.current)}
          onBlur={hover.leave}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: st.color,
              flexShrink: 0,
              display: 'inline-block',
            }}
          />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600 }}>{ticketKey}</span>
        </span>
        {hover.open && hover.rect && (
          <Floating
            rect={hover.rect}
            width={400}
            onEnter={hover.keep}
            onLeave={hover.leave}
            label={`Ticket ${ticketKey}`}
          >
            <TicketCard
              ticketKey={ticketKey}
              fallbackStatus={result?.ticketStatus}
              onOpen={() => {
                hover.close();
                onOpenTicket?.(ticketKey);
              }}
            />
          </Floating>
        )}
      </>
    );
  }

  // ---------- pages ----------
  const pageTitle = props.pageTitle;
  const missing = status === 'missing';
  const inBin = status === 'in_bin';
  const sectionMissing = status === 'section_missing';

  if (missing) {
    return (
      <>
        <span
          ref={ref as React.RefObject<HTMLSpanElement>}
          className="dk-chip dk-chip-missing"
          tabIndex={0}
          onMouseEnter={() => hover.enter(ref.current, 150)}
          onMouseMove={() => hover.enter(ref.current, 150)}
          onMouseLeave={() => {
            if (!ref.current?.matches(':hover')) hover.leave();
          }}
          onFocus={() => hover.enter(ref.current, 0)}
          onBlur={hover.leave}
        >
          <Icon name="i22" size={13} strokeWidth={2} />
          {label}
        </span>
        {hover.open && hover.rect && (
          <ChipTip
            rect={hover.rect}
            text="Page not found"
            action={props.onCreatePage ? 'Create it' : undefined}
            onAction={() => {
              hover.close();
              props.onCreatePage?.(pageTitle ?? label);
            }}
            onEnter={hover.keep}
            onLeave={hover.leave}
          />
        )}
      </>
    );
  }
  if (inBin) {
    return (
      <>
        <span
          ref={ref as React.RefObject<HTMLSpanElement>}
          className="dk-chip"
          tabIndex={0}
          data-testid="ref-in-bin"
          onClick={() =>
            ticketSurface &&
            result?.pageId &&
            props.onPeek?.(result.pageId, null, { deleted: true, title: pageTitle ?? label })
          }
          style={{
            background: '#F1F3F1',
            border: '1px solid #DCE6DF',
            color: '#7A8A80',
            textDecoration: 'line-through',
            textDecorationColor: '#9AA8A0',
            cursor: ticketSurface ? 'pointer' : 'default',
          }}
          onMouseEnter={() => hover.enter(ref.current, 150)}
          onMouseMove={() => hover.enter(ref.current, 150)}
          onMouseLeave={() => {
            if (!ref.current?.matches(':hover')) hover.leave();
          }}
          onFocus={() => hover.enter(ref.current, 0)}
          onBlur={hover.leave}
        >
          <Icon name="i12" size={13} strokeWidth={1.9} style={{ color: '#9AA8A0' }} />
          {label}
        </span>
        {hover.open && hover.rect && ticketSurface && (
          <Floating
            rect={hover.rect}
            width={400}
            ticket
            onEnter={hover.keep}
            onLeave={hover.leave}
            label="Page in the Recycle Bin"
          >
            {(i) => (
              <TicketDeletedCard
                {...i}
                canRestore={!!props.onRestorePage && !!result?.pageId}
                deletedBy={result?.deletedBy}
                deletedAt={result?.deletedAt}
                onRestore={() => {
                  hover.close();
                  if (result?.pageId) props.onRestorePage?.(result.pageId);
                }}
                onOpenBin={() => {
                  hover.close();
                  if (result?.pageId) props.onPeek?.(result.pageId, null, { deleted: true, title: pageTitle ?? label });
                }}
              />
            )}
          </Floating>
        )}
        {hover.open && hover.rect && !ticketSurface && (
          <ChipTip
            rect={hover.rect}
            icon={<Icon name="i12" size={13} strokeWidth={2} style={{ color: '#F2C98A' }} />}
            text="In Recycle Bin"
            action={props.onRestorePage && result?.pageId ? 'Restore' : undefined}
            onAction={() => {
              hover.close();
              if (result?.pageId) props.onRestorePage?.(result.pageId);
            }}
            onEnter={hover.keep}
            onLeave={hover.leave}
          />
        )}
      </>
    );
  }

  const goAnchor = sectionMissing && !ticketSurface ? null : (result?.anchor ?? props.anchor ?? null);
  const go = () => {
    if (!result?.pageId) return;
    if (ticketSurface && props.onPeek) props.onPeek(result.pageId, goAnchor);
    else onOpenPage?.(result.pageId, sectionMissing ? null : goAnchor);
  };
  const baseStyle = sectionMissing
    ? { background: '#FEF6E7', border: '1px dashed #E3C27A', color: '#7A4F08' }
    : undefined;
  const iconColor = sectionMissing ? '#B4791E' : undefined;
  return (
    <>
      <span
        ref={ref as React.RefObject<HTMLSpanElement>}
        role="link"
        tabIndex={0}
        className={sectionMissing ? 'dk-chip' : 'dk-chip dk-chip-page'}
        data-testid={sectionMissing ? 'ref-section-missing' : 'ref-page'}
        style={baseStyle}
        onClick={go}
        onKeyDown={(e) => e.key === 'Enter' && go()}
        onMouseEnter={() => hover.enter(ref.current)}
        onMouseMove={() => hover.enter(ref.current)}
        onMouseLeave={() => {
          if (!ref.current?.matches(':hover')) hover.leave();
        }}
        onFocus={() => hover.enter(ref.current)}
        onBlur={hover.leave}
      >
        <Icon name="page" size={13} strokeWidth={1.9} style={iconColor ? { color: iconColor } : undefined} />
        <PageChipBody
          title={pageTitle}
          anchor={props.anchor}
          section={result?.section}
          custom={props.custom}
          label={label}
          color={iconColor}
        />
      </span>
      {hover.open && hover.rect && result?.pageId && ticketSurface && !sectionMissing && (
        <Floating
          rect={hover.rect}
          width={400}
          ticket
          onEnter={hover.keep}
          onLeave={hover.leave}
          label={`Preview of ${pageTitle ?? label}`}
        >
          {(i) => (
            <TicketPageCard
              {...i}
              pageId={result.pageId!}
              anchor={result.anchor ?? props.anchor ?? null}
              onPeek={() => {
                hover.close();
                go();
              }}
              onOpenDocs={() => {
                hover.close();
                props.onOpenInDocs?.(result.pageId!, result.anchor ?? props.anchor ?? null);
              }}
            />
          )}
        </Floating>
      )}
      {hover.open && hover.rect && result?.pageId && !(ticketSurface && !sectionMissing) && (
        <Floating
          rect={hover.rect}
          width={sectionMissing ? 330 : 400}
          onEnter={hover.keep}
          onLeave={hover.leave}
          label={`Preview of ${pageTitle ?? label}`}
        >
          {sectionMissing ? (
            <MissingSection
              pageId={result.pageId}
              title={pageTitle ?? label}
              anchor={props.anchor ?? ''}
              onOpen={() => {
                hover.close();
                if (ticketSurface && props.onPeek) props.onPeek(result.pageId!, props.anchor ?? null);
                else onOpenPage?.(result.pageId!, null);
              }}
              onUse={props.onReplaceSection}
              onDone={hover.close}
            />
          ) : (
            <PageCard
              pageId={result.pageId}
              anchor={result.anchor ?? props.anchor ?? null}
              projectName={props.projectName}
              onOpen={() => {
                hover.close();
                go();
              }}
            />
          )}
        </Floating>
      )}
    </>
  );
}

/* ---------- cards ---------- */

const cardStyle = {
  boxSizing: 'border-box',
  border: '1px solid #E3E8E5',
  borderRadius: 12,
  background: '#FFFFFF',
  boxShadow: '0 14px 36px rgba(30,42,34,0.18)',
  overflow: 'hidden',
} as const;

function Dot() {
  return <span style={{ color: '#C7D2CB' }}>|</span>;
}

function PageCard({
  pageId,
  anchor,
  projectName,
  onOpen,
}: {
  pageId: string;
  anchor: string | null;
  projectName?: string;
  onOpen: () => void;
}) {
  const { data: page, isLoading, isError } = useDocsPage(pageId);
  return (
    <div className="docs-root" style={cardStyle}>
      {isLoading || !page ? (
        <div style={{ padding: '14px 16px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {isError ? (
            <span style={{ fontSize: 12.5, color: '#5B6B60' }}>Couldn't load a preview.</span>
          ) : (
            <>
              <div className="skel" style={{ width: 160, height: 12 }} />
              <div className="skel" style={{ width: 220, height: 16 }} />
              <div className="skel" style={{ width: '100%', height: 11 }} />
              <div className="skel" style={{ width: '80%', height: 11 }} />
            </>
          )}
        </div>
      ) : (
        <PageCardBody page={page} anchor={anchor} projectName={projectName} />
      )}
      <div
        style={{ display: 'flex', gap: 8, padding: '10px 16px', borderTop: '1px solid #EEF3EF', background: '#FBFCFB' }}
      >
        <button type="button" className="st-btn st-btn-primary st-btn-sm" onClick={onOpen}>
          <Icon name="i38" size={14} strokeWidth={1.9} />
          Open page
        </button>
      </div>
    </div>
  );
}

function PageCardBody({ page, anchor, projectName }: { page: DocsPage; anchor: string | null; projectName?: string }) {
  const heading = anchor ? page.headings.find((h) => h.slug === slugify(anchor)) : null;
  const text = useMemo(() => excerptOf(page.markdown, anchor), [page.markdown, anchor]);
  const author = actorName(page.updatedBy);
  const av = avatarColors(author);
  return (
    <div style={{ padding: '14px 16px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <Icon name="folder" size={13} strokeWidth={1.8} style={{ color: '#9AA8A0' }} />
        {[projectName ?? 'Docs', ...page.path.map((p) => p.title)].map((t, i) => (
          <span key={i} style={{ display: 'contents' }}>
            <span style={{ fontSize: 12.5, color: '#5B6B60', fontWeight: 500, whiteSpace: 'nowrap' }}>{t}</span>
            <Icon name="chevronRight" size={10} strokeWidth={2.4} style={{ color: '#C7D2CB' }} />
          </span>
        ))}
        <span style={{ fontSize: 12.5, fontWeight: 700, color: '#1E2A22', whiteSpace: 'nowrap' }}>{page.title}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 15, fontWeight: 800, color: '#1E2A22' }}>
        <span style={{ display: 'flex', color: '#2E6F40' }}>
          <Icon name="page" size={17} strokeWidth={1.9} />
        </span>
        {page.title}
        {heading && (
          <>
            <span style={sage}>›</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <Icon name="hash" size={13} strokeWidth={2.2} />
              {heading.text}
            </span>
          </>
        )}
      </div>
      <div
        style={{
          position: 'relative',
          fontSize: 13,
          lineHeight: 1.6,
          color: '#3A4A3E',
          maxHeight: 62,
          overflow: 'hidden',
        }}
      >
        {text || 'This page has no content yet.'}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: 24,
            background: 'linear-gradient(rgba(255,255,255,0),#FFFFFF)',
          }}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#5B6B60' }}>
        <span
          title={author}
          style={{
            width: 20,
            height: 20,
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
          {actorInitials(page.updatedBy).slice(0, 2)}
        </span>
        {author}
        <Dot />
        edited {relativeTime(page.updatedAt)}
        {page.version > 0 && (
          <>
            <Dot />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: '#5B6B60' }}>v{page.version}</span>
          </>
        )}
      </div>
    </div>
  );
}

function TicketCard({
  ticketKey,
  fallbackStatus,
  onOpen,
}: {
  ticketKey: string;
  fallbackStatus?: string;
  onOpen: () => void;
}) {
  const { data: t, isLoading } = useTicket(ticketKey);
  const st = ticketStatus(t?.status ?? fallbackStatus);
  const acs = t?.acceptanceCriteria ?? [];
  const desc = t ? plain(t.description ?? '').slice(0, 200) : '';
  const due = t?.dueDate ? new Date(t.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;
  const who = t?.assignee ? actorName(t.assignee) : null;
  const copy = () => void navigator.clipboard?.writeText(ticketKey);
  return (
    <div className="docs-root" style={cardStyle}>
      <div style={{ padding: '14px 16px 12px', display: 'flex', flexDirection: 'column', gap: 9 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ display: 'flex', color: '#B4791E' }}>
            <Icon name="i58" size={16} strokeWidth={1.8} />
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: '#5B6B60' }}>{ticketKey}</span>
          <span
            style={{
              marginLeft: 'auto',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '3px 8px',
              borderRadius: 5,
              border: '1px solid #E3E8E5',
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: st.color,
                flexShrink: 0,
                display: 'inline-block',
              }}
            />
            <span style={{ fontSize: 11.5, fontWeight: 600, color: '#1E2A22' }}>{st.label}</span>
          </span>
        </div>
        {isLoading || !t ? (
          <>
            <div className="skel" style={{ width: '70%', height: 16 }} />
            <div className="skel" style={{ width: '100%', height: 11 }} />
          </>
        ) : (
          <>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: '#1E2A22', lineHeight: 1.35 }}>{t.title}</div>
            {desc && (
              <div
                style={{
                  fontSize: 12.5,
                  lineHeight: 1.55,
                  color: '#5B6B60',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
              >
                {desc}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: '#5B6B60' }}>
              {who && t.assignee && (
                <>
                  <span
                    title={who}
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: '50%',
                      ...avatarColors(who),
                      fontSize: 11,
                      fontWeight: 700,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    {actorInitials(t.assignee).slice(0, 2)}
                  </span>
                  {who}
                </>
              )}
              {due && (
                <>
                  {who && <Dot />}
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <Icon name="i68" size={13} strokeWidth={1.8} />
                    {due}
                  </span>
                </>
              )}
              {acs.length > 0 && (
                <>
                  {(who || due) && <Dot />}
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <Icon name="check" size={13} strokeWidth={2} />
                    {acs.filter((a) => a.done).length} / {acs.length} AC
                  </span>
                </>
              )}
            </div>
          </>
        )}
      </div>
      <div
        style={{ display: 'flex', gap: 8, padding: '10px 16px', borderTop: '1px solid #EEF3EF', background: '#FBFCFB' }}
      >
        <button type="button" className="st-btn st-btn-primary st-btn-sm" onClick={onOpen}>
          <Icon name="i38" size={14} strokeWidth={1.9} />
          Open ticket
        </button>
        <button type="button" className="st-btn st-btn-sm" onClick={copy}>
          <Icon name="i24" size={14} strokeWidth={1.9} />
          Copy key
        </button>
      </div>
    </div>
  );
}

function MissingSection({
  pageId,
  title,
  anchor,
  onOpen,
  onUse,
  onDone,
}: {
  pageId: string;
  title: string;
  anchor: string;
  onOpen: () => void;
  onUse?: RefChipProps['onReplaceSection'];
  onDone: () => void;
}) {
  const { data: page } = useDocsPage(pageId);
  const closest = page ? closestHeading(page.headings, anchor) : null;
  return (
    <div
      className="docs-root dk-menu"
      style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <div style={{ fontSize: 12.5, lineHeight: 1.5, color: '#1E2A22' }}>
        Section "{anchor}" not found.
        {closest ? (
          <>
            {' '}
            Closest: <b>"{closest.text}"</b>
          </>
        ) : null}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {closest && onUse && (
          <button
            type="button"
            className="st-btn st-btn-primary st-btn-sm"
            onClick={() => {
              onUse({ title, anchor }, closest.text);
              onDone();
            }}
          >
            Use "{closest.text}"
          </button>
        )}
        <button type="button" className="st-btn st-btn-sm" onClick={onOpen}>
          Open page
        </button>
      </div>
    </div>
  );
}
