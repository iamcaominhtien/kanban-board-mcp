import { Fragment, useMemo } from 'react';
import type { DocsDiff, DocsDiffRow } from '../../types/docs';
import styles from './DiffView.module.css';

const CONTEXT = 2;

interface DiffViewProps {
  diff: DocsDiff;
  mode: 'inline' | 'side-by-side';
}

/** Heading text without the leading #s, used to match diff sections to rows. */
export function normalizeHeading(text: string): string {
  return text.replace(/^#+\s*/, '').trim();
}

function headingOf(row: DocsDiffRow): string | null {
  return /^#{1,6}\s/.test(row.text) ? normalizeHeading(row.text) : null;
}

type Unit =
  | { kind: 'row'; row: DocsDiffRow }
  | { kind: 'pair'; left: DocsDiffRow | null; right: DocsDiffRow | null };

type Item = { kind: 'unit'; unit: Unit } | { kind: 'gap'; count: number };

interface Group {
  heading: string;
  units: Unit[];
}

function unitChanged(u: Unit): boolean {
  if (u.kind === 'row') return u.row.type !== 'same';
  return (u.left?.type ?? 'same') !== 'same' || (u.right?.type ?? 'same') !== 'same';
}

function toSideUnits(rows: DocsDiffRow[]): Unit[] {
  const out: Unit[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].type === 'same') {
      out.push({ kind: 'pair', left: rows[i], right: rows[i] });
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
    for (let k = 0; k < n; k += 1) {
      out.push({ kind: 'pair', left: dels[k] ?? null, right: adds[k] ?? null });
    }
  }
  return out;
}

/** Split rows into heading-led groups so each changed section gets a header. */
function groupRows(rows: DocsDiffRow[], mode: DiffViewProps['mode']): Group[] {
  const groups: { heading: string; rows: DocsDiffRow[] }[] = [{ heading: '', rows: [] }];
  for (const row of rows) {
    const h = row.type === 'del' ? null : headingOf(row);
    if (h !== null) groups.push({ heading: h, rows: [] });
    groups[groups.length - 1].rows.push(row);
  }
  return groups
    .filter((g) => g.rows.length > 0)
    .map((g) => ({
      heading: g.heading,
      units: mode === 'inline' ? g.rows.map((row): Unit => ({ kind: 'row', row })) : toSideUnits(g.rows),
    }));
}

/** Collapse long unchanged runs, keeping CONTEXT lines around each change. */
function collapse(units: Unit[]): Item[] {
  const keep = units.map(() => false);
  units.forEach((u, i) => {
    if (!unitChanged(u)) return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(units.length - 1, i + CONTEXT); k += 1) {
      keep[k] = true;
    }
  });
  const items: Item[] = [];
  let hidden = 0;
  units.forEach((u, i) => {
    if (keep[i]) {
      if (hidden > 0) items.push({ kind: 'gap', count: hidden });
      hidden = 0;
      items.push({ kind: 'unit', unit: u });
    } else {
      hidden += 1;
    }
  });
  if (hidden > 0) items.push({ kind: 'gap', count: hidden });
  return items;
}

function Text({ row }: { row: DocsDiffRow }) {
  if (row.type !== 'same' && row.words && row.words.length > 0) {
    return (
      <>
        {row.words.map((w, i) => (
          <span
            key={i}
            className={w.changed ? (row.type === 'add' ? styles.wordAdd : styles.wordDel) : undefined}
          >
            {w.text}
          </span>
        ))}
      </>
    );
  }
  return <>{row.text || ' '}</>;
}

function Gap({ count }: { count: number }) {
  return (
    <div className={styles.gap}>
      … {count} unchanged {count === 1 ? 'line' : 'lines'}
    </div>
  );
}

function InlineRow({ row }: { row: DocsDiffRow }) {
  const cls = row.type === 'add' ? styles.add : row.type === 'del' ? styles.del : '';
  const marker = row.type === 'add' ? '+' : row.type === 'del' ? '−' : '';
  return (
    <div className={`${styles.row} ${cls}`}>
      <span className={styles.no}>{row.oldNo ?? ''}</span>
      <span className={styles.no}>{row.newNo ?? ''}</span>
      <span className={styles.marker} aria-hidden="true">{marker}</span>
      <span className={styles.text}>
        {row.type === 'add' && <span className={styles.srOnly}>Added: </span>}
        {row.type === 'del' && <span className={styles.srOnly}>Removed: </span>}
        <Text row={row} />
      </span>
    </div>
  );
}

function Cell({ row, side }: { row: DocsDiffRow | null; side: 'left' | 'right' }) {
  if (!row) return <div className={`${styles.cell} ${styles.empty}`} />;
  const cls = row.type === 'add' ? styles.add : row.type === 'del' ? styles.del : '';
  return (
    <div className={`${styles.cell} ${cls}`}>
      <span className={styles.no}>{side === 'left' ? row.oldNo : row.newNo}</span>
      <span className={styles.text}>
        <Text row={row} />
      </span>
    </div>
  );
}

function sectionCounts(units: Unit[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  const count = (r: DocsDiffRow | null) => {
    if (r?.type === 'add') added += 1;
    if (r?.type === 'del') removed += 1;
  };
  for (const u of units) {
    if (u.kind === 'row') count(u.row);
    else {
      if (u.left?.type === 'del') count(u.left);
      if (u.right?.type === 'add') count(u.right);
    }
  }
  return { added, removed };
}

export function DiffView({ diff, mode }: DiffViewProps) {
  const groups = useMemo(() => groupRows(diff.rows, mode), [diff.rows, mode]);

  if (diff.rows.every((r) => r.type === 'same')) {
    return <p className={styles.none}>No differences between these versions.</p>;
  }

  return (
    <div className={styles.diff} data-mode={mode}>
      {groups.map((g, gi) => {
        const changed = g.units.some(unitChanged);
        if (!changed) return <Gap key={gi} count={g.units.length} />;
        const { added, removed } = sectionCounts(g.units);
        return (
          <section key={gi} className={styles.section} data-section={g.heading}>
            <header className={styles.sectionHead}>
              <span className={styles.sectionName}>{g.heading || 'Top of page'}</span>
              <span className={styles.counts}>
                <span className={styles.plus}>+{added}</span> <span className={styles.minus}>−{removed}</span>
              </span>
            </header>
            <div className={mode === 'side-by-side' ? styles.sideBody : undefined}>
              {collapse(g.units).map((it, i) => (
                <Fragment key={i}>
                  {it.kind === 'gap' ? (
                    <Gap count={it.count} />
                  ) : it.unit.kind === 'row' ? (
                    <InlineRow row={it.unit.row} />
                  ) : (
                    <div className={styles.pair}>
                      <Cell row={it.unit.left} side="left" />
                      <Cell row={it.unit.right} side="right" />
                    </div>
                  )}
                </Fragment>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
