import { useEffect, useMemo, useRef, useState } from 'react';
import { useCreatePage, useDocsTree, useTicketDocs } from '../../api/docs';
import { client } from '../../api/client';
import type { DocsLinkTargets } from '../../types/docs';
import { useDocsRefs } from './DocsRefsContext';
import { LinkedDocCard } from './links/LinkedDocCard';
import { useProjects } from '../../api/projects';
import { useDocsSuggest, useLinkTicketDoc } from '../../api/docsActions';
import { extractError } from '../../api/extractError';
import { useAiTeams } from '../../api/ai';
import { sendErrorCode, useSendTicketComments, useTicketDocComments } from '../../api/docsSendToAi';
import type { DocsSuggestItem, TicketDocOrigin, TicketDocRow } from '../../types/docsActions';
import { useToast } from '../Toast';
import { SuggestRows } from './DocsSuggest';
import { Icon } from './Icon';
import { useCanvas } from '../canvas/CanvasContext';

interface TicketDocsSectionProps {
  ticketId: string;
  /** Project whose pages the "Link a doc" search offers. */
  projectId?: string;
  onOpenPage: (pageId: string, projectId: string) => void;
}

const WHERE: Record<string, string> = {
  description: 'Mentioned in description',
  comment: 'Mentioned in comment',
  acceptance_criterion: 'Mentioned in acceptance criterion',
  test_case: 'Mentioned in test case',
  debug_note: 'Mentioned in debug note',
};

/** "Mentioned in test case TC-3", "Manual link", "From docs". */
function originLabel(d: { origin?: TicketDocOrigin; detail?: string }): string {
  const o = d.origin ?? 'page';
  if (o === 'manual') return 'Manual link';
  if (o === 'page') return 'From docs';
  return `${WHERE[o] ?? `Mentioned in ${o}`}${o === 'test_case' && d.detail ? ` ${d.detail}` : ''}`;
}

type Chip = { label: string; manual: boolean };
type Grouped = TicketDocRow & {
  /** One chip per place the ticket and the page are tied: a mention, "From docs", "Manual link". */
  chips: Chip[];
  /** The sections of the page the ticket is named in. */
  sections: string[];
  /** Tied by hand (`link_doc`, "Link a doc"): the only part the remove button can undo. */
  manual: boolean;
  /** Named in a field of the ticket (description, comment, ...). */
  mentioned: boolean;
};

/**
 * One row per page, however many places tie it to the ticket: a mention in a field, the page naming the ticket, a
 * manual link. The AI often does two of them, and a page must not be drawn twice.
 */
function mergeByPage(list: TicketDocRow[]): Grouped[] {
  const out = new Map<string, Grouped>();
  for (const d of list) {
    const key = `${d.kind ?? 'page'}:${d.pageId}:${d.canvasId ?? ''}`;
    const o = d.origin ?? 'page';
    const row = out.get(key) ?? { ...d, chips: [], sections: [], manual: false, mentioned: false };
    if (!row.block && d.block) Object.assign(row, { block: d.block, blockId: d.blockId, excerpt: d.excerpt });
    const label = originLabel(d);
    if (!row.chips.some((c) => c.label === label)) row.chips.push({ label, manual: o === 'manual' });
    if (d.section && !row.sections.includes(d.section)) row.sections.push(d.section);
    if (o === 'manual') row.manual = true;
    else if (o !== 'page') row.mentioned = true;
    out.set(key, row);
  }
  return [...out.values()];
}

// RichDocsLinks H 47: an 11 px uppercase group label over a row of 196 px cards
const groupLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: '#5B6B60',
  marginBottom: 6,
};

function LinkPopover({
  projectId,
  linked,
  onPick,
  onClose,
}: {
  projectId?: string;
  linked: Set<string>;
  onPick: (item: DocsSuggestItem) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const suggest = useDocsSuggest(projectId, q, true);
  const projectName = useProjects().data?.find((p) => p.id === projectId)?.name;
  // a linked page is hidden, but its sections stay (typing "Auth" still finds them)
  const items = (suggest.data ?? []).filter((i) => i.kind === 'section' || !linked.has(i.pageId));

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown' && items.length) {
      e.preventDefault();
      setActive((a) => (a + 1) % items.length);
    } else if (e.key === 'ArrowUp' && items.length) {
      e.preventDefault();
      setActive((a) => (a - 1 + items.length) % items.length);
    } else if (e.key === 'Enter' && items[active]) {
      e.preventDefault();
      onPick(items[active]);
    }
  }

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Link a doc"
      onKeyDown={onKey}
      style={{
        position: 'absolute',
        left: 0,
        top: 'calc(100% + 6px)',
        zIndex: 70,
        width: 420,
        maxWidth: 'calc(100vw - 32px)', // not '100%': the parent shrink-wraps the button
        boxSizing: 'border-box',
        border: '1px solid #E3E8E5',
        borderRadius: 12,
        background: '#FFFFFF',
        boxShadow: '0 14px 36px rgba(30,42,34,0.18)',
        padding: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '7px 10px',
          borderRadius: 8,
          border: '1px solid #2E6F40',
          boxShadow: '0 0 0 3px rgba(46,111,64,0.14)',
          fontSize: 13,
          color: '#1E2A22',
        }}
      >
        <span style={{ display: 'flex', color: '#9AA8A0' }}>
          <Icon name="i09" size={14} strokeWidth={2} />
        </span>
        <input
          autoFocus
          aria-label="Search pages and sections"
          placeholder="Search pages…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{
            flex: 1,
            minWidth: 0,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            font: 'inherit',
            color: '#1E2A22',
            padding: 0,
          }}
        />
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '8px 10px 3px',
          fontSize: 11,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: '#5B6B60',
        }}
      >
        {projectName ? `Pages and sections in ${projectName}` : 'Pages and sections in this space'}
      </div>
      <SuggestRows
        items={items}
        active={active}
        query={q}
        onPick={onPick}
        onHover={setActive}
        loading={suggest.isFetching}
      />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '6px 12px',
          padding: '8px 10px 4px',
          marginTop: 4,
          borderTop: '1px solid #EEF3EF',
          fontSize: 11.5,
          color: '#5B6B60',
        }}
      >
        <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
          <span className="dk-kbd">↑ ↓</span> move
        </span>
        <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
          <span className="dk-kbd">Enter</span> link
        </span>
        <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
          <span className="dk-kbd">Esc</span> close
        </span>
      </div>
    </div>
  );
}

/** The teams of a project to choose from when a ticket has none; mounted only then so the list is not polled. */
function GiveTeam({
  projectId,
  busy,
  preferred,
  onGive,
}: {
  projectId?: string;
  busy: boolean;
  /** The team that built the page: the one offered first. */
  preferred?: string;
  onGive: (teamId: string) => void;
}) {
  const teams = (useAiTeams(projectId ?? '').data ?? []).filter((t) => t.kind === 'ai');
  const [teamId, setTeamId] = useState('');
  const chosen = teams.find((t) => t.id === teamId) ?? teams.find((t) => t.id === preferred) ?? teams[0];
  if (teams.length === 0)
    return (
      <span style={{ fontSize: 12, color: '#5B6B60' }} data-testid="ticket-comments-no-team">
        This ticket has no AI team, and neither has the project: add one in Members.
      </span>
    );
  return (
    <div
      data-testid="ticket-comments-give"
      style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, fontSize: 12, color: '#5B6B60' }}
    >
      <span>This ticket has no team.</span>
      <select
        aria-label="Team"
        value={chosen?.id ?? ''}
        onChange={(e) => setTeamId(e.target.value)}
        style={{ font: 'inherit', padding: '4px 6px', borderRadius: 6, border: '1px solid #DCE6DF' }}
      >
        {teams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="st-btn st-btn-sm st-btn-primary"
        disabled={busy || !chosen}
        onClick={() => chosen && onGive(chosen.id)}
      >
        {busy ? 'Sending…' : 'Give it to a team and send'}
      </button>
    </div>
  );
}

/** "Ask the team to apply the comments (3)": the open comment threads of the ticket's linked pages go to its team. */
function ApplyComments({ ticketId, projectId }: { ticketId: string; projectId?: string }) {
  const toast = useToast();
  const info = useTicketDocComments(ticketId);
  const send = useSendTicketComments(ticketId);
  const [needTeam, setNeedTeam] = useState(false);
  const n = info.data?.threads ?? 0;
  if (n === 0) return null;

  async function go(giveTeamId?: string) {
    try {
      const r = await send.mutateAsync({ giveTeamId });
      setNeedTeam(false);
      toast.success('Sent to the team', r.note);
    } catch (err) {
      if (sendErrorCode(err) === 'no_team') setNeedTeam(true);
      else toast.error("Couldn't send the comments", extractError(err));
    }
  }

  const pages = info.data?.pages ?? [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="ticket-comments-send">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="st-btn st-btn-sm"
          disabled={send.isPending}
          onClick={() => void go()}
          title={pages.map((p) => `${p.title} (${p.threads})`).join(', ')}
          data-testid="ticket-comments-send-btn"
        >
          <Icon name="send" size={13} strokeWidth={1.9} />
          {send.isPending && !needTeam ? 'Sending…' : `Ask the team to apply the comments (${n})`}
        </button>
        <span style={{ fontSize: 11.5, color: '#9AA8A0' }}>
          Open comments on {pages.length === 1 ? pages[0].title : `${pages.length} linked pages`}
        </span>
      </div>
      {needTeam && (
        <GiveTeam
          projectId={projectId}
          busy={send.isPending}
          preferred={info.data?.builderTeam?.id}
          onGive={(id) => void go(id)}
        />
      )}
    </div>
  );
}

/**
 * "Linked docs" on a ticket: mentioned / linked manually / pages that mention it, plus "+ Link a doc".
 * @param props.ticketId - Ticket whose linked docs are shown.
 * @param props.projectId - Project whose pages the "Link a doc" search offers.
 * @param props.onOpenPage - Called with page id and project id when a doc is opened.
 */
export function TicketDocsSection({ ticketId, projectId, onOpenPage }: TicketDocsSectionProps) {
  const canvas = useCanvas();
  const toast = useToast();
  const refs = useDocsRefs();
  const { data } = useTicketDocs(ticketId);
  const { link, unlink } = useLinkTicketDoc(ticketId);
  const tree = useDocsTree(projectId ?? '');
  const createPage = useCreatePage(projectId ?? '');
  const [adding, setAdding] = useState(false);
  const docs = useMemo(() => (data ?? []) as unknown as TicketDocRow[], [data]);

  const groups = useMemo(() => {
    const merged = mergeByPage(docs);
    return {
      mentioned: merged.filter((d) => d.mentioned),
      manual: merged.filter((d) => !d.mentioned && d.manual),
      pages: merged.filter((d) => !d.mentioned && !d.manual),
    };
  }, [docs]);
  const linked = useMemo(() => new Set(docs.map((d) => d.pageId)), [docs]);
  const count = groups.mentioned.length + groups.manual.length + groups.pages.length;

  async function add(item: DocsSuggestItem) {
    setAdding(false);
    try {
      // a heading of a rich page is linked by its block, so the card opens the page there (H 48)
      let blockId: string | null = null;
      if (item.kind === 'section' && item.slug) {
        const t = (await client.get<DocsLinkTargets>(`/docs/pages/${item.pageId}/link-targets`)).data;
        blockId = t.headings.find((h) => h.slug === item.slug)?.blockId ?? null;
      }
      await link.mutateAsync({ pageId: item.pageId, blockId });
    } catch (err) {
      toast.error("Couldn't link the doc", extractError(err));
    }
  }

  /** "Write a page for KAN-12": a page that names the ticket (so it links by itself), opened to write. */
  async function writePage() {
    if (!projectId) return;
    try {
      const page = await createPage.mutateAsync({
        title: `Notes for ${ticketId}`,
        markdown: `Notes for ${ticketId}.\n`,
      });
      await link.mutateAsync(page.id);
      onOpenPage(page.id, projectId);
    } catch (err) {
      toast.error("Couldn't start the page", extractError(err));
    }
  }

  const nodes = tree.data ?? [];
  const where = (d: Grouped) => {
    const path = (d.path ?? []).filter((t, i, a) => !(i === a.length - 1 && t === d.title));
    return path.length ? path.join(' › ') : 'Top level';
  };
  const open = (d: Grouped) => {
    if (d.kind === 'canvas' && d.canvasId && canvas.available) return canvas.openViewer({ id: d.canvasId });
    // the side panel at the heading or block (a sheet on a phone); without one, the page in Docs
    if (refs) return refs.peek(d.pageId, d.blockId ? `block-${d.blockId}` : (d.sections[0] ?? null));
    onOpenPage(d.pageId, d.projectId);
  };

  async function remove(d: TicketDocRow) {
    try {
      await unlink.mutateAsync(d.pageId);
    } catch (err) {
      toast.error("Couldn't remove the link", extractError(err));
    }
  }

  const group = (label: string, list: Grouped[]) =>
    list.length > 0 && (
      <div>
        <div style={groupLabel}>{label}</div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {list.map((d) => {
            const node = nodes.find((n) => n.id === d.pageId);
            const target = d.block ?? (d.sections.length === 1 ? { kind: 'heading', label: d.sections[0] } : null);
            return (
              <LinkedDocCard
                key={`${d.kind ?? 'page'}-${d.pageId}-${d.canvasId ?? ''}`}
                testId={`ticket-doc-${d.manual && !d.mentioned ? 'manual' : d.mentioned ? 'mention' : 'page'}`}
                doc={{
                  pageId: d.pageId,
                  title: d.title,
                  icon: node?.icon ?? null,
                  where: where(d),
                  published: (node?.version ?? d.version ?? 1) > 0,
                  target,
                  excerpt: d.excerpt || d.snippet || null,
                  origins: d.chips,
                  canvas: d.kind === 'canvas',
                }}
                onOpen={() => open(d)}
                onRemove={d.manual ? () => void remove(d) : undefined}
              />
            );
          })}
        </div>
      </div>
    );

  return (
    <div
      className="docs-root"
      data-testid="ticket-docs"
      style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 4, borderTop: '1px solid #EEF3EF' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: '#1E2A22' }}>Linked docs</span>
        <span style={{ fontSize: 12.5, color: '#5B6B60' }} data-testid="ticket-docs-count">
          {count === 1 ? '1 page' : `${count} pages`}
        </span>
        <span style={{ flex: 1 }} />
        <div style={{ position: 'relative' }}>
          <button
            type="button"
            className="st-btn"
            style={{ minHeight: 32 }}
            data-testid="ticket-docs-link"
            onClick={() => setAdding((a) => !a)}
          >
            <svg
              width={13}
              height={13}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.4}
              aria-hidden="true"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            Link a doc
          </button>
          {adding && (
            <LinkPopover
              projectId={projectId}
              linked={linked}
              onPick={(i) => void add(i)}
              onClose={() => setAdding(false)}
            />
          )}
        </div>
        {projectId && (
          <button
            type="button"
            className="st-btn st-btn-primary"
            style={{ minHeight: 32 }}
            data-testid="ticket-docs-write"
            disabled={createPage.isPending}
            onClick={() => void writePage()}
          >
            <svg
              width={13}
              height={13}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path d="M4 20h4L19 9l-4-4L4 16z" />
              <path d="M13.5 6.5l4 4" />
            </svg>
            Write a page for {ticketId}
          </button>
        )}
      </div>
      {group('Mentioned in this ticket', groups.mentioned)}
      {group('Linked manually', groups.manual)}
      {group('Pages that mention this ticket', groups.pages)}
      <ApplyComments ticketId={ticketId} projectId={projectId} />
      {count === 0 && (
        <div style={{ fontSize: 12.5, color: '#5B6B60' }}>
          A page that mentions {ticketId} links by itself. A doc you link here can be removed again.
        </div>
      )}
    </div>
  );
}
