/**
 * "3 changes waiting" (RichDocsStates frame 24): what is queued in this browser while offline, by kind, opened from
 * the Offline status in the bar. Publishing always needs a connection.
 */

import { useEffect, useRef } from 'react';
import type { JSONContent } from '@tiptap/core';
import { changeGroup, type ChangeGroup } from './blockInfo';
import { StIcon, type StIconName } from './stIcons';
import './states.css';

/** One row of the list: a kind of change and how many blocks it covers. */
export interface WaitingRow {
  group: ChangeGroup;
  count: number;
}

/**
 * The changed blocks grouped by kind, in the board's order (text, table, picture, other).
 * @param blocks - The blocks that differ from the last saved draft.
 */
export function waitingRows(blocks: { node: JSONContent }[]): WaitingRow[] {
  const n: Record<ChangeGroup, number> = { text: 0, table: 0, picture: 0, other: 0 };
  for (const b of blocks) n[changeGroup(b.node)] += 1;
  return (['text', 'table', 'picture', 'other'] as ChangeGroup[])
    .filter((g) => n[g] > 0)
    .map((g) => ({ group: g, count: n[g] }));
}

const ROW: Record<ChangeGroup, { icon: StIconName; title: string; one: string; many: string }> = {
  text: { icon: 'text', title: 'Text', one: '1 block changed', many: '{n} blocks changed' },
  table: { icon: 'table', title: 'Table', one: '1 table changed', many: '{n} tables changed' },
  picture: { icon: 'picture', title: 'Picture', one: '1 picture changed', many: '{n} pictures changed' },
  other: { icon: 'file', title: 'Other blocks', one: '1 block changed', many: '{n} blocks changed' },
};

interface Props {
  /** How many changes wait (the title). */
  total: number;
  rows: WaitingRow[];
  /** The title was changed too. */
  titleChanged: boolean;
  /** Pictures that wait to upload (frame 24: "harbour-night.jpg · 2.1 MB waits to upload", Needs connection). */
  uploads?: { name: string; size: string }[];
  /** Other writes of the page that wait (the offline queue: highlights…), by label. */
  writes?: { label: string; count: number }[];
  onRetry: () => void;
  onClose: () => void;
}

/**
 * The popover of changes waiting; Esc and a click outside close it.
 * @param props.total - The count in the title.
 * @param props.rows - The changes by kind.
 * @param props.titleChanged - Adds a Title row.
 * @param props.uploads - Pictures waiting to upload.
 * @param props.writes - Other queued writes of the page.
 * @param props.onRetry - Retry now.
 * @param props.onClose - Closes the list.
 */
export function WaitingList({ total, rows, titleChanged, uploads = [], writes = [], onRetry, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t) && !(t as HTMLElement).closest?.('[data-state="offline"]')) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="dst-menu"
      role="dialog"
      aria-label={`${total} changes waiting`}
      data-testid="waiting-list"
      style={{ width: 380, right: 0, top: 'calc(100% + 10px)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div className="dst-menu-title">
          {total} change{total === 1 ? '' : 's'} waiting
        </div>
        <button type="button" className="st-btn st-btn-sm" onClick={onRetry}>
          <StIcon name="retry" size={13} sw={2} />
          Retry now
        </button>
      </div>
      <div className="dst-menu-sub">Kept in this browser. They are sent in order when the connection returns.</div>
      {titleChanged && <Row icon="text" title="Title" sub="The page title changed" />}
      {rows.map((r) => (
        <Row
          key={r.group}
          icon={ROW[r.group].icon}
          title={ROW[r.group].title}
          sub={r.count === 1 ? ROW[r.group].one : ROW[r.group].many.replace('{n}', String(r.count))}
        />
      ))}
      {uploads.map((u, i) => (
        <Row key={`up-${i}`} icon="picture" title="Picture" sub={`${u.name} · ${u.size} waits to upload`} needsNet />
      ))}
      {writes.map((w) => (
        <Row key={w.label} icon="list" title={w.label} sub={`${w.count} waiting`} />
      ))}
      <Row icon="send" title="Publish" sub="Needs a connection. Your draft is safe." />
    </div>
  );
}

function Row({ icon, title, sub, needsNet }: { icon: StIconName; title: string; sub: string; needsNet?: boolean }) {
  return (
    <div className="dst-row">
      <span className="dst-row-icon" aria-hidden="true">
        <StIcon name={icon} size={15} sw={1.9} />
      </span>
      <div style={{ flex: 1 }}>
        <div className="dst-row-title">{title}</div>
        <div className="dst-row-sub">{sub}</div>
      </div>
      {needsNet && <span className="dst-needs-net">Needs connection</span>}
    </div>
  );
}
