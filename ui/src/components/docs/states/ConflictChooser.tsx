/**
 * Choosing block by block (RichDocsStates frames 31, 32, 35, 36): each block both people changed is shown as it will
 * look on each side, with the words that changed marked and a changed position or width named; the person keeps
 * theirs, the other person's, or (text) both. A confirmation guards "Keep mine" (frame 33).
 */

import { useEffect, useState, type ReactNode } from 'react';
import type { JSONContent } from '@tiptap/core';
import { TEXT_BLOCK_TYPES, type BlockChoice, type BlockConflict, type JoinedBlock } from '../../../richdoc/merge';
import { wordDiff } from '../../ai/editor/diff';
import type { RichDoc } from '../../../types/docs';
import { blockText } from '../suggestions/describe';
import { displayName, initialsOf, useEscape } from '../docsShared';
import { blockKind, blockLabel, changeChips, type ChangeChip } from './blockInfo';
import { StIcon } from './stIcons';
import { StateDialog } from './StateDialog';
import './states.css';

/** Whether "Keep both" is offered: two text blocks (her paragraph goes after yours). */
export function canKeepBoth(c: BlockConflict): boolean {
  return Boolean(
    c.mine && c.theirs && TEXT_BLOCK_TYPES.has(c.mine.type ?? '') && TEXT_BLOCK_TYPES.has(c.theirs.type ?? ''),
  );
}

/**
 * "Hoa Mai’s typo fixes, a new table row and your new sentence" in plain counts: who the joined blocks came from.
 * @param joined - The blocks joined without a question.
 * @param who - The other person's name.
 */
export function joinedSummary(joined: JoinedBlock[], who: string): string {
  const theirs = joined.filter((j) => j.by === 'theirs').length;
  const mine = joined.filter((j) => j.by === 'mine').length;
  const both = joined.length - theirs - mine;
  const parts = [
    theirs ? `${theirs === 1 ? 'a change' : `${theirs} changes`} by ${who}` : '',
    mine ? `${mine === 1 ? 'a change' : `${mine} changes`} of yours` : '',
    both ? `${both === 1 ? 'a block' : `${both} blocks`} you both changed in different places` : '',
  ].filter(Boolean);
  const s = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? '');
  return s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}.` : '';
}

const hhmm = (d: Date) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** The block on one side, drawn as it will look: text with its changes marked, a picture where it sits. */
function SideBody({ base, node }: { base: JSONContent | null; node: JSONContent | null }) {
  if (!node) return <span className="dst-side-empty">Removed in this version.</span>;
  if (node.type === 'image') {
    const a = node.attrs ?? {};
    const pl = typeof a.placement === 'string' ? a.placement : 'block';
    const w = typeof a.widthPct === 'number' ? `${a.widthPct}%` : '100%';
    const float = pl === 'floatRight' ? 'right' : pl === 'floatLeft' ? 'left' : undefined;
    return (
      <div
        style={{
          float,
          width: float ? w : '100%',
          margin: float === 'right' ? '2px 0 6px 12px' : float === 'left' ? '2px 12px 6px 0' : '2px 0 6px',
        }}
      >
        {typeof a.src === 'string' && a.src ? <img src={a.src} alt={typeof a.alt === 'string' ? a.alt : ''} /> : null}
        {typeof a.caption === 'string' && a.caption && (
          <div className="dst-side-cap" style={{ textAlign: float ? undefined : 'center' }}>
            {a.caption}
          </div>
        )}
      </div>
    );
  }
  const after = blockText(node as RichDoc);
  if (!base || !TEXT_BLOCK_TYPES.has(node.type ?? '')) return <>{after || blockKind(node)}</>;
  const segs = wordDiff(blockText(base as RichDoc), after);
  return (
    <>
      {segs.map((s, i) =>
        s.kind === 'same' ? (
          <span key={i}>{s.text}</span>
        ) : s.kind === 'add' ? (
          <ins key={i}>{s.text}</ins>
        ) : (
          <del key={i}>{s.text}</del>
        ),
      )}
    </>
  );
}

const chipClass = (c: ChangeChip) =>
  c.tone === 'blue' ? 'dst-chip dst-chip-blue' : c.tone === 'amber' ? 'dst-chip dst-chip-amber' : 'dst-chip';

/** One side's card: who, when, a radio, the block, the change labels. */
function SideCard({
  who,
  initials,
  when,
  base,
  node,
  theirs,
  checked,
  onPick,
  testId,
}: {
  who: string;
  initials: string;
  when: string;
  base: JSONContent | null;
  node: JSONContent | null;
  theirs: boolean;
  checked: boolean;
  onPick?: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className="dst-side"
      onClick={onPick}
      data-testid={testId}
    >
      <span className="dst-side-head" style={{ width: '100%', boxSizing: 'border-box' }}>
        <span className="dst-avatar" aria-hidden="true">
          {initials}
        </span>
        <span style={{ flex: 1 }}>
          <span className="dst-side-who" style={{ display: 'block' }}>
            {who}
          </span>
          <span className="dst-side-when" style={{ display: 'block' }}>
            {when}
          </span>
        </span>
        <span className="dst-radio" aria-hidden="true" />
      </span>
      <span className="dst-side-text" style={{ display: 'block', width: '100%', boxSizing: 'border-box' }}>
        <SideBody base={base} node={node} />
      </span>
      <span className="dst-side-chips" style={{ width: '100%', boxSizing: 'border-box' }}>
        {changeChips(base, node, theirs).map((c) => (
          <span key={c.text} className={chipClass(c)}>
            {c.text}
          </span>
        ))}
      </span>
    </button>
  );
}

interface Props {
  conflicts: BlockConflict[];
  joined: JoinedBlock[];
  /** The newer version (its number and who published it when). */
  theirs: { version: number; author: string; at: string };
  baseVersion: number;
  /** When your draft was last changed. */
  mineAt: Date | null;
  me?: string;
  /** The page as merged so far (block numbers). */
  doc: JSONContent;
  onApply: (choices: Record<string, BlockChoice>) => void;
  onClose: () => void;
  layout: 'desktop' | 'tablet' | 'phone';
}

/**
 * The block-by-block chooser.
 * @param props.conflicts - The blocks both people changed.
 * @param props.joined - What was joined without a question (the summary line).
 * @param props.theirs - The newer version.
 * @param props.baseVersion - The version the draft started from.
 * @param props.mineAt - When the draft was last changed.
 * @param props.me - The person editing.
 * @param props.doc - The merged page, for "Block N".
 * @param props.onApply - Called with a choice for every block.
 * @param props.onClose - Cancel, Esc and the close button.
 * @param props.layout - Side by side (desktop), stacked (tablet) or one side at a time (phone).
 */
export function ConflictChooser({
  conflicts,
  joined,
  theirs,
  baseVersion,
  mineAt,
  me,
  doc,
  onApply,
  onClose,
  layout,
}: Props) {
  useEscape(onClose);
  const [at, setAt] = useState(0);
  const [choices, setChoices] = useState<Record<string, BlockChoice>>({});
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [phoneSide, setPhoneSide] = useState<BlockChoice>('mine');
  const who = displayName(theirs.author);
  const c = conflicts[at];
  const choice = choices[c.id] ?? 'mine';
  const last = at === conflicts.length - 1;
  const both = canKeepBoth(c);
  const pick = (v: BlockChoice) => {
    setChoices((m) => ({ ...m, [c.id]: v }));
    setChosen((s) => new Set(s).add(c.id));
  };
  const next = () => {
    const all = { ...choices, [c.id]: choice };
    setChoices(all);
    setChosen((s) => new Set(s).add(c.id));
    if (last) onApply(all);
    else {
      setAt(at + 1);
      setPhoneSide(choices[conflicts[at + 1].id] ?? 'mine');
    }
  };
  const label = (x: BlockConflict) => blockLabel(doc, x.id, x.mine ?? x.theirs);
  const mineWhen = `Edited ${mineAt ? hhmm(mineAt) : 'now'}${layout === 'desktop' ? ` · from v${baseVersion}` : ''}`;
  const theirWhen = `Published ${hhmm(new Date(theirs.at))}${layout === 'desktop' ? ` · v${theirs.version}` : ''}`;
  const mineCard = (
    <SideCard
      who="Your version"
      initials={initialsOf(me ?? 'You')}
      when={mineWhen}
      base={c.base}
      node={c.mine}
      theirs={false}
      checked={choice === 'mine' || choice === 'both'}
      onPick={() => pick('mine')}
      testId="conflict-mine"
    />
  );
  const theirCard = (
    <SideCard
      who={`${who}’s version`}
      initials={initialsOf(theirs.author)}
      when={theirWhen}
      base={c.base}
      node={c.theirs}
      theirs
      checked={choice === 'theirs' || choice === 'both'}
      onPick={() => pick('theirs')}
      testId="conflict-theirs"
    />
  );
  const seg: ReactNode = (
    <div className="dst-seg" role="radiogroup" aria-label="Which to keep">
      {(
        [
          ['mine', layout === 'phone' ? 'Yours' : 'Keep mine'],
          ['theirs', layout === 'phone' ? `${who}’s` : `Use ${who}’s`],
          ...(both ? [['both', layout === 'phone' ? 'Both' : 'Keep both']] : []),
        ] as [BlockChoice, string][]
      ).map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={(layout === 'phone' ? phoneSide : choice) === v}
          onClick={() => {
            if (layout === 'phone') setPhoneSide(v);
            pick(v);
          }}
          data-testid={`conflict-choice-${v}`}
        >
          {text}
        </button>
      ))}
    </div>
  );
  const hint = both
    ? 'Keep both puts her paragraph after yours.'
    : c.mine?.type === 'image' || c.theirs?.type === 'image'
      ? 'A picture is chosen whole; its caption goes with it.'
      : `A ${blockKind(c.mine ?? c.theirs)} is chosen whole.`;
  const summary = joinedSummary(joined, who);

  if (layout === 'phone') {
    return (
      <StateDialog
        width={390}
        title={conflicts.length === 1 ? 'One block changed' : `${countWord(conflicts.length)} blocks changed`}
        sub={`Conflict · v${baseVersion} and v${theirs.version}`}
        onClose={onClose}
        sheet
        testId="conflict-chooser"
        footer={
          <button type="button" className="st-btn st-btn-primary" onClick={next} data-testid="conflict-next">
            {last ? 'Apply and continue' : 'Keep this · next block'}
          </button>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700 }}>{label(c)} · changed in both versions</div>
          {seg}
          {phoneSide === 'theirs' ? theirCard : mineCard}
          {phoneSide === 'both' && theirCard}
          <div style={{ fontSize: 12, color: '#5B6B60' }}>
            {both ? `Tap ${who}’s to compare. Both keeps her paragraph after yours.` : hint}
          </div>
        </div>
      </StateDialog>
    );
  }

  return (
    <div className="dst-scrim docs-root" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={conflicts.length === 1 ? 'One block changed in both versions' : 'Blocks changed in both versions'}
        className="dst-dialog dst-choose"
        data-testid="conflict-chooser"
      >
        <div className="dst-choose-head">
          <span className="dst-choose-badge" aria-hidden="true">
            <StIcon name="warn" size={18} sw={2} />
          </span>
          <div style={{ flex: 1 }}>
            <div className="dst-choose-title">
              {conflicts.length === 1
                ? 'One block changed in both versions'
                : `${countWord(conflicts.length)} blocks changed in both versions`}
            </div>
            <div className="dst-choose-sub">Choose which to keep. The other stays in History as v{theirs.version}.</div>
          </div>
          <button type="button" className="dst-dialog-close" aria-label="Close" onClick={onClose}>
            <StIcon name="x" size={16} sw={1.9} />
          </button>
        </div>
        <div className="dst-tabs" role="tablist" aria-label="Blocks to choose">
          {conflicts.map((x, i) => (
            <button
              key={x.id}
              type="button"
              role="tab"
              aria-selected={i === at}
              className="dst-tab"
              onClick={() => setAt(i)}
            >
              {label(x)}
            </button>
          ))}
        </div>
        <div className="dst-choose-body" role="tabpanel" aria-label={label(c)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="dst-sides" role="radiogroup" aria-label="The two versions">
              {mineCard}
              {theirCard}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {seg}
              <span style={{ fontSize: 12, color: '#5B6B60' }}>{hint}</span>
            </div>
          </div>
          {joined.length > 0 && (
            <div className="dst-joined">
              <b>
                Joined for you · {joined.length} block{joined.length === 1 ? '' : 's'}
              </b>
              <span style={{ color: '#5B6B60', flex: 1 }}>{summary}</span>
            </div>
          )}
        </div>
        <div className="dst-choose-foot">
          <span style={{ fontSize: 12.5, color: '#5B6B60' }} data-testid="conflict-count">
            {chosen.size} of {conflicts.length} chosen
          </span>
          <span style={{ flex: 1 }} />
          <button type="button" className="st-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="st-btn st-btn-primary" onClick={next} data-testid="conflict-next">
            {last ? 'Apply and continue' : 'Next block'}
          </button>
        </div>
      </div>
    </div>
  );
}

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
const countWord = (n: number) => WORDS[n] ?? String(n);

/**
 * "Keep your version of both blocks?" (frame 33).
 * @param props.count - The blocks both people changed.
 * @param props.joinedCount - The blocks joined without a question.
 * @param props.who - The other person.
 * @param props.version - The newer version (stays in History).
 * @param props.pageTitle - Sub-line.
 * @param props.onConfirm - Keep mine.
 * @param props.onClose - Cancel.
 * @param props.sheet - A phone sheet.
 */
export function KeepMineConfirm({
  count,
  joinedCount,
  who,
  version,
  pageTitle,
  onConfirm,
  onClose,
  sheet,
}: {
  count: number;
  joinedCount: number;
  who: string;
  version: number;
  pageTitle: string;
  onConfirm: () => void;
  onClose: () => void;
  sheet?: boolean;
}) {
  const name = displayName(who);
  return (
    <StateDialog
      width={500}
      role="alertdialog"
      title={
        count === 1
          ? 'Keep your version of this block?'
          : `Keep your version of ${count === 2 ? 'both' : 'all'} blocks?`
      }
      sub={pageTitle}
      onClose={onClose}
      sheet={sheet}
      testId="keep-mine-confirm"
      footer={
        <>
          <button type="button" className="st-btn" onClick={onClose}>
            Cancel
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="st-btn st-btn-primary" onClick={onConfirm} data-testid="keep-mine-yes">
            Keep mine
          </button>
        </>
      }
    >
      <p className="dst-p">
        {name}’s changes to{' '}
        <b>
          {count} block{count === 1 ? '' : 's'}
        </b>{' '}
        will not be used. They stay in History as v{version} and can be restored from there.
        {joinedCount > 0 &&
          ` The ${joinedCount} block${joinedCount === 1 ? ' that was' : 's that were'} joined for you stay${joinedCount === 1 ? 's' : ''} joined.`}
      </p>
    </StateDialog>
  );
}

/**
 * "Joined. Publish is available again." (frame 34): a card at the bottom with Undo; it goes after 8 seconds.
 * @param props.version - The version the page is now based on.
 * @param props.onUndo - Puts the draft back as it was; the button is hidden without it.
 * @param props.onClose - Called when it goes.
 */
export function JoinedToast({
  version,
  onUndo,
  onClose,
}: {
  version: number;
  onUndo?: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onClose, 8000);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div className="dst-toast" role="status" data-testid="joined-toast">
      <span className="dst-toast-disc" aria-hidden="true">
        <StIcon name="check" size={16} sw={2.4} />
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>Joined. Publish is available again.</div>
        <div style={{ fontSize: 12, color: '#5B6B60' }}>Your page is now based on v{version}.</div>
      </div>
      {onUndo && (
        <button
          type="button"
          className="st-btn st-btn-sm"
          onClick={() => {
            onUndo();
            onClose();
          }}
        >
          Undo
        </button>
      )}
      <button type="button" className="dst-x" aria-label="Dismiss" onClick={onClose}>
        <StIcon name="x" size={14} sw={1.9} />
      </button>
    </div>
  );
}
