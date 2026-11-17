/**
 * Book mode (frames 34 to 41): many pages, one document. Pick pages, put them in order (drag the handle, Alt + ↑ ↓,
 * or Move up / Move down in a row's menu), then set the cover, title page, contents, chapter breaks, numbering and
 * the format once. The order lives only in this export; nothing changes in Docs. Three columns on a desktop, three
 * steps on a tablet or a phone.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DocsLayout } from '../../../hooks/useDocsLayout';
import type { DocsTreeNode } from '../../../types/docs';
import { ExportFrame, ICONS, Svg } from './ExportFrame';
import { FormatOptions, Seg, SwitchRow } from './ExportForm';
import {
  FORMAT_LABEL,
  descendantsInOrder,
  extensionFor,
  flatTree,
  type BookSettings,
  type ExportFormat,
  type ExportOptions,
} from './exportModel';

export type BookStep = 'pages' | 'order' | 'book';

/** Book mode's choices, kept while the dialog is open. */
export interface BookState {
  /** The chosen pages, in the book's order. */
  ids: string[];
  step: BookStep;
  settings: BookSettings;
  format: ExportFormat;
  options: ExportOptions;
  draft: boolean;
  /** The format's options are open under "… options…". */
  showOptions: boolean;
}

/**
 * A new book of `ids`: titled after the pages' common parent (else the first page), with its cover.
 * @param ids - The pages, in order.
 * @param nodes - The tree.
 * @param format - The format to start with.
 * @param options - The options to start with.
 * @param now - Today (the date line).
 */
export function newBook(
  ids: readonly string[],
  nodes: readonly DocsTreeNode[],
  format: ExportFormat,
  options: ExportOptions,
  now = new Date(),
): BookState {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const chosen = ids.map((id) => byId.get(id)).filter((n): n is DocsTreeNode => !!n);
  const parentId = chosen[0]?.parentId ?? null;
  const parent = parentId && chosen.every((n) => n.parentId === parentId) ? byId.get(parentId) : undefined;
  const head = parent ?? chosen[0];
  return {
    ids: chosen.map((n) => n.id),
    step: 'pages',
    format,
    options,
    draft: false,
    showOptions: false,
    settings: {
      title: head?.title ?? 'Book',
      subtitle: '',
      author: head?.createdBy ?? '',
      date: now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
      coverImage: head?.cover ?? chosen.find((n) => n.cover)?.cover ?? '',
      cover: true,
      titlePage: true,
      contents: true,
      chapterBreaks: true,
      numberChapters: true,
    },
  };
}

/**
 * Moves one page of the order.
 * @param ids - The order.
 * @param id - The page that moves.
 * @param to - Its new index (clamped).
 */
export function moveInOrder(ids: readonly string[], id: string, to: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return [...ids];
  const out = ids.filter((x) => x !== id);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, id);
  return out;
}

interface Props {
  book: BookState;
  onChange: (b: BookState) => void;
  nodes: readonly DocsTreeNode[];
  layout: DocsLayout;
  canEdit: boolean;
  /** Why Export book is off (offline, a refused request); null when it is on. */
  blocked: string | null;
  busy: boolean;
  onExport: () => void;
  onClose: () => void;
}

function PagesColumn({ book, onChange, nodes }: Pick<Props, 'book' | 'onChange' | 'nodes'>) {
  const [q, setQ] = useState('');
  const rows = useMemo(() => flatTree(nodes), [nodes]);
  const shown = q.trim() ? rows.filter((r) => r.node.title.toLowerCase().includes(q.trim().toLowerCase())) : rows;
  const chosen = new Set(book.ids);
  const first = nodes.find((n) => n.id === book.ids[0]);
  const parent = first?.parentId ? nodes.find((n) => n.id === first.parentId) : undefined;
  const toggle = (id: string, on: boolean) =>
    onChange({ ...book, ids: on ? [...book.ids, id] : book.ids.filter((x) => x !== id) });
  return (
    <>
      <span className="dx-label">Pages</span>
      <input
        className="dx-search"
        type="search"
        placeholder="Search pages…"
        aria-label="Search pages"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {parent && (
        <button
          type="button"
          className="dx-link"
          style={{ textAlign: 'left' }}
          data-testid="book-add-all"
          onClick={() => {
            const below = descendantsInOrder(nodes, parent.id).map((n) => n.id);
            onChange({ ...book, ids: [...book.ids, ...below.filter((id) => !chosen.has(id))] });
          }}
        >
          Add all pages below {parent.title}
        </button>
      )}
      <div role="group" aria-label="Pages in the book" data-testid="book-pages">
        {shown.map(({ node, depth }) => (
          <label key={node.id} className="dx-tick" style={{ paddingLeft: q.trim() ? 0 : depth * 14 }}>
            <input type="checkbox" checked={chosen.has(node.id)} onChange={(e) => toggle(node.id, e.target.checked)} />
            <span style={{ flex: 1, minWidth: 0 }}>{node.title}</span>
            {node.status === 'draft' && <span className="dx-tag">Draft</span>}
          </label>
        ))}
        {!shown.length && <p className="dx-line">No page matches.</p>}
      </div>
    </>
  );
}

function OrderRowMenu({
  title,
  first,
  last,
  onUp,
  onDown,
  onRemove,
}: {
  title: string;
  first: boolean;
  last: boolean;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDownDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDownDoc);
    return () => document.removeEventListener('mousedown', onDownDoc);
  }, [open]);
  const item = (label: string, fn: () => void, disabled = false) => (
    <button
      type="button"
      role="menuitem"
      className="dk-mi"
      disabled={disabled}
      style={disabled ? { opacity: 0.45 } : undefined}
      onClick={() => {
        setOpen(false);
        fn();
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="dx-row-menu" ref={ref}>
      <button
        type="button"
        className="dk-icobtn"
        aria-label={`More for ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Svg d={ICONS.more} size={16} width={2.6} />
      </button>
      {open && (
        <div className="dk-menu" role="menu" aria-label={title}>
          {item('Move up', onUp, first)}
          {item('Move down', onDown, last)}
          {item('Remove from the book', onRemove)}
        </div>
      )}
    </div>
  );
}

function OrderColumn({
  book,
  onChange,
  nodes,
  touch,
}: Pick<Props, 'book' | 'onChange' | 'nodes'> & { touch: boolean }) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [lifted, setLifted] = useState<{ id: string; from: number } | null>(null);
  const [said, setSaid] = useState('');
  const n = book.ids.length;
  const title = (id: string) => byId.get(id)?.title ?? 'Page';
  const move = (id: string, to: number, announce = true) => {
    const next = moveInOrder(book.ids, id, to);
    onChange({ ...book, ids: next });
    if (announce) setSaid(`Moved ${title(id)} to position ${next.indexOf(id) + 1} of ${n}.`);
  };
  const s = book.settings;
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="dx-label" style={{ flex: 1 }}>
          Order in the book · {n} {n === 1 ? 'page' : 'pages'}
        </span>
        {!touch && <span className="dx-line">Drag the handle, or Alt + ↑ ↓</span>}
      </div>
      {touch && (
        <p className="dx-line">Touch and hold the handle to drag. Or open a row’s menu for Move up and Move down.</p>
      )}
      <ol className="dx-order" data-testid="book-order">
        {s.cover && (
          <li className="dx-ord dx-ord-front">
            <Svg d={ICONS.book} size={15} />
            <span style={{ flex: 1 }}>
              Cover page
              <div className="dx-line">From the settings · {s.title || 'Book'}</div>
            </span>
          </li>
        )}
        {(s.titlePage || s.contents) && (
          <li className="dx-ord dx-ord-front">
            <Svg d={ICONS.book} size={15} />
            <span style={{ flex: 1 }}>
              {s.titlePage && s.contents ? 'Title page and contents' : s.titlePage ? 'Title page' : 'Contents'}
              <div className="dx-line">From the settings</div>
            </span>
          </li>
        )}
        {book.ids.map((id, i) => (
          <li
            key={id}
            draggable
            data-testid="book-order-row"
            onDragStart={(e) => {
              setDragId(id);
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', id);
              setSaid(`Grabbed ${title(id)}, position ${i + 1} of ${n}.`);
            }}
            onDragOver={(e) => {
              if (!dragId) return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              setDropAt(e.clientY > r.top + r.height / 2 ? i + 1 : i);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId && dropAt != null) {
                const from = book.ids.indexOf(dragId);
                move(dragId, dropAt > from ? dropAt - 1 : dropAt);
              }
              setDragId(null);
              setDropAt(null);
            }}
            onDragEnd={() => {
              setDragId(null);
              setDropAt(null);
            }}
            style={{ listStyle: 'none' }}
          >
            <div
              className="dx-ord"
              data-lifted={lifted?.id === id || dragId === id}
              data-drop={dropAt === i && dragId !== id ? 'before' : undefined}
            >
              <button
                type="button"
                className="dx-handle"
                aria-label={`Move ${title(id)}, position ${i + 1} of ${n}`}
                aria-pressed={lifted?.id === id}
                onKeyDown={(e) => {
                  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                    e.preventDefault();
                    move(id, e.key === 'ArrowUp' ? i - 1 : i + 1);
                    return;
                  }
                  if (e.key === ' ' || e.key === 'Enter') {
                    e.preventDefault();
                    if (lifted) {
                      setLifted(null);
                      setSaid(`Dropped ${title(id)} at position ${i + 1} of ${n}.`);
                    } else {
                      setLifted({ id, from: i });
                      setSaid(`Grabbed ${title(id)}, position ${i + 1} of ${n}.`);
                    }
                  } else if (lifted?.id === id && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                    e.preventDefault();
                    move(id, e.key === 'ArrowUp' ? i - 1 : i + 1);
                  } else if (lifted?.id === id && e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    move(id, lifted.from, false);
                    setLifted(null);
                    setSaid(`${title(id)} put back at position ${lifted.from + 1} of ${n}.`);
                  }
                }}
                onBlur={() => setLifted(null)}
              >
                <Svg d={ICONS.grip} size={16} width={2.6} />
              </button>
              <span className="dx-ord-num">{i + 1}</span>
              <span style={{ flex: 1, minWidth: 0 }}>{title(id)}</span>
              <OrderRowMenu
                title={title(id)}
                first={i === 0}
                last={i === n - 1}
                onUp={() => move(id, i - 1)}
                onDown={() => move(id, i + 1)}
                onRemove={() => onChange({ ...book, ids: book.ids.filter((x) => x !== id) })}
              />
            </div>
            {s.chapterBreaks && i < n - 1 && <div className="dx-break">NEW PAGE</div>}
          </li>
        ))}
        {dropAt === n && <li className="dx-ord" data-drop="before" style={{ height: 0, minHeight: 0, border: 0 }} />}
      </ol>
      {!n && <p className="dx-line">Tick pages to add them to the book.</p>}
      <div className="dx-sr" aria-live="assertive" data-testid="book-said">
        {said}
      </div>
    </>
  );
}

function BookColumn({ book, onChange, nodes, canEdit }: Pick<Props, 'book' | 'onChange' | 'nodes' | 'canEdit'>) {
  const s = book.settings;
  const set = (patch: Partial<BookSettings>) => onChange({ ...book, settings: { ...s, ...patch } });
  const covers = nodes.filter((n) => n.cover);
  const chosen = nodes.filter((n) => book.ids.includes(n.id));
  const anyDraft = chosen.some((n) => n.hasDraft || n.status === 'draft');
  return (
    <>
      <span className="dx-label">Book</span>
      <label className="dx-field">
        Title
        <input value={s.title} onChange={(e) => set({ title: e.target.value })} data-testid="book-title" />
      </label>
      <label className="dx-field">
        Subtitle
        <input value={s.subtitle} onChange={(e) => set({ subtitle: e.target.value })} data-testid="book-subtitle" />
      </label>
      <label className="dx-field">
        Author
        <input value={s.author} onChange={(e) => set({ author: e.target.value })} data-testid="book-author" />
      </label>
      <label className="dx-field">
        Date
        <input value={s.date} onChange={(e) => set({ date: e.target.value })} />
      </label>
      <SwitchRow
        title="Cover page"
        hint="The page cover, with the title on it."
        on={s.cover}
        onChange={(v) => set({ cover: v })}
        testId="book-cover"
      />
      {s.cover && (
        <>
          {s.coverImage && (
            <div
              className="dx-cover"
              role="img"
              aria-label={`Cover of ${s.title}`}
              style={{ backgroundImage: `url("${s.coverImage}")` }}
            />
          )}
          {covers.length > 0 && (
            <label className="dx-field">
              Cover picture
              <select value={s.coverImage} onChange={(e) => set({ coverImage: e.target.value })}>
                <option value="">No picture</option>
                {covers.map((n) => (
                  <option key={n.id} value={n.cover ?? ''}>
                    The cover of {n.title}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
      <SwitchRow
        title="Title page"
        hint="Title, author and date."
        on={s.titlePage}
        onChange={(v) => set({ titlePage: v })}
        testId="book-titlepage"
      />
      <SwitchRow
        title="Table of contents"
        hint="The page titles, with page numbers."
        on={s.contents}
        onChange={(v) => set({ contents: v })}
        testId="book-contents"
      />
      <SwitchRow
        title="Each page starts on a new page"
        hint="A page break before every chapter."
        on={s.chapterBreaks}
        onChange={(v) => set({ chapterBreaks: v })}
        testId="book-breaks"
      />
      <SwitchRow
        title="Number the chapters"
        hint="Chapter 1, Chapter 2… before the page titles."
        on={s.numberChapters}
        onChange={(v) => set({ numberChapters: v })}
        testId="book-numbers"
      />
      {canEdit && anyDraft && (
        <div className="dx-section">
          <span className="dx-label">Pages with changes not yet published</span>
          <Seg
            label="Version"
            value={book.draft ? 'draft' : 'published'}
            onChange={(v) => onChange({ ...book, draft: v === 'draft' })}
            choices={[
              ['published', 'Published version'],
              ['draft', 'My draft'],
            ]}
          />
        </div>
      )}
      <div className="dx-section">
        <span className="dx-label">Format</span>
        <Seg
          label="Book format"
          testId="book-format"
          value={book.format}
          onChange={(format) => onChange({ ...book, format })}
          choices={(['docx', 'pdf', 'html', 'md'] as const).map((f) => [f, FORMAT_LABEL[f]] as const)}
        />
        <button
          type="button"
          className="dx-link"
          style={{ textAlign: 'left' }}
          aria-expanded={book.showOptions}
          onClick={() => onChange({ ...book, showOptions: !book.showOptions })}
        >
          {FORMAT_LABEL[book.format]} options…
        </button>
        {book.showOptions && (
          <FormatOptions
            format={book.format}
            options={book.options}
            onChange={(options) => onChange({ ...book, options })}
          />
        )}
      </div>
    </>
  );
}

const STEPS: readonly [BookStep, string][] = [
  ['pages', 'Pages'],
  ['order', 'Order'],
  ['book', 'Book'],
];

/**
 * The book dialog.
 * @param props.book - The choices.
 * @param props.onChange - Called with the choices changed.
 * @param props.onExport - "Export book".
 */
export function BookDialog({ book, onChange, nodes, layout, canEdit, blocked, busy, onExport, onClose }: Props) {
  const stepped = layout !== 'desktop';
  const n = book.ids.length;
  const ext = extensionFor(book.format, 'book', n);
  const at = STEPS.findIndex(([k]) => k === book.step);
  const go = (step: BookStep) => onChange({ ...book, step });
  const exportBtn = (
    <button
      type="button"
      className="st-btn st-btn-primary"
      disabled={!n || !!blocked || busy || !book.settings.title.trim()}
      onClick={onExport}
      data-testid="book-export"
    >
      Export book
    </button>
  );
  const footer = stepped ? (
    <>
      {at > 0 && layout !== 'phone' && (
        <button type="button" className="st-btn" onClick={() => go(STEPS[at - 1][0])}>
          Back
        </button>
      )}
      <span className="dx-spacer" />
      {at < STEPS.length - 1 ? (
        <button
          type="button"
          className="st-btn st-btn-primary"
          disabled={!n}
          onClick={() => go(STEPS[at + 1][0])}
          data-testid="book-next"
        >
          Next: {STEPS[at + 1][1]}
          {at === 0 ? ` · ${n} ${n === 1 ? 'page' : 'pages'}` : ''}
        </button>
      ) : (
        exportBtn
      )}
    </>
  ) : (
    <>
      <span className="dx-line">
        {n} {n === 1 ? 'page' : 'pages'} · {FORMAT_LABEL[book.format]} .{ext}
      </span>
      <span className="dx-spacer" />
      <button type="button" className="st-btn" onClick={onClose}>
        Cancel
      </button>
      {exportBtn}
    </>
  );
  const cols = {
    pages: <PagesColumn book={book} onChange={onChange} nodes={nodes} />,
    order: <OrderColumn book={book} onChange={onChange} nodes={nodes} touch={layout !== 'desktop'} />,
    book: <BookColumn book={book} onChange={onChange} nodes={nodes} canEdit={canEdit} />,
  };
  return (
    <ExportFrame
      layout={layout}
      label="Export as a book"
      title="Export as a book"
      subtitle={
        stepped
          ? `Step ${at + 1} of 3 · ${STEPS[at][1]}`
          : 'One document made of many pages. Your pages in Docs are not changed.'
      }
      icon={ICONS.book}
      width={1080}
      rawBody={!stepped}
      className={stepped ? 'dx-book-steps' : ''}
      onClose={onClose}
      tabs={
        stepped ? (
          <div className="dx-steptabs" role="tablist" aria-label="Steps">
            {STEPS.map(([k, label], i) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={book.step === k}
                disabled={i > 0 && !n}
                onClick={() => go(k)}
                data-testid={`book-step-${k}`}
              >
                {i + 1} {label}
              </button>
            ))}
          </div>
        ) : undefined
      }
      footer={footer}
    >
      {blocked && (
        <div className="dx-note dx-note-warn" role="status" style={{ margin: stepped ? 0 : '12px 18px 0' }}>
          {blocked}
        </div>
      )}
      {stepped ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{cols[book.step]}</div>
      ) : (
        <div className="dx-book" data-testid="book-columns" style={{ maxHeight: 'calc(100vh - 200px)' }}>
          <section>{cols.pages}</section>
          <section>{cols.order}</section>
          <section>{cols.book}</section>
        </div>
      )}
    </ExportFrame>
  );
}
