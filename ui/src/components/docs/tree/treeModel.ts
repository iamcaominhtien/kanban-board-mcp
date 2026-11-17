/**
 * The rules of the page tree (design board "Rich Docs — organising pages", A–C): what a row says (status, icon,
 * chapter number), the filters that combine (AND), the rows a tree shows with its parents dimmed and open, the
 * gallery and recent orders, multi-select where child pages follow their parent, and the keyboard moves.
 * Pure functions, so the tree, the gallery, the recent list and the tests share one answer.
 */

import type { DocsTreeNode } from '../../../types/docs';
import { monthsBetween, OUTDATED_MONTHS } from '../pageStatus';

/** The three ways to see the same pages. */
export type TreeView = 'tree' | 'gallery' | 'recent';

/** How the gallery and the recent list order pages (the tree keeps its own order). */
export type TreeSort = 'edited' | 'title' | 'tree';

export const SORT_LABEL: Record<TreeSort, string> = {
  edited: 'Recently edited',
  title: 'Title, A to Z',
  tree: 'Tree order',
};

/** The "Show only" choices of the filter. */
export type FilterKey = 'mine' | 'drafts' | 'unpublished' | 'outdated' | 'suggestions' | 'books';

export const FILTER_KEYS: readonly FilterKey[] = ['mine', 'drafts', 'unpublished', 'outdated', 'suggestions', 'books'];

export const FILTER_LABEL: Record<FilterKey, string> = {
  mine: 'My pages',
  drafts: 'Drafts',
  unpublished: 'Unpublished changes',
  outdated: 'May be outdated',
  suggestions: 'With AI suggestions',
  books: 'Books',
};

/** How recently a page was edited. */
export type EditedWithin = 'any' | 'today' | 'week' | 'month';

export const EDITED_LABEL: Record<EditedWithin, string> = {
  any: 'Any time',
  today: 'Today',
  week: 'This week',
  month: 'This month',
};

/** The filters of the tree, the gallery and the recent list; every choice must hold (AND). */
export interface TreeFilters {
  only: FilterKey[];
  edited: EditedWithin;
}

export const NO_FILTERS: TreeFilters = { only: [], edited: 'any' };

/** Who is looking and when, for "My pages" and the age rules. */
export interface FilterContext {
  /** The person's name as the server writes authors (`DocsAccess.me`); empty: "My pages" uses drafts only. */
  me: string;
  now: Date;
}

/** How many choices are on (the number on the Filter button). */
export function activeFilterCount(f: TreeFilters): number {
  return f.only.length + (f.edited === 'any' ? 0 : 1);
}

/** Whether a page is a book (its `book` setting says so). */
export const isBook = (n: Pick<DocsTreeNode, 'book'>) => n.book?.isBook === true;

/** Whether a published page may be outdated: marked so, or not edited for six months. */
export function isOutdated(n: DocsTreeNode, now: Date): boolean {
  if (n.pageStatus === 'outdated') return true;
  if (n.version < 1 || n.status !== 'published') return false;
  const t = new Date(n.updatedAt);
  return !Number.isNaN(t.getTime()) && monthsBetween(t, now) >= OUTDATED_MONTHS;
}

/** Whether the page is the person's: they made it, edited it last, or hold a draft of it. */
export function isMine(n: DocsTreeNode, me: string): boolean {
  if (n.hasDraft) return true;
  if (!me) return false;
  return n.createdBy === me || n.updatedBy === me;
}

function editedWithin(n: DocsTreeNode, within: EditedWithin, now: Date): boolean {
  if (within === 'any') return true;
  const t = new Date(n.updatedAt);
  if (Number.isNaN(t.getTime())) return false;
  if (within === 'today') return t.toDateString() === now.toDateString();
  const days = within === 'week' ? 7 : 30;
  return now.getTime() - t.getTime() <= days * 86_400_000;
}

/** Whether one choice of "Show only" keeps the page. */
export function matchesKey(n: DocsTreeNode, key: FilterKey, ctx: FilterContext): boolean {
  switch (key) {
    case 'mine':
      return isMine(n, ctx.me);
    case 'drafts':
      return n.status === 'draft' || n.version < 1;
    case 'unpublished':
      return n.hasDraft && n.version > 0;
    case 'outdated':
      return isOutdated(n, ctx.now);
    case 'suggestions':
      return (n.suggestions ?? 0) > 0;
    case 'books':
      return isBook(n);
  }
}

/** Whether every chosen filter keeps the page (the choices combine with AND). */
export function matchesFilters(n: DocsTreeNode, f: TreeFilters, ctx: FilterContext): boolean {
  return f.only.every((k) => matchesKey(n, k, ctx)) && editedWithin(n, f.edited, ctx.now);
}

/** How many pages each "Show only" choice keeps on its own (the numbers beside the choices). */
export function filterCounts(nodes: DocsTreeNode[], ctx: FilterContext): Record<FilterKey, number> {
  const out = { mine: 0, drafts: 0, unpublished: 0, outdated: 0, suggestions: 0, books: 0 };
  for (const n of nodes) for (const k of FILTER_KEYS) if (matchesKey(n, k, ctx)) out[k] += 1;
  return out;
}

/**
 * The line of the "No pages match" state, naming the filters: "None of your pages may be outdated.", "None of the
 * pages edited today are drafts."
 */
export function noMatchText(f: TreeFilters): string {
  const subject = f.only.includes('mine') ? 'your pages' : 'the pages';
  const when = f.edited === 'any' ? '' : ` edited ${EDITED_LABEL[f.edited].toLowerCase()}`;
  const preds: Record<Exclude<FilterKey, 'mine'>, string> = {
    drafts: 'are drafts',
    unpublished: 'have unpublished changes',
    outdated: 'may be outdated',
    suggestions: 'have AI suggestions waiting',
    books: 'are books',
  };
  const said = f.only.filter((k): k is Exclude<FilterKey, 'mine'> => k !== 'mine').map((k) => preds[k]);
  if (!said.length) return when ? `None of ${subject} were${when}.` : 'None of the pages are yours yet.';
  return `None of ${subject}${when} ${said.join(' and ')}.`;
}

/* ---------- the tree's rows ---------- */

/** One row of the tree as drawn. */
export interface TreeRow {
  node: DocsTreeNode;
  depth: number;
  hasChildren: boolean;
  open: boolean;
  childCount: number;
  /** A parent kept only so a match below it can show: drawn dimmed. */
  dim: boolean;
}

/** The pages under each parent (`null`: the top level), in tree order; a page whose parent is gone is top level. */
export function childrenMap(nodes: DocsTreeNode[]): Map<string | null, DocsTreeNode[]> {
  const ids = new Set(nodes.map((n) => n.id));
  const m = new Map<string | null, DocsTreeNode[]>();
  for (const n of nodes) {
    const k = n.parentId && ids.has(n.parentId) ? n.parentId : null;
    const list = m.get(k);
    if (list) list.push(n);
    else m.set(k, [n]);
  }
  m.forEach((list) => list.sort((a, b) => a.position - b.position));
  return m;
}

/** The ids of a page's parents, nearest first. */
export function ancestorsOf(nodes: DocsTreeNode[], id: string): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  let cur = byId.get(id)?.parentId ?? null;
  while (cur && byId.has(cur) && !out.includes(cur)) {
    out.push(cur);
    cur = byId.get(cur)?.parentId ?? null;
  }
  return out;
}

/**
 * The rows of the tree. With a text filter or filters on, the matching pages show with their parents dimmed and
 * open; otherwise the closed pages hide their children.
 * @param nodes - The space's pages.
 * @param o.closed - Pages whose children are folded away.
 * @param o.q - Text the titles must contain (case-insensitive); empty: none.
 * @param o.filters - The filters (AND).
 * @param o.ctx - Who and when, for the filters.
 */
export function buildRows(
  nodes: DocsTreeNode[],
  o: { closed: ReadonlySet<string>; q: string; filters: TreeFilters; ctx: FilterContext },
): TreeRow[] {
  const kids = childrenMap(nodes);
  const out: TreeRow[] = [];
  const q = o.q.trim().toLowerCase();
  if (q || activeFilterCount(o.filters) > 0) {
    const matches = new Set(
      nodes
        .filter((n) => (!q || n.title.toLowerCase().includes(q)) && matchesFilters(n, o.filters, o.ctx))
        .map((n) => n.id),
    );
    const keep = new Set(matches);
    for (const id of matches) for (const a of ancestorsOf(nodes, id)) keep.add(a);
    const walk = (parent: string | null, depth: number) => {
      for (const n of kids.get(parent) ?? []) {
        if (!keep.has(n.id)) continue;
        const all = kids.get(n.id) ?? [];
        const shown = all.filter((c) => keep.has(c.id));
        out.push({
          node: n,
          depth,
          hasChildren: all.length > 0,
          open: shown.length > 0,
          childCount: all.length,
          dim: !matches.has(n.id),
        });
        if (shown.length) walk(n.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }
  const walk = (parent: string | null, depth: number) => {
    for (const n of kids.get(parent) ?? []) {
      const all = kids.get(n.id) ?? [];
      const open = all.length > 0 && !o.closed.has(n.id);
      out.push({ node: n, depth, hasChildren: all.length > 0, open, childCount: all.length, dim: false });
      if (open) walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/**
 * The chapter numbers of the tree: the child pages of a book that numbers its chapters, 1 and up in tree order (a
 * draft chapter keeps its number).
 */
export function chapterNumbers(nodes: DocsTreeNode[]): Map<string, number> {
  const kids = childrenMap(nodes);
  const out = new Map<string, number>();
  for (const b of nodes) {
    if (!isBook(b) || b.book?.numberChapters === false) continue;
    (kids.get(b.id) ?? []).forEach((c, i) => out.set(c.id, i + 1));
  }
  return out;
}

/* ---------- row facts ---------- */

/** What the status dot of a row says. */
export type RowStatusKey = 'published' | 'draft' | 'changed' | 'outdated' | 'review' | 'final';

export interface RowStatus {
  key: RowStatusKey;
  label: string;
  /** The dot's colour (for "may be outdated", the colour of its ring). */
  color: string;
}

/** The colours of a status pill (hover card, recent list): background, text and border. */
export interface StatusTone {
  bg: string;
  fg: string;
  border: string;
}

/** The status pills of the boards (organising pages, A 5 and B 12): green, blue, amber, purple. */
export const STATUS_TONE: Record<RowStatusKey, StatusTone> = {
  published: { bg: '#E6F2EA', fg: '#1F5A31', border: '#CFE6D6' },
  final: { bg: '#E6F2EA', fg: '#1F5A31', border: '#CFE6D6' },
  changed: { bg: '#E8F1FA', fg: '#244E78', border: '#C9DDF0' },
  draft: { bg: '#FDF3E3', fg: '#8A5A00', border: '#EBD3A4' },
  outdated: { bg: '#FDF3E3', fg: '#8A5A00', border: '#EBD3A4' },
  review: { bg: '#EFE9FB', fg: '#5B3FA8', border: '#DCD0F4' },
};

/** The status of a row: draft, unpublished changes, may be outdated or in review stand out; published is quiet. */
export function rowStatus(n: DocsTreeNode, now: Date): RowStatus {
  if (n.status === 'draft' || n.version < 1) return { key: 'draft', label: 'Draft', color: '#C98A1B' };
  if (n.hasDraft) return { key: 'changed', label: 'Unpublished changes', color: '#2F6FB0' };
  if (isOutdated(n, now)) return { key: 'outdated', label: 'May be outdated', color: '#C98A1B' };
  if (n.pageStatus === 'in-review') return { key: 'review', label: 'In review', color: '#7A5AB8' };
  if (n.pageStatus === 'final') return { key: 'final', label: 'Final', color: '#2E6F40' };
  return { key: 'published', label: 'Published', color: '#2E6F40' };
}

/** A page icon: an emoji, one of the app's line icons (`icon:<name>`) or an uploaded picture. */
export type PageIconSpec =
  { kind: 'emoji'; value: string } | { kind: 'icon'; name: string } | { kind: 'image'; src: string };

/** Reads the stored `icon` setting; `null` when the page has none. */
export function parseIcon(v: unknown): PageIconSpec | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim();
  if (s.startsWith('icon:')) return s.length > 5 ? { kind: 'icon', name: s.slice(5) } : null;
  if (s.startsWith('/uploads/') || /^https?:\/\//.test(s) || s.startsWith('data:image/'))
    return { kind: 'image', src: s };
  return { kind: 'emoji', value: s };
}

/* ---------- gallery and recent ---------- */

/**
 * Pages in the order of a sort: newest edit first, by title, or in tree order (position, then title).
 * @returns A new array.
 */
export function sortPages(nodes: DocsTreeNode[], sort: TreeSort): DocsTreeNode[] {
  const list = [...nodes];
  if (sort === 'title') list.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  else if (sort === 'tree') list.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
  else list.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return list;
}

/** A day of the recent list. */
export interface DayGroup {
  label: 'Today' | 'Yesterday' | 'Earlier';
  pages: DocsTreeNode[];
}

/** Pages grouped by the day of their last edit (Today, Yesterday, Earlier), keeping the given order inside. */
export function groupByDay(pages: DocsTreeNode[], now: Date): DayGroup[] {
  const today = now.toDateString();
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  const yesterday = y.toDateString();
  const groups: DayGroup[] = [
    { label: 'Today', pages: [] },
    { label: 'Yesterday', pages: [] },
    { label: 'Earlier', pages: [] },
  ];
  for (const p of pages) {
    const d = new Date(p.updatedAt).toDateString();
    groups[d === today ? 0 : d === yesterday ? 1 : 2].pages.push(p);
  }
  return groups.filter((g) => g.pages.length);
}

/* ---------- selecting several pages ---------- */

/** Every page under the given ones (not counting them). */
export function descendantsOf(nodes: DocsTreeNode[], id: string): string[] {
  const kids = childrenMap(nodes);
  const out: string[] = [];
  const walk = (p: string) => {
    for (const c of kids.get(p) ?? []) {
      out.push(c.id);
      walk(c.id);
    }
  };
  walk(id);
  return out;
}

/** The pages a selection changes: the selected ones and every page under them (children follow their parent). */
export function affectedPages(nodes: DocsTreeNode[], selected: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const id of selected) {
    out.add(id);
    for (const d of descendantsOf(nodes, id)) out.add(d);
  }
  return out;
}

/** The selected pages none of whose parents is selected, in tree order: the ones an action runs on. */
export function selectionRoots(nodes: DocsTreeNode[], selected: ReadonlySet<string>): string[] {
  const order = buildRows(nodes, { closed: new Set(), q: '', filters: NO_FILTERS, ctx: { me: '', now: new Date() } });
  return order
    .map((r) => r.node.id)
    .filter((id) => selected.has(id) && !ancestorsOf(nodes, id).some((a) => selected.has(a)));
}

/* ---------- moving ---------- */

/** Where a page lands: under `parentId`, after `afterId` or before `beforeId` (both null: the end). */
export interface MoveTarget {
  parentId: string | null;
  beforeId: string | null;
  afterId: string | null;
}

/** A keyboard move: up or down among its siblings, out of its parent, or into the page above it. */
export type MoveDir = 'up' | 'down' | 'in' | 'out';

/**
 * Where a keyboard move takes a page.
 * @returns The landing place, or `null` when the page cannot go that way (first, last, already top level, nothing above).
 */
export function keyboardMove(nodes: DocsTreeNode[], id: string, dir: MoveDir): MoveTarget | null {
  const node = nodes.find((n) => n.id === id);
  if (!node) return null;
  const kids = childrenMap(nodes);
  const parent = node.parentId && nodes.some((n) => n.id === node.parentId) ? node.parentId : null;
  const sibs = kids.get(parent) ?? [];
  const i = sibs.findIndex((s) => s.id === id);
  switch (dir) {
    case 'up':
      return i > 0 ? { parentId: parent, beforeId: sibs[i - 1].id, afterId: null } : null;
    case 'down':
      return i >= 0 && i < sibs.length - 1 ? { parentId: parent, beforeId: null, afterId: sibs[i + 1].id } : null;
    case 'in': {
      if (i <= 0) return null;
      const above = sibs[i - 1];
      const under = kids.get(above.id) ?? [];
      return { parentId: above.id, beforeId: null, afterId: under.length ? under[under.length - 1].id : null };
    }
    case 'out': {
      if (!parent) return null;
      const p = nodes.find((n) => n.id === parent)!;
      const grand = p.parentId && nodes.some((n) => n.id === p.parentId) ? p.parentId : null;
      return { parentId: grand, beforeId: null, afterId: p.id };
    }
  }
}

/** Where a page is now, as a move target that puts it back (for Undo). */
export function placeOf(nodes: DocsTreeNode[], id: string): MoveTarget {
  const node = nodes.find((n) => n.id === id);
  const parent = node?.parentId && nodes.some((n) => n.id === node.parentId) ? node.parentId : null;
  const sibs = childrenMap(nodes).get(parent) ?? [];
  const at = sibs.findIndex((s) => s.id === id);
  if (at > 0) return { parentId: parent, afterId: sibs[at - 1].id, beforeId: null };
  return { parentId: parent, afterId: null, beforeId: sibs.find((s) => s.id !== id)?.id ?? null };
}

/**
 * The words for a landing place: "Move under Architecture, after Data model", "Move to the top level, first",
 * "Move under The Harbour Lights, as chapter 8".
 * @param verb - "Move" for the tip while dragging, "Moved" for the announcement after.
 */
export function describeTarget(nodes: DocsTreeNode[], t: MoveTarget, verb = 'Move', movingId?: string): string {
  const title = (id: string | null) => nodes.find((n) => n.id === id)?.title ?? '';
  const parent = t.parentId ? nodes.find((n) => n.id === t.parentId) : undefined;
  const where = parent ? `${verb} under ${parent.title}` : `${verb} to the top level`;
  if (parent && isBook(parent)) {
    const sibs = (childrenMap(nodes).get(parent.id) ?? []).filter((s) => s.id !== movingId);
    let at = sibs.length;
    if (t.afterId) at = sibs.findIndex((s) => s.id === t.afterId) + 1;
    else if (t.beforeId)
      at = Math.max(
        0,
        sibs.findIndex((s) => s.id === t.beforeId),
      );
    return `${where}, as chapter ${at + 1}`;
  }
  if (t.afterId) return `${where}, after ${title(t.afterId)}`;
  if (t.beforeId) return `${where}, before ${title(t.beforeId)}`;
  return where;
}
