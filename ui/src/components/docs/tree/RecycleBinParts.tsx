/**
 * The Recycle Bin's dialogs and rules (design "Rich Docs — organising pages", E 40-48): days left that turn amber in
 * the last week and red in the last three days, where a page whose parent is gone comes back, deleting forever
 * (saying what goes with it) and emptying the bin (counts first, then a scope, then the red button). On a phone the
 * confirmations are bottom sheets with the red button first.
 */

import { useState, type ReactNode } from 'react';
import type { DocsTreeNode } from '../../../types/docs';
import type { RecycleEntry } from '../../../types/docsActions';
import { BottomSheet } from '../DocsSheets';
import { agoText, displayName, ModalShell, plural, Spacer } from '../docsShared';
import './tree.css';

/** How urgent the days left are: 30 to 8 quiet grey, 7 to 4 amber, 3 or fewer red. */
export function daysLeftTone(days: number): { tone: 'grey' | 'amber' | 'red'; color: string } {
  if (days <= 3) return { tone: 'red', color: '#C4432A' };
  if (days <= 7) return { tone: 'amber', color: '#B4791E' };
  return { tone: 'grey', color: '#9AA8A0' };
}

/** "6 days left", "1 day left", "Deleted forever today". */
export function daysLeftText(days: number): string {
  if (days <= 0) return 'Deleted forever today';
  return `${days} ${days === 1 ? 'day' : 'days'} left`;
}

/** Where a restored page goes when its parent is gone. */
export type RestoreWhere =
  { kind: 'top' } | { kind: 'page'; parentId: string } | { kind: 'parent-first'; parentId: string };

/** The entry of a page's parent, when the parent is in the bin too (matched by title: the bin lists no parent id). */
export function parentEntryOf(entry: RecycleEntry, entries: RecycleEntry[]): RecycleEntry | undefined {
  if (!entry.parentDeleted || !entry.parentTitle) return undefined;
  return entries.find((e) => e.id !== entry.id && e.title === entry.parentTitle);
}

/** A confirmation: a centred dialog, or a bottom sheet with the red button first on a phone. */
function Confirm({
  phone,
  label,
  title,
  danger,
  onClose,
  children,
}: {
  phone: boolean;
  label: string;
  title: ReactNode;
  danger: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  if (phone)
    return (
      <BottomSheet label={label} onClose={onClose}>
        <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#1E2A22' }}>{title}</div>
          {children}
          {danger}
          <button type="button" className="st-btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </BottomSheet>
    );
  return (
    <ModalShell
      width={480}
      ariaLabel={label}
      icon="i12"
      iconTone="red"
      title={title}
      onClose={onClose}
      zIndex={1300}
      bodyStyle={{ padding: '14px 22px', display: 'flex', flexDirection: 'column', gap: 10 }}
      footer={
        <>
          <Spacer />
          <button type="button" className="st-btn" onClick={onClose}>
            Cancel
          </button>
          {danger}
        </>
      }
    >
      {children}
    </ModalShell>
  );
}

const text: React.CSSProperties = { margin: 0, fontSize: 13, lineHeight: 1.5, color: '#3A4A3E' };

/**
 * "Where should 'Pricing draft' go?": its parent is gone, so it comes back at the top level unless you choose a page,
 * or restore the parent first.
 * @param props.parent - The parent's entry when it is in the bin (offers "Restore it first").
 * @param props.nodes - The tree, to choose a page.
 */
export function RestoreWhereDialog({
  entry,
  parent,
  nodes,
  phone,
  onRestore,
  onClose,
}: {
  entry: RecycleEntry;
  parent?: RecycleEntry;
  nodes: DocsTreeNode[];
  phone: boolean;
  onRestore: (where: RestoreWhere) => void;
  onClose: () => void;
}) {
  const [choice, setChoice] = useState<'top' | 'page' | 'parent-first'>('top');
  const [pageId, setPageId] = useState('');
  const ok = choice !== 'page' || !!pageId;
  const go = () => {
    if (!ok) return;
    if (choice === 'top') onRestore({ kind: 'top' });
    else if (choice === 'page') onRestore({ kind: 'page', parentId: pageId });
    else if (parent) onRestore({ kind: 'parent-first', parentId: parent.id });
  };
  const option = (id: typeof choice, title: string, sub: string, extra?: ReactNode) => (
    <label key={id} className={`tr-where${choice === id ? ' tr-where-on' : ''}`}>
      <input type="radio" name="restore-where" checked={choice === id} onChange={() => setChoice(id)} />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
        <b>{title}</b>
        <small>{sub}</small>
        {extra}
      </span>
    </label>
  );
  const body = (
    <div role="radiogroup" aria-label="Where it goes" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <p style={text}>
        Its parent, {entry.parentTitle}, is {parent ? 'still in the Recycle Bin' : 'gone'}.
      </p>
      {option('top', 'At the top level', 'Same title, same content. You can move it later.')}
      {option(
        'page',
        'Choose a page…',
        'Pick where it should live.',
        choice === 'page' && (
          <select
            className="st-input"
            aria-label="Restore under"
            value={pageId}
            onChange={(e) => setPageId(e.target.value)}
            style={{ marginTop: 6 }}
          >
            <option value="">Choose a page…</option>
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.title}
              </option>
            ))}
          </select>
        ),
      )}
      {parent &&
        option(
          'parent-first',
          `Restore “${parent.title}” first`,
          `Brings back ${parent.title}, then this page under it.`,
        )}
    </div>
  );
  const button = (
    <button type="button" className="st-btn st-btn-primary" disabled={!ok} onClick={go} data-testid="restore-where-go">
      Restore
    </button>
  );
  if (phone)
    return (
      <BottomSheet label="Restore page" onClose={onClose}>
        <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Where should “{entry.title}” go?</div>
          {body}
          {button}
        </div>
      </BottomSheet>
    );
  return (
    <ModalShell
      width={480}
      ariaLabel="Restore page"
      icon="i19"
      title={<>Where should “{entry.title}” go?</>}
      subtitle="Restore page"
      onClose={onClose}
      zIndex={1300}
      bodyStyle={{ padding: '14px 22px' }}
      footer={
        <>
          <Spacer />
          <button type="button" className="st-btn" onClick={onClose}>
            Cancel
          </button>
          {button}
        </>
      }
    >
      {body}
    </ModalShell>
  );
}

/** "Delete 'Old launch plan' forever?": names the child pages that go with it and what is removed. */
export function PurgeDialog({
  entries,
  phone,
  busy,
  onConfirm,
  onClose,
}: {
  entries: RecycleEntry[];
  phone: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const one = entries.length === 1 ? entries[0] : null;
  const pages = entries.reduce((n, e) => n + Math.max(1, e.pageCount), 0);
  const title = one ? <>Delete “{one.title}” forever?</> : <>Delete {plural(entries.length, 'page')} forever?</>;
  return (
    <Confirm
      phone={phone}
      label="Delete forever"
      title={title}
      onClose={onClose}
      danger={
        <button
          type="button"
          className="st-btn st-btn-danger"
          disabled={busy}
          onClick={onConfirm}
          data-testid="purge-confirm"
        >
          {busy ? 'Deleting…' : pages > entries.length ? `Delete ${plural(pages, 'page')} forever` : 'Delete forever'}
        </button>
      }
    >
      <p style={text}>This can’t be undone. The page, its comments, highlights and history are removed.</p>
      {one && (
        <p style={{ ...text, color: '#5B6B60', fontSize: 12.5 }}>
          {one.parentTitle ?? 'Top level'} · {displayName(one.deletedBy)} · {agoText(one.deletedAt)}
        </p>
      )}
      {pages > entries.length && (
        <p style={text}>
          {plural(pages - entries.length, 'child page')} {pages - entries.length === 1 ? 'goes' : 'go'} with{' '}
          {one ? 'it' : 'them'}
          {one?.childTitles?.length ? `: ${one.childTitles.slice(0, 4).join(', ')}` : ''}.
        </p>
      )}
      <p style={text}>Files only these pages use are deleted as well. Links to them will show “Page not found”.</p>
    </Confirm>
  );
}

/** What emptying the bin deletes: every page, or only the pages deleted more than `OLDER_DAYS` days ago. */
export type EmptyScope = 'all' | 'older';

/** "Only pages deleted more than a week ago" (30 days in the bin, so 23 or fewer left). */
export const OLDER_DAYS = 7;

/** The pages an emptying of the bin deletes. */
export function pagesToEmpty(entries: RecycleEntry[], scope: EmptyScope): RecycleEntry[] {
  return scope === 'all' ? entries : entries.filter((e) => 30 - e.daysLeft > OLDER_DAYS);
}

/**
 * "Empty the Recycle Bin?": the counts first, a scope, then the red button.
 * @param props.tickets - Won't Do tickets in the bin (they stay: only pages are emptied).
 */
export function EmptyBinDialog({
  entries,
  tickets,
  phone,
  busy,
  onConfirm,
  onClose,
}: {
  entries: RecycleEntry[];
  tickets: number;
  phone: boolean;
  busy?: boolean;
  onConfirm: (scope: EmptyScope) => void;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<EmptyScope>('all');
  const older = pagesToEmpty(entries, 'older');
  const chosen = pagesToEmpty(entries, scope);
  const pages = chosen.reduce((n, e) => n + Math.max(1, e.pageCount), 0);
  return (
    <Confirm
      phone={phone}
      label="Empty the Recycle Bin"
      title="Empty the Recycle Bin?"
      onClose={onClose}
      danger={
        <button
          type="button"
          className="st-btn st-btn-danger"
          disabled={busy || chosen.length === 0}
          onClick={() => onConfirm(scope)}
          data-testid="empty-bin-confirm"
        >
          {busy ? 'Deleting…' : `Delete ${plural(pages, 'page')} forever`}
        </button>
      }
    >
      <p style={text}>Deleted pages are removed forever. This can’t be undone.</p>
      <div className="tr-counts">
        <span>
          <b>{entries.reduce((n, e) => n + Math.max(1, e.pageCount), 0)}</b> pages
        </span>
        <span>
          <b>{tickets}</b> {tickets === 1 ? 'ticket' : 'tickets'} <small>stay in the bin</small>
        </span>
      </div>
      <div role="radiogroup" aria-label="What to delete" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label className={`tr-where${scope === 'all' ? ' tr-where-on' : ''}`}>
          <input type="radio" name="empty-scope" checked={scope === 'all'} onChange={() => setScope('all')} />
          <span>
            <b>Every deleted page ({entries.length})</b>
          </span>
        </label>
        <label className={`tr-where${scope === 'older' ? ' tr-where-on' : ''}`} aria-disabled={older.length === 0}>
          <input
            type="radio"
            name="empty-scope"
            checked={scope === 'older'}
            disabled={older.length === 0}
            onChange={() => setScope('older')}
          />
          <span>
            <b>
              Only pages deleted more than {OLDER_DAYS} days ago ({older.length})
            </b>
            <small>Recent deletions stay, in case someone wants them back.</small>
          </span>
        </label>
      </div>
    </Confirm>
  );
}
