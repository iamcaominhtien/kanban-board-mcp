/**
 * One block of a comparison as it reads (design "History and comments on rich pages", B 7–9 and 13): the block
 * wrapped with a coloured bar and its change named in words — the words that changed for text, the formatting in
 * words for a format change, a table or an embed whole before and after, an image side by side, a new block, a
 * removed one struck through, a moved one with where from and where to. Inline, side by side, or a phone card with a
 * Changes / Before / After switch.
 */

import { useState, type CSSProperties, type ReactNode } from 'react';
import type { RichDoc } from '../../../types/docs';
import { RichBlocks } from '../RichDocView';
import { blockText } from '../suggestions/describe';
import {
  changeDetail,
  changeLabel,
  changeWords,
  tableChangeText,
  type BlockChange,
  type ChangeCounts,
} from './blockDiff';

/** How a comparison is laid out. */
export type CompareMode = 'inline' | 'side-by-side' | 'phone';

/** The two versions' labels ("v11", "v15"). */
export interface SideLabels {
  from: string;
  to: string;
}

/** The colour class of a change's bar: green added, red removed, blue changed, grey moved. */
const tone = (c: BlockChange) => (c.kind === 'changed' && c.moved ? 'changed' : c.kind);

/** One formatting change in words: "Alignment: left → centre". */
function Chip({ what, from, to }: { what: string; from: string; to: string }) {
  return (
    <span className="hx-chip">
      {what}: <span className="hx-from">{from}</span>
      <span className="hx-arrow" aria-label="to">
        →
      </span>
      <b>{to}</b>
    </span>
  );
}

/** The change's label, detail and formatting chips. */
export function ChangeTags({ c }: { c: BlockChange }) {
  const detail = changeDetail(c);
  const table = c.kind === 'changed' ? tableChangeText(c.before, c.after) : null;
  return (
    <div className="hx-tags">
      <span className={`hx-tag hx-tag-${tone(c)}`} data-testid="hx-label">
        {changeLabel(c)}
      </span>
      {detail && <span className="hx-tag hx-tag-muted">{detail}</span>}
      {table && <span className="hx-note">{table}</span>}
      {c.changes.map((f, i) => (
        <Chip key={i} {...f} />
      ))}
      {c.kind === 'changed' && c.moved && <span className="hx-tag hx-tag-moved">Moved</span>}
      {c.moveText && <span className="hx-note">{c.moveText}</span>}
    </div>
  );
}

const TEXT_TAG: Record<string, string> = { blockquote: 'blockquote', pullQuote: 'blockquote', codeBlock: 'pre' };

/**
 * The words that changed, in the block's own kind of element (a heading stays a heading).
 * @param props.c - The change.
 * @param props.side - Only the words of one side (side by side): `before` hides added words, `after` removed ones.
 */
export function DiffText({ c, side }: { c: BlockChange; side?: 'before' | 'after' }) {
  const node = side === 'before' ? c.before : (c.after ?? c.before);
  const a = node?.attrs ?? {};
  const level = typeof a.level === 'number' ? Math.min(6, Math.max(1, a.level)) : 2;
  const Tag = (node?.type === 'heading' ? `h${level}` : (TEXT_TAG[node?.type ?? ''] ?? 'p')) as 'p';
  const style: CSSProperties = { whiteSpace: 'pre-wrap' };
  if (typeof a.textAlign === 'string') style.textAlign = a.textAlign as CSSProperties['textAlign'];
  return (
    <Tag className="hx-diff" style={style} data-testid="hx-diff">
      {changeWords(c).map((seg, i) =>
        seg.kind === 'same' ? (
          <span key={i}>{seg.text}</span>
        ) : seg.kind === 'del' ? (
          side === 'after' ? null : (
            <del key={i} className="hx-del">
              {seg.text}
            </del>
          )
        ) : side === 'before' ? null : (
          <ins key={i} className="hx-ins">
            {seg.text}
          </ins>
        ),
      )}
    </Tag>
  );
}

/** A block drawn by the reader, or "Not in this version". */
function Side({ node, empty = 'Not in this version' }: { node: RichDoc | null; empty?: string }) {
  if (!node) return <div className="hx-empty">{empty}</div>;
  return <RichBlocks nodes={[node]} />;
}

/** Two columns, each with its version's label. */
function Pair({ left, right, labels }: { left: ReactNode; right: ReactNode; labels: SideLabels }) {
  return (
    <div className="hx-pair">
      <div>
        <span className="hx-side-label">{labels.from}</span>
        {left}
      </div>
      <div>
        <span className="hx-side-label">{labels.to}</span>
        {right}
      </div>
    </div>
  );
}

/** The block as the inline comparison draws it. */
function InlineBody({ c, rendered, labels }: { c: BlockChange; rendered: ReactNode; labels: SideLabels }) {
  if (c.kind === 'removed') return <div className="hx-removed-body">{rendered}</div>;
  if (c.kind !== 'changed') return <>{rendered}</>;
  if (c.draw === 'text') return <DiffText c={c} />;
  if (c.draw === 'format') return <>{rendered}</>;
  return <Pair labels={labels} left={<Side node={c.before} />} right={rendered} />;
}

/** The block as the side-by-side comparison draws it: before on the left, after on the right. */
function SideBody({ c, rendered, labels }: { c: BlockChange; rendered: ReactNode; labels: SideLabels }) {
  if (c.kind === 'added') return <Pair labels={labels} left={<Side node={null} />} right={rendered} />;
  if (c.kind === 'removed') return <Pair labels={labels} left={rendered} right={<Side node={null} />} />;
  if (c.kind === 'changed' && c.draw === 'text') {
    return <Pair labels={labels} left={<DiffText c={c} side="before" />} right={<DiffText c={c} side="after" />} />;
  }
  return <Pair labels={labels} left={<Side node={c.before} />} right={rendered} />;
}

/** A phone card's body: Changes (as inline), Before or After. */
function PhoneBody({ c, rendered, labels }: { c: BlockChange; rendered: ReactNode; labels: SideLabels }) {
  const [tab, setTab] = useState<'changes' | 'before' | 'after'>('changes');
  return (
    <>
      <div className="hx-switch" role="group" aria-label="Changes, before or after">
        {(['changes', 'before', 'after'] as const).map((k) => (
          <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}>
            {k === 'changes' ? 'Changes' : k === 'before' ? 'Before' : 'After'}
          </button>
        ))}
      </div>
      {tab === 'changes' && <InlineBody c={c} rendered={rendered} labels={labels} />}
      {tab === 'before' && (c.kind === 'removed' ? rendered : <Side node={c.before} />)}
      {tab === 'after' && (c.kind === 'removed' ? <Side node={null} /> : c.after ? rendered : <Side node={null} />)}
    </>
  );
}

/**
 * One changed block of the comparison.
 * @param props.c - The change.
 * @param props.rendered - The block as the reader draws it (the newer block; the older one for a removed block).
 * @param props.mode - Inline, side by side, or a phone card.
 * @param props.index - Its number among the changes (the jump list's `data-change-index`).
 * @param props.labels - The two versions' labels.
 * @param props.active - The change the jump list is on.
 */
export function BlockChangeView({
  c,
  rendered,
  mode,
  index,
  labels,
  active,
  name,
}: {
  c: BlockChange;
  rendered: ReactNode;
  mode: CompareMode;
  index: number;
  labels: SideLabels;
  active?: boolean;
  /** The block's name (phone cards say it first: "Paragraph 2"). */
  name?: string;
}) {
  if (c.kind === 'same' && mode !== 'side-by-side') return <>{rendered}</>;
  if (c.kind === 'same') return <Pair labels={labels} left={rendered} right={rendered} />;
  return (
    <div
      className={`hx-block hx-${tone(c)}${active ? ' is-active' : ''}${mode === 'phone' ? ' hx-card' : ''}`}
      data-change-index={index >= 0 ? index : undefined}
      data-testid="hx-change"
      data-kind={c.kind}
    >
      {mode === 'phone' && name && <div className="hx-card-name">{name}</div>}
      <ChangeTags c={c} />
      {mode === 'inline' && <InlineBody c={c} rendered={rendered} labels={labels} />}
      {mode === 'side-by-side' && <SideBody c={c} rendered={rendered} labels={labels} />}
      {mode === 'phone' && <PhoneBody c={c} rendered={rendered} labels={labels} />}
    </div>
  );
}

/** "12 unchanged blocks · Show" (or "4 more changes · Show" past a very large change's limit). */
export function FoldRow({ blocks, onShow }: { blocks: BlockChange[]; onShow: () => void }) {
  const changed = blocks.filter((b) => b.kind !== 'same').length;
  const same = blocks.length - changed;
  const text = [
    same ? `${same} unchanged ${same === 1 ? 'block' : 'blocks'}` : '',
    changed ? `${changed} more ${changed === 1 ? 'change' : 'changes'}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const first = blocks.find((b) => b.after ?? b.before);
  const peek = first ? blockText(first.after ?? first.before).split('\n')[0] : '';
  return (
    <div className="hx-fold" data-testid="hx-fold">
      <span>{text}</span>
      {peek && <span className="hx-fold-peek">{peek}</span>}
      <button type="button" className="hx-link" onClick={onShow}>
        Show
      </button>
    </div>
  );
}

/** "5 changed · 2 added · 1 removed blocks" (moved too when there are any). */
export function CountsLine({ counts }: { counts: ChangeCounts }) {
  return (
    <span className="hx-counts" data-testid="hx-counts">
      <b className="hx-c-changed">{counts.changed}</b> changed <b className="hx-c-added">{counts.added}</b> added{' '}
      <b className="hx-c-removed">{counts.removed}</b> removed
      {counts.moved > 0 && (
        <>
          {' '}
          <b className="hx-c-moved">{counts.moved}</b> moved
        </>
      )}{' '}
      blocks
    </span>
  );
}
