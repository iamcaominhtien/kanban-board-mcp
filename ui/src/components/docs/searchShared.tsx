import type { CSSProperties, ReactNode } from 'react';
import { parseSearchQuery } from './useDocsOffline';
import type { DocsSearchPage } from '../../types/docsFx';

export const TICKET_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/** Server snippets are HTML-escaped except <mark>; anything else that looks like a tag is neutralised here too. */
export function safeSnippet(html: string): string {
  return html.replace(/<(?!\/?mark>)/g, '&lt;');
}

/**
 * Render a sanitized search snippet that keeps its `<mark>` highlights.
 * @param props.html - Snippet HTML; sanitized before rendering.
 */
export function Snip({ html, style, className }: { html: string; style?: CSSProperties; className?: string }) {
  return (
    <div
      className={`fx-snip ${className ?? ''}`}
      style={style}
      dangerouslySetInnerHTML={{ __html: safeSnippet(html) }}
    />
  );
}

/**
 * Wraps case-insensitive occurrences of the query words in <mark>.
 * @param text - Text to scan.
 * @param q - Search query; its terms and phrases are wrapped.
 * @returns `text` unchanged when no term is found, else nodes with matches in `<mark>`.
 */
export function highlight(text: string, q: string): ReactNode {
  const { terms, phrases } = parseSearchQuery(q);
  const needles = [...terms, ...phrases].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!needles.length) return text;
  const re = new RegExp(needles.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(
      <mark key={i++} className="fx-mark">
        {m[0]}
      </mark>,
    );
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Ancestors of a result without the page itself. */
export function ancestors(p: Pick<DocsSearchPage, 'path' | 'title'>): string[] {
  const path = p.path ?? [];
  return path.length && path[path.length - 1] === p.title ? path.slice(0, -1) : path;
}

/** Return a page's parent title, or "Top level". */
export function parentLabel(p: Pick<DocsSearchPage, 'path' | 'title'>): string {
  const a = ancestors(p);
  return a.length ? a[a.length - 1] : 'Top level';
}

export const AVATAR_COLORS: [string, string][] = [
  ['#E6E9F5', '#5B5FA8'],
  ['#DCEEE1', '#2E6F40'],
  ['#F3E7DC', '#B4791E'],
  ['#FBE4E9', '#B0446E'],
];

/** Return a stable avatar color and initials for a name. */
export function avatarFor(name: string): { bg: string; fg: string; text: string } {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const [bg, fg] = AVATAR_COLORS[h % AVATAR_COLORS.length];
  const parts = name.trim().split(/\s+/);
  const text = ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  return { bg, fg, text };
}

/**
 * Round avatar with initials.
 * @param props.size - Diameter in px.
 */
export function Avatar({ name, size = 20 }: { name: string; size?: number }) {
  const a = avatarFor(name);
  return (
    <span
      title={name}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: a.bg,
        color: a.fg,
        fontSize: 11,
        fontWeight: 700,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {a.text}
    </span>
  );
}

const STATUS_DOT: Record<string, string> = {
  backlog: '#9AA8A0',
  todo: '#9AA8A0',
  'in-progress': '#2F6FB0',
  review: '#B4791E',
  testing: '#6D5DD3',
  done: '#2E6F40',
  wont_do: '#C7D2CB',
};
const STATUS_LABEL: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  'in-progress': 'In Progress',
  review: 'Review',
  testing: 'Testing',
  done: 'Done',
  wont_do: "Won't do",
};
/** Return the dot color of a ticket status. */
export const statusDot = (s: string) => STATUS_DOT[s] ?? '#9AA8A0';
/** Return the label of a ticket status. */
export const statusLabel = (s: string) => STATUS_LABEL[s] ?? s;

/**
 * Colored dot for a ticket status.
 * @param props.status - Ticket status that picks the color.
 * @param props.size - Diameter in px.
 */
export function StatusDot({ status, size = 8 }: { status: string; size?: number }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: statusDot(status),
        flexShrink: 0,
        display: 'inline-block',
      }}
    />
  );
}

/** Format a past time as "just now", "5m ago", "yesterday" or a date. */
export function timeAgo(iso: string): string {
  const t = new Date(iso.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z').getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  if (d === 1) return 'yesterday';
  if (d < 14) return `${d} days ago`;
  if (d < 60) return `${Math.floor(d / 7)} weeks ago`;
  return `${Math.floor(d / 30)} months ago`;
}

// ─── query syntax tokens for the coloured input overlay ───────────────────────

export type TokKind = 'plain' | 'link' | 'hash' | 'ticket' | 'phrase' | 'exclude';

export interface Tok {
  text: string;
  kind: TokKind;
}

export const TOKEN_STYLE: Record<Exclude<TokKind, 'plain'>, { fg: string; bg: string }> = {
  link: { fg: '#2F6FB0', bg: 'rgba(47,111,176,0.12)' },
  hash: { fg: '#2E6F40', bg: 'rgba(46,111,64,0.12)' },
  ticket: { fg: '#6D5DD3', bg: 'rgba(109,93,211,0.12)' },
  phrase: { fg: '#B4791E', bg: 'rgba(180,121,30,0.14)' },
  exclude: { fg: '#C4432A', bg: 'rgba(196,67,42,0.12)' },
};

/** Split a search query into typed tokens for display. */
export function tokenize(q: string): Tok[] {
  const t = q.trim();
  if (t.startsWith('[[')) {
    const lead = q.slice(0, q.indexOf('[[') + 2);
    return [
      { text: lead, kind: 'link' },
      { text: q.slice(lead.length), kind: 'plain' },
    ];
  }
  if (t.startsWith('#')) {
    const lead = q.slice(0, q.indexOf('#') + 1);
    return [
      { text: lead, kind: 'hash' },
      { text: q.slice(lead.length), kind: 'plain' },
    ];
  }
  if (TICKET_KEY.test(t)) return [{ text: q, kind: 'ticket' }];
  const out: Tok[] = [];
  const re = /"[^"]*"?|(?:^|(?<=\s))-\S+|\s+|\S+/g;
  for (const m of q.matchAll(re)) {
    const s = m[0];
    if (s.startsWith('"')) out.push({ text: s, kind: 'phrase' });
    else if (s.length > 1 && s.startsWith('-')) out.push({ text: s, kind: 'exclude' });
    else if (s === '-') out.push({ text: s, kind: 'exclude' });
    else out.push({ text: s, kind: 'plain' });
  }
  return out;
}

/** Key-cap element. */
export function Kbd({ children }: { children: ReactNode }) {
  return <span className="dk-kbd">{children}</span>;
}

export const sectionLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: '#5B6B60',
};
