import { useRef, useState } from 'react';
import { aiApi, useAiMutation, useTicketHolder, type HandoffFields, type TicketHolder } from '../../../api/ai';
import { extractError } from '../../../api/extractError';
import type { HandoffNote, Ticket } from '../../../types';
import { useToast } from '../../Toast';
import { LineIcon, type LineIconName } from '../../ui/LineIcon';
import { FloatMenu } from '../ComposerAi';
import { TakeOverButton } from '../RunActions';
import '../ticketWork.css';
import './handoff.css';

/** The four fields of a handoff note, in the order every role writes and reads them (issue #272). */
export const HANDOFF_FIELDS: { key: keyof HandoffFields; label: string; hint: string }[] = [
  { key: 'done', label: 'Done', hint: 'What you did: the result, not the steps.' },
  { key: 'where', label: 'Where', hint: 'The branch, the files, the page, the comment with the screenshots.' },
  { key: 'left', label: 'Left', hint: 'What is not done, and why. “Nothing.” when nothing is.' },
  { key: 'check', label: 'Check', hint: 'What the next one should check first.' },
];

/** `code` spans in a note's field, the rest as text. */
function Inline({ text }: { text: string }) {
  const parts = text.split('`');
  return <>{parts.map((p, i) => (i % 2 === 1 ? <code key={i}>{p}</code> : <span key={i}>{p}</span>))}</>;
}

/** A handoff note in the comments: a card with its four fields, instead of the comment's plain text. */
export function HandoffCard({ note }: { note: HandoffNote }) {
  return (
    <div className="ho-card" data-testid="handoff-card">
      <div className="ho-head">
        <span className="ho-chip">
          <LineIcon name="send" size={12} /> Handoff note
        </span>
        {note.step && <span className="ho-step">{note.step}</span>}
        {note.to && <span className="ho-to">→ {note.to}</span>}
      </div>
      <dl className="ho-rows">
        {HANDOFF_FIELDS.map((f) => (
          <div key={f.key} className="ho-row" data-testid={`handoff-${f.key}`}>
            <dt>{f.label}</dt>
            <dd className={note[f.key] === 'Not said.' ? 'ho-missing' : undefined}>
              <Inline text={note[f.key] || 'Not said.'} />
            </dd>
          </div>
        ))}
      </dl>
      {note.complete === false && (
        <div className="ho-foot" data-testid="handoff-by-board">
          Written by the board from the run: the AI left no note of its own.
        </div>
      )}
    </div>
  );
}

const KIND_ICON: Record<TicketHolder['kind'], LineIconName> = {
  ai: 'sparkle',
  person: 'user',
  waiting: 'clock',
  nobody: 'user',
};

/**
 * Who has the ticket now, in one line (design AiTicketWork H1, extended by issue #272): the AI working on it and its
 * step, the person who took it back, or whom it waits on. A ticket taken back offers Give back to the AI team.
 */
export function WhoHasIt({ ticket }: { ticket: Ticket }) {
  const holder = useTicketHolder(ticket.id).data;
  if (!holder || holder.kind === 'nobody') return null;
  const takenBack = holder.state === 'taken_back';
  return (
    <div className="ho-who" data-testid="who-has-it">
      <span className={`ho-holder ho-${holder.kind}`} data-testid="who-has-it-chip" title={holder.text}>
        <LineIcon name={KIND_ICON[holder.kind]} size={12} />
        <span className="ho-holder-text">{holder.text}</span>
      </span>
      {takenBack && <GiveBackButton ticketId={ticket.id} />}
      {!takenBack && ((holder.kind === 'ai' && holder.state !== 'idle') || holder.state === 'needs_input') && (
        <TakeOverButton ticketId={ticket.id} projectId={ticket.projectId} />
      )}
    </div>
  );
}

/** Give back to the AI team: a short handoff note (Done is enough), then the paused workflow goes on from its step. */
export function GiveBackButton({ ticketId, label = 'Give back to AI' }: { ticketId: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const [fields, setFields] = useState<HandoffFields>({});
  const toast = useToast();
  const give = useAiMutation((body: HandoffFields) => aiApi.handOver(ticketId, body));
  const ready = !!fields.done?.trim();
  return (
    <>
      <button
        ref={btn}
        type="button"
        className="ai-btn ai-btn-sm"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="give-back"
        onClick={() => setOpen(!open)}
      >
        <LineIcon name="send" size={13} /> {label}
      </button>
      {open && (
        <FloatMenu anchor={btn.current} onClose={() => setOpen(false)} width={340}>
          <div role="dialog" aria-label="Give back to the AI team" data-testid="give-back-pop" className="ho-pop">
            <b className="ho-pop-title">Give {ticketId} back to the AI team</b>
            <div className="ai-hint">
              Your note goes on the ticket. The AI reads it first and goes on from the step it was on.
            </div>
            {HANDOFF_FIELDS.map((f, i) => (
              <label key={f.key} className="ho-field">
                <span>
                  {f.label}
                  {i === 0 && <em> · needed</em>}
                </span>
                <textarea
                  rows={f.key === 'done' ? 2 : 1}
                  placeholder={f.hint}
                  value={fields[f.key] ?? ''}
                  data-testid={`give-back-${f.key}`}
                  onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })}
                />
              </label>
            ))}
            <div className="ho-pop-foot">
              <button type="button" className="ai-btn ai-btn-sm" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="ai-btn ai-btn-sm ai-btn-primary"
                disabled={!ready || give.isPending}
                data-testid="give-back-confirm"
                onClick={async () => {
                  try {
                    const out = await give.mutateAsync(fields);
                    setOpen(false);
                    setFields({});
                    toast.success(
                      'Given back',
                      out.route === 'resumed'
                        ? `The workflow goes on at ${out.step ?? 'its step'}, from your note.`
                        : `${out.member ?? 'The AI'} takes it, from your note.`,
                    );
                  } catch (err) {
                    toast.error("Couldn't give it back", extractError(err));
                  }
                }}
              >
                Give back
              </button>
            </div>
          </div>
        </FloatMenu>
      )}
    </>
  );
}
