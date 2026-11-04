import type { ReactNode } from 'react';
import { aiApi, useAiMutation } from '../../api/ai';
import { extractError } from '../../api/extractError';
import type { CardMemory } from '../../types/aiResources';
import type { NeedsItem, TeamCard, TeamNow, TeamRange } from '../../types/aiTeam';
import { useToast } from '../Toast';
import { Badge, ICONS, Icon, Spark, STATE_ORDER, StateChip, TicketChip, stateLine } from './teamUi';
import { AUTO_RESTARTS, LEVEL_COLOR, fmtMb, levelOf, limitPct } from './resourcesFormat';
import { fmtAgo, fmtClock, fmtDuration, fmtUsd, usageText } from './teamFormat';

export interface NowActions {
  onOpenTicket: (ticketId: string) => void;
  onOpenMember: (memberId: string) => void;
  onSeeResources: () => void;
}

const RANGE_LABEL: Record<TeamRange, { head: string; runs: string; spent: string }> = {
  today: { head: 'Today', runs: 'Runs today', spent: 'Spent today' },
  '7d': { head: 'Last 7 days', runs: 'Runs, last 7 days', spent: 'Spent, last 7 days' },
  '30d': { head: 'Last 30 days', runs: 'Runs, last 30 days', spent: 'Spent, last 30 days' },
};

const OFFLINE_TEXT: Record<string, string> = {
  not_logged_in: 'Not logged in to the local runner',
  key_invalid: 'The API key is not accepted',
  runner_missing: 'The local runner was not found',
  model_retired: 'The model is retired',
};

const LAST_VERB: Record<string, string> = {
  finished: 'finished',
  failed: 'failed',
  timed_out: 'timed out on',
  cancelled: 'was stopped on',
};

function Tickets({ ids, onOpen }: { ids: string[]; onOpen: (id: string) => void }) {
  return (
    <>
      {ids.map((id, i) => (
        <span key={id}>
          {i > 0 ? ', ' : ''}
          <TicketChip id={id} onOpen={onOpen} />
        </span>
      ))}
    </>
  );
}

function NeedCard({ item, actions }: { item: NeedsItem; actions: NowActions }) {
  const toast = useToast();
  const retry = useAiMutation((runId: string) => aiApi.retry(runId));
  const dismiss = useAiMutation((runId: string) => aiApi.dismissStop(runId));
  const wait = item.waitingS != null ? `waiting ${fmtDuration(item.waitingS)}` : '';
  const who = item.memberName ?? 'An AI';
  const open = actions.onOpenTicket;
  const ticket = item.ticketId ? <TicketChip id={item.ticketId} onOpen={open} /> : null;

  let icon: ReactNode = ICONS.question;
  let red = false;
  let title: string;
  let body: ReactNode;
  let hint: string;
  let buttons: ReactNode;
  switch (item.kind) {
    case 'question':
      title = `${who} asks a question`;
      body = (
        <>
          <b>{who}</b> on {ticket} “{item.text}”
        </>
      );
      hint = `${wait} · blocks ${item.ticketId}`;
      buttons = (
        <button type="button" className="st-btn st-btn-primary st-btn-sm" onClick={() => open(item.ticketId!)}>
          Answer
        </button>
      );
      break;
    case 'offline':
      icon = ICONS.plug;
      red = true;
      title = `${who} is offline`;
      body = (
        <>
          <b>{who}</b>: {item.text}
          {item.since ? ` (since ${fmtClock(item.since)})` : ''}.
        </>
      );
      hint = `offline ${fmtDuration(item.waitingS)} · ${item.ticketsWaiting.length} ticket${item.ticketsWaiting.length === 1 ? '' : 's'} waiting`;
      buttons = (
        <button
          type="button"
          className="st-btn st-btn-primary st-btn-sm"
          onClick={() => actions.onOpenMember(item.memberId)}
        >
          Fix connection
        </button>
      );
      break;
    case 'memory_stop':
      icon = ICONS.plug;
      red = true;
      title = `${who}’s run was stopped: memory`;
      body = (
        <>
          <b>{who}</b> on {ticket}: the CLI went over {item.limitMb ? `its ${fmtMb(item.limitMb)}` : 'the memory'} limit
          again after {AUTO_RESTARTS} restarts{item.peakRssMb ? ` (peak ${fmtMb(item.peakRssMb)})` : ''}. Partial work
          in the folder is kept.
        </>
      );
      hint = `stopped ${fmtDuration(item.waitingS)} ago · the ticket stays assigned to ${who}`;
      buttons = (
        <>
          <button
            type="button"
            className="st-btn st-btn-primary st-btn-sm"
            disabled={retry.isPending}
            onClick={() => retry.mutate(item.runId, { onError: (e) => toast.error("Couldn't retry", extractError(e)) })}
          >
            Retry
          </button>
          <button type="button" className="st-btn st-btn-sm" onClick={() => open(item.ticketId!)}>
            Open run
          </button>
          <button type="button" className="st-btn st-btn-sm" onClick={actions.onSeeResources}>
            See resources
          </button>
          <button
            type="button"
            className="st-btn st-btn-sm"
            disabled={dismiss.isPending}
            onClick={() =>
              dismiss.mutate(item.runId, { onError: (e) => toast.error("Couldn't dismiss it", extractError(e)) })
            }
          >
            Dismiss
          </button>
        </>
      );
      break;
  }
  return (
    <div className="at-need" data-testid={`needs-${item.kind}`}>
      <div className="at-need-head">
        <span className={`at-need-ico${red ? ' red' : ''}`}>
          <Icon color={red ? '#C4432A' : '#B8860B'}>{icon}</Icon>
        </span>
        <b>{title}</b>
      </div>
      <div className="at-need-body">{body}</div>
      <div className="at-hint-sm">{hint}</div>
      <div className="at-actions">{buttons}</div>
    </div>
  );
}

/** The RAM and CPU chip on a working AI's card (design/screens/ai-resources.md, C1). */
function MemoryChip({ memory, onOpen }: { memory: CardMemory; onOpen: () => void }) {
  if (!memory.readable || memory.cliRssMb == null) return null;
  const pct = limitPct(memory.cliRssMb, memory.limitMb);
  const level = levelOf(pct);
  const look = { ok: '#E6F2EA', warn: '#FEF3D9', bad: '#FDF3F0' }[level];
  const title = [
    `CLI ${fmtMb(memory.cliRssMb)}${memory.limitMb > 0 ? ` of ${fmtMb(memory.limitMb)} (${pct}%)` : ''}`,
    memory.peakRssMb != null ? `peak ${fmtMb(memory.peakRssMb)}` : null,
    memory.extraMb ? `+${fmtMb(memory.extraMb)} from what it started` : null,
    memory.restarts ? `${memory.restarts} restart${memory.restarts === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <button
        type="button"
        className="rs-chip"
        style={{ background: look, color: LEVEL_COLOR[level].text, border: 'none', cursor: 'pointer' }}
        title={title}
        onClick={onOpen}
      >
        <span className="rs-chip-bar">
          <i style={{ width: `${Math.min(100, pct)}%`, background: LEVEL_COLOR[level].bar }} />
        </span>
        RAM {fmtMb(memory.cliRssMb)}
        {memory.cpuPct != null && <span style={{ fontWeight: 500 }}>· CPU {Math.round(memory.cpuPct)}%</span>}
      </button>
      {memory.limitMb > 0 && level !== 'ok' && <span className="at-hint-sm">{pct}% of its limit</span>}
    </div>
  );
}

function MemberCard({ card, range, actions }: { card: TeamCard; range: TeamRange; actions: NowActions }) {
  const toast = useToast();
  const pause = useAiMutation((v: { runId: string; resume: boolean }) =>
    v.resume ? aiApi.resumeRun(v.runId) : aiApi.pauseRun(v.runId),
  );
  const { current, last, queued } = card;
  const open = actions.onOpenTicket;
  const apiKey = card.connection === 'api_key';
  const runnerText = `${card.model ?? card.providerLabel} · ${apiKey ? 'API key' : card.connection === 'inbox' ? 'MCP inbox' : 'local runner'}`;
  const u = card.usage;
  const budget = u.metered ? (u.dailyBudget ?? null) : null;
  const nearCap = budget != null && (u.costUsd ?? 0) >= budget * 0.8;
  const queuedIds = [...new Set([...queued.map((r) => r.ticketId), ...card.assigned])].filter(
    (id) => id !== current?.ticketId,
  );

  let body: ReactNode;
  if (card.state === 'offline') {
    body = (
      <>
        <div style={{ color: '#A5321E', fontWeight: 600 }}>{OFFLINE_TEXT[card.status.code] ?? card.status.label}</div>
        <div className="at-hint">
          {card.status.detail ? `${card.status.detail}. ` : ''}
          {queuedIds.length ? (
            <>
              Queued: <Tickets ids={queuedIds} onOpen={open} />.
            </>
          ) : (
            'Nothing is waiting for it.'
          )}
        </div>
        {last && (
          <div className="at-hint-sm">
            Last run {LAST_VERB[last.state]?.replace(/ on$/, '') ?? last.state} {fmtClock(last.endedAt)}
          </div>
        )}
      </>
    );
  } else if (current) {
    const asked = current.question;
    const limit = apiKey && current.limitMin ? current.limitMin : null;
    const elapsedMin = Math.round((current.elapsedS ?? 0) / 60);
    body = (
      <>
        <div>
          On <TicketChip id={current.ticketId} onOpen={open} /> <b>{current.ticketTitle}</b>
        </div>
        {asked ? (
          <>
            <div className="at-quote">“{asked.text}”</div>
            <div className="at-hint-sm">
              Asked{' '}
              {fmtAgo(Math.max(0, Math.round((Date.now() - new Date(asked.askedAt ?? Date.now()).getTime()) / 1000)))} ·
              run is paused, nothing is lost
            </div>
          </>
        ) : card.state === 'waiting' ? (
          <div className="at-hint">Waiting for your approval before it goes on.</div>
        ) : (
          <>
            {current.step && (
              <div style={{ color: '#3A4A3E' }}>
                Step {current.step.n}: {current.step.text}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {limit ? (
                <>
                  <div className="at-bar">
                    <i style={{ width: `${Math.min(100, (elapsedMin / limit) * 100)}%`, background: '#2E6F40' }} />
                  </div>
                  <span className="at-hint-sm" style={{ whiteSpace: 'nowrap' }}>
                    {elapsedMin} min of {limit}
                  </span>
                </>
              ) : (
                <span className="at-hint-sm">
                  {current.paused ? 'Paused · ' : ''}
                  {fmtDuration(current.elapsedS)} so far
                </span>
              )}
            </div>
            {current.memory && <MemoryChip memory={current.memory} onOpen={actions.onSeeResources} />}
            {queued[0] && (
              <div className="at-hint-sm">
                Next in line: <TicketChip id={queued[0].ticketId} onOpen={open} /> (queued behind this run)
              </div>
            )}
          </>
        )}
      </>
    );
  } else {
    body = (
      <>
        {card.state === 'queued' && queuedIds.length ? (
          <div>
            Queued: <Tickets ids={queuedIds} onOpen={open} />
          </div>
        ) : card.state === 'paused' ? (
          <>
            {card.pause?.project && !card.pause.own && !card.pause.cancelled && !queuedIds.length && (
              <div className="at-hint">Paused for the project.</div>
            )}
            {card.pause?.cancelled && (
              <div>
                On <TicketChip id={card.pause.cancelled.ticketId} onOpen={open} /> cancelled at step{' '}
                {card.pause.cancelled.step}
                {card.pause.cancelled.at ? ` (${fmtClock(card.pause.cancelled.at)})` : ''}.{' '}
                <span className="at-hint">Partial work is kept.</span>
              </div>
            )}
            {card.pause?.own && (
              <div className="at-hint">
                {card.pause.ownLabel || card.status.label}
                {card.pause.project ? '. Paused on its own, not only by the project: Resume will not start it.' : ''}
              </div>
            )}
            {!card.pause && <div className="at-hint">{card.status.detail || card.status.label}</div>}
            {card.pause?.project && queuedIds.length > 0 && (
              <div>
                Held: <Tickets ids={queuedIds} onOpen={open} />{' '}
                <span className="at-hint">{queuedIds.length === 1 ? 'starts' : 'start'} on resume</span>
              </div>
            )}
          </>
        ) : queuedIds.length ? (
          <div className="at-hint">
            Assigned: <Tickets ids={queuedIds} onOpen={open} />
          </div>
        ) : (
          <div className="at-hint">Nothing assigned.</div>
        )}
        {last && (
          <>
            <div>
              Last: {LAST_VERB[last.state] ?? last.state} <TicketChip id={last.ticketId} onOpen={open} />{' '}
              {last.summary ? <i>{last.summary.split('\n')[0].slice(0, 60)}</i> : null}
            </div>
            <div className="at-hint-sm">
              {fmtAgo(last.agoS)} · {usageText(last.usage, { verbose: true })}
            </div>
          </>
        )}
        {card.connectionUnknown && (
          <span className="at-chip" style={{ background: '#F1F3F1', color: '#5B6B60', width: 'max-content' }}>
            <Icon color="#5B6B60" size={11}>
              {ICONS.info}
            </Icon>
            Connection unknown
          </span>
        )}
      </>
    );
  }

  const lastRunTicket = last?.ticketId;
  return (
    <div className="at-card" data-testid={`team-card-${card.state}`}>
      <div className="at-card-head">
        <Badge name={card.name} color={card.color} role={card.role} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="at-card-name">{card.name}</div>
          <div className="at-hint-sm">{runnerText}</div>
        </div>
        <StateChip state={card.state} project={!!card.pause?.project && !card.pause.own} />
      </div>
      <div className="at-card-body">{body}</div>
      <div className="at-card-foot">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div className="at-label">{RANGE_LABEL[range].head}</div>
            <Spark values={card.spark} color={stateLine(card.state)} />
          </div>
          <div style={{ fontSize: 12 }}>
            {u.runs} run{u.runs === 1 ? '' : 's'} · {u.ok} ok
            {u.failed ? ` · ${u.failed} failed` : ''} ·{' '}
            {nearCap ? (
              <b style={{ color: '#A5321E' }}>
                {fmtUsd(u.costUsd ?? 0)} / {fmtUsd(budget!)}
              </b>
            ) : (
              <span title={u.tokensCached != null ? usageText({ ...u, costUsd: 0, metered: false }) : undefined}>
                {usageText(u)}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="at-actions">
        {card.state === 'offline' && (
          <button
            type="button"
            className="st-btn st-btn-primary st-btn-sm"
            onClick={() => actions.onOpenMember(card.id)}
          >
            Fix connection
          </button>
        )}
        {card.state === 'waiting' && current?.question && (
          <button type="button" className="st-btn st-btn-primary st-btn-sm" onClick={() => open(current.ticketId)}>
            Answer
          </button>
        )}
        {current ? (
          <button type="button" className="st-btn st-btn-sm" onClick={() => open(current.ticketId)}>
            Open run
          </button>
        ) : (
          lastRunTicket &&
          card.state !== 'offline' && (
            <button type="button" className="st-btn st-btn-sm" onClick={() => open(lastRunTicket)}>
              Open last run
            </button>
          )
        )}
        {current && card.state === 'working' && (
          <button
            type="button"
            className="st-btn st-btn-sm"
            disabled={pause.isPending}
            onClick={() =>
              pause.mutate(
                { runId: current.runId, resume: current.paused },
                { onError: (e) => toast.error("Couldn't change the run", extractError(e)) },
              )
            }
          >
            <Icon>{current.paused ? ICONS.play : ICONS.pause}</Icon>
            {current.paused ? 'Resume' : 'Pause'}
          </button>
        )}
      </div>
    </div>
  );
}

/** Now: what needs a person, a card per AI, and the totals (design/screens/ai-team.md, B). */
export function NowTab({ data, range, actions }: { data: TeamNow; range: TeamRange; actions: NowActions }) {
  const t = data.totals;
  const label = RANGE_LABEL[range];
  const cap = t.dailyCap;
  const working = data.counts.working ?? 0;
  const queued = data.counts.queued ?? 0;
  return (
    <>
      <div className="at-states">
        {STATE_ORDER.filter((s) => data.counts[s]).map((s) => {
          if (s !== 'paused' || !data.pausedAll) return <StateChip key={s} state={s} count={data.counts[s]} />;
          // While the project is paused, two kinds of paused: orange for the project, grey for the AI's own
          const own = data.members.filter((c) => c.state === 'paused' && c.pause?.own).length;
          const proj = (data.counts[s] ?? 0) - own;
          return (
            <span key={s} style={{ display: 'inline-flex', gap: 8 }}>
              {proj > 0 && <StateChip state="paused" project count={proj} />}
              {own > 0 && <StateChip state="paused" count={own} />}
            </span>
          );
        })}
        <span className="at-hint">{data.members.length} AI members</span>
        {data.pausedAll && (
          <span className="at-hint" data-testid="paused-legend">
            <b style={{ color: '#B4571F' }}>Orange</b>: paused for the whole project.{' '}
            <b style={{ color: '#5B6B60' }}>Grey</b>: paused on its own (budget, rate limit, or by a person).
          </span>
        )}
      </div>

      {data.needsYou.length > 0 && (
        <div id="at-needs-you">
          <div className="at-section-head">
            <b>Needs you · {data.needsYou.length}</b>
            <span className="at-hint">Oldest first. Each one is something an AI cannot continue without.</span>
          </div>
          <div className="at-needs">
            {data.needsYou.map((item) => (
              <NeedCard
                key={`${item.kind}-${'runId' in item ? item.runId : (item.ticketId ?? item.memberId)}`}
                item={item}
                actions={actions}
              />
            ))}
          </div>
        </div>
      )}

      {data.needsYou.length === 0 && (
        <div id="at-needs-you" data-testid="needs-you-empty">
          <div className="at-section-head">
            <b>Needs you · 0</b>
          </div>
          <div className="at-hint">
            Nothing is waiting on you.
            {working + queued > 0
              ? ` ${[
                  working ? `${working} ${working === 1 ? 'AI is' : 'AIs are'} working` : '',
                  queued ? `${queued} ${queued === 1 ? 'is' : 'are'} queued` : '',
                ]
                  .filter(Boolean)
                  .join(', ')}.`
              : ''}
          </div>
        </div>
      )}

      {data.members.length === 0 ? (
        <div className="at-empty">This project has no AI members yet. Add one in Members to see its work here.</div>
      ) : (
        <div className="at-cards">
          {data.members.map((c) => (
            <MemberCard key={c.id} card={c} range={range} actions={actions} />
          ))}
        </div>
      )}

      <div className="at-bottom">
        <div className="at-totals">
          <b style={{ fontSize: 13.5 }}>{range === 'today' ? 'Today so far' : label.head}</b>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div className="at-total">
              <div className="at-label">{label.runs}</div>
              <span className="at-total-n">{t.runs}</span>
              <div className="at-hint-sm">
                {t.ok} ok · {t.failed} failed · {t.running} running
              </div>
            </div>
            <div className="at-total">
              <div className="at-label">{label.spent}</div>
              <span className="at-total-n">{fmtUsd(t.spentUsd)}</span>
              <div className="at-hint-sm">
                {cap ? `of ${fmtUsd(cap)} daily cap for the team` : 'no daily cap for the team'}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
