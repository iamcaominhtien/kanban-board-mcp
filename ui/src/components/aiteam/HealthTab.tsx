import { useState } from 'react';
import { MenuSelect } from '../ui/MenuSelect';
import {
  useHealth,
  type Health,
  type HealthFix,
  type HealthRange,
  type TeamHealth,
  type Verdict,
} from '../../api/aiHealth';
import { LoadError } from '../ai/aiUi';
import { openRun } from './runLink';
import { openSettingsAt } from './settingsLink';
import { deltaOf, fmtShort, fmtTokens, fmtUsd, type Delta } from './teamFormat';
import { CalendarIcon, ICONS, Icon, TicketChip } from './teamUi';
import './touches.css';

const V: Record<Verdict, { bg: string; fg: string; label: string }> = {
  good: { bg: '#E6F2EA', fg: '#1F5A31', label: 'Good' },
  watch: { bg: '#FEF3D9', fg: '#7A5A06', label: 'Watch' },
  fix: { bg: '#FDECE8', fg: '#A5321E', label: 'Fix' },
};
const RANGES: { value: HealthRange; label: string }[] = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
];

export interface HealthActions {
  onOpenTicket: (ticketId: string) => void;
  /** Open a team's page (its caps and roles). */
  onOpenTeam: (teamId: string) => void;
  /** Open another tab of AI Team (the avoidable touches, Memory). */
  onOpenTab: (tab: 'memory' | 'stepped', mark?: 'avoidable') => void;
}

function VerdictChip({ v }: { v: Verdict | null }) {
  if (!v) return null;
  return (
    <span className="at-chip" style={{ background: V[v].bg, color: V[v].fg }}>
      {V[v].label}
    </span>
  );
}

function Tile({
  name,
  verdict,
  value,
  delta,
  hint,
}: {
  name: string;
  verdict: Verdict | null;
  value: string;
  delta: Delta | null;
  hint: string;
}) {
  const color = !delta || delta.better === null ? '#5B6B60' : delta.better ? '#2E6F40' : '#C4432A';
  return (
    <div className="at-measure" data-testid={`measure-${name.toLowerCase()}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="at-label" style={{ flex: 1, fontSize: 11 }}>
          {name}
        </span>
        <VerdictChip v={verdict} />
      </div>
      <span className="at-measure-n">{value}</span>
      {delta && <div style={{ fontSize: 12, fontWeight: 700, color }}>{delta.text}</div>}
      <div className="at-hint-sm">{hint}</div>
    </div>
  );
}

function Fix({ n, f, actions }: { n: number; f: HealthFix; actions: HealthActions }) {
  const a = f.action;
  const go = () => {
    if (a.type === 'setting') openSettingsAt({ page: a.page, setting: a.setting });
    else if (a.type === 'run') openRun(a.runId);
    else if (a.type === 'team') actions.onOpenTeam(a.teamId);
    else if (a.type === 'ticket') actions.onOpenTicket(a.ticketId);
    else actions.onOpenTab(a.tab, a.mark);
  };
  return (
    <div className="at-fix" data-testid="health-fix">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="at-num">{n}</span>
        <b style={{ fontSize: 14, flex: 1 }}>{f.title}</b>
        <span className="at-chip" style={{ background: V[f.severity].bg, color: V[f.severity].fg }}>
          {V[f.severity].label}
        </span>
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>
        <span className="at-label">Evidence</span> {f.evidence}{' '}
        {f.tickets.map((t) => (
          <span key={t} style={{ marginRight: 4 }}>
            <TicketChip id={t} onOpen={actions.onOpenTicket} />
          </span>
        ))}
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>
        <span className="at-label" style={{ color: '#2E6F40' }}>
          Suggestion
        </span>{' '}
        {f.suggestion}
      </div>
      <div className="at-actions">
        <button type="button" className="st-btn st-btn-primary st-btn-sm" onClick={go} data-testid="health-fix-action">
          {a.label}
        </button>
        {f.runId && a.type !== 'run' && (
          <button type="button" className="st-btn st-btn-sm" onClick={() => openRun(f.runId as string)}>
            Open a run
          </button>
        )}
      </div>
    </div>
  );
}

/** 85%, 69.6%: a decimal only when rounding would hide which side of a limit it is on. */
const pct = (v: number | null) =>
  v == null ? '–' : `${Math.round(v * 1000) % 10 === 0 ? Math.round(v * 100) : Math.round(v * 1000) / 10}%`;
const pts = (cur: number | null, prev: number | null) => (cur == null || prev == null ? null : (cur - prev) * 100);

function Row({ t, onOpenTeam }: { t: TeamHealth; onOpenTeam: (id: string) => void }) {
  const m = t.measures;
  const cost =
    m.cost.pricedRuns > 0
      ? `${fmtUsd(m.cost.usd)}${m.cost.perRun != null ? ` · ${fmtUsd(m.cost.perRun)}/run` : ''}`
      : m.cost.tokens
        ? `${fmtTokens(m.cost.tokens)} tokens`
        : '–';
  return (
    <div className="hl-grid" data-testid="health-team-row">
      <span>
        <button type="button" className="ai-link" onClick={() => onOpenTeam(t.id)}>
          <b>{t.name}</b>
        </button>
        {t.paused && <span className="hl-sub">paused</span>}
      </span>
      <span>{t.runs}</span>
      <span>
        <b>{pct(m.reliability.value)}</b>
        <span className="hl-sub">
          {m.reliability.ok} of {m.reliability.ended}
        </span>
      </span>
      <span>
        <b>{m.autonomy.value ?? '–'}</b>
        <span className="hl-sub">touches / ticket</span>
      </span>
      <span>
        <b>{fmtShort(m.speed.runMedianS)}</b>
        <span className="hl-sub">to Review {fmtShort(m.speed.toReviewMedianS)}</span>
      </span>
      <span>
        <b>{pct(m.quality.value)}</b>
        <span className="hl-sub">
          {m.quality.reopened} of {m.quality.finishedTickets} reopened
        </span>
      </span>
      <span>
        {cost}
        {m.cost.monthShare != null && (
          <span className="hl-sub">{Math.round(m.cost.monthShare * 100)}% of the monthly cap</span>
        )}
      </span>
      <span style={{ textAlign: 'right' }}>
        {t.status === 'idle' ? (
          <span className="at-hint-sm">No runs</span>
        ) : t.status === 'too_few' ? (
          <span className="at-chip" style={{ background: '#E8F1FA', color: '#244E78' }}>
            Too few runs to judge
          </span>
        ) : (
          <span
            className="at-chip"
            style={
              t.status === 'healthy'
                ? { background: '#E6F2EA', color: '#1F5A31' }
                : { background: V[t.status].bg, color: V[t.status].fg }
            }
          >
            {t.status === 'healthy' ? 'Healthy' : V[t.status].label}
          </span>
        )}
      </span>
    </div>
  );
}

/** Health: is the AI team healthy? A verdict in words, five measures, a row per team and what to fix. */
export function HealthTab({ projectId, actions }: { projectId: string; actions: HealthActions }) {
  const [range, setRange] = useState<HealthRange>('7d');
  const q = useHealth(projectId, range);
  const h: Health | undefined = q.data;
  if (!h) {
    return q.isError ? (
      <LoadError what="the health page" error={q.error} onRetry={() => void q.refetch()} />
    ) : (
      <span className="ai-spin" />
    );
  }
  const m = h.measures;
  const p = h.previous;
  const unknown = h.state === 'unknown';
  const bannerClass = h.state === 'good' ? 'good' : h.state === 'fix' ? 'fix' : unknown ? 'unknown' : '';
  const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const noTeams = !h.hasTeams;
  const title = noTeams
    ? 'No AI team in this project'
    : h.runs === 0
      ? `No AI work between ${day(h.since)} and ${day(h.until)}`
      : h.title;
  const text = noTeams ? 'Add a team to see how it works. Start with a ready-made one.' : h.text;
  const hasPrev = p.runs > 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 24 }} data-testid="at-health">
      <div
        className={`at-banner ${bannerClass}`}
        data-testid="health-banner"
        data-state={noTeams ? 'no-team' : h.state}
      >
        <span
          className="at-banner-ico"
          style={{
            borderColor:
              h.state === 'good' ? '#2E6F40' : h.state === 'fix' ? '#C4432A' : unknown ? '#C9DDF0' : undefined,
          }}
        >
          {unknown ? (
            <Icon color="#244E78" size={22}>
              {ICONS.info}
            </Icon>
          ) : (
            <Icon color={h.state === 'good' ? '#2E6F40' : h.state === 'fix' ? '#C4432A' : '#B8860B'} size={22}>
              {h.state === 'good' ? ICONS.check : <path d="M12 4l9 16H3L12 4zM12 10v4M12 17v.5" />}
            </Icon>
          )}
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <b style={{ fontSize: 18, color: unknown ? '#244E78' : undefined }}>{title}</b>
            {h.runs > 0 && (
              <span className="at-hint">
                {h.runs} runs on {h.tickets} tickets · {day(h.since)} to {day(h.until)}
              </span>
            )}
          </div>
          <div style={{ fontSize: 13.5, lineHeight: 1.55, marginTop: 3 }} data-testid="health-text">
            {text}
          </div>
        </div>
        {h.runs === 0 && h.hasTeams && range !== '30d' && (
          <button type="button" className="st-btn st-btn-sm" onClick={() => setRange('30d')} data-testid="health-widen">
            Widen to 30 days
          </button>
        )}
        {h.canJudge && (
          <span className="at-chip" style={{ background: '#E6F2EA', color: '#1F5A31' }}>
            {h.counts.good} good · {h.counts.watch} watch · {h.counts.fix} fix
          </span>
        )}
        <MenuSelect<HealthRange>
          variant="button"
          label="Range"
          icon={<CalendarIcon />}
          testId="health-range"
          value={range}
          options={RANGES}
          onChange={setRange}
        />
      </div>

      <div className="at-measures">
        <Tile
          name="Reliability"
          verdict={m.reliability.verdict}
          value={pct(m.reliability.value)}
          delta={hasPrev ? deltaOf('pts', pts(m.reliability.value, p.reliability), 'up') : null}
          hint={`runs that finished OK: ${m.reliability.ok} of ${m.reliability.ended}. Failed, timed out and cancelled count against`}
        />
        <Tile
          name="Autonomy"
          verdict={m.autonomy.verdict}
          value={m.autonomy.value == null ? '–' : `${m.autonomy.value}`}
          delta={null}
          hint={`touches per ticket: ${m.autonomy.touches} on ${m.autonomy.tickets} tickets. ${m.autonomy.clean} tickets with no touch at all`}
        />
        <Tile
          name="Speed"
          verdict={null}
          value={fmtShort(m.speed.runMedianS)}
          delta={
            hasPrev && p.runMedianS != null && m.speed.runMedianS != null
              ? deltaOf('seconds', m.speed.runMedianS - p.runMedianS, 'down')
              : null
          }
          hint={`median run. Assignment to Review: ${fmtShort(m.speed.toReviewMedianS)} (${m.speed.toReviewTickets} tickets)`}
        />
        <Tile
          name="Quality"
          verdict={m.quality.verdict}
          value={pct(m.quality.value)}
          delta={hasPrev ? deltaOf('pts', pts(m.quality.value, p.quality), 'down') : null}
          hint={`finished work sent back: ${m.quality.reopened} of ${m.quality.finishedTickets} tickets reopened${
            m.quality.findings != null ? `. Reviewer findings: ${m.quality.findings}` : ''
          }`}
        />
        <Tile
          name="Cost"
          verdict={m.cost.verdict}
          value={m.cost.pricedRuns > 0 || !m.cost.tokens ? fmtUsd(m.cost.usd) : `${fmtTokens(m.cost.tokens)} tokens`}
          delta={hasPrev ? deltaOf('usd', m.cost.usd - p.usd, 'down') : null}
          hint={`${m.cost.perRun != null ? `${fmtUsd(m.cost.perRun)} per run, ` : ''}${fmtTokens(m.cost.tokensPerRun ?? 0)} tokens per run${
            m.cost.tokensOnlyRuns ? `. ${m.cost.tokensOnlyRuns} runs report tokens only` : ''
          }${m.cost.runsOverCap ? `. ${m.cost.runsOverCap} over the cap of one run` : ''}`}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center' }}>
        <b style={{ fontSize: 14, flex: 1 }}>Each team</b>
        <span className="at-hint">
          One row per team: cost exists per run, not per role. Where no price is reported, tokens show, never $0
        </span>
      </div>
      <div className="hl-table" data-testid="health-per-team">
        <div className="hl-grid head">
          {['Team', 'Runs', 'Finished OK', 'Autonomy', 'Run · to Review', 'Sent back', 'Cost', ''].map((c) => (
            <span key={c || 'status'} className="at-label" style={{ fontSize: 11 }}>
              {c}
            </span>
          ))}
        </div>
        {h.teams.length === 0 ? (
          <div className="at-hint" style={{ padding: 16 }}>
            {noTeams ? 'No team yet.' : 'No team ran in this range.'}
          </div>
        ) : (
          h.teams.map((t) => <Row key={t.id} t={t} onOpenTeam={actions.onOpenTeam} />)
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center' }}>
        <b style={{ fontSize: 14, flex: 1 }}>What to fix · {h.fixes.length}</b>
        <span className="at-hint">Worked out from rules, at most five. Nothing is changed for you</span>
      </div>
      {h.fixes.length === 0 ? (
        <div className="at-empty" data-testid="health-no-fixes">
          {h.canJudge
            ? 'Nothing to fix in this range.'
            : `What to fix waits for ${h.minRuns} runs in the range. A rule shows only with enough cases.`}
        </div>
      ) : (
        <div className="at-fixgrid">
          {h.fixes.map((f, i) => (
            <Fix key={f.id} n={i + 1} f={f} actions={actions} />
          ))}
        </div>
      )}
      <div className="at-hint-sm">
        Thresholds: reliability 85% good, 70% watch · autonomy under 1 touch per ticket good, over 2 fix · quality under
        10% reopened good, over 20% fix · cost under 70% of the monthly cap good, over 90% fix. Speed has no verdict.
        Under {h.minRuns} runs the numbers show without a verdict.
      </div>
    </div>
  );
}
