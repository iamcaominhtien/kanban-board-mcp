import { useEffect, useRef, useState } from 'react';
import { DialogShell } from './DialogShell';

/** "Continue with a note": the run goes on from where it stopped and is told the note first. A note is required. */
export function ContinueNoteDialog({
  ended,
  onSubmit,
  onClose,
}: Readonly<{ ended: boolean; onSubmit: (note: string) => Promise<unknown>; onClose: () => void }>) {
  const [note, setNote] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus(), []);
  return (
    <DialogShell
      title="Continue with a note"
      hint={
        ended
          ? 'A new run picks up the same conversation and reads your note first.'
          : 'The run goes on from where it is and reads your note at its next step.'
      }
      confirm="Continue"
      canConfirm={note.trim().length > 0}
      onConfirm={() => onSubmit(note.trim())}
      onClose={onClose}
    >
      <textarea
        className="ai-input"
        ref={field}
        rows={4}
        value={note}
        placeholder="What should it know or do differently?"
        aria-label="Note for the AI"
        onChange={(e) => setNote(e.target.value)}
      />
    </DialogShell>
  );
}
