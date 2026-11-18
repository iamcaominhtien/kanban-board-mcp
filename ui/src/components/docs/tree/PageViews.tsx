/**
 * The gallery and the recent list (design "Rich Docs — organising pages", B 7-17 and G 61): the same pages as the
 * tree, as cards with covers (a card with pages inside opens as a folder; inside a book the cards are its chapters in
 * reading order, dragged to reorder) or as a flat list of the newest edits grouped by day. Both follow the tree's
 * filters and say which ones are on when nothing matches.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { resolveOrigin } from '../../../api/resolveOrigin';
import type { DocsLayout } from '../../../hooks/useDocsLayout';
import type { DocsTreeNode } from '../../../types/docs';
import { agoText, displayName } from '../docsShared';
import { Icon } from '../Icon';
import { coverUrl } from '../pageSettings';
import {
  activeFilterCount,
  childrenMap,
  filterCounts,
  groupByDay,
  isBook,
  matchesFilters,
  noMatchText,
  parseIcon,
  rowStatus,
  SORT_LABEL,
  sortPages,
  type FilterContext,
  type FilterKey,
  type MoveTarget,
  type TreeFilters,
  type TreeSort,
  type TreeView,
} from './treeModel';
import { BoardIcon } from './boardIcons';
import { FilterMark, SortMenu, ViewSwitch } from './TreeToolbar';
import { BookTag, EditorAvatar, PageIcon, pageTint, StatusDot, StatusPill } from './treeParts';
import './tree.css';

interface ViewProps {
  nodes: DocsTreeNode[];
  layout: DocsLayout;
  filters: TreeFilters;
  onFiltersChange: (f: TreeFilters) => void;
  ctx: FilterContext;
  sort: TreeSort;
  onSortChange: (s: TreeSort) => void;
  onOpen: (id: string) => void;
  /** The "···" of a card or a row: opens the page's menu at that button. */
  onMenu?: (node: DocsTreeNode, at: DOMRect) => void;
  /** The ✦ slot of a card (filled by the AI suggestions). */
  renderSuggestions?: (node: DocsTreeNode) => ReactNode;
  /** Touch: the bar's Pages button, which opens the tree's drawer. */
  onOpenTree?: () => void;
  /** Touch: the bar's view switch. */
  onViewChange?: (v: TreeView) => void;
}

/**
 * The bar over the gallery and the recent list on a tablet or a phone (Tree1 B 8-9, 13-14): a 44 px "Pages" button
 * that opens the tree, the view's name and the three-way view switch.
 */
function TouchViewBar({
  title,
  view,
  onOpenTree,
  onViewChange,
}: {
  title: string;
  view: TreeView;
  onOpenTree?: () => void;
  onViewChange?: (v: TreeView) => void;
}) {
  return (
    <div className="tr-touchbar" data-testid="views-touchbar">
      {onOpenTree && (
        <button type="button" className="tr-touchbar-pages" onClick={onOpenTree}>
          <BoardIcon name="viewTree" size={16} strokeWidth={1.9} />
          Pages
        </button>
      )}
      <span className="tr-touchbar-title">{title}</span>
      {onViewChange && <ViewSwitch view={view} onView={onViewChange} />}
    </div>
  );
}

const QUICK: { key: FilterKey | null; label: string }[] = [
  { key: null, label: 'All pages' },
  { key: 'mine', label: 'My pages' },
  { key: 'drafts', label: 'Drafts' },
  { key: 'outdated', label: 'May be outdated' },
  { key: 'suggestions', label: 'With AI suggestions' },
];

/** The row of quick filters over the gallery and the recent list, with their counts. */
function QuickFilters({
  nodes,
  filters,
  onFiltersChange,
  ctx,
}: Pick<ViewProps, 'nodes' | 'filters' | 'onFiltersChange' | 'ctx'>) {
  const counts = useMemo(() => filterCounts(nodes, ctx), [nodes, ctx]);
  return (
    <div className="tr-quick" role="group" aria-label="Quick filters">
      {QUICK.map((q) => {
        const on = q.key ? filters.only.includes(q.key) : activeFilterCount(filters) === 0;
        return (
          <button
            key={q.label}
            type="button"
            aria-pressed={on}
            className={`tr-pill${on ? ' tr-pill-on' : ''}`}
            onClick={() => {
              if (!q.key) onFiltersChange({ only: [], edited: 'any' });
              else
                onFiltersChange({
                  ...filters,
                  only: on ? filters.only.filter((k) => k !== q.key) : [...filters.only, q.key],
                });
            }}
          >
            {q.key && q.key !== 'mine' && <FilterMark k={q.key} />}
            {q.label}
            <span className="tr-count">{q.key ? counts[q.key] : nodes.length}</span>
          </button>
        );
      })}
    </div>
  );
}

function SortSelect({ sort, onSortChange }: Pick<ViewProps, 'sort' | 'onSortChange'>) {
  return <SortMenu sort={sort} onSort={onSortChange} />;
}

/**
 * "No pages match": names the filters that are on and offers to clear them.
 * @param props.filters - The filters that matched nothing.
 * @param props.onClear - Clears them.
 */
export function NoMatch({ filters, onClear }: { filters: TreeFilters; onClear: () => void }) {
  return (
    <div className="tr-nomatch" role="status" data-testid="tree-no-match">
      <span className="tr-nomatch-ico">
        <BoardIcon name="filter" size={18} strokeWidth={1.8} />
      </span>
      <div className="tr-nomatch-title">No pages match</div>
      <div className="tr-nomatch-text">{noMatchText(filters)}</div>
      <button type="button" className="st-btn" onClick={onClear}>
        <BoardIcon name="close" size={14} strokeWidth={2} />
        Clear filters
      </button>
    </div>
  );
}

function MoreButton({ node, onMenu }: { node: DocsTreeNode; onMenu?: ViewProps['onMenu'] }) {
  if (!onMenu) return null;
  return (
    <button
      type="button"
      className="dk-icobtn tr-card-more"
      aria-label={`Page actions for ${node.title}`}
      onClick={(e) => {
        e.stopPropagation();
        onMenu(node, e.currentTarget.getBoundingClientRect());
      }}
    >
      <BoardIcon name="more" size={16} strokeWidth={2} />
    </button>
  );
}

/** One card of the gallery: the cover (or the page colour and its emoji), the title and who edited it. */
function Card({
  node,
  kids,
  chapter,
  onClick,
  onMenu,
  renderSuggestions,
  drag,
}: {
  node: DocsTreeNode;
  kids: number;
  chapter?: number;
  onClick: () => void;
  onMenu?: ViewProps['onMenu'];
  renderSuggestions?: ViewProps['renderSuggestions'];
  drag?: { onDragStart: () => void; onDrop: () => void; over: boolean; onDragOver: () => void };
}) {
  const icon = parseIcon(node.icon);
  const status = rowStatus(node, new Date());
  const book = isBook(node);
  // a cover keeps the page's icon in a white badge over its lower edge; no cover shows the colour and the emoji
  const badge = !!node.cover && !chapter && icon?.kind === 'emoji';
  return (
    <div
      role="listitem"
      className={`tr-card${drag?.over ? ' tr-card-over' : ''}${badge ? ' tr-card-badged' : ''}`}
      data-testid={`gallery-card-${node.slug}`}
      draggable={!!drag}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        drag?.onDragStart();
      }}
      onDragOver={(e) => {
        if (!drag) return;
        e.preventDefault();
        drag.onDragOver();
      }}
      onDrop={(e) => {
        e.preventDefault();
        drag?.onDrop();
      }}
    >
      <button
        type="button"
        className="tr-card-main"
        onClick={onClick}
        aria-label={chapter ? `${chapter}. ${node.title}` : node.title}
      >
        <div
          className="tr-card-cover"
          style={
            node.cover
              ? { backgroundImage: `url("${coverUrl(node.cover, resolveOrigin())}")` }
              : { background: pageTint(node.id) }
          }
        >
          {chapter ? (
            <span className="tr-card-num">{chapter}</span>
          ) : node.cover ? null : icon?.kind === 'emoji' ? (
            <span className="tr-card-emoji">{icon.value}</span>
          ) : (
            <PageIcon icon={node.icon} kind={node.kind} size={30} />
          )}
        </div>
        {badge && <span className="tr-card-badge">{icon.value}</span>}
        <div className="tr-card-body">
          <div className="tr-card-title">{chapter ? `${chapter}. ${node.title}` : node.title}</div>
          <div className="tr-card-meta">
            {book && <BookTag>Book · {kids} ch.</BookTag>}
            {node.updatedBy && <EditorAvatar name={node.updatedBy} size={20} />}
            <span className="tr-card-by">
              {node.updatedBy ? `${displayName(node.updatedBy).split(' ')[0]} · ` : ''}
              {agoText(node.updatedAt)}
            </span>
            <span className="tr-card-marks">
              {renderSuggestions?.(node)}
              {kids > 0 && !chapter && !book && (
                <span className="tr-card-kids" title={`${kids} pages inside`}>
                  <BoardIcon name="page" size={12} strokeWidth={1.9} />
                  {kids}
                </span>
              )}
              <StatusDot status={status} slot={false} />
            </span>
          </div>
        </div>
      </button>
      <MoreButton node={node} onMenu={onMenu} />
    </div>
  );
}

/**
 * The gallery: top-level pages as cards; a card with pages inside opens as a folder with a breadcrumb; inside a book
 * the cards are its chapters in reading order and can be dragged to reorder.
 * @param props.onMove - Moves a chapter (drag to reorder inside a book).
 * @param props.onAddChild - "Add a chapter" inside a book; absent for a reader who can't edit.
 */
export function GalleryView(
  props: ViewProps & {
    onMove?: (id: string, target: MoveTarget) => void;
    onAddChild?: (parentId: string) => void;
  },
) {
  const { nodes, filters, onFiltersChange, ctx, sort, onOpen, onMenu, renderSuggestions, onMove, onAddChild, layout } =
    props;
  const [folder, setFolder] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const kids = useMemo(() => childrenMap(nodes), [nodes]);
  const filtering = activeFilterCount(filters) > 0;
  const folderNode = folder ? nodes.find((n) => n.id === folder) : undefined;
  const inBook = !!folderNode && isBook(folderNode);
  const trail: DocsTreeNode[] = [];
  for (let cur = folderNode; cur; cur = cur.parentId ? nodes.find((n) => n.id === cur!.parentId) : undefined)
    trail.unshift(cur);

  let cards: DocsTreeNode[];
  if (filtering)
    cards = sortPages(
      nodes.filter((n) => matchesFilters(n, filters, ctx)),
      sort,
    );
  else {
    const level = kids.get(folderNode ? folderNode.id : null) ?? [];
    cards = inBook ? level : sortPages(level, sort);
  }
  const top = (kids.get(null) ?? []).length;

  return (
    <section className={`tr-view tr-view-${layout}`} aria-label="Gallery" data-testid="docs-gallery">
      {layout !== 'desktop' && (
        <TouchViewBar
          title={folderNode && !filtering ? folderNode.title : 'All pages'}
          view="gallery"
          onOpenTree={props.onOpenTree}
          onViewChange={props.onViewChange}
        />
      )}
      <nav className="tr-crumbs" aria-label="Folder" hidden={layout !== 'desktop' && !folderNode}>
        <button type="button" onClick={() => setFolder(null)} aria-current={!folderNode ? 'page' : undefined}>
          All pages
        </button>
        {!filtering &&
          trail.map((t) => (
            <span key={t.id} style={{ display: 'contents' }}>
              <Icon name="chevronRight" size={11} strokeWidth={2.2} />
              <button type="button" onClick={() => setFolder(t.id)} aria-current={t.id === folder ? 'page' : undefined}>
                {t.title}
              </button>
            </span>
          ))}
      </nav>
      {folderNode && !filtering ? (
        <header className="tr-view-head">
          <PageIcon icon={folderNode.icon} kind={folderNode.kind} size={22} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>{folderNode.title}</h2>
            <div className="tr-view-sub">
              {inBook
                ? `Book · ${cards.length} ${cards.length === 1 ? 'chapter' : 'chapters'} · ${cards.filter((c) => c.version > 0).length} published`
                : `${cards.length} ${cards.length === 1 ? 'page' : 'pages'} inside`}
            </div>
          </div>
          <button type="button" className="st-btn st-btn-sm" onClick={() => onOpen(folderNode.id)}>
            {inBook ? 'Open book page' : 'Open page'}
          </button>
        </header>
      ) : layout === 'phone' && !filtering ? null : (
        <header className="tr-view-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>{filtering ? 'Matching pages' : 'All pages'}</h2>
            <div className="tr-view-sub">
              {filtering
                ? `${cards.length} of ${nodes.length} pages`
                : `${top} top-level ${top === 1 ? 'page' : 'pages'} · ${nodes.length} in total`}
            </div>
          </div>
          {layout !== 'phone' && <SortSelect sort={sort} onSortChange={props.onSortChange} />}
        </header>
      )}
      <QuickFilters nodes={nodes} filters={filters} onFiltersChange={onFiltersChange} ctx={ctx} />
      {filtering && cards.length === 0 ? (
        <NoMatch filters={filters} onClear={() => onFiltersChange({ only: [], edited: 'any' })} />
      ) : inBook && !filtering && cards.length === 0 ? (
        <div className="tr-nomatch" role="status">
          <div className="tr-nomatch-title">No chapters yet</div>
          <div className="tr-nomatch-text">
            Chapters are the child pages of a book. Add the first one and it becomes “1.”
          </div>
          {onAddChild && (
            <button type="button" className="st-btn st-btn-sm st-btn-primary" onClick={() => onAddChild(folderNode.id)}>
              Add a chapter
            </button>
          )}
        </div>
      ) : (
        <div className="tr-grid" role="list">
          {cards.map((n, i) => {
            const count = (kids.get(n.id) ?? []).length;
            const chapter = inBook && !filtering ? i + 1 : undefined;
            return (
              <Card
                key={n.id}
                node={n}
                kids={count}
                chapter={chapter}
                onMenu={onMenu}
                renderSuggestions={renderSuggestions}
                onClick={() => (count > 0 && !chapter && !filtering ? setFolder(n.id) : onOpen(n.id))}
                drag={
                  chapter && onMove
                    ? {
                        over: overId === n.id && dragId !== n.id,
                        onDragStart: () => setDragId(n.id),
                        onDragOver: () => setOverId(n.id),
                        onDrop: () => {
                          const from = dragId;
                          setDragId(null);
                          setOverId(null);
                          if (!from || from === n.id) return;
                          const fromAt = cards.findIndex((c) => c.id === from);
                          // dropping on a later card puts the chapter after it, on an earlier one before it
                          onMove(
                            from,
                            fromAt < i
                              ? { parentId: folderNode!.id, afterId: n.id, beforeId: null }
                              : { parentId: folderNode!.id, beforeId: n.id, afterId: null },
                          );
                        },
                      }
                    : undefined
                }
              />
            );
          })}
          {inBook && !filtering && onAddChild && (
            <button type="button" className="tr-card tr-card-add" onClick={() => onAddChild(folderNode!.id)}>
              <Icon name="plus" size={16} strokeWidth={2.2} />
              Add a chapter
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** Where a page sits, for the recent list: its parent's title, or "Top level". */
function parentTitle(nodes: DocsTreeNode[], n: DocsTreeNode): string {
  return (n.parentId && nodes.find((x) => x.id === n.parentId)?.title) || 'Top level';
}

const PAGE_SIZE = 10;

/** The recent list: the newest edits first, grouped by day, ten at a time with Show more. */
export function RecentView(props: ViewProps) {
  const { nodes, filters, onFiltersChange, ctx, sort, onOpen, onMenu, renderSuggestions, layout } = props;
  const [limit, setLimit] = useState(PAGE_SIZE);
  const kept = useMemo(
    () =>
      sortPages(
        nodes.filter((n) => matchesFilters(n, filters, ctx)),
        sort,
      ),
    [nodes, filters, ctx, sort],
  );
  const shown = kept.slice(0, limit);
  const groups = sort === 'edited' ? groupByDay(shown, ctx.now) : [{ label: null, pages: shown }];
  const touch = layout !== 'desktop';
  return (
    <section className={`tr-view tr-view-${layout}`} aria-label="Recent" data-testid="docs-recent">
      {touch && (
        <TouchViewBar title="Recent" view="recent" onOpenTree={props.onOpenTree} onViewChange={props.onViewChange} />
      )}
      <header className="tr-view-head" hidden={touch}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2>Recent</h2>
          <div className="tr-view-sub">
            {sort === 'edited' ? 'Newest edit first' : SORT_LABEL[sort]} · {kept.length}{' '}
            {kept.length === 1 ? 'page' : 'pages'}
          </div>
        </div>
        {layout !== 'phone' && <SortSelect sort={sort} onSortChange={props.onSortChange} />}
      </header>
      <QuickFilters nodes={nodes} filters={filters} onFiltersChange={onFiltersChange} ctx={ctx} />
      {kept.length === 0 ? (
        <NoMatch filters={filters} onClear={() => onFiltersChange({ only: [], edited: 'any' })} />
      ) : (
        <div className="tr-recent" role="list">
          {!touch && (
            <div className="tr-recent-head" aria-hidden="true">
              <span className="tr-col-ico" />
              <span className="tr-col-page">Page</span>
              <span className="tr-col-status">Status</span>
              <span className="tr-col-by">Edited by</span>
              <span className="tr-col-at">Edited</span>
              <span className="tr-col-more" />
            </div>
          )}
          {groups.map((g) => (
            <div key={g.label ?? 'all'} role="group" aria-label={g.label ?? undefined}>
              {g.label && <div className="tr-day">{g.label}</div>}
              {g.pages.map((n) => {
                const status = rowStatus(n, ctx.now);
                return (
                  <div key={n.id} role="listitem" className={`tr-recent-row${touch ? ' tr-recent-touch' : ''}`}>
                    <button type="button" className="tr-recent-main" onClick={() => onOpen(n.id)}>
                      <span className="tr-recent-ico">
                        <PageIcon icon={n.icon} kind={n.kind} size={18} />
                      </span>
                      <span className="tr-recent-title tr-col-page">
                        <span>{n.title}</span>
                        <small>
                          {parentTitle(nodes, n)}
                          {touch && ` · ${agoText(n.updatedAt)}`}
                        </small>
                      </span>
                      {!touch && (
                        <>
                          <span className="tr-recent-status tr-col-status">
                            <StatusPill status={status} />
                            {renderSuggestions?.(n)}
                          </span>
                          <span className="tr-recent-by tr-col-by">
                            {n.updatedBy ? (
                              <>
                                <EditorAvatar name={n.updatedBy} size={22} />
                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {displayName(n.updatedBy)}
                                </span>
                              </>
                            ) : (
                              '—'
                            )}
                          </span>
                          <span className="tr-recent-at tr-col-at">{agoText(n.updatedAt)}</span>
                        </>
                      )}
                    </button>
                    <MoreButton node={n} onMenu={onMenu} />
                  </div>
                );
              })}
            </div>
          ))}
          {kept.length > shown.length && (
            <div className="tr-more">
              Showing {shown.length} of {kept.length}
              <button type="button" className="st-btn st-btn-sm" onClick={() => setLimit((l) => l + 20)}>
                Show more
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
