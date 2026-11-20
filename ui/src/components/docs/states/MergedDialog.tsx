/**
 * "Merged for you" (RichDocsStates frames 23 and 26): the blocks that were joined without a question, who changed
 * each one, and a jump to it.
 */

import type { JSONContent } from '@tiptap/core';
import type { JoinedBlock } from '../../../richdoc/merge';
import { displayName, initialsOf } from '../docsShared';
import { blockKind, blockLabel, changeChips } from './blockInfo';
import { StateDialog } from './StateDialog';
import './states.css';

interface Props {
  joined: JoinedBlock[];
  /** The block as both started from, by id (for the chips). */
  baseOf: (id: string) => JSONContent | null;
  /** The page as merged (block numbers are counted in it). */
  doc: JSONContent;
  fromVersion: number;
  toVersion: number;
  /** Who published the newer version. */
  author: string;
  me?: string;
  onGoTo: (blockId: string) => void;
  onOpenHistory?: () => void;
  onClose: () => void;
  sheet?: boolean;
}

/**
 * The row title of a joined block: "Hoa Mai changed the picture", "Hoa Mai added a table", "Your new paragraph
 * stayed".
 * @param j - The joined block.
 * @param who - The other person's name.
 */
export function joinedTitle(j: JoinedBlock, who: string): string {
  const kind = blockKind(j.node);
  if (j.by === 'both') return `Your change and ${who}’s were joined`;
  if (j.by === 'mine') {
    if (j.kind === 'added') return `Your new ${kind} stayed`;
    if (j.kind === 'removed') return `The ${kind} you removed stays removed`;
    return `Your change to the ${kind} stayed`;
  }
  if (j.kind === 'added') return `${who} added a ${kind}`;
  if (j.kind === 'removed') return `${who} removed a ${kind}`;
  return `${who} changed the ${kind}`;
}

/**
 * The "Merged for you" dialog.
 * @param props.joined - What the merge joined.
 * @param props.baseOf - The block as both started from.
 * @param props.doc - The merged page.
 * @param props.fromVersion - The version the draft started from.
 * @param props.toVersion - The newer version it now builds on.
 * @param props.author - Who published the newer version.
 * @param props.me - The person editing (their initials on their rows).
 * @param props.onGoTo - Scrolls to a block and closes the dialog.
 * @param props.onOpenHistory - Opens Page history; the button is hidden without it.
 * @param props.onClose - Done, Esc and the close button.
 * @param props.sheet - Draw as a phone sheet.
 */
export function MergedDialog({
  joined,
  baseOf,
  doc,
  fromVersion,
  toVersion,
  author,
  me,
  onGoTo,
  onOpenHistory,
  onClose,
  sheet,
}: Props) {
  const who = displayName(author);
  return (
    <StateDialog
      width={520}
      title="Merged for you"
      sub={`${joined.length} block${joined.length === 1 ? '' : 's'} · v${fromVersion} → v${toVersion}`}
      onClose={onClose}
      sheet={sheet}
      testId="merged-dialog"
      footer={
        <>
          {onOpenHistory && (
            <button type="button" className="st-btn" onClick={onOpenHistory}>
              Open History
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="st-btn st-btn-primary" onClick={onClose} data-autofocus>
            Done
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 12.5, color: '#3A4A3E', lineHeight: 1.5 }}>
          {sheet
            ? 'Joined without a question. Both sets of changes are in History.'
            : 'These blocks were joined without a question. Nothing is lost: both sets of changes are in History.'}
        </div>
        <div>
          {joined.map((j) => {
            const chips =
              j.kind === 'changed' ? changeChips(baseOf(j.id), j.node).filter((c) => c.tone !== 'blue') : [];
            return (
              <div key={j.id} className="dst-row" data-testid="merged-row">
                <span className="dst-avatar" aria-hidden="true">
                  {initialsOf(j.by === 'theirs' ? author : (me ?? 'You'))}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="dst-row-title">{joinedTitle(j, who)}</div>
                  <div className="dst-row-sub">{blockLabel(doc, j.id, j.node)}</div>
                  {chips.length > 0 && (
                    <div style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {chips.map((c) => (
                        <span key={c.text} className="dst-chip">
                          {c.text}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {j.kind !== 'removed' && (
                  <button type="button" className="st-btn st-btn-sm" onClick={() => onGoTo(j.id)}>
                    Go to block
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </StateDialog>
  );
}
