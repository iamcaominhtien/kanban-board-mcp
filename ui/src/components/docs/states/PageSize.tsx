/**
 * The size of a page (RichDocsStates frames 49, 50): a warning at 75 % of the limit, a list of what takes space, and
 * the dialog when the page is too large to save. The limit is the server's (`MAX_CONTENT_BYTES` in
 * kb-docs `docs/body.rs`): the page JSON may be 50 MB.
 */

import { useEffect, useRef } from 'react';
import type { JSONContent } from '@tiptap/core';
import { StateBar } from './StateBar';
import { StateDialog } from './StateDialog';
import { StIcon, type StIconName } from './stIcons';
import './states.css';

/** The largest page the server saves, in bytes of its JSON. */
export const PAGE_SIZE_LIMIT = 50 * 1024 * 1024;
/** From this share of the limit the editor says the page is getting large. */
export const PAGE_SIZE_WARN = 0.75;

const enc = new TextEncoder();

/**
 * The size of a page as the server counts it: the bytes of its JSON.
 * @param doc - The page.
 */
export function pageBytes(doc: JSONContent): number {
  return enc.encode(JSON.stringify(doc)).length;
}

/** "38 MB", "640 KB". */
export function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`.replace('.0 ', ' ');
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** One kind of block in "What takes space". */
export interface SpaceRow {
  kind: 'video' | 'picture' | 'file' | 'text';
  count: number;
  bytes: number;
  /** The id of the largest block of this kind (Show jumps to it). */
  largestId: string | null;
}

const KIND_OF: Record<string, SpaceRow['kind']> = {
  video: 'video',
  image: 'picture',
  fileCard: 'file',
  htmlEmbed: 'file',
};

/**
 * What takes space in a page, largest first: videos, pictures, files and the rest (text, tables, code).
 * @param doc - The page.
 */
export function whatTakesSpace(doc: JSONContent): SpaceRow[] {
  const rows = new Map<SpaceRow['kind'], SpaceRow & { top: number }>();
  for (const b of doc.content ?? []) {
    const kind = KIND_OF[b.type ?? ''] ?? 'text';
    const size = pageBytes(b);
    const r = rows.get(kind) ?? { kind, count: 0, bytes: 0, largestId: null, top: 0 };
    r.count += 1;
    r.bytes += size;
    if (size > r.top) {
      r.top = size;
      r.largestId = typeof b.attrs?.blockId === 'string' ? b.attrs.blockId : null;
    }
    rows.set(kind, r);
  }
  return [...rows.values()].sort((a, b) => b.bytes - a.bytes).map(({ top: _top, ...r }) => r);
}

const ROW: Record<SpaceRow['kind'], { icon: StIconName; one: string; many: string }> = {
  video: { icon: 'video', one: 'video', many: 'videos' },
  picture: { icon: 'picture', one: 'picture', many: 'pictures' },
  file: { icon: 'file', one: 'file or embed', many: 'files and embeds' },
  text: { icon: 'text', one: 'block of text', many: 'blocks of text, tables and code' },
};

/**
 * "This page is getting large" (frame 49), amber, under the editor header.
 * @param props.bytes - The page size.
 * @param props.onShow - Opens "What takes space".
 * @param props.onClose - Hides the bar until the page grows again.
 */
export function SizeWarningBar({ bytes, onShow, onClose }: { bytes: number; onShow: () => void; onClose: () => void }) {
  return (
    <StateBar
      tone="amber"
      icon="storage"
      testId="size-warning"
      title="This page is getting large"
      text={`It is ${fmtSize(bytes)}. The limit is ${fmtSize(PAGE_SIZE_LIMIT)}, and saving gets slower as it grows.`}
      actions={
        <button type="button" className="st-btn st-btn-sm st-btn-primary" onClick={onShow}>
          See what takes space
        </button>
      }
      onClose={onClose}
    />
  );
}

/**
 * "What takes space" (frame 49): the size against the limit, and each kind of block with a jump to the largest.
 * @param props.doc - The page.
 * @param props.onShow - Scrolls to a block.
 * @param props.onClose - Closes the list (Esc, a click outside).
 */
export function SpaceList({
  doc,
  onShow,
  onClose,
}: {
  doc: JSONContent;
  onShow: (blockId: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [onClose]);
  const total = pageBytes(doc);
  const pct = Math.min(100, (total / PAGE_SIZE_LIMIT) * 100);
  const rows = whatTakesSpace(doc);
  return (
    <div
      ref={ref}
      className="dst-menu"
      role="dialog"
      aria-label="What takes space"
      data-testid="space-list"
      style={{ width: 420, right: 16, top: 'calc(100% + 6px)' }}
    >
      <div className="dst-menu-title">What takes space</div>
      <div className="dst-menu-sub">
        {fmtSize(total)} of {fmtSize(PAGE_SIZE_LIMIT)}
      </div>
      <div className={`dst-meter${pct >= 100 ? ' dst-meter-full' : ''}`}>
        <i style={{ width: `${pct}%` }} />
      </div>
      <div style={{ marginTop: 8 }}>
        {rows.map((r) => (
          <div key={r.kind} className="dst-row dst-row-center">
            <span className="dst-row-icon" aria-hidden="true">
              <StIcon name={ROW[r.kind].icon} size={15} sw={1.9} />
            </span>
            <div style={{ flex: 1 }}>
              <div className="dst-row-title">
                {r.count} {r.count === 1 ? ROW[r.kind].one : ROW[r.kind].many}
              </div>
              <div className="dst-row-sub">{fmtSize(r.bytes)}</div>
            </div>
            {r.largestId && (
              <button type="button" className="st-btn st-btn-sm" onClick={() => onShow(r.largestId!)}>
                Show
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * "This page is too large to save" (frame 50): saving stops, the text stays in this browser.
 * @param props.bytes - The page size.
 * @param props.onShowSpace - See what takes space.
 * @param props.onKeepCopy - Keep a copy.
 * @param props.onClose - Closes the dialog (the red bar stays).
 */
export function TooLargeDialog({
  bytes,
  onShowSpace,
  onKeepCopy,
  onClose,
}: {
  bytes: number;
  onShowSpace: () => void;
  onKeepCopy: () => void;
  onClose: () => void;
}) {
  return (
    <StateDialog width={560} title="This page is too large to save" hideHead onClose={onClose} testId="too-large">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span className="dst-big-disc" aria-hidden="true">
          <StIcon name="storage" size={24} sw={1.9} />
        </span>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>This page is too large to save</div>
          <p className="dst-p" style={{ marginTop: 4 }}>
            It is {fmtSize(bytes)}; the limit is {fmtSize(PAGE_SIZE_LIMIT)}. Your text is kept in this browser. Make the
            page smaller and it saves by itself.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="st-btn st-btn-primary" onClick={onShowSpace}>
            <StIcon name="list" size={14} sw={2} />
            See what takes space
          </button>
          <button type="button" className="st-btn" onClick={onKeepCopy}>
            <StIcon name="download" size={14} sw={2} />
            Keep a copy
          </button>
        </div>
      </div>
    </StateDialog>
  );
}
