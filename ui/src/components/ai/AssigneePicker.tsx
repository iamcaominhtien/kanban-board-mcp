import { useEffect, useRef, useState } from 'react';
import { aiApi, useAiMutation } from '../../api/ai';
import { assistApi, assistError } from '../../api/assist';
import { extractError } from '../../api/extractError';
import type { Member, Ticket } from '../../types';
import type { AiMember } from '../../types/ai';
import { MemberAvatar } from '../MemberAvatar';
import { useToast } from '../Toast';
import { useSchedules } from '../schedules/SchedulesContext';
import { currentPerson } from '../assist/assistUi';
import { ASSIGN_AI_EVENT } from './AiTicketContext';
import { ACTIVE_RUN_STATES, AiAvatar, StatusLabel, useAiBoardState } from './aiUi';

/** Why an AI member cannot take work now (the picker greys it out), or a note on how it will start. */
function aiNote(m: AiMember): { disabled: boolean; note: string; tag?: string; grey?: boolean } {
  switch (m.status.code) {
    case 'running':
      return { disabled: false, note: `· ${m.slotsInUse} of ${m.maxParallel} slots` };
    case 'runner_missing':
      // greyed, with its label on the right; it can still be picked: the ticket waits in its queue
      return { disabled: false, note: '', tag: 'offline', grey: true };
    case 'key_invalid':
      return { disabled: true, note: '', tag: 'key invalid' };
    case 'not_logged_in':
      return { disabled: true, note: '', tag: 'signed out' };
    case 'model_retired':
      return { disabled: true, note: '· fix in AI members' };
    case 'over_budget':
      return { disabled: true, note: '· resets 00:00' };
    case 'paused':
      return { disabled: true, note: '· resume in AI members' };
    case 'paused_all':
      return { disabled: true, note: '· AI is paused' };
    default:
      return { disabled: false, note: '' };
  }
}

/**
 * Assignee picker with a separate AI group (live status, reasons for disabled members). Picking an AI asks how
 * to start: now, queue, or assign without running.
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
  onPickPerson: (id: string | null) => void;
  onAssignedAi: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [pending, setPending] = useState<AiMember | null>(null);
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
        <div className="ai-muted" style={{ marginTop: 3 }}>
          {aiMap.get(current.id)!.connection === 'local'
            ? 'Local runner · Not metered'
            : aiMap.get(current.id)!.connection === 'api_key'
              ? 'API key · metered'
              : 'Inbox only'}
        </div>
      )}
      {open && !pending && (
        <div className="ai-popover" style={{ right: 0, top: 30, width: 330, padding: 8 }} data-testid="assignee-menu">
          <input
            className="ai-input"
            placeholder="Search people and AI…"
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
                {m.id === value && <span style={{ marginLeft: m.name === me ? 8 : 'auto', color: '#2E6F40' }}>✓</span>}
              </button>
            ))}
            {ais.length > 0 && (
              <div className="ai-label" style={{ padding: '8px 10px 4px' }}>
                AI · {ais.length}
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
                  <AiAvatar provider={m.provider} color={m.color} glyph={m.glyph} size={22} />
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
                  {m.id === value && <span style={{ marginLeft: 'auto', color: '#2E6F40' }}>✓</span>}
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
          onDone={() => {
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

/** On assign: how to start (A2). */
export function AssignStartPopover({
  ticket,
  member,
  onDone,
  onCancel,
}: {
  ticket: Ticket;
  member: AiMember;
  onDone: () => void;
  onCancel: () => void;
}) {
  const inbox = member.connection === 'inbox';
  const free = member.maxParallel - member.slotsInUse;
  const { runsByTicket } = useAiBoardState();
  // Another AI holds this ticket: this one can only queue behind it (design H1)
  const held = runsByTicket.get(ticket.id);
  const heldBy =
    held && held.mode === 'work' && ACTIVE_RUN_STATES.includes(held.state) && held.memberId !== member.id
      ? held
      : undefined;
  const busyWith = member.running.find((r) => r.state === 'running' || r.state === 'starting');
  const [start, setStart] = useState<'now' | 'queue' | 'schedule' | 'plan' | 'none'>(
    inbox ? 'none' : free > 0 && !heldBy ? 'now' : 'queue',
  );
  const { openEditor } = useSchedules();
  const [ctx, setCtx] = useState(true);
  const [instruction, setInstruction] = useState('');
  const toast = useToast();
  const assign = useAiMutation(() =>
    aiApi.assign(ticket.id, {
      memberId: member.id,
      // Scheduling assigns first; the editor then picks the time
      start: start === 'schedule' || start === 'plan' ? 'none' : start,
      includeContext: ctx,
      instruction,
    }),
  );
  const criteria = ticket.acceptanceCriteria?.length ?? 0;
  const comments = ticket.comments?.length ?? 0;
  const options: {
    id: 'now' | 'queue' | 'schedule' | 'plan' | 'none';
    title: string;
    sub: string;
    isNew?: boolean;
    chip?: string;
    disabled?: boolean;
  }[] = [
    {
      id: 'now',
      title: 'Start now',
      sub: heldBy
        ? `${heldBy.memberName} holds ${ticket.id} right now. Only one agent works on a ticket at a time.`
        : member.connection === 'local'
          ? `Launches a run in ${member.workingDir ?? 'its folder'} on this computer. ${Math.max(free, 0)} of ${member.maxParallel} slots free.`
          : `The board starts its agent loop. ${Math.max(free, 0)} of ${member.maxParallel} slots free.`,
      chip: !heldBy && free > 0 ? 'Starts in a few seconds' : undefined,
      disabled: !!heldBy,
    },
    {
      id: 'queue',
      title: 'Queue',
      sub: heldBy
        ? `Waits for ${heldBy.memberName} to release ${ticket.id}, then takes the ticket. Next in line.`
        : `Waits for a free slot or the runner. Position #${member.queued + 1}${busyWith ? ` behind ${busyWith.ticketId}` : ''}.`,
    },
    ...(ticket.parentId
      ? []
      : [
          {
            id: 'plan' as const,
            title: 'Plan sub-tickets',
            sub: 'Drafts sub-tickets for this ticket to accept or discard. Nothing is created until you accept.',
          },
        ]),
    {
      id: 'schedule',
      title: 'Schedule…',
      sub: 'Pick a date and time, done criteria and review.',
      isNew: true,
    },
    {
      id: 'none',
      title: 'Assign without running',
      sub: 'Only sets the assignee. Start a run later from the Run button.',
    },
  ];
  return (
    <div className="ai-popover" style={{ right: 0, top: 30 }} data-testid="assign-start-popover">
      <div style={{ fontSize: 13.5, fontWeight: 700 }}>
        Assign {ticket.id} to {member.name}
      </div>
      <div className="ai-muted" style={{ marginBottom: 10 }}>
        {ticket.title}
      </div>
      {inbox ? (
        <div className="ai-notice ai-notice-info">
          {member.name} connects through MCP: it sees the ticket in its inbox the next time it reads its tickets. The
          board cannot start it.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              className={`ai-option ${start === o.id ? 'ai-option-active' : ''}`}
              disabled={o.disabled}
              style={o.disabled ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}
              onClick={() => setStart(o.id)}
              data-testid={`assign-${o.id}`}
            >
              <span className={`ai-radio ${start === o.id ? 'ai-radio-on' : ''}`} />
              <span>
                <b style={{ fontSize: 12.5 }}>{o.title}</b>
                {o.isNew && (
                  <span className="sc-new" style={{ marginLeft: 6 }}>
                    NEW
                  </span>
                )}
                <div className="ai-muted">{o.sub}</div>
                {o.chip && (
                  <span
                    className="ai-chip"
                    style={{ marginTop: 4, height: 18, background: '#F1F8F3', color: '#2E6F40' }}
                    data-testid="starts-soon"
                  >
                    {o.chip}
                  </span>
                )}
              </span>
            </button>
          ))}
          {start !== 'none' && start !== 'schedule' && start !== 'plan' && (
            <>
              <label style={{ display: 'flex', gap: 8, fontSize: 12.5, alignItems: 'center', marginTop: 4 }}>
                <input type="checkbox" checked={ctx} onChange={(e) => setCtx(e.target.checked)} />
                Send the ticket, {criteria} criteria and {comments} comments as context
              </label>
              <input
                className="ai-input"
                placeholder="Extra instruction (optional)"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
              />
            </>
          )}
          <div className="ai-muted">
            Ticket text is untrusted input for the agent. Permission: up to{' '}
            {member.ceiling === 'in-progress'
              ? 'In Progress'
              : member.ceiling[0].toUpperCase() + member.ceiling.slice(1)}
            .
          </div>
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button type="button" className="ai-btn ai-btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="ai-btn ai-btn-sm ai-btn-primary"
          disabled={assign.isPending}
          onClick={async () => {
            try {
              await assign.mutateAsync(undefined);
              if (start === 'plan')
                await assistApi.startDraft(ticket.projectId, { kind: 'split', ticketId: ticket.id });
              onDone();
              if (start === 'schedule') openEditor({ ticketId: ticket.id, memberId: member.id });
            } catch (err) {
              toast.error("Couldn't assign", assistError(err)?.detail ?? extractError(err));
            }
          }}
          data-testid="assign-confirm"
        >
          {start === 'none' || inbox
            ? 'Assign'
            : start === 'schedule'
              ? 'Assign & schedule…'
              : start === 'plan'
                ? 'Assign & plan'
                : 'Assign & start'}
        </button>
      </div>
    </div>
  );
}
