import { useEffect, useRef, useState } from 'react';
import type { Member, Ticket } from '../../types';
import type { AiTeam } from '../../types/ai';
import { MemberAvatar } from '../MemberAvatar';
import { currentPerson } from '../assist/assistUi';
import { ASSIGN_AI_EVENT } from './AiTicketContext';
import { ACTIVE_RUN_STATES, AiAvatar, StatusLabel, useAiBoardState } from './aiUi';
import { LineIcon } from '../ui/LineIcon';

/** Why a team cannot take work now (the picker greys it out), or a note on how it will start. */
function aiNote(m: AiTeam): { disabled: boolean; note: string; tag?: string; grey?: boolean } {
  switch (m.status.code) {
    case 'running':
      return { disabled: false, note: `· ${m.slotsInUse} running` };
    case 'runner_missing':
      // greyed, with its label on the right; it can still be picked: the ticket waits in its queue
      return { disabled: false, note: '', tag: 'offline', grey: true };
    case 'not_logged_in':
      return { disabled: true, note: '', tag: 'signed out' };
    case 'over_budget':
      return { disabled: true, note: '· resets 00:00' };
    case 'paused':
      return { disabled: true, note: '· resume in AI teams' };
    case 'paused_all':
      return { disabled: true, note: '· AI is paused' };
    default:
      return { disabled: false, note: '' };
  }
}

/**
 * Assignee picker with people and a separate group of AI teams (live status, reasons for disabled teams). Picking a
 * team asks whether to start its lead now or only assign it.
 */
export function AssigneePicker({
  ticket,
  members,
  value,
  onPickPerson,
  onAssignedAi,
}: {
  ticket: Ticket;
  members: Member[];
  value: string | null;
  /** `start` is false when an AI team is assigned without starting. */
  onPickPerson: (id: string | null, start?: boolean) => void;
  onAssignedAi: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [pending, setPending] = useState<AiTeam | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const { members: aiMap } = useAiBoardState();
  const me = currentPerson();
  const current = members.find((m) => m.id === value);
  const people = members.filter(
    (m) => (m.kind ?? 'human') === 'human' && m.name.toLowerCase().includes(q.toLowerCase()),
  );
  const ais = [...aiMap.values()].filter((m) => m.kind === 'ai' && m.name.toLowerCase().includes(q.toLowerCase()));

  // “Assign here” on an AI's hover card, or “Assign to someone else” on the offline banner
  useEffect(() => {
    const onAssign = (e: Event) => {
      const d = (e as CustomEvent<{ ticketId: string; memberId: string }>).detail;
      if (!d || d.ticketId !== ticket.id) return;
      const ai = d.memberId ? aiMap.get(d.memberId) : undefined;
      if (ai) setPending(ai);
      else setOpen(true);
    };
    window.addEventListener(ASSIGN_AI_EVENT, onAssign);
    return () => window.removeEventListener(ASSIGN_AI_EVENT, onAssign);
  }, [ticket.id, aiMap]);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setPending(null);
      }
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, []);

  return (
    <div ref={ref} style={{ position: 'relative' }} className="ai-root">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        data-testid="assignee-picker"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          border: 'none',
          background: 'none',
          padding: 0,
          cursor: 'pointer',
          font: 'inherit',
          color: 'inherit',
          textAlign: 'left',
        }}
      >
        {current ? (
          <>
            <MemberAvatar member={current} size={22} />
            <span style={{ fontWeight: 600, fontSize: 12.5 }}>{current.name}</span>
          </>
        ) : (
          <span style={{ color: '#9AA8A0', fontSize: 12.5 }}>Unassigned</span>
        )}
      </button>
      {current && aiMap.get(current.id) && (
        <div className="ai-muted" style={{ marginTop: 3 }} data-testid="assignee-team-sub">
          {aiMap.get(current.id)!.packName ?? 'Team'} · Claude Code
        </div>
      )}
      {open && !pending && (
        <div className="ai-popover" style={{ right: 0, top: 30, width: 330, padding: 8 }} data-testid="assignee-menu">
          <input
            className="ai-input"
            placeholder="Search people and teams…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
          />
          <div style={{ maxHeight: 360, overflow: 'auto', marginTop: 6 }}>
            <button
              type="button"
              className="ai-mi"
              onClick={() => {
                onPickPerson(null);
                setOpen(false);
              }}
            >
              Unassigned
            </button>
            <div className="ai-label" style={{ padding: '8px 10px 4px' }}>
              People
            </div>
            {people.map((m) => (
              <button
                key={m.id}
                type="button"
                className="ai-mi"
                onClick={() => {
                  onPickPerson(m.id);
                  setOpen(false);
                }}
              >
                <MemberAvatar member={m} size={22} />
                {m.name}
                {m.name === me && (
                  <span className="ai-muted" style={{ marginLeft: 'auto' }} data-testid="assign-you-tag">
                    you
                  </span>
                )}
                {m.id === value && (
                  <span style={{ marginLeft: m.name === me ? 8 : 'auto', color: '#2E6F40' }}>
                    <LineIcon name="check" size={13} />
                  </span>
                )}
              </button>
            ))}
            {ais.length > 0 && (
              <div className="ai-label" style={{ padding: '8px 10px 4px' }}>
                AI teams · {ais.length}
              </div>
            )}
            {ais.map((m) => {
              const n = aiNote(m);
              return (
                <button
                  key={m.id}
                  type="button"
                  className="ai-mi"
                  disabled={n.disabled}
                  style={{
                    opacity: n.disabled || n.grey ? 0.5 : 1,
                    cursor: n.disabled ? 'not-allowed' : 'pointer',
                  }}
                  title={n.tag === 'offline' ? 'Runner not detected: the ticket waits in its queue' : undefined}
                  onClick={() => setPending(m)}
                  data-testid={`assign-ai-${m.name}`}
                >
                  <AiAvatar color={m.color} size={22} />
                  <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                    <span>{m.name}</span>
                    {!n.tag && (
                      <span style={{ display: 'flex', gap: 4, alignItems: 'center', fontWeight: 500 }}>
                        <StatusLabel status={m.status} sub={null} />
                        <span className="ai-muted">{n.note}</span>
                      </span>
                    )}
                  </span>
                  {n.tag && (
                    <span className="ai-muted" style={{ marginLeft: 'auto' }} data-testid="assign-ai-tag">
                      {n.tag}
                    </span>
                  )}
                  {m.id === value && (
                    <span style={{ marginLeft: 'auto', color: '#2E6F40' }}>
                      <LineIcon name="check" size={13} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {pending && (
        <AssignStartPopover
          ticket={ticket}
          member={pending}
          onDone={(start) => {
            onPickPerson(pending.id, start);
            onAssignedAi(pending.id);
            setPending(null);
            setOpen(false);
          }}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}

/** Assign a team: start its lead now (the server does it when the assignee changes), or only assign it. */
export function AssignStartPopover({
  ticket,
  member,
  onDone,
  onCancel,
}: {
  ticket: Ticket;
  member: AiTeam;
  onDone: (start: boolean) => void;
  onCancel: () => void;
}) {
  const { runsByTicket, members } = useAiBoardState();
  const held = runsByTicket.get(ticket.id);
  const heldBy = held && ACTIVE_RUN_STATES.includes(held.state) && held.memberId !== member.id ? held : undefined;
  const heldByName = heldBy ? (members.get(heldBy.memberId)?.name ?? 'Another team') : null;
  return (
    <div className="ai-popover" style={{ right: 0, top: 30 }} data-testid="assign-start-popover">
      <div style={{ fontSize: 13.5, fontWeight: 700 }}>
        Assign {ticket.id} to {member.name}
      </div>
      <div className="ai-muted" style={{ marginBottom: 10 }}>
        {ticket.title}
      </div>
      <div className="ai-notice ai-notice-info">
        Start now: the team's lead begins at once
        {member.roles.length ? `, with ${member.roles.map((r) => r.name ?? r.key).join(', ')} as its roles` : ''}.
        Assign only: the team holds the ticket and starts when you run it.
        {heldByName ? ` ${heldByName} is working on it now; that run is cancelled.` : ''}
      </div>
      <div className="ai-muted" style={{ marginTop: 8 }}>
        Ticket text is untrusted input for the agent.
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button type="button" className="ai-btn ai-btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="ai-btn ai-btn-sm" onClick={() => onDone(false)} data-testid="assign-only">
          Assign only
        </button>
        <button
          type="button"
          className="ai-btn ai-btn-sm ai-btn-primary"
          onClick={() => onDone(true)}
          data-testid="assign-confirm"
        >
          Assign & start
        </button>
      </div>
    </div>
  );
}
