import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import './docs.css';
import { Icon } from './Icon';
import { useDocsOnline, getDocsCacheStats, searchDocsCache, parseSearchQuery } from './useDocsOffline';
import { useDocsSearch } from '../../api/docsFx';
import { docsErrorDetail, useDocsPage, useDocsTree } from '../../api/docs';
import { useProjects } from '../../api/projects';
import { useToast } from '../Toast';
import {
  Kbd,
  Snip,
  StatusDot,
  TICKET_KEY,
  TOKEN_STYLE,
  ancestors,
  highlight,
  parentLabel,
  sectionLabelStyle,
  statusLabel,
  tokenize,
} from './searchShared';
import type { DocsSearchPage, DocsSearchResponse } from '../../types/docsFx';

// ─── recents + hotkey (exported helpers) ──────────────────────────────────────

const RECENT_SEARCHES = 'docsRecentSearches';
const recentPagesKey = (projectId: string) => `docsRecentPages:${projectId}`;

export interface RecentDocsPage {
  id: string;
  title: string;
  at: number;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

export function getRecentSearches(): string[] {
  return readJson<string[]>(RECENT_SEARCHES, []).filter((s) => typeof s === 'string');
}
function saveRecentSearch(q: string) {
  const t = q.trim();
  if (t.length < 2) return;
  writeJson(RECENT_SEARCHES, [t, ...getRecentSearches().filter((s) => s !== t)].slice(0, 8));
}

/** Call whenever a page is viewed; feeds "Recently viewed" in the palette (localStorage `docsRecentPages:<projectId>`). */
export function rememberDocsPage(projectId: string, pageId: string, title: string) {
  const list = readJson<RecentDocsPage[]>(recentPagesKey(projectId), []);
  writeJson(
    recentPagesKey(projectId),
    [{ id: pageId, title, at: Date.now() }, ...list.filter((p) => p.id !== pageId)].slice(0, 8),
  );
}

/** Ctrl/Cmd+K, and `/` outside text fields, open the palette. Mount it only while Docs is shown. */
export function useDocsSearchHotkey(onOpen: () => void) {
  const ref = useRef(onOpen);
  ref.current = onOpen;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ref.current();
        return;
      }
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const t = e.target as HTMLElement | null;
        const tag = t?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
        e.preventDefault();
        ref.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

// ─── component ────────────────────────────────────────────────────────────────

type Scope = 'space' | 'page' | 'all' | 'tickets';

export interface SearchPaletteProps {
  projectId: string;
  projectName: string;
  /** Currently open page; enables the "This page" scope. */
  pageId?: string;
  onClose: () => void;
  onOpenPage: (id: string, anchor?: string) => void;
  onOpenTicket: (id: string) => void;
  onOpenResults: (q: string) => void;
  /** Optional: shown as "Create page “…”" when nothing was found. */
  onCreatePage?: (title: string) => void;
  /** Optional: "Filter the tree instead" in the error state. */
  onFilterTree?: (q: string) => void;
  initialQuery?: string;
}

type Row =
  | { kind: 'page'; key: string; page: DocsSearchPage; label: string; offline?: boolean }
  | { kind: 'content'; key: string; page: DocsSearchPage; mi: number; label?: string; offline?: boolean }
  | { kind: 'section'; key: string; page: DocsSearchPage; mi: number }
  | { kind: 'heading'; key: string; page: DocsSearchPage; mi: number }
  | { kind: 'linksec'; key: string; title: string; section: string; slug: string }
  | { kind: 'ticket'; key: string; id: string; title: string; status: string; snippet?: string }
  | { kind: 'mention'; key: string; page: DocsSearchPage }
  | { kind: 'recent-search'; key: string; text: string }
  | { kind: 'recent-page'; key: string; id: string; title: string; label: string };

interface Section {
  title: string;
  rows: Row[];
}

const SCOPES: { id: Scope; label: string; icon: string }[] = [
  { id: 'space', label: 'This space', icon: 'i07' },
  { id: 'page', label: 'This page', icon: 'i00' },
  { id: 'all', label: 'All projects', icon: 'i21' },
  { id: 'tickets', label: 'Tickets', icon: 'i13' },
];

const kbdLabel = (t: string) => <span style={{ fontSize: 11.5, color: '#5B6B60' }}>{t}</span>;
const hint = (keys: ReactNode, label: string) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
    {keys}
    {kbdLabel(label)}
  </span>
);

export function SearchPalette({
  projectId,
  projectName,
  pageId,
  onClose,
  onOpenPage,
  onOpenTicket,
  onOpenResults,
  onCreatePage,
  onFilterTree,
  initialQuery = '',
}: SearchPaletteProps) {
  const toast = useToast();
  const online = useDocsOnline();
  const [q, setQ] = useState(initialQuery);
  const [dq, setDq] = useState(initialQuery);
  const [scope, setScope] = useState<Scope>('space');
  const [sel, setSel] = useState(0);
  const [syntaxOpen, setSyntaxOpen] = useState(false);
  const [recents, setRecents] = useState<string[]>(() => getRecentSearches());
  const forceOffline = false;
  const inputRef = useRef<HTMLInputElement>(null);
  const backRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    const t = window.setTimeout(() => setDq(q), 150);
    return () => window.clearTimeout(t);
  }, [q]);

  const tree = useDocsTree(projectId);
  const nodes = useMemo(() => tree.data ?? [], [tree.data]);
  const page = useDocsPage(pageId ?? null);
  const projects = useProjects();

  // ── what kind of query is this ──
  const trimmed = q.trim();
  const dTrim = dq.trim();
  let mode: 'plain' | 'link' | 'headings' | 'ticket' = 'plain';
  let term = dTrim;
  let sectionPart = '';
  if (dTrim.startsWith('[[')) {
    mode = 'link';
    const rest = dTrim.slice(2);
    const h = rest.indexOf('#');
    term = (h >= 0 ? rest.slice(0, h) : rest).trim();
    sectionPart = h >= 0 ? rest.slice(h + 1).trim() : '';
  } else if (dTrim.startsWith('#')) {
    mode = 'headings';
    term = dTrim.slice(1).trim();
  } else if (TICKET_KEY.test(dTrim)) {
    mode = 'ticket';
  }
  const parsed = useMemo(() => parseSearchQuery(mode === 'plain' ? dTrim : term), [mode, dTrim, term]);
  const hasPhrase = mode === 'plain' && parsed.phrases.length > 0;
  const hasExclude = mode === 'plain' && parsed.excludes.length > 0;
  const tooShort = trimmed.length === 1 || (mode !== 'plain' && mode !== 'ticket' && term.length < 1 && false);
  const searchable = dTrim.length >= 2 && (mode === 'ticket' || mode === 'plain' || term.length >= 1);
  const typing = q !== dq;

  const apiScope = scope === 'all' ? 'all' : scope === 'tickets' && mode !== 'ticket' ? 'tickets' : 'space';
  const useNet = online && !forceOffline;
  const main = useDocsSearch(
    projectId,
    {
      q: mode === 'plain' ? dTrim : mode === 'ticket' ? dTrim : term,
      scope: mode === 'headings' || mode === 'link' ? 'space' : apiScope,
      mode: mode === 'headings' ? 'headings' : undefined,
      pageId: scope === 'page' && mode === 'plain' ? pageId : undefined,
      limit: 8,
    },
    { enabled: searchable && useNet && term.length > 0 },
  );
  const ticketQ = useDocsSearch(
    projectId,
    { q: dTrim, scope: 'tickets', limit: 3 },
    { enabled: searchable && useNet && mode === 'ticket' },
  );
  const noQuotes = useDocsSearch(
    projectId,
    {
      q: dTrim.replace(/"/g, ''),
      scope: apiScope === 'tickets' ? 'space' : apiScope,
      pageId: scope === 'page' ? pageId : undefined,
      limit: 1,
    },
    { enabled: searchable && useNet && hasPhrase },
  );
  const noExcl = useDocsSearch(
    projectId,
    {
      q: parsed.terms.join(' '),
      scope: apiScope === 'tickets' ? 'space' : apiScope,
      pageId: scope === 'page' ? pageId : undefined,
      limit: 1,
    },
    { enabled: searchable && useNet && hasExclude && parsed.terms.length > 0 },
  );
  // sections of the top page in link mode
  const topLinkPage = mode === 'link' ? main.data?.pages?.[0] : undefined;
  const linkPage = useDocsPage(mode === 'link' && sectionPart !== '' ? (topLinkPage?.pageId ?? null) : null);

  // Network failure (no response) behaves like offline: cached pages only.
  const netError = main.isError && !(main.error as { response?: unknown })?.response;
  const showOffline = (!useNet || netError) && searchable;
  const offlineData: DocsSearchResponse | null = useMemo(
    () =>
      showOffline
        ? searchDocsCache(projectId, mode === 'plain' ? dTrim : term, {
            pageId: scope === 'page' ? pageId : undefined,
            projectName,
            headingsOnly: mode === 'headings',
          })
        : null,
    [showOffline, projectId, mode, dTrim, term, scope, pageId, projectName],
  );
  const data: DocsSearchResponse | undefined = showOffline ? (offlineData ?? undefined) : main.data;
  const loading = !showOffline && searchable && (typing || (main.isLoading && !main.data));
  const failed = !showOffline && main.isError && !netError;
  const errDetail = failed ? docsErrorDetail(main.error) : null;

  // ── pending (page edited moments ago, not yet in the index) ──
  const pending = useMemo(() => {
    if (!data || !searchable || mode !== 'plain' || scope === 'all' || scope === 'tickets' || showOffline) return null;
    const words = parsed.terms.concat(parsed.phrases);
    if (!words.length) return null;
    const known = new Set(data.pages.map((p) => p.pageId));
    for (const n of nodes) {
      const age =
        (Date.now() - new Date(/Z|[+-]\d\d:?\d\d$/.test(n.updatedAt) ? n.updatedAt : n.updatedAt + 'Z').getTime()) /
        1000;
      if (age >= 0 && age < 10 && !known.has(n.id) && words.some((w) => n.title.toLowerCase().includes(w)))
        return { title: n.title, age: Math.max(1, Math.round(age)) };
    }
    return null;
  }, [data, searchable, mode, scope, showOffline, parsed, nodes]);

  // ── rows ──
  const sections: Section[] = useMemo(() => {
    const out: Section[] = [];
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const parentOf = (id: string) => {
      const n = nodeById.get(id);
      const par = n?.parentId ? nodeById.get(n.parentId) : undefined;
      return par?.title ?? 'Top level';
    };
    if (!searchable || tooShort) {
      const rs = recents.slice(0, 4).map<Row>((t) => ({ kind: 'recent-search', key: 'rs:' + t, text: t }));
      if (rs.length) out.push({ title: 'Recent searches', rows: rs });
      const rp = readJson<RecentDocsPage[]>(recentPagesKey(projectId), [])
        .slice(0, 3)
        .map<Row>((p) => ({
          kind: 'recent-page',
          key: 'rp:' + p.id,
          id: p.id,
          title: nodeById.get(p.id)?.title ?? p.title,
          label: parentOf(p.id),
        }));
      if (rp.length && trimmed.length === 0) out.push({ title: 'Recently viewed', rows: rp });
      return out;
    }
    if (!data) return out;
    const words = parsed.terms.concat(parsed.phrases);
    const titleHit = (p: DocsSearchPage) => words.some((w) => p.title.toLowerCase().includes(w));
    if (mode === 'link') {
      out.push({
        title: `Pages · ${data.pages.length}`,
        rows: data.pages.map((p) => ({ kind: 'page', key: 'p:' + p.pageId, page: p, label: parentLabel(p) })),
      });
      if (sectionPart !== '' && topLinkPage && linkPage.data) {
        const secs = linkPage.data.headings.filter(
          (h) => h.text.toLowerCase().includes(sectionPart.toLowerCase()) || sectionPart === '',
        );
        out.push({
          title: `Sections of ${topLinkPage.title} · ${secs.length}`,
          rows: secs.map((h) => ({
            kind: 'linksec',
            key: 'ls:' + h.slug,
            title: topLinkPage.title,
            section: h.text,
            slug: h.slug,
          })),
        });
        // with a section typed, the section list is what Enter inserts
        out.reverse();
      }
      return out.filter((s) => s.rows.length);
    }
    if (mode === 'headings') {
      const rows: Row[] = [];
      data.pages.forEach((p) =>
        p.matches.forEach((m, mi) => rows.push({ kind: 'heading', key: `h:${p.pageId}:${m.slug}`, page: p, mi })),
      );
      out.push({ title: `Headings · ${rows.length}`, rows });
      return out;
    }
    if (mode === 'ticket') {
      const tickets = ticketQ.data?.tickets ?? data.tickets;
      if (tickets.length) {
        out.push({
          title: `Ticket · ${tickets.length}`,
          rows: tickets.map((t) => ({
            kind: 'ticket',
            key: 't:' + t.ticketId,
            id: t.ticketId,
            title: t.title,
            status: t.status,
          })),
        });
      }
      out.push({
        title: `Pages that mention ${dTrim.toUpperCase()} · ${data.pages.length}`,
        rows: data.pages.map((p) => ({ kind: 'mention', key: 'm:' + p.pageId, page: p })),
      });
      return out.filter((s) => s.rows.length);
    }
    if (scope === 'tickets') {
      out.push({
        title: `Tickets · ${data.tickets.length}`,
        rows: data.tickets.map((t) => ({
          kind: 'ticket',
          key: 't:' + t.ticketId,
          id: t.ticketId,
          title: t.title,
          status: t.status,
          snippet: t.snippet,
        })),
      });
      return out.filter((s) => s.rows.length);
    }
    if (scope === 'page') {
      const p = data.pages[0];
      const rows: Row[] = p ? p.matches.map((_, mi) => ({ kind: 'section', key: `s:${mi}`, page: p, mi })) : [];
      out.push({ title: `In this page · ${rows.length}`, rows });
      return out.filter((s) => s.rows.length);
    }
    if (scope === 'all') {
      out.push({
        title: `Pages · ${data.pages.length}`,
        rows: data.pages.map((p) => ({ kind: 'content', key: 'c:' + p.pageId, page: p, mi: 0, label: p.projectName })),
      });
      return out.filter((s) => s.rows.length);
    }
    // this space (or offline)
    const offline = showOffline;
    if (offline) {
      const rows: Row[] = data.pages.map((p) =>
        p.matches.length && !titleHit(p)
          ? { kind: 'content', key: 'c:' + p.pageId, page: p, mi: 0, offline: true }
          : { kind: 'page', key: 'p:' + p.pageId, page: p, label: parentLabel(p), offline: true },
      );
      out.push({ title: `Saved pages · ${rows.length}`, rows });
      return out;
    }
    const hits = data.pages.filter(titleHit);
    if (hits.length && !hasPhrase)
      out.push({
        title: `Pages · ${hits.length}`,
        rows: hits.map((p) => ({ kind: 'page', key: 'p:' + p.pageId, page: p, label: parentLabel(p) })),
      });
    const withText = data.pages.filter((p) => p.matches.length);
    if (withText.length)
      out.push({
        title: `In page content · ${withText.length}`,
        rows: withText.map((p) => ({ kind: 'content', key: 'c:' + p.pageId, page: p, mi: 0 })),
      });
    return out;
  }, [
    searchable,
    tooShort,
    recents,
    projectId,
    trimmed,
    data,
    parsed,
    mode,
    nodes,
    scope,
    showOffline,
    ticketQ.data,
    sectionPart,
    topLinkPage,
    linkPage.data,
    dTrim,
    hasPhrase,
  ]);

  const flat = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  useEffect(() => setSel(0), [dq, scope, flat.length]);
  useEffect(() => {
    listRef.current?.querySelector('[data-sel="1"]')?.scrollIntoView({ block: 'nearest' });
  }, [sel, flat.length]);

  // ── actions ──
  const copy = useCallback(
    (ref: string) => {
      navigator.clipboard?.writeText(ref).catch(() => undefined);
      toast.success(`Copied ${ref}`, 'Paste it into a page or ticket to link it.');
      onClose();
    },
    [toast, onClose],
  );
  const finish = useCallback(() => {
    saveRecentSearch(trimmed);
    onClose();
  }, [trimmed, onClose]);

  const activate = useCallback(
    (r: Row, shift = false) => {
      switch (r.kind) {
        case 'recent-search':
          setQ(r.text);
          inputRef.current?.focus();
          return;
        case 'recent-page':
          onOpenPage(r.id);
          onClose();
          return;
        case 'ticket':
          saveRecentSearch(trimmed);
          onOpenTicket(r.id);
          onClose();
          return;
        case 'linksec':
          copy(`[[${r.title}#${r.section}]]`);
          return;
        case 'page':
          if (mode === 'link') return copy(`[[${r.page.title}]]`);
          finish();
          onOpenPage(r.page.pageId);
          return;
        case 'heading':
          if (shift) return copy(`[[${r.page.title}#${r.page.matches[r.mi].section}]]`);
          finish();
          onOpenPage(r.page.pageId, r.page.matches[r.mi].slug);
          return;
        case 'section':
        case 'content': {
          finish();
          const m = r.page.matches[r.mi];
          onOpenPage(r.page.pageId, m?.slug || undefined);
          return;
        }
        case 'mention':
          finish();
          onOpenPage(r.page.pageId, r.page.matches[0]?.slug || undefined);
      }
    },
    [mode, copy, finish, onOpenPage, onOpenTicket, onClose, trimmed],
  );

  const nextScope = (dir: 1 | -1) => {
    const ids = SCOPES.filter((s) => s.id !== 'page' || pageId).map((s) => s.id);
    setScope((cur) => ids[(ids.indexOf(cur) + dir + ids.length) % ids.length]);
  };

  const showAll = () => {
    saveRecentSearch(trimmed);
    onOpenResults(trimmed);
    onClose();
  };

  const noResults = searchable && !loading && !failed && !!data && flat.length === 0 && !pending;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (syntaxOpen) setSyntaxOpen(false);
      else onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (flat.length) setSel((s) => (s + 1) % flat.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (flat.length) setSel((s) => (s - 1 + flat.length) % flat.length);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (mode === 'ticket') return;
      nextScope(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if ((e.ctrlKey || e.metaKey) && trimmed.length >= 2) return showAll();
      if (noResults && !showOffline) {
        if (scope !== 'all') setScope('all');
        return;
      }
      const r = flat[sel];
      if (r) activate(r, e.shiftKey);
    } else if (e.key === '?' && q === '') {
      e.preventDefault();
      setSyntaxOpen(true);
    }
  };

  // ── render helpers ──
  const header = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '13px 18px',
        borderBottom: '1px solid #E3E8E5',
      }}
    >
      <Icon name="i09" size={18} strokeWidth={2} style={{ color: '#2E6F40' }} />
      <div className="fx-qwrap">
        <div className="fx-qback" ref={backRef} aria-hidden="true">
          {q === '' ? (
            <span style={{ color: '#6B7A70' }}>{`Search ${projectName} docs…`}</span>
          ) : (
            tokenize(q).map((t, i) =>
              t.kind === 'plain' ? (
                <span key={i}>
                  {(mode === 'link' || mode === 'headings') && i > 0 ? (
                    <mark className="fx-mark">{t.text}</mark>
                  ) : (
                    t.text
                  )}
                </span>
              ) : (
                <span
                  key={i}
                  className="fx-qtok"
                  style={{ color: TOKEN_STYLE[t.kind].fg, ['--tok-bg' as string]: TOKEN_STYLE[t.kind].bg }}
                >
                  {t.text}
                </span>
              ),
            )
          )}
        </div>
        <input
          ref={inputRef}
          className="fx-qinput"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onScroll={(e) => {
            if (backRef.current) backRef.current.scrollLeft = e.currentTarget.scrollLeft;
          }}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
          aria-label={`Search ${projectName} docs`}
          role="combobox"
          aria-expanded="true"
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {loading && <span className="mc-spin" />}
        {!loading && modeChip(mode, hasPhrase, hasExclude, parsed.excludes.length)}
        {!loading && mode === 'plain' && !hasPhrase && !hasExclude && trimmed !== '' && !syntaxOpen && <Kbd>Esc</Kbd>}
        {!loading && mode === 'plain' && !hasPhrase && !hasExclude && trimmed === '' && !syntaxOpen && <Kbd>Esc</Kbd>}
      </div>
    </div>
  );

  const inLabel =
    scope === 'all'
      ? `Projects you are a member of (${projects.data?.length ?? 1})`
      : scope === 'tickets'
        ? `Tickets in ${projectName}`
        : scope === 'page'
          ? `${page.data?.title ?? 'This page'}${page.data && ancestors({ path: page.data.path.map((p) => p.title), title: page.data.title }).length ? ` (${ancestors({ path: page.data.path.map((p) => p.title), title: page.data.title }).slice(-1)[0]})` : ''}`
          : `${projectName} docs${showOffline ? ' (offline)' : ''}`;

  const scopeBar = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '9px 18px',
        borderBottom: '1px solid #EEF3EF',
        background: '#FBFCFB',
        flexWrap: 'wrap',
      }}
    >
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#5B6B60', whiteSpace: 'nowrap' }}
      >
        <span style={{ fontWeight: 700, color: '#5B6B60' }}>In:</span>
        <span style={{ fontWeight: 700, color: '#1E2A22' }}>{inLabel}</span>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {SCOPES.filter((s) => s.id !== 'page' || pageId).map((s) => {
          const on = scope === s.id;
          return (
            <button
              key={s.id}
              type="button"
              className={`dk-tabs-btn${on ? ' dk-tabs-btn-on' : ''}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '4px 10px',
                whiteSpace: 'nowrap',
              }}
              onClick={() => {
                setScope(s.id);
                inputRef.current?.focus();
              }}
              aria-pressed={on}
            >
              <Icon name={s.icon} size={12} strokeWidth={2} style={{ color: on ? '#2E6F40' : '#9AA8A0' }} />
              {s.label}
            </button>
          );
        })}
      </div>
    </div>
  );

  const showAllRow =
    mode === 'plain' && scope === 'space' && !showOffline && data && flat.length > 0 && data.total > 0 ? (
      <div
        role="button"
        tabIndex={-1}
        onClick={showAll}
        className="fx-row"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 18px 4px',
          fontSize: 12.5,
          fontWeight: 600,
          color: '#2E6F40',
        }}
      >
        <Icon name="i09" size={13} strokeWidth={2} />
        Show all {data.total + (data.tickets?.length ?? 0)} results
        <div style={{ flex: 1 }} />
        <Kbd>Ctrl</Kbd>
        <Kbd>Enter</Kbd>
      </div>
    ) : null;

  const renderRow = (r: Row, idx: number) => {
    const on = idx === sel;
    const common = {
      key: r.key,
      'data-sel': on ? '1' : '0',
      onMouseMove: () => setSel(idx),
      onClick: (e: React.MouseEvent) => activate(r, e.shiftKey),
      className: `fx-row${on ? ' fx-row-on' : ''}`,
      role: 'option',
      'aria-selected': on,
    } as const;
    const enterKbd = on ? (
      <span style={{ flexShrink: 0, marginTop: 1 }}>
        <Kbd>Enter</Kbd>
      </span>
    ) : null;
    const offlineChip = (
      <span className="mc-chip" style={{ background: '#F1F3F1', color: '#3A4A3E', height: 20, padding: '0 7px' }}>
        Offline copy
      </span>
    );
    switch (r.kind) {
      case 'page':
        return (
          <div {...common} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 18px' }}>
            <span style={{ display: 'flex', color: on ? '#2E6F40' : '#9AA8A0' }}>
              <Icon name="i00" size={16} strokeWidth={1.8} />
            </span>
            <span
              style={{
                fontSize: 13.5,
                fontWeight: 600,
                color: '#1E2A22',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                minWidth: 0,
              }}
            >
              {highlight(r.page.title, mode === 'link' ? term : dTrim)}
            </span>
            <div style={{ flex: 1, minWidth: 8 }} />
            <span style={{ flexShrink: 0, fontSize: 12, color: '#5B6B60', whiteSpace: 'nowrap' }}>
              {mode === 'link' && r.label !== 'Top level' ? highlight(r.label, term) : r.label}
            </span>
            {r.offline && offlineChip}
            {on && !r.offline && (
              <span style={{ flexShrink: 0 }}>
                <Kbd>Enter</Kbd>
              </span>
            )}
          </div>
        );
      case 'content': {
        const m = r.page.matches[r.mi];
        const anc = r.label ?? ancestors(r.page).slice(-1)[0];
        return (
          <div {...common} style={{ display: 'flex', gap: 10, padding: '9px 18px', alignItems: 'flex-start' }}>
            <span style={{ display: 'flex', color: on ? '#2E6F40' : '#9AA8A0', marginTop: 2 }}>
              <Icon name="i00" size={16} strokeWidth={1.8} />
            </span>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <span style={{ fontWeight: 700, color: '#1E2A22', whiteSpace: 'nowrap' }}>
                  {highlight(r.page.title, dTrim)}
                </span>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    fontSize: 12,
                    color: '#5B6B60',
                    flexWrap: 'nowrap',
                    minWidth: 0,
                  }}
                >
                  {anc && <span style={{ whiteSpace: 'nowrap' }}>{anc}</span>}
                  {m?.section && (
                    <>
                      <Icon name="i05" size={10} strokeWidth={2.4} style={{ color: '#C7D2CB' }} />
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 2,
                          whiteSpace: 'nowrap',
                          color: '#2E6F40',
                          fontWeight: 600,
                        }}
                      >
                        <Icon name="i04" size={11} strokeWidth={2.2} />
                        {m.section}
                      </span>
                    </>
                  )}
                </span>
              </div>
              {m && (
                <Snip
                  html={m.snippet}
                  style={{
                    fontSize: 12.5,
                    lineHeight: 1.5,
                    color: '#5B6B60',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                />
              )}
            </div>
            {r.offline ? offlineChip : enterKbd}
          </div>
        );
      }
      case 'section':
      case 'heading': {
        const m = r.page.matches[r.mi];
        const isHead = r.kind === 'heading';
        return (
          <div {...common} style={{ display: 'flex', gap: 10, padding: '9px 18px', alignItems: 'flex-start' }}>
            <span style={{ display: 'flex', color: on ? '#2E6F40' : '#9AA8A0', marginTop: 2 }}>
              <Icon name="i04" size={16} strokeWidth={1.8} />
            </span>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <span style={{ fontWeight: 700, color: '#1E2A22', whiteSpace: 'nowrap' }}>
                  {isHead ? highlight(m.section, term) : m.section}
                </span>
                {isHead && (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: 12,
                      color: '#5B6B60',
                      flexWrap: 'nowrap',
                      minWidth: 0,
                    }}
                  >
                    {ancestors(r.page).length > 0 && (
                      <span style={{ whiteSpace: 'nowrap' }}>{parentLabel(r.page)}</span>
                    )}
                    <Icon name="i05" size={10} strokeWidth={2.4} style={{ color: '#C7D2CB' }} />
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 2,
                        whiteSpace: 'nowrap',
                        color: '#2E6F40',
                        fontWeight: 600,
                      }}
                    >
                      <Icon name="i04" size={11} strokeWidth={2.2} />
                      {r.page.title}
                    </span>
                  </span>
                )}
              </div>
              {m.snippet && !(isHead && m.snippet.replace(/<\/?mark>/g, '') === m.section) && (
                <Snip
                  html={m.snippet}
                  style={{
                    fontSize: 12.5,
                    lineHeight: 1.5,
                    color: '#5B6B60',
                    display: '-webkit-box',
                    WebkitLineClamp: isHead ? 1 : 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                />
              )}
            </div>
            {isHead && r.page.status === 'draft' ? (
              <span style={{ flexShrink: 0, marginTop: 1 }}>
                <span className="mc-chip" style={{ background: '#FCEFD9', color: '#7A4F08' }}>
                  Draft
                </span>
              </span>
            ) : (
              enterKbd
            )}
          </div>
        );
      }
      case 'linksec':
        return (
          <div {...common} style={{ display: 'flex', gap: 10, padding: '9px 18px', alignItems: 'flex-start' }}>
            <span style={{ display: 'flex', color: on ? '#2E6F40' : '#9AA8A0', marginTop: 2 }}>
              <Icon name="i04" size={16} strokeWidth={1.8} />
            </span>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <span style={{ fontWeight: 700, color: '#1E2A22', whiteSpace: 'nowrap' }}>{r.title}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#5B6B60' }}>
                  <Icon name="i05" size={10} strokeWidth={2.4} style={{ color: '#C7D2CB' }} />
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 2,
                      whiteSpace: 'nowrap',
                      color: '#2E6F40',
                      fontWeight: 600,
                    }}
                  >
                    <Icon name="i04" size={11} strokeWidth={2.2} />
                    {highlight(r.section, sectionPart)}
                  </span>
                </span>
              </div>
            </div>
            {enterKbd}
          </div>
        );
      case 'ticket':
        return mode === 'ticket' ? (
          <div {...common} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 18px' }}>
            <span style={{ marginTop: 5 }}>
              <StatusDot status={r.status} />
            </span>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: '#5B6B60' }}>
                  {r.id}
                </span>
                <span style={{ fontSize: 13.5, fontWeight: 700, color: '#1E2A22' }}>{r.title}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#5B6B60' }}>
                <span className="mc-chip" style={{ background: '#E1EEFB', color: '#1F5A8E' }}>
                  <span className="mc-dot" style={{ background: '#2F6FB0' }} />
                  {statusLabel(r.status)}
                </span>
                <span style={{ color: '#9AA8A0' }}>· mentioned in {data?.pages.length ?? 0} pages</span>
              </div>
            </div>
            <span style={{ display: 'flex', color: '#2E6F40', marginTop: 2 }}>
              <Icon name="i38" size={15} strokeWidth={1.9} />
            </span>
          </div>
        ) : (
          <div {...common} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 18px' }}>
            <StatusDot status={r.status} />
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: '#5B6B60' }}>{r.id}</span>
            <span
              style={{
                fontSize: 13.5,
                fontWeight: 600,
                color: '#1E2A22',
                flex: 1,
                minWidth: 0,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {highlight(r.title, dTrim)}
            </span>
          </div>
        );
      case 'mention': {
        const n = r.page.mentions ?? Math.max(1, r.page.matches.length);
        return (
          <div {...common} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 18px' }}>
            <span style={{ display: 'flex', color: on ? '#2E6F40' : '#9AA8A0' }}>
              <Icon name="i00" size={16} strokeWidth={1.8} />
            </span>
            <span
              style={{
                fontSize: 13.5,
                fontWeight: 600,
                color: '#1E2A22',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                minWidth: 0,
              }}
            >
              {r.page.title}
            </span>
            <div style={{ flex: 1, minWidth: 8 }} />
            {ancestors(r.page).length > 0 && (
              <span style={{ flexShrink: 0, fontSize: 12, color: '#5B6B60', whiteSpace: 'nowrap' }}>
                {parentLabel(r.page)}
              </span>
            )}
            <span style={{ flexShrink: 0, fontSize: 11.5, color: '#9AA8A0' }}>
              {n} {n === 1 ? 'mention' : 'mentions'}
            </span>
          </div>
        );
      }
      case 'recent-search':
        return (
          <div {...common} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 18px' }}>
            <span style={{ display: 'flex', color: '#9AA8A0' }}>
              <Icon name="i20" size={15} strokeWidth={1.8} />
            </span>
            <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: '#1E2A22' }}>{r.text}</span>
            <button
              type="button"
              aria-label={`Remove ${r.text}`}
              onClick={(e) => {
                e.stopPropagation();
                const next = getRecentSearches().filter((s) => s !== r.text);
                writeJson(RECENT_SEARCHES, next);
                setRecents(next);
              }}
              style={{
                display: 'flex',
                color: '#C7D2CB',
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              <Icon name="i08" size={13} strokeWidth={2} />
            </button>
          </div>
        );
      case 'recent-page':
        return (
          <div {...common} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 18px' }}>
            <span style={{ display: 'flex', color: '#9AA8A0' }}>
              <Icon name="i00" size={16} strokeWidth={1.8} />
            </span>
            <span
              style={{
                fontSize: 13.5,
                fontWeight: 600,
                color: '#1E2A22',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                minWidth: 0,
              }}
            >
              {r.title}
            </span>
            <div style={{ flex: 1, minWidth: 8 }} />
            <span style={{ flexShrink: 0, fontSize: 12, color: '#5B6B60', whiteSpace: 'nowrap' }}>{r.label}</span>
          </div>
        );
    }
  };

  let idx = 0;
  const body = (() => {
    // E1 skeleton
    if (loading && !data) {
      return (
        <div style={{ padding: '2px 0' }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ display: 'flex', gap: 10, padding: '11px 18px', alignItems: 'flex-start' }}>
              <div className="skel" style={{ width: 16, height: 16, flexShrink: 0, marginTop: 1 }} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 7 }}>
                <div className="skel" style={{ width: '42%', height: 12, flexShrink: 0 }} />
                <div className="skel" style={{ width: '92%', height: 9, flexShrink: 0 }} />
                <div className="skel" style={{ width: '68%', height: 9, flexShrink: 0 }} />
              </div>
            </div>
          ))}
        </div>
      );
    }
    // E3 error
    if (failed) {
      return (
        <div
          style={{
            padding: '26px 24px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center',
            gap: 10,
          }}
        >
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: '50%',
              background: '#FBE7E4',
              color: '#C4432A',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Icon name="i22" size={20} strokeWidth={1.9} />
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#1E2A22' }}>Search isn’t available right now</div>
          <div style={{ fontSize: 12.5, lineHeight: 1.5, color: '#5B6B60', maxWidth: 320 }}>
            We couldn’t reach the search service. Your query is kept, and the page tree still works.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button type="button" className="st-btn st-btn-primary st-btn-sm" onClick={() => main.refetch()}>
              <Icon name="i41" size={14} strokeWidth={1.9} />
              Try again
            </button>
            <button
              type="button"
              className="st-btn st-btn-sm"
              onClick={() => {
                onFilterTree?.(trimmed);
                onClose();
              }}
            >
              <Icon name="i07" size={14} strokeWidth={1.9} />
              Filter the tree instead
            </button>
          </div>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#9AA8A0', marginTop: 6 }}>
            {errDetail?.code ?? 'search_unavailable'}
            {(errDetail as { requestId?: string } | null)?.requestId
              ? ` · request ${(errDetail as { requestId?: string }).requestId}`
              : ''}
          </div>
        </div>
      );
    }
    // E2 no results
    if (noResults) {
      const suggestion = data?.suggestion;
      return (
        <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: '50%',
                background: '#F1F3F1',
                color: '#7A8A80',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Icon name="i09" size={18} strokeWidth={1.9} />
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#1E2A22' }}>No results for “{trimmed}”</div>
              <div style={{ fontSize: 12, color: '#5B6B60', marginTop: 1 }}>In {inLabel} · 0 pages</div>
            </div>
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              fontSize: 12.5,
              lineHeight: 1.5,
              color: '#3A4A3E',
            }}
          >
            <div style={{ display: 'flex', gap: 8 }}>
              <span style={{ color: '#9AA8A0' }}>•</span>
              <span>
                Check the spelling.
                {suggestion && (
                  <>
                    {' '}
                    Did you mean{' '}
                    <b style={{ color: '#2E6F40', cursor: 'pointer' }} onClick={() => setQ(suggestion)}>
                      {suggestion}
                    </b>
                    ?
                  </>
                )}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <span style={{ color: '#9AA8A0' }}>•</span>
              <span>Try fewer or more general words.</span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <span style={{ color: '#9AA8A0' }}>•</span>
              <span>Drop “quotes” or −exclusions; they narrow the search.</span>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 2 }}>
            {scope !== 'all' && (
              <button
                type="button"
                className="st-btn"
                style={{ justifyContent: 'flex-start' }}
                onClick={() => setScope('all')}
              >
                <Icon name="i21" size={14} strokeWidth={1.9} />
                <span>Search all projects for “{trimmed}”</span>
              </button>
            )}
            {onCreatePage && (
              <button
                type="button"
                className="st-btn"
                style={{
                  justifyContent: 'flex-start',
                  color: '#2E6F40',
                  borderColor: '#B7D9C0',
                  background: '#F1F8F3',
                }}
                onClick={() => {
                  onCreatePage(trimmed);
                  onClose();
                }}
              >
                <Icon name="i23" size={14} strokeWidth={1.9} />
                <span>Create page “{trimmed}”</span>
              </button>
            )}
          </div>
        </div>
      );
    }
    // empty / too short / results
    return (
      <div style={{ padding: '2px 0 6px' }} role="listbox">
        {tooShort && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              margin: '10px 14px 2px',
              padding: '9px 11px',
              borderRadius: 8,
              background: '#E8F1FB',
              border: '1px solid #B9D3EE',
              fontSize: 12,
              lineHeight: 1.45,
              color: '#3A4A3E',
            }}
          >
            <span style={{ display: 'flex', color: '#2F6FB0' }}>
              <Icon name="i28" size={15} strokeWidth={1.9} />
            </span>
            Keep typing: search starts at 2 characters.
          </div>
        )}
        {showOffline && (
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 9,
              margin: '10px 14px 2px',
              padding: '9px 11px',
              borderRadius: 8,
              background: '#FEF6E7',
              border: '1px solid #F0DBA8',
              fontSize: 12,
              lineHeight: 1.45,
              color: '#3A4A3E',
            }}
          >
            <span style={{ display: 'flex', color: '#B8860B', marginTop: 1 }}>
              <Icon name="i37" size={15} strokeWidth={1.9} />
            </span>
            <span>
              <b style={{ color: '#1E2A22', fontWeight: 700 }}>You’re offline.</b>{' '}
              {(() => {
                const st = getDocsCacheStats(projectId);
                return `Searching the ${st.saved} pages saved on this device${st.total ? `, not all ${st.total}` : ''}. Results may be out of date.`;
              })()}
            </span>
          </div>
        )}
        {mode === 'link' && !tooShort && (
          <div style={{ padding: '8px 18px 6px', fontSize: 12, lineHeight: 1.5, color: '#5B6B60' }}>
            Link mode: results are copied or inserted as a reference, not opened.
          </div>
        )}
        {mode === 'headings' && !tooShort && (
          <div style={{ padding: '8px 18px 6px', fontSize: 12, lineHeight: 1.5, color: '#5B6B60' }}>
            Headings in every page of this space, newest edit first.
          </div>
        )}
        {hasPhrase && !tooShort && (
          <div style={{ padding: '8px 18px 6px', fontSize: 12, lineHeight: 1.5, color: '#5B6B60' }}>
            Words must appear together, in this order. Capitals are ignored.
          </div>
        )}
        {hasExclude && !tooShort && noExcl.data && noExcl.data.total > (data?.total ?? 0) && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              margin: '8px 18px 4px',
              padding: '8px 10px',
              borderRadius: 8,
              background: '#FBE7E4',
              fontSize: 12,
              lineHeight: 1.4,
              color: '#A5321E',
            }}
          >
            <Icon name="i08" size={13} strokeWidth={2} style={{ color: '#C4432A' }} />
            <span style={{ flex: 1 }}>
              Hiding {noExcl.data.total - (data?.total ?? 0)} pages that contain “{parsed.excludes.join('”, “')}”
            </span>
            <button
              type="button"
              onClick={() => setQ(parsed.terms.join(' '))}
              style={{
                border: 'none',
                background: 'none',
                fontSize: 12,
                fontWeight: 700,
                color: '#A5321E',
                cursor: 'pointer',
                padding: 0,
                textDecoration: 'underline',
                fontFamily: 'inherit',
              }}
            >
              Show them
            </button>
          </div>
        )}
        {sections.map((s) => (
          <div key={s.title}>
            <div style={{ display: 'flex', alignItems: 'center', padding: '10px 18px 4px' }}>
              <span style={sectionLabelStyle}>{s.title}</span>
              <div style={{ flex: 1 }} />
              {s.title === 'Recent searches' && (
                <button
                  type="button"
                  onClick={() => {
                    writeJson(RECENT_SEARCHES, []);
                    setRecents([]);
                  }}
                  style={{
                    border: 'none',
                    background: 'none',
                    fontSize: 12,
                    fontWeight: 600,
                    color: '#2E6F40',
                    cursor: 'pointer',
                    padding: 0,
                    fontFamily: 'inherit',
                  }}
                >
                  Clear
                </button>
              )}
            </div>
            {s.rows.map((r) => renderRow(r, idx++))}
          </div>
        ))}
        {scope === 'page' && sections.length > 0 && searchable && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 18px 6px',
              fontSize: 12,
              color: '#5B6B60',
            }}
          >
            <Icon name="i69" size={13} strokeWidth={1.9} style={{ color: '#9AA8A0' }} />
            Press <Kbd>Ctrl</Kbd>
            <Kbd>F</Kbd>
            to jump between matches in the page
          </div>
        )}
        {mode === 'plain' && hasPhrase && noQuotes.data && (
          <div style={{ padding: '12px 18px 4px', fontSize: 12, lineHeight: 1.5, color: '#5B6B60' }}>
            Without quotes this search finds {noQuotes.data.total} {noQuotes.data.total === 1 ? 'page' : 'pages'}.
          </div>
        )}
        {mode === 'plain' && hasExclude && noExcl.data && flat.length > 0 && (
          <div style={{ padding: '12px 18px 4px', fontSize: 12, lineHeight: 1.5, color: '#5B6B60' }}>
            {data?.total} pages, down from {noExcl.data.total}.
          </div>
        )}
        {pending && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              margin: '6px 14px 0',
              padding: '9px 11px',
              borderRadius: 8,
              border: '1px dashed #C7D2CB',
              background: '#FBFCFB',
            }}
          >
            <span className="mc-spin" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: '#1E2A22' }}>
                {pending.title} <span style={{ fontWeight: 500, color: '#9AA8A0' }}>· edited {pending.age}s ago</span>
              </div>
              <div style={{ fontSize: 12, color: '#5B6B60' }}>Still being added to search</div>
            </div>
          </div>
        )}
        {showAllRow}
      </div>
    );
  })();

  // footer
  const countText = data
    ? mode === 'ticket'
      ? null
      : scope === 'tickets'
        ? `${data.tickets.length} results · ${data.tookMs} ms`
        : scope === 'page'
          ? `${flat.length} matches · ${data.tookMs} ms`
          : hasExclude
            ? `${data.total} shown · ${data.tookMs} ms`
            : `${showOffline ? flat.length : mode === 'headings' ? flat.length : data.total} results · ${data.tookMs} ms`
    : null;
  const footer = (() => {
    const wrap = (left: ReactNode, right?: ReactNode) => (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '10px 18px',
          borderTop: '1px solid #E3E8E5',
          background: '#FBFCFB',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>{left}</div>
        <div style={{ flex: 1 }} />
        {right}
      </div>
    );
    const count = countText ? (
      <span style={{ fontSize: 11.5, color: '#5B6B60', whiteSpace: 'nowrap' }}>{countText}</span>
    ) : null;
    if (loading && !data)
      return wrap(
        <span style={{ fontSize: 11.5, color: '#5B6B60' }}>Results appear as soon as the first batch is ready</span>,
      );
    if (failed)
      return wrap(<span style={{ fontSize: 11.5, color: '#C4432A', fontWeight: 600 }}>Could not search</span>);
    if (tooShort) return wrap(hint(<Kbd>Esc</Kbd>, 'Close'));
    if (pending)
      return (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 18px',
            borderTop: '1px solid #E3E8E5',
            background: '#FBFCFB',
          }}
        >
          <span style={{ display: 'flex', color: '#9AA8A0' }}>
            <Icon name="i20" size={14} strokeWidth={1.9} />
          </span>
          <span style={{ flex: 1, fontSize: 11.5, lineHeight: 1.45, color: '#5B6B60' }}>
            A page edited moments ago may take a few seconds to appear.
          </span>
          <button
            type="button"
            onClick={() => main.refetch()}
            style={{
              border: 'none',
              background: 'none',
              fontSize: 11.5,
              fontWeight: 700,
              color: '#2E6F40',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Refresh
          </button>
        </div>
      );
    if (noResults)
      return wrap(
        hint(<Kbd>Enter</Kbd>, 'Search all projects'),
        <span style={{ fontSize: 11.5, color: '#5B6B60', whiteSpace: 'nowrap' }}>
          0 results · {data?.tookMs ?? 0} ms
        </span>,
      );
    if (showOffline) return wrap(kbdLabel('Titles and saved text only'), count);
    if (!searchable) {
      return wrap(
        <>
          {hint(
            <>
              <Kbd>↑</Kbd> <Kbd>↓</Kbd>
            </>,
            'Navigate',
          )}
          {hint(<Kbd>Enter</Kbd>, 'Open')}
          {hint(<Kbd>Tab</Kbd>, 'Scope')}
          {hint(<Kbd>Esc</Kbd>, 'Close')}
        </>,
        <button
          type="button"
          onClick={() => setSyntaxOpen((v) => !v)}
          style={{
            border: 'none',
            background: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 11.5,
            fontWeight: 600,
            color: '#5B6B60',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          <Icon name="i59" size={13} strokeWidth={1.9} />
          Syntax help
        </button>,
      );
    }
    if (mode === 'link')
      return wrap(
        <>
          {hint(<Kbd>Enter</Kbd>, 'Insert')}
          {hint(<Kbd>#</Kbd>, 'Pick a section')}
        </>,
      );
    if (mode === 'headings')
      return wrap(
        <>
          {hint(<Kbd>Enter</Kbd>, 'Go to heading')}
          {hint(
            <>
              <Kbd>Shift</Kbd> <Kbd>Enter</Kbd>
            </>,
            'Copy link',
          )}
        </>,
      );
    if (mode === 'ticket')
      return wrap(
        <>
          {hint(<Kbd>Enter</Kbd>, 'Open ticket')}
          {hint(<Kbd>Tab</Kbd>, 'Pages only')}
        </>,
      );
    if (scope === 'page') return wrap(hint(<Kbd>Enter</Kbd>, 'Go to match'), count);
    if (scope === 'tickets') return wrap(hint(<Kbd>Enter</Kbd>, 'Open ticket'), count);
    if (scope === 'all' || hasPhrase || hasExclude) return wrap(hint(<Kbd>Enter</Kbd>, 'Open'), count);
    return wrap(
      <>
        {hint(
          <>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd>
          </>,
          'Navigate',
        )}
        {hint(<Kbd>Enter</Kbd>, 'Open')}
        {hint(<Kbd>Tab</Kbd>, 'Scope')}
        {hint(<Kbd>Esc</Kbd>, 'Close')}
      </>,
      count,
    );
  })();

  return (
    <div
      className="docs-root"
      role="dialog"
      aria-modal="true"
      aria-label="Search docs"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(37,61,44,0.5)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '10vh',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ position: 'relative', width: 620, maxWidth: 'calc(100vw - 32px)' }}>
        <div
          style={{
            width: '100%',
            borderRadius: 14,
            border: '1px solid #E3E8E5',
            boxShadow: '0 24px 64px rgba(30,42,34,0.22)',
            background: '#FFFFFF',
            overflow: 'hidden',
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {header}
          {scopeBar}
          <div
            ref={listRef}
            className="fx-scroll"
            style={{ maxHeight: 'min(460px, 60vh)', overflowY: 'auto', minHeight: 0 }}
          >
            {body}
          </div>
          {footer}
        </div>
        {syntaxOpen && <SyntaxHelp onClose={() => setSyntaxOpen(false)} />}
      </div>
    </div>
  );
}

function modeChip(mode: string, phrase: boolean, exclude: boolean, nExcl: number): ReactNode {
  if (mode === 'link')
    return (
      <span className="mc-chip" style={{ background: '#E1EEFB', color: '#1F5A8E' }}>
        Link a page
      </span>
    );
  if (mode === 'headings')
    return (
      <span className="mc-chip" style={{ background: '#DCEEE1', color: '#1F5A31' }}>
        Headings
      </span>
    );
  if (mode === 'ticket')
    return (
      <span className="mc-chip" style={{ background: '#ECE9FA', color: '#4B3FA8' }}>
        Ticket
      </span>
    );
  if (phrase)
    return (
      <span className="mc-chip" style={{ background: '#FCEFD9', color: '#7A4F08' }}>
        Exact phrase
      </span>
    );
  if (exclude)
    return (
      <span className="mc-chip" style={{ background: '#FBE7E4', color: '#A5321E' }}>
        {nExcl} {nExcl === 1 ? 'exclusion' : 'exclusions'}
      </span>
    );
  return null;
}

const SYNTAX: [string, string][] = [
  ['rate limit', 'Pages with both words, in any order'],
  ['"rate limit"', 'The exact phrase'],
  ['rate -billing', 'Leave out pages that contain a word'],
  ['[[arch', 'Find pages and sections to link'],
  ['#endpoints', 'Headings only'],
  ['KAN-12', 'A ticket and its pages'],
];

function SyntaxHelp({ onClose }: { onClose: () => void }) {
  const row = (k: string, d: string) => (
    <div
      key={k}
      style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '5px 0', borderTop: '1px solid #EEF3EF' }}
    >
      <div style={{ width: 132, flexShrink: 0 }}>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 12,
            color: '#2E6F40',
            background: '#F6FAF7',
            borderRadius: 4,
            padding: '2px 6px',
            whiteSpace: 'nowrap',
          }}
        >
          {k}
        </span>
      </div>
      <div style={{ flex: 1, fontSize: 12.5, lineHeight: 1.45, color: '#3A4A3E' }}>{d}</div>
    </div>
  );
  return (
    <div
      className="dk-menu"
      style={{ position: 'absolute', left: 14, right: 14, top: 62, padding: '14px 16px', zIndex: 2 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Icon name="i59" size={16} strokeWidth={1.9} style={{ color: '#2E6F40' }} />
        <span style={{ fontSize: 14, fontWeight: 700, color: '#1E2A22', flex: 1 }}>Search syntax</span>
        <button type="button" onClick={onClose} className="dk-kbd" style={{ cursor: 'pointer' }}>
          Esc
        </button>
      </div>
      {SYNTAX.map(([k, d]) => row(k, d))}
      <div style={{ paddingTop: 8, borderTop: '1px solid #EEF3EF', ...sectionLabelStyle, marginTop: 4 }}>
        Filters (planned)
      </div>
      {row('by:hoa', 'Last edited by a person')}
      {row('is:draft', 'Drafts only')}
    </div>
  );
}
