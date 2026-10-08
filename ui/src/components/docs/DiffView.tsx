import { Fragment, useMemo } from 'react';
import type { DocsDiff, DocsDiffRow } from '../../types/docs';
import { Icon } from './Icon';

const CONTEXT = 3;
const MONO = "'JetBrains Mono', monospace";

export type DiffMode = 'inline' | 'side-by-side';

export interface DiffSection {
  heading: string;
  added: number;
  removed: number;
  kind: 'Changed' | 'Added' | 'Removed';
}

interface DiffViewProps {
  diff: DocsDiff;
  mode: DiffMode;
  /** "v12 Linh Pham, Oct 4": column headers of the side-by-side layout (older first). */
  leftLabel?: { version: number; text: string };
  rightLabel?: { version: number; text: string };
  /** Index (in `diffSections`) of the section to mark as current. */
  activeSection?: number;
}

/** Heading text without the leading #s, used to match diff sections to rows. */
export function normalizeHeading(text: string): string {
  return text.replace(/^#+\s*/, '').trim();
}

function headingOf(row: DocsDiffRow): string | null {
  return /^#{1,6}\s/.test(row.text) ? normalizeHeading(row.text) : null;
}

interface Group {
  heading: string;
  rows: DocsDiffRow[];
}

function groupRows(rows: DocsDiffRow[]): Group[] {
  const groups: Group[] = [{ heading: '', rows: [] }];
  for (const row of rows) {
    const h = row.type === 'del' ? null : headingOf(row);
    if (h !== null) groups.push({ heading: h, rows: [] });
    groups[groups.length - 1].rows.push(row);
  }
  return groups.filter((g) => g.rows.length > 0);
}

function sectionOf(g: Group): DiffSection | null {
  const added = g.rows.filter((r) => r.type === 'add').length;
  const removed = g.rows.filter((r) => r.type === 'del').length;
  if (!added && !removed) return null;
  const same = g.rows.some((r) => r.type === 'same');
  return {
    heading: g.heading,
    added,
    removed,
    kind: !same && !removed ? 'Added' : !same && !added ? 'Removed' : 'Changed',
  };
}

/** Changed sections only, in page order (what the "Jump to a change" list shows). */
export function diffSections(diff: DocsDiff): DiffSection[] {
  return groupRows(diff.rows)
    .map(sectionOf)
    .filter((s): s is DiffSection => s !== null);
}

type Unit = { left: DocsDiffRow | null; right: DocsDiffRow | null; row?: DocsDiffRow };
type Item = { kind: 'unit'; unit: Unit } | { kind: 'gap'; count: number };

function inlineUnits(rows: DocsDiffRow[]): Unit[] {
  return rows.map((row) => ({ left: null, right: null, row }));
}

function sideUnits(rows: DocsDiffRow[]): Unit[] {
  const out: Unit[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].type === 'same') {
      out.push({ left: rows[i], right: rows[i] });
      i += 1;
      continue;
    }
    const dels: DocsDiffRow[] = [];
    const adds: DocsDiffRow[] = [];
    while (i < rows.length && rows[i].type !== 'same') {
      (rows[i].type === 'del' ? dels : adds).push(rows[i]);
      i += 1;
    }
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k += 1) out.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return out;
}

function unitChanged(u: Unit): boolean {
  if (u.row) return u.row.type !== 'same';
  return (u.left?.type ?? 'same') !== 'same' || (u.right?.type ?? 'same') !== 'same';
}

/** Collapse long unchanged runs, keeping CONTEXT lines around each change. */
function collapse(units: Unit[]): Item[] {
  const keep = units.map(() => false);
  units.forEach((u, i) => {
    if (!unitChanged(u)) return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(units.length - 1, i + CONTEXT); k += 1) keep[k] = true;
  });
  const items: Item[] = [];
  let hidden = 0;
  units.forEach((u, i) => {
    if (keep[i]) {
      if (hidden > 0) items.push({ kind: 'gap', count: hidden });
      hidden = 0;
      items.push({ kind: 'unit', unit: u });
    } else hidden += 1;
  });
  if (hidden > 0) items.push({ kind: 'gap', count: hidden });
  return items;
}

const BG = { same: '#FFFFFF', add: '#E6F2E9', del: '#FBE7E4', empty: '#F6FAF7' };
const HL = { add: 'rgba(46,111,64,0.22)', del: 'rgba(196,67,42,0.22)' };

/** The text of a changed line: word-level marks when the line has a counterpart, whole line otherwise. */
function LineText({ row }: { row: DocsDiffRow }) {
  if (row.type === 'same') return <>{row.text === '' ? ' ' : row.text}</>;
  const hl = { background: HL[row.type], borderRadius: 2 };
  if (row.words && row.words.length > 0) {
    return (
      <>
        {row.words.map((w, i) => (
          <span key={i} style={w.changed ? hl : undefined}>
            {w.text}
          </span>
        ))}
      </>
    );
  }
  return row.text === '' ? <>{' '}</> : <span style={hl}>{row.text}</span>;
}

const numCol: React.CSSProperties = {
  width: 30,
  flexShrink: 0,
  textAlign: 'right',
  padding: '3px 6px 3px 0',
  color: '#9AA8A0',
  fontSize: 11,
};
const textCol: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '3px 10px',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  lineHeight: 1.55,
};

function Gap({ count }: { count: number }) {
  return (
    <div
      style={{
        padding: '3px 12px',
        fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
        fontSize: 11.5,
        color: '#9AA8A0',
        background: '#FBFCFB',
        borderTop: '1px solid #EEF3EF',
        borderBottom: '1px solid #EEF3EF',
      }}
    >
      … {count} unchanged {count === 1 ? 'line' : 'lines'}
    </div>
  );
}

function InlineRow({ row }: { row: DocsDiffRow }) {
  const cls = row.type === 'add' ? 'diff-row diff-add' : row.type === 'del' ? 'diff-row diff-del' : 'diff-row';
  const marker = row.type === 'add' ? '+' : row.type === 'del' ? '−' : '';
  return (
    <div className={cls} style={{ display: 'flex', background: BG[row.type] }}>
      <span style={numCol}>{row.oldNo ?? ''}</span>
      <span style={{ ...numCol, borderRight: '1px solid rgba(0,0,0,0.05)' }}>{row.newNo ?? ''}</span>
      <span
        aria-hidden="true"
        style={{
          width: 22,
          flexShrink: 0,
          textAlign: 'center',
          color: row.type === 'add' ? '#2E6F40' : row.type === 'del' ? '#C4432A' : '#9AA8A0',
          fontWeight: 700,
          borderRight: '1px solid rgba(0,0,0,0.05)',
          padding: '3px 0',
        }}
      >
        {marker}
      </span>
      <span style={textCol}>
        {row.type === 'add' && <span className="diff-sr">Added: </span>}
        {row.type === 'del' && <span className="diff-sr">Removed: </span>}
        <LineText row={row} />
      </span>
    </div>
  );
}

function Cell({ row, side }: { row: DocsDiffRow | null; side: 'left' | 'right' }) {
  const cls = row?.type === 'add' ? 'diff-cell diff-add' : row?.type === 'del' ? 'diff-cell diff-del' : 'diff-cell';
  return (
    <div className={cls} style={{ flex: 1, minWidth: 0, display: 'flex', background: row ? BG[row.type] : BG.empty }}>
      <span style={{ ...numCol, width: 28, borderRight: '1px solid rgba(0,0,0,0.05)' }}>
        {row ? (side === 'left' ? row.oldNo : row.newNo) : ''}
      </span>
      <span style={{ ...textCol, padding: '3px 8px' }}>{row ? <LineText row={row} /> : ' '}</span>
    </div>
  );
}

function SectionHead({ g, s, chips }: { g: Group; s: DiffSection; chips: boolean }) {
  const chipStyle =
    s.kind === 'Added'
      ? { background: '#DCEEE1', color: '#1F5A31' }
      : s.kind === 'Removed'
        ? { background: '#FBE7E4', color: '#A5321E' }
        : { background: '#E1EEFB', color: '#1F5A8E' };
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        background: '#F6FAF7',
        borderBottom: '1px solid #E3E8E5',
        fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
        fontSize: 12.5,
        fontWeight: 700,
        color: '#1E2A22',
      }}
    >
      <span style={{ display: 'flex', color: '#9AA8A0' }}>
        <Icon name="i04" size={12} strokeWidth={2.2} />
      </span>
      {g.heading || 'Top of page'}
      {chips && (
        <>
          <span className="mc-chip" style={{ ...chipStyle, height: 20 }}>
            {s.kind}
          </span>
          <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 11.5, fontWeight: 500 }}>
            <span style={{ color: '#2E6F40' }}>+{s.added}</span> <span style={{ color: '#C4432A' }}>−{s.removed}</span>
          </span>
        </>
      )}
    </div>
  );
}

/**
 * Line and word diff between two versions, inline or side by side.
 * @param props.diff - Diff between two versions.
 * @param props.mode - Inline or side-by-side layout.
 * @param props.leftLabel - Older version column header (side-by-side only).
 * @param props.rightLabel - Newer version column header (side-by-side only).
 * @param props.activeSection - Index in `diffSections` of the section marked as current.
 */
export function DiffView({ diff, mode, leftLabel, rightLabel, activeSection }: DiffViewProps) {
  const groups = useMemo(() => groupRows(diff.rows), [diff.rows]);

  if (diff.rows.every((r) => r.type === 'same')) {
    return (
      <p style={{ fontSize: 13, color: '#5B6B60', padding: '12px 0', margin: 0 }}>
        No differences between these versions.
      </p>
    );
  }

  const changed = groups
    .map((g) => ({ g, s: sectionOf(g) }))
    .filter((x): x is { g: Group; s: DiffSection } => x.s !== null);
  const side = mode === 'side-by-side';

  const renderBody = (g: Group) => {
    const units = side ? sideUnits(g.rows) : inlineUnits(g.rows);
    return collapse(units).map((it, i) => (
      <Fragment key={i}>
        {it.kind === 'gap' ? (
          <Gap count={it.count} />
        ) : it.unit.row ? (
          <InlineRow row={it.unit.row} />
        ) : (
          <div style={{ display: 'flex' }}>
            <Cell row={it.unit.left} side="left" />
            <div style={{ width: 1, background: '#E3E8E5' }} />
            <Cell row={it.unit.right} side="right" />
          </div>
        )}
      </Fragment>
    ));
  };

  const style = (
    <style>{`.diff-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}`}</style>
  );

  if (side) {
    return (
      <div data-mode={mode} style={{ display: 'flex', flexDirection: 'column' }}>
        {style}
        <div
          style={{
            display: 'flex',
            fontSize: 12,
            fontWeight: 600,
            color: '#5B6B60',
            border: '1px solid #E3E8E5',
            borderBottom: 'none',
            borderRadius: '8px 8px 0 0',
            background: '#FBFCFB',
          }}
        >
          {[leftLabel, rightLabel].map((l, i) => (
            <Fragment key={i}>
              {i === 1 && <div style={{ width: 1, background: '#E3E8E5' }} />}
              <div style={{ flex: 1, padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 7 }}>
                {l && <span style={{ fontFamily: MONO, fontSize: 12, color: '#1E2A22' }}>v{l.version}</span>}
                {l?.text}
              </div>
            </Fragment>
          ))}
        </div>
        <div
          style={{
            border: '1px solid #E3E8E5',
            borderRadius: '0 0 8px 8px',
            overflow: 'hidden',
            fontFamily: MONO,
            fontSize: 11.5,
            color: '#1E2A22',
          }}
        >
          {changed.map(({ g, s }, i) => (
            <section
              key={i}
              data-section={g.heading}
              data-section-index={i}
              style={{
                scrollMarginTop: 8,
                outline: activeSection === i ? '2px solid rgba(46,111,64,0.35)' : undefined,
                outlineOffset: -2,
              }}
            >
              <SectionHead g={g} s={s} chips={false} />
              {renderBody(g)}
            </section>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div data-mode={mode} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {style}
      {changed.map(({ g, s }, i) => (
        <section
          key={i}
          data-section={g.heading}
          data-section-index={i}
          style={{
            border: '1px solid #E3E8E5',
            borderRadius: 8,
            overflow: 'hidden',
            fontFamily: MONO,
            fontSize: 12,
            color: '#1E2A22',
            scrollMarginTop: 8,
            boxShadow: activeSection === i ? '0 0 0 2px rgba(46,111,64,0.35)' : undefined,
          }}
        >
          <SectionHead g={g} s={s} chips />
          {renderBody(g)}
        </section>
      ))}
    </div>
  );
}
