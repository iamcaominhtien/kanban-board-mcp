import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Member, Ticket } from '../../types';
import type { AiTeam } from '../../types/ai';
import { MemberAvatar } from '../MemberAvatar';
import { currentPerson } from '../assist/assistUi';
import { ASSIGN_AI_EVENT } from './AiTicketContext';
import { ACTIVE_RUN_STATES, AiAvatar, StatusLabel, useAiBoardState } from './aiUi';
import { LineIcon } from '../ui/LineIcon';
import { FloatMenu } from './ComposerAi';

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
    case 'rate_limited':
      // still pickable: its runs wait in the queue
      return { disabled: false, note: '' };
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
  const trigger = useRef<HTMLButtonElement>(null);
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
      // the list is drawn in the page body (it must not be cut by the ticket's box): a click in it is not outside
      if ((e.target as HTMLElement).closest?.('.tw-menu')) return;
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
        ref={trigger}
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
        <FloatMenu anchor={trigger.current} onClose={() => setOpen(false)} width={330}>
          <div style={{ padding: 4 }} data-testid="assignee-menu">
            <div className="ai-label" style={{ padding: '4px 6px 6px' }}>
              Assignee
            </div>
            <div style={{ position: 'relative' }}>
              <input
                className="ai-input"
                style={{ paddingRight: 30 }}
                placeholder="Search people and teams…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                autoFocus
              />
              <span style={{ position: 'absolute', right: 10, top: 9, color: '#9AA8A0', display: 'flex' }}>
                <LineIcon name="search" size={14} />
              </span>
            </div>
            <div style={{ maxHeight: 'min(460px, 55vh)', overflow: 'auto', marginTop: 6 }}>
              <button
                type="button"
                className="ai-mi"
                onClick={() => {
                  onPickPerson(null);
                  setOpen(false);
                }}
              >
                <span
                  aria-hidden="true"
                  style={{ width: 22, height: 22, borderRadius: '50%', border: '1.5px dashed #C5CEC8', flexShrink: 0 }}
                />
                <span style={{ color: '#9AA8A0' }}>Unassigned</span>
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
                    <AiAvatar color={m.color} size={22} dim={n.disabled || n.grey} />
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
                      <span
                        className="ai-muted"
                        style={{
                          marginLeft: 'auto',
                          border: '1px solid #DCE3DE',
                          borderRadius: 4,
                          padding: '0 6px',
                          fontSize: 10.5,
                          lineHeight: '17px',
                          background: '#fff',
                        }}
                        data-testid="assign-ai-tag"
                      >
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
        </FloatMenu>
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

/** One of the two choices of the assign popover: a radio, a small icon tile, a title and one line. */
function ChoiceCard({
  on,
  title,
  line,
  icon,
  onPick,
  testId,
}: {
  on: boolean;
  title: string;
  line: string;
  icon: ReactNode;
  onPick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      tabIndex={on ? 0 : -1}
      onClick={onPick}
      data-testid={testId}
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        padding: '11px 13px',
        border: `1.5px solid ${on ? '#2E6F40' : '#DCE3DE'}`,
        borderRadius: 11,
        background: on ? '#F1F8F3' : '#fff',
        textAlign: 'left',
        font: 'inherit',
        color: 'inherit',
        cursor: 'pointer',
        width: '100%',
      }}
    >
      <span
        style={{
          width: 16,
          height: 16,
          borderRadius: '50%',
          border: `1.6px solid ${on ? '#2E6F40' : '#DCE3DE'}`,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: 'none',
        }}
      >
        {on && <i style={{ width: 8, height: 8, borderRadius: '50%', background: '#2E6F40', display: 'block' }} />}
      </span>
      <span
        style={{
          width: 30,
          height: 30,
          borderRadius: 8,
          background: on ? '#DCEEE1' : '#F1F3F1',
          color: on ? '#2E6F40' : '#5B6B60',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: 'none',
        }}
      >
        {icon}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13, fontWeight: 700 }}>{title}</span>
        <span style={{ display: 'block', fontSize: 12, color: '#5B6B60', lineHeight: 1.4 }}>{line}</span>
      </span>
    </button>
  );
}

const ICON_PROPS = {
  width: 15,
  height: 15,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

/**
 * Assign a team (A2): two choice cards, Start now (the server starts the lead when the assignee changes) or Assign
 * only (the team holds the ticket and starts when a person presses Run), and one button for the choice made.
 */
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
  const [start, setStart] = useState(true);
  const held = runsByTicket.get(ticket.id);
  const heldBy = held && ACTIVE_RUN_STATES.includes(held.state) && held.memberId !== member.id ? held : undefined;
  const heldByName = heldBy ? (members.get(heldBy.memberId)?.name ?? 'Another team') : null;
  const roles = member.roles.map((r) => r.name ?? r.key).join(', ');
  return (
    <div
      className="ai-popover"
      style={{ right: 0, top: 30, width: 420, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 11 }}
      data-testid="assign-start-popover"
    >
      <div style={{ display: 'flex', gap: 11, alignItems: 'center' }}>
        <AiAvatar color={member.color} size={36} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14.5, fontWeight: 700 }}>
            Assign {ticket.id} to {member.name}
          </div>
          <div
            style={{
              fontSize: 12,
              color: '#5B6B60',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {ticket.title}
          </div>
        </div>
      </div>
      <div
        role="radiogroup"
        aria-label="How to begin"
        style={{ display: 'flex', flexDirection: 'column', gap: 11 }}
        onKeyDown={(e) => {
          if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            e.preventDefault();
            setStart((v) => !v);
          }
        }}
      >
        <ChoiceCard
          on={start}
          onPick={() => setStart(true)}
          testId="assign-choice-start"
          title="Start now"
          line={`The lead begins at once${roles ? ` · ${roles}` : ''}`}
          icon={
            <svg {...ICON_PROPS} aria-hidden="true">
              <path d="M7 5L19 12L7 19Z" />
            </svg>
          }
        />
        <ChoiceCard
          on={!start}
          onPick={() => setStart(false)}
          testId="assign-choice-only"
          title="Assign only"
          line="The team is assigned and starts when you press Run"
          icon={
            <svg {...ICON_PROPS} aria-hidden="true">
              <path d="M9 3h6l-1 6 3 3H7l3-3z" />
              <path d="M12 12v9" />
            </svg>
          }
        />
      </div>
      {heldByName && (
        <div
          className="ai-notice ai-notice-warn"
          data-testid="assign-held-by"
          style={{ display: 'flex', gap: 8, alignItems: 'center' }}
        >
          <LineIcon name="warning" size={14} />
          <span>{heldByName} is working on it now. That run is cancelled.</span>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center', fontSize: 11, color: '#9AA8A0', flex: 1 }}>
          <LineIcon name="lock" size={11} />
          Ticket text is untrusted input for the agent.
        </span>
        <button type="button" className="ai-btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="ai-btn ai-btn-primary"
          onClick={() => onDone(start)}
          data-testid="assign-confirm"
        >
          {start ? 'Assign & start' : 'Assign'}
        </button>
      </div>
    </div>
  );
}
