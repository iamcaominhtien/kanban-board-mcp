import type { ReactNode } from 'react';
import type { AiTeam, AiTeamRole, RoleActivity } from '../../types/ai';
import { ago, fmtElapsed, secondsSince } from '../ai/aiUi';
import { roleLook } from '../ai/roleLook';
import { ContextMeter } from '../assist/ContextMeter';
import { openRun } from './runLink';
import { Badge, StateChip, TicketChip } from './teamUi';

const modelLine = (model: string | null, effort: string | null, fallback = 'Team default') =>
  [model, effort].filter(Boolean).join(' · ') || fallback;

interface CardProps {
  name: string;
  /** A short line under the name: the model and effort. */
  sub: string;
  badge: ReactNode;
  activity: RoleActivity;
  /** The lead's card shows how full its conversation is. */
  meter?: boolean;
  /** The whole team is paused or cannot start: an idle card says so instead of "Idle". */
  blocked?: string | null;
  onOpenTicket: (ticketId: string) => void;
  testId: string;
}

function Card({ name, sub, badge, activity, meter, blocked, onOpenTicket, testId }: CardProps) {
  const { working, lastWorked: last } = activity;
  const open = working?.runId ?? last?.runId ?? null;
  return (
    <div className="at-card" data-testid={testId} data-state={working ? 'working' : 'idle'}>
      <div className="at-card-head">
        {badge}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="at-card-name" title={name}>
            {name}
          </div>
          <div className="at-hint-sm">{sub}</div>
        </div>
        {working ? (
          <StateChip state={working.state === 'needs_input' ? 'waiting' : 'working'} />
        ) : blocked ? (
          <StateChip state="paused" label={blocked} />
        ) : (
          <StateChip state="idle" />
        )}
      </div>
      <div className="at-card-body">
        {working ? (
          <>
            <div>
              On {working.ticketId && <TicketChip id={working.ticketId} onOpen={onOpenTicket} />}{' '}
              <b>{working.ticketTitle ?? ''}</b>
            </div>
            <div className="at-step" style={{ color: '#3A4A3E' }} title={working.step?.title} data-testid="role-step">
              {working.step ? working.step.title : 'Starting…'}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="at-hint-sm">
                {fmtElapsed(secondsSince(working.since))} so far · run #{working.number}
              </span>
              {meter && working.contextUsed != null && working.contextWindow ? (
                <ContextMeter used={working.contextUsed} size={working.contextWindow} inline />
              ) : null}
            </div>
          </>
        ) : last ? (
          <>
            <div>
              Last worked {ago(last.at)}
              {last.ticketId && (
                <>
                  {' on '}
                  <TicketChip id={last.ticketId} onOpen={onOpenTicket} />
                </>
              )}
            </div>
            {last.text && <div className="at-quote">“{last.text}”</div>}
          </>
        ) : (
          <div className="at-hint">Has not worked yet.</div>
        )}
      </div>
      <div className="at-card-foot">
        <div style={{ flex: 1, minWidth: 0, fontSize: 12 }} data-testid="role-today">
          <div className="at-label">Today</div>
          {activity.stepsToday} step{activity.stepsToday === 1 ? '' : 's'} · {activity.runsToday} run
          {activity.runsToday === 1 ? '' : 's'}
        </div>
        {open && (
          <button type="button" className="st-btn st-btn-sm" onClick={() => openRun(open)}>
            Open run
          </button>
        )}
      </div>
    </div>
  );
}

/** The card of the team's lead: it runs the ticket and calls the roles. */
export function LeadCard({
  team,
  activity,
  onOpenTicket,
}: {
  team: AiTeam;
  activity: RoleActivity;
  onOpenTicket: (id: string) => void;
}) {
  return (
    <Card
      testId="lead-card"
      name={`${team.name} · lead`}
      sub={modelLine(team.model, team.effort)}
      badge={<Badge name={team.name} color={team.color} role="lead" size={36} />}
      activity={activity}
      meter
      blocked={team.paused ? 'Paused' : null}
      onOpenTicket={onOpenTicket}
    />
  );
}

/** The card of one role of the team: a subagent the lead calls. Runs and steps, never money. */
export function RoleCard({
  role,
  activity,
  team,
  onOpenTicket,
}: {
  role: AiTeamRole;
  activity: RoleActivity;
  team: AiTeam;
  onOpenTicket: (id: string) => void;
}) {
  const look = roleLook(role.key);
  return (
    <Card
      testId={`role-card-${role.key}`}
      name={role.name ?? role.key}
      sub={modelLine(role.model, role.effort, modelLine(team.model, team.effort))}
      badge={<Badge name={role.name ?? role.key} color={look.border} role={role.key} size={36} />}
      activity={activity}
      blocked={team.paused ? 'Paused' : null}
      onOpenTicket={onOpenTicket}
    />
  );
}
