import { useState } from 'react';
import { useAiOverview } from '../../../api/ai';
import { AiAvatar } from '../aiUi';
import { DialogShell } from './DialogShell';

/** "Hand to another AI": a new run for the same ticket with another member of the project; an optional note. */
export function HandToDialog({
  projectId,
  currentMemberId,
  onSubmit,
  onClose,
}: Readonly<{
  projectId: string;
  currentMemberId: string | null;
  onSubmit: (memberId: string, note?: string) => Promise<unknown>;
  onClose: () => void;
}>) {
  const overview = useAiOverview(projectId);
  const members = (overview.data?.members ?? []).filter((m) => m.kind === 'ai' && m.id !== currentMemberId);
  const [pick, setPick] = useState<string | null>(null);
  const [note, setNote] = useState('');
  return (
    <DialogShell
      title="Hand to another AI"
      hint="The ticket and the work done so far go to the AI you pick, in a new run."
      confirm="Hand over"
      canConfirm={!!pick}
      onConfirm={() => onSubmit(pick!, note.trim() || undefined)}
      onClose={onClose}
    >
      {overview.isLoading && <div className="ai-muted">Loading the AI members…</div>}
      {!overview.isLoading && members.length === 0 && (
        <div className="ai-muted">There is no other AI member in this project.</div>
      )}
      {members.map((m) => (
        <button
          key={m.id}
          type="button"
          className={`ai-option ${pick === m.id ? 'ai-option-active' : ''}`}
          aria-pressed={pick === m.id}
          onClick={() => setPick(m.id)}
        >
          <span className={`ai-radio ${pick === m.id ? 'ai-radio-on' : ''}`} />
          <AiAvatar provider={m.provider} color={m.color} glyph={m.glyph} size={26} />
          <span style={{ fontSize: 13, fontWeight: 700 }}>{m.name}</span>
        </button>
      ))}
      <textarea
        className="ai-input"
        rows={3}
        value={note}
        placeholder="A note for it (optional)"
        aria-label="Note for the AI"
        onChange={(e) => setNote(e.target.value)}
      />
    </DialogShell>
  );
}
