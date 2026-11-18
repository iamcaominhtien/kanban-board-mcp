/**
 * What a rename does to the links (RichDocsLinks H 44): links that follow by themselves (the chip shows the new
 * title), and links with their own text (they keep it). Each row shows the link before and after.
 */

import type { CSSProperties, ReactNode } from 'react';
import { useBacklinksEx } from '../../../api/docsActions';
import type { BacklinkPageRow } from '../../../types/docsActions';
import { plural } from '../docsShared';
import { KindGlyph } from './BlockKind';

const CHIP: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  height: 22,
  padding: '0 8px',
  borderRadius: 6,
  background: '#F1F8F3',
  color: '#2E6F40',
  border: '1px solid #CFE6D6',
  fontSize: 12.5,
  fontWeight: 600,
  whiteSpace: 'nowrap',
  verticalAlign: 'middle',
  boxSizing: 'border-box',
};

const BOX: CSSProperties = { border: '1px solid #E3EAE5', borderRadius: 10, overflow: 'hidden' };
const HEAD: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 14px',
  background: '#F6FAF7',
  fontSize: 13,
  fontWeight: 700,
};
const ROW: CSSProperties = {
  display: 'flex',
  gap: 10,
  padding: '9px 14px',
  borderTop: '1px solid #EEF3EF',
  fontSize: 13,
  lineHeight: 1.55,
};

const ARROW = (
  <svg
    aria-hidden="true"
    width={11}
    height={11}
    viewBox="0 0 24 24"
    fill="none"
    stroke="#5B6B60"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ margin: '0 4px', verticalAlign: 'middle' }}
  >
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

/** The `|label` a link was written with, from its excerpt (`[[Page#…|label]]`), if any. */
function ownText(row: BacklinkPageRow): string | null {
  const m = /\[\[[^\]|]+\|([^\]]+)\]\]/.exec(row.excerpt ?? row.context ?? '');
  return m ? m[1].trim() : null;
}

function Chip({ title, target }: { title: string; target?: { kind: string; label: string } | null }) {
  return (
    <span style={CHIP}>
      {title}
      {target && (
        <>
          <span style={{ opacity: 0.55 }}>›</span>
          {target.kind !== 'heading' && <KindGlyph kind={target.kind} size={11} />}
          <span style={{ fontWeight: 600 }}>{target.label}</span>
        </>
      )}
    </span>
  );
}

function Group({
  title,
  note,
  children,
  testId,
}: {
  title: string;
  note: string;
  children: ReactNode;
  testId: string;
}) {
  return (
    <div style={BOX} data-testid={testId}>
      <div style={HEAD}>
        <svg
          aria-hidden="true"
          width={14}
          height={14}
          viewBox="0 0 24 24"
          fill="none"
          stroke="#2E6F40"
          strokeWidth={2.6}
          strokeLinecap="round"
        >
          <path d="M5 12.5L10 17.5L19 7" />
        </svg>
        {title}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: '#5B6B60' }}>{note}</span>
      </div>
      {children}
    </div>
  );
}

/**
 * The link groups of the rename dialog.
 * @param props.pageId - The page being renamed.
 * @param props.oldTitle - Its title now.
 * @param props.newTitle - The title it gets.
 */
export function RenameLinkGroups({
  pageId,
  oldTitle,
  newTitle,
}: {
  pageId: string;
  oldTitle: string;
  newTitle: string;
}) {
  const q = useBacklinksEx(pageId);
  const pages = q.data?.pages ?? [];
  const tickets = q.data?.tickets ?? [];
  const follow = pages.filter((p) => !ownText(p));
  const own = pages.filter((p) => ownText(p));
  if (!pages.length && !tickets.length) return null;
  const followPages = new Set(follow.map((p) => p.pageId)).size;
  const ticketIds = [...new Set(tickets.map((t) => t.ticketId))];
  const followCount = follow.length + tickets.length;
  const by = [
    followPages ? plural(followPages, 'page') : '',
    ticketIds.length ? plural(ticketIds.length, 'ticket') : '',
  ]
    .filter(Boolean)
    .join(' and ');
  const title = newTitle.trim() || oldTitle;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {followCount > 0 && (
        <Group
          title="Links follow by themselves"
          note={`${plural(followCount, 'link')} · ${by}`}
          testId="rename-follow"
        >
          {follow.map((p, i) => (
            <div key={`${p.pageId}-${i}`} style={ROW}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{p.title}</b>
                <div style={{ color: '#3A4A3E' }}>
                  <Chip title={oldTitle} target={p.targetBlock} />
                  {ARROW}
                  <Chip title={title} target={p.targetBlock} />
                </div>
              </div>
            </div>
          ))}
          {ticketIds.length > 0 && (
            <div style={ROW}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{ticketIds.join(' · ')}</b>
                <div style={{ color: '#5B6B60' }}>tickets show the new title as well</div>
              </div>
            </div>
          )}
        </Group>
      )}
      {own.length > 0 && (
        <Group title="Links with their own text" note={plural(own.length, 'link')} testId="rename-own">
          {own.map((p, i) => (
            <div key={`${p.pageId}-${i}`} style={ROW}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{p.title}</b>
                <div style={{ color: '#3A4A3E' }}>
                  <span style={{ ...CHIP, borderBottomStyle: 'dotted' }}>{ownText(p)}</span> keeps its own text “
                  {ownText(p)}”
                </div>
              </div>
            </div>
          ))}
        </Group>
      )}
    </div>
  );
}
