import { useState } from 'react';
import { DialogShell } from './DialogShell';

export interface AccountRoom {
  accountId: string;
  name: string;
  email?: string;
  plan?: string;
  used?: number;
  free?: number;
}

/** "Move urgent work": pick the Claude account that has room until the window reopens. */
export function MoveAccountDialog({
  room,
  until,
  onSubmit,
  onClose,
}: Readonly<{
  room: AccountRoom[];
  until?: string;
  onSubmit: (accountId: string) => Promise<unknown>;
  onClose: () => void;
}>) {
  const [pick, setPick] = useState<string | null>(room.length === 1 ? room[0].accountId : null);
  return (
    <DialogShell
      title="Move urgent work"
      hint={until ? `This account's window is used up until ${until}. Pick an account with room.` : undefined}
      confirm="Move it"
      canConfirm={!!pick}
      onConfirm={() => onSubmit(pick!)}
      onClose={onClose}
    >
      {room.length === 0 && <div className="ai-muted">No other account has room right now.</div>}
      {room.map((a) => (
        <button
          key={a.accountId}
          type="button"
          className={`ai-option ${pick === a.accountId ? 'ai-option-active' : ''}`}
          aria-pressed={pick === a.accountId}
          onClick={() => setPick(a.accountId)}
        >
          <span className={`ai-radio ${pick === a.accountId ? 'ai-radio-on' : ''}`} />
          <span style={{ display: 'flex', flexDirection: 'column', textAlign: 'left' }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>{a.name}</span>
            <span className="ai-muted">
              {[a.email, a.plan, a.free != null ? `${a.free} free${a.used != null ? `, ${a.used} used` : ''}` : null]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
        </button>
      ))}
    </DialogShell>
  );
}
