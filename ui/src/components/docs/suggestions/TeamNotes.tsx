/**
 * The notes a team leaves under a block it did not change (design "AI teams on rich pages", G 35–36): the block is
 * locked for teams, or rewriting it would have removed its formatting. The second one keeps what the team wrote:
 * "Show what it wrote" opens it as plain text with Copy text, Replace the block and Dismiss. Values from the board's
 * code (RichDocsAi2, frames 35–36).
 */

import { useState } from 'react';
import { extractError } from '../../../api/extractError';
import { useToast } from '../../Toast';
import { useNoteActions, type TeamNote } from './api';
import { SgIcon, Spark } from './sgIcons';
import './suggestions.css';

/** The word of each kind of formatting the server counts, singular and plural. */
const WORDS: Record<string, [string, string]> = {
  colour: ['colour', 'colours'],
  highlight: ['highlight', 'highlights'],
  link: ['link', 'links'],
  font: ['font change', 'font changes'],
  underline: ['underline', 'underlines'],
  chip: ['page or ticket chip', 'page or ticket chips'],
  formula: ['formula', 'formulas'],
};

/**
 * What a rewrite would have removed, in words: "1 colour, 1 highlight and 1 link".
 * @param lost - The count of each kind of formatting lost.
 */
export function lostPhrase(lost: Record<string, number>): string {
  const parts = Object.entries(lost)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => {
      const [one, many] = WORDS[k] ?? [k, `${k}s`];
      return `${n} ${n === 1 ? one : many}`;
    });
  if (parts.length <= 1) return parts[0] ?? 'its formatting';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The note's sentence: bold lead and the reason. */
export function noteWords(n: TeamNote): { lead: string; rest: string } {
  if (n.kind === 'locked') {
    return {
      lead: `${n.author} wanted to change this block, but it is locked for teams.`,
      rest: 'Nothing was changed.',
    };
  }
  return {
    lead: `${n.author} left this block as it is.`,
    rest: `Rewriting it would have removed its formatting: ${lostPhrase(n.lost)}.`,
  };
}

/**
 * One team note under its block.
 * @param props.note - The note.
 * @param props.pageId - The page.
 * @param props.projectId - Its project.
 * @param props.canEdit - The reader may replace the block or dismiss the note.
 */
export function TeamNoteView({
  note,
  pageId,
  projectId,
  canEdit,
}: {
  note: TeamNote;
  pageId: string;
  projectId: string;
  canEdit: boolean;
}) {
  const toast = useToast();
  const { dismiss, replace } = useNoteActions(pageId, projectId);
  const [open, setOpen] = useState(false);
  const words = noteWords(note);
  const busy = dismiss.isPending || replace.isPending;
  const onDismiss = () =>
    dismiss.mutate([note.id], { onError: (e) => toast.error("Couldn't dismiss the note", extractError(e)) });
  const onReplace = () =>
    replace.mutate(note.id, {
      onSuccess: (p) => toast.success('Block replaced', `Saved as v${p.version}.`),
      onError: (e) => toast.error("Couldn't replace the block", extractError(e)),
    });
  const copy = () => {
    void navigator.clipboard?.writeText(note.wrote ?? '').then(
      () => toast.success('Copied', 'What the team wrote is on the clipboard.'),
      () => toast.error("Couldn't copy", 'The browser did not allow it.'),
    );
  };
  const dismissBtn = canEdit && (
    <button type="button" className="sg-btn" disabled={busy} onClick={onDismiss} data-testid="sg-note-dismiss">
      Dismiss
    </button>
  );
  return (
    <div className="sg-team-note" data-testid="sg-team-note" data-kind={note.kind}>
      <div className="sg-msg sg-msg-note">
        {note.kind === 'locked' ? <SgIcon name="lock" size={14} color="#5B3AA6" /> : <Spark size={14} />}
        <div>
          <b>{words.lead}</b> {words.rest}
        </div>
      </div>
      {!open && (note.wrote || canEdit) && (
        <div className="sg-note-actions">
          {note.wrote && (
            <button type="button" className="sg-btn" onClick={() => setOpen(true)} data-testid="sg-note-show">
              Show what it wrote
            </button>
          )}
          {dismissBtn}
        </div>
      )}
      {open && note.wrote && (
        <div className="sg-note-wrote" data-testid="sg-note-wrote">
          <div className="sg-note-wrote-head">WHAT IT WROTE · PLAIN TEXT</div>
          <div className="sg-note-wrote-text">{note.wrote}</div>
          <div className="sg-note-actions">
            <button type="button" className="sg-btn" onClick={copy}>
              Copy text
            </button>
            {canEdit && (
              <button
                type="button"
                className="sg-btn"
                disabled={busy}
                onClick={onReplace}
                data-testid="sg-note-replace"
              >
                {replace.isPending ? 'Saving…' : 'Replace the block'}
              </button>
            )}
            {dismissBtn}
          </div>
        </div>
      )}
    </div>
  );
}
