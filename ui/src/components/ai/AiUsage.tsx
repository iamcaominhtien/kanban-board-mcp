import { useMemo, useState } from 'react';
import { aiApi, useAiMutation, useAiOverview } from '../../api/ai';
import {
  safetyApi,
  useBudgetAlerts,
  useUsageDashboard,
  type LimitRow,
  type Limits,
  type UsageDashboard,
} from '../../api/aiSafety';
import { extractError } from '../../api/extractError';
import { resolveOrigin } from '../../api/resolveOrigin';
import type { AiMember } from '../../types/ai';
import { useToast } from '../Toast';
import { AiAvatar, fmtElapsed } from './aiUi';
import { ChipChoice, Pill, RadioRow, SafetyCard, compact, dateTime, usd } from './aiSafetyUi';

const SERIES = ['#B4571F', '#B0446E', '#2F6FB0', '#6D5DD3', '#2E6F40', '#B4791E', '#5B6B60'];
const RANGES = [
  ['today', 'Today'],
  ['7d', '7 days'],
  ['month', 'Month'],
  ['custom', 'Custom'],
] as const;

function Meter({ used, cap }: { used: number; cap: number | null | undefined }) {
  const pct = cap ? Math.min(100, (used / cap) * 100) : 0;
  return (
    <div className={`ai-meter ${cap && used >= cap ? 'ai-meter-full' : pct >= 80 ? 'ai-meter-warn' : ''}`}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

function niceDate(iso: string) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Usage dashboard (C1), limits (C4), the cap policies (C5) and alerts (C3). */
export function UsageView({ projectId, members }: { projectId: string; members: AiMember[] }) {
  const [range, setRange] = useState<'today' | '7d' | 'month' | 'custom'>('month');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const dash = useUsageDashboard(
    projectId,
    range,
    range === 'custom' ? since : undefined,
    range === 'custom' ? until : undefined,
  );
  const alerts = useBudgetAlerts(projectId);
  const [prices, setPrices] = useState(false);
  const [editing, setEditing] = useState<LimitRow | 'board' | null>(null);
  const d = dash.data;
  if (dash.isError)
    return (
      <div className="ai-notice ai-notice-error">
        Couldn’t load usage.{' '}
        <button type="button" className="ai-link" onClick={() => void dash.refetch()}>
          Retry
        </button>
      </div>
    );
  if (!d) return <span className="ai-spin" />;
  const t = d.tiles;
  const q = new URLSearchParams({ range });
  if (range === 'custom') {
    if (since) q.set('since', since);
    if (until) q.set('until', until);
  }
  const monthWord = range === 'month' ? 'month' : range === 'today' ? 'today' : range === '7d' ? '7 days' : 'range';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }} data-testid="ai-usage">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <b style={{ fontSize: 16 }}>AI usage</b>
          <div className="ai-muted">
            {niceDate(d.range.since)} – {niceDate(d.range.until)} · resets 00:00 local time
          </div>
        </div>
        <ChipChoice value={range} options={RANGES} onChange={setRange} />
        {range === 'custom' && (
          <>
            <input
              className="ai-input"
              type="date"
              style={{ width: 150, height: 30 }}
              value={since}
              onChange={(e) => setSince(e.target.value)}
            />
            <input
              className="ai-input"
              type="date"
              style={{ width: 150, height: 30 }}
              value={until}
              onChange={(e) => setUntil(e.target.value)}
            />
          </>
        )}
        <a
          className="ai-btn ai-btn-sm"
          href={`${resolveOrigin()}/projects/${projectId}/ai/usage/export?${q.toString()}`}
          data-testid="usage-export"
        >
          Export CSV
        </a>
      </div>
      <div className="ai-tiles" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="ai-tile">
          <div className="ai-label">API spend · {monthWord}</div>
          <div className="ai-tile-v">{usd(range === 'month' ? t.monthSpend : t.spend)}</div>
          <div className="ai-muted">of {usd(t.monthBudget)} board budget</div>
          <Meter used={t.monthSpend} cap={t.monthBudget} />
        </div>
        <div className="ai-tile">
          <div className="ai-label">Today</div>
          <div className="ai-tile-v">{usd(t.today)}</div>
          <div className="ai-muted">of {usd(t.dailyCap)} board daily cap</div>
          <Meter used={t.today} cap={t.dailyCap} />
        </div>
        <div className="ai-tile">
          <div className="ai-label">
            Forecast ·{' '}
            {new Date(`${t.forecastDate}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' })}
          </div>
          <div className="ai-tile-v">≈ {usd(t.forecast, 0)}</div>
          <div className="ai-muted" style={{ color: t.forecastWithin ? undefined : '#C4432A' }}>
            {t.forecastWithin ? 'within budget' : 'over budget'} at {usd(t.forecastPerDay)} a day
          </div>
        </div>
        <div className="ai-tile">
          <div className="ai-label">Runs · {monthWord}</div>
          <div className="ai-tile-v">{t.runs}</div>
          <div className="ai-muted">
            {t.apiRuns} API · {t.localRuns} local
          </div>
        </div>
      </div>
      <SpendChart d={d} showCap={range !== 'today'} />
      <div className="ai-card">
        <table className="ai-table" data-testid="usage-agents">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Runs</th>
              <th>Tokens / time</th>
              <th>Spend</th>
              <th>Of monthly cap</th>
            </tr>
          </thead>
          <tbody>
            {d.agents.length === 0 && (
              <tr>
                <td colSpan={5} className="ai-muted">
                  No AI runs in this range.
                </td>
              </tr>
            )}
            {d.agents.map((a) => {
              const m = members.find((x) => x.id === a.memberId);
              return (
                <tr key={a.memberId}>
                  <td style={{ fontWeight: 600 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      {m && <AiAvatar provider={m.provider} size={24} />}
                      {a.name}
                    </span>
                  </td>
                  <td>{a.runs}</td>
                  <td className="ai-mono">{a.metered ? compact(a.tokens) : fmtElapsed(a.seconds) || '0s'}</td>
                  <td className="ai-mono">{a.metered ? usd(a.costUsd) : <Pill>Not metered</Pill>}</td>
                  <td style={{ minWidth: 190 }}>
                    {a.metered && a.monthlyCap ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ flex: 1 }}>
                          <Meter used={a.pctOfCap ?? 0} cap={100} />
                        </div>
                        <span className="ai-muted">
                          {a.pctOfCap}% of ${a.monthlyCap}
                        </span>
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="ai-grid2">
        <SafetyCard title="Most expensive runs" right={<span className="ai-label">Cost</span>}>
          {d.topRuns.length === 0 && <div className="ai-muted">No metered runs yet.</div>}
          {d.topRuns.map((r) => (
            <div
              key={r.runId}
              style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '5px 0', fontSize: 12.5 }}
            >
              <span className="ai-mono ai-chip" style={{ background: '#F6FAF7' }}>
                {r.ticketId}
              </span>
              <span className="ai-muted" style={{ flex: 1 }}>
                {r.name} · #{r.number} · {compact(r.tokensIn)} in
              </span>
              <b className="ai-mono">{usd(r.costUsd)}</b>
            </div>
          ))}
        </SafetyCard>
        <SafetyCard title="Spend by ticket" right={<span className="ai-label">Cost</span>}>
          {d.tickets.length === 0 && <div className="ai-muted">No runs yet.</div>}
          {d.tickets.map((r) => (
            <div
              key={r.ticketId}
              style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '5px 0', fontSize: 12.5 }}
            >
              <span className="ai-mono ai-chip" style={{ background: '#F6FAF7' }}>
                {r.ticketId}
              </span>
              <span
                className="ai-muted"
                style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {r.title} · {r.runs} run{r.runs === 1 ? '' : 's'}
              </span>
              <b className="ai-mono">{usd(r.costUsd)}</b>
            </div>
          ))}
        </SafetyCard>
      </div>
      <LimitsTable
        limits={d.limits}
        onEdit={setEditing}
        prices={d.prices}
        showPrices={prices}
        onPrices={() => setPrices(!prices)}
      />
      <div className="ai-grid2">
        <CapPolicies limits={d.limits} />
        <SafetyCard title="Alerts" sub="To owners and the assigner; once per threshold a day">
          {alerts.data?.length === 0 && <div className="ai-muted">No budget alerts yet.</div>}
          {alerts.data?.map((a) => {
            const pct = a.data.percent;
            const key = a.data.kind === 'key_reminder';
            return (
              <div
                key={a.id}
                style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 0', fontSize: 12.5 }}
              >
                <Pill
                  bg={key ? '#EEF2F6' : pct && pct >= 100 ? '#FBEEEA' : '#FDF5E6'}
                  color={key ? '#34455A' : pct && pct >= 100 ? '#C4432A' : '#8A5A12'}
                >
                  {key ? 'Key' : `${pct ?? ''}%`}
                </Pill>
                <span style={{ flex: 1 }}>{a.body}</span>
                <span className="ai-muted">{dateTime(a.createdAt)}</span>
              </div>
            );
          })}
        </SafetyCard>
      </div>
      {editing === 'board' && <BoardLimitsDialog projectId={projectId} onClose={() => setEditing(null)} />}
      {editing && editing !== 'board' && (
        <EditBudgetDialog
          projectId={projectId}
          row={editing}
          limits={d.limits}
          member={members.find((m) => m.id === editing.memberId)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/** Spend by day stacked by agent, the daily cap as a dashed line, forecast days as dashed empty bars. */
function SpendChart({ d, showCap }: { d: UsageDashboard; showCap: boolean }) {
  const cap = showCap ? d.boardDailyCap : null;
  const max = useMemo(() => Math.max(...d.days.map((x) => x.costUsd), cap ?? 0, 0.5) * 1.1, [d.days, cap]);
  const metered = d.tiles.spend > 0 || d.series.length > 0;
  const maxRuns = Math.max(...d.days.map((x) => x.runs), 1);
  const color = (id: string) =>
    SERIES[
      Math.max(
        0,
        d.series.findIndex((s) => s.memberId === id),
      ) % SERIES.length
    ];
  const every = d.days.length > 16 ? 7 : 1;
  return (
    <div className="ai-card" style={{ padding: 16 }} data-testid="usage-chart">
      <div
        style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8, fontSize: 12.5 }}
      >
        {d.series.map((s) => (
          <span key={s.memberId} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="ai-dot" style={{ background: color(s.memberId), borderRadius: 2 }} />
            {s.name}
          </span>
        ))}
        {d.days.some((x) => x.forecast) && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span
              className="ai-dot"
              style={{ border: '1.5px dashed #9AA8A0', background: 'transparent', borderRadius: 2 }}
            />
            Forecast at the 7-day average
          </span>
        )}
        <span className="ai-muted" style={{ marginLeft: 'auto' }}>
          {metered ? 'Spend by day' : 'Runs by day'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <div
          className="ai-muted ai-mono"
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            height: 150,
            textAlign: 'right',
            minWidth: 34,
          }}
        >
          <span>{metered ? usd(max, 0) : maxRuns}</span>
          <span>{metered ? usd(max / 2, 0) : Math.round(maxRuns / 2)}</span>
          <span>{metered ? '$0' : '0'}</span>
        </div>
        <div style={{ flex: 1, position: 'relative' }}>
          <div className="ai-days">
            {cap != null && metered && (
              <div className="ai-capline" style={{ bottom: `${(cap / max) * 100}%` }}>
                <span>{usd(cap)} board daily cap</span>
              </div>
            )}
            {d.days.map((day) => (
              <div
                key={day.date}
                className="ai-day"
                title={`${day.date}: ${day.runs} runs · ${usd(day.costUsd)}${day.forecast ? ' (forecast)' : ''}`}
              >
                {day.forecast ? (
                  <div
                    className="ai-day-seg ai-day-fc"
                    style={{ height: `${(day.costUsd / max) * 100}%`, minHeight: 4 }}
                  />
                ) : metered ? (
                  day.byAgent.map((a) => (
                    <div
                      key={a.memberId}
                      className="ai-day-seg"
                      style={{ height: `${(a.costUsd / max) * 100}%`, background: color(a.memberId) }}
                    />
                  ))
                ) : (
                  <div
                    className="ai-day-seg"
                    style={{ height: `${(day.runs / maxRuns) * 100}%`, background: '#9AA8A0' }}
                  />
                )}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 3, marginTop: 4 }}>
            {d.days.map((day, i) => (
              <span
                key={day.date}
                className="ai-muted"
                style={{ flex: 1, textAlign: 'center', fontSize: 10.5, minWidth: 3 }}
              >
                {i % every === 0 || i === d.days.length - 1 ? Number(day.date.slice(8)) : ''}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Cell({ c, money = true }: { c?: { used: number; cap: number | null; full: boolean }; money?: boolean }) {
  if (!c) return <td />;
  const fmt = (v: number) =>
    money ? (v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2).replace(/\.00$/, '')}`) : compact(v);
  return (
    <td className="ai-mono" style={{ color: c.full ? '#C4432A' : undefined, minWidth: 96 }}>
      <div>
        {fmt(c.used)}
        {c.cap != null ? `/${money ? c.cap : compact(c.cap)}` : ''}
      </div>
      {c.cap != null && <Meter used={c.used} cap={c.cap} />}
    </td>
  );
}

const AT_CAP_LABEL: Record<string, string> = { pause: 'Pause new', stop: 'Hard stop', ask: 'Ask owner' };

/** Limits per agent and for the board (C4): the lower one wins. */
function LimitsTable({
  limits,
  onEdit,
  prices,
  showPrices,
  onPrices,
}: {
  limits: Limits;
  onEdit: (r: LimitRow | 'board') => void;
  prices: UsageDashboard['prices'];
  showPrices: boolean;
  onPrices: () => void;
}) {
  const b = limits.board;
  return (
    <SafetyCard
      title="Limits per agent and for the board"
      sub="Local runners: “Per run” is a maximum run time, not dollars. The lower limit wins."
      right={
        <button
          type="button"
          className="ai-btn ai-btn-sm"
          onClick={() => onEdit('board')}
          data-testid="limits-edit-board"
        >
          Edit board limits…
        </button>
      }
    >
      <div style={{ overflowX: 'auto' }}>
        <table className="ai-table ai-table-wide" data-testid="limits-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Daily</th>
              <th>Monthly</th>
              <th>Tokens/day</th>
              <th>Per run</th>
              <th>Parallel</th>
              <th>Runs/day</th>
              <th>At the cap</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ fontWeight: 700 }}>{b.name}</td>
              <Cell c={b.daily} />
              <Cell c={b.monthly} />
              <Cell c={b.tokens} money={false} />
              <td>—</td>
              <td className="ai-mono">
                {b.parallel.used}/{b.parallel.cap} total
              </td>
              <td className="ai-mono" style={{ color: b.runs.full ? '#C4432A' : undefined }}>
                {b.runs.cap != null ? `${b.runs.used}/${b.runs.cap}` : '—'}
              </td>
              <td>{AT_CAP_LABEL[b.atCap]}</td>
              <td />
            </tr>
            {limits.agents.map((a) => (
              <tr key={a.memberId} className={a.daily?.full ? 'ai-hl-row' : undefined}>
                <td style={{ fontWeight: 600 }}>{a.name}</td>
                {a.metered ? (
                  <>
                    <Cell c={a.daily} />
                    <Cell c={a.monthly} />
                    <Cell c={a.tokens} money={false} />
                    <td className="ai-mono">{a.capPerRun != null ? usd(a.capPerRun) : '—'}</td>
                  </>
                ) : (
                  <>
                    <td colSpan={3} className="ai-muted">
                      Not metered · no dollars or tokens
                    </td>
                    <td className="ai-mono">{a.perRunMinutes} min</td>
                  </>
                )}
                <td className="ai-mono">{a.parallel}</td>
                <td className="ai-mono" style={{ color: a.runs?.full ? '#C4432A' : undefined }}>
                  {a.runs ? `${a.runs.used}${a.runs.cap != null ? ` / ${a.runs.cap}` : ''}` : '—'}
                </td>
                <td>{AT_CAP_LABEL[a.atCap]}</td>
                <td>
                  <button
                    type="button"
                    className="ai-link"
                    onClick={() => onEdit(a)}
                    data-testid={`limits-edit-${a.name}`}
                  >
                    Edit…
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10, fontSize: 12 }}>
        <b>Prices</b>
        <span className="ai-muted">
          USD · built-in table, updated {prices.updated} (sample prices; the provider invoice is the truth)
        </span>
        <button type="button" className="ai-link" onClick={onPrices}>
          {showPrices ? 'Hide price table' : 'View price table'}
        </button>
      </div>
      {showPrices && (
        <table className="ai-table" style={{ marginTop: 8 }} data-testid="price-table">
          <thead>
            <tr>
              <th>Model (prefix)</th>
              <th>Input / 1M tokens</th>
              <th>Output / 1M tokens</th>
            </tr>
          </thead>
          <tbody>
            {prices.rows.map((p) => (
              <tr key={p.model}>
                <td className="ai-mono">{p.model}</td>
                <td className="ai-mono">{usd(p.input)}</td>
                <td className="ai-mono">{usd(p.output)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SafetyCard>
  );
}

/** At the cap, and the queue (C5). */
function CapPolicies({ limits }: { limits: Limits }) {
  const count = (p: string) => limits.agents.filter((a) => a.atCap === p).length + (limits.board.atCap === p ? 1 : 0);
  return (
    <SafetyCard title="At the cap, and the queue" sub="Default: pause new runs.">
      {(
        [
          [
            'pause',
            'Pause new runs',
            'The running one finishes.',
            ['Over budget — paused', 'resets 00:00', 'Waiting for budget'],
          ],
          ['stop', 'Stop everything now', 'Cancelled; partial work is kept.', ['Stopped · budget']],
          [
            'ask',
            'Ask an owner first',
            'An approval to raise today’s cap.',
            ['Raise cap', 'Medium risk', '+ $2.00, today only'],
          ],
        ] as const
      ).map(([id, title, sub, chips]) => (
        <div key={id} style={{ padding: '6px 0', borderTop: id === 'pause' ? 0 : '1px solid #EEF3EF' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <b style={{ fontSize: 13 }}>{title}</b>
            <span className="ai-muted">{sub}</span>
            <span className="ai-muted" style={{ marginLeft: 'auto' }}>
              {count(id)} in use
            </span>
          </div>
          <div className="ai-chips" style={{ marginTop: 4 }}>
            {chips.map((c) => (
              <Pill key={c}>{c}</Pill>
            ))}
          </div>
        </div>
      ))}
      <div className="ai-muted" style={{ marginTop: 8 }}>
        Queue: tickets stay assigned and wait in order, up to 10 per agent; an 11th assignment is refused with a note. A
        free slot starts the next one at once.
      </div>
    </SafetyCard>
  );
}

function NumberField({
  label,
  prefix,
  value,
  onChange,
  error,
  step,
  placeholder,
}: {
  label: string;
  prefix?: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
  step?: string;
  placeholder?: string;
}) {
  return (
    <label className="ai-field">
      <span className="ai-label ai-label-dark">{label}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {prefix && <span className="ai-muted">{prefix}</span>}
        <input
          className={`ai-input ${error ? 'ai-input-error' : ''}`}
          type="number"
          min={0}
          step={step ?? 'any'}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      {error && <span className="ai-error-text">{error}</span>}
    </label>
  );
}

const num = (v: string): number | null => (v.trim() === '' ? null : Number(v));

/** Edit budget (C2): daily, monthly, tokens, cap per run, parallel, warnings and the policy at the cap. */
function EditBudgetDialog({
  projectId,
  row,
  limits,
  member,
  onClose,
}: {
  projectId: string;
  row: LimitRow;
  limits: Limits;
  member?: AiMember;
  onClose: () => void;
}) {
  const metered = row.metered;
  const [daily, setDaily] = useState(String(row.daily?.cap ?? ''));
  const [monthly, setMonthly] = useState(String(row.monthly?.cap ?? ''));
  const [tokens, setTokens] = useState(String(row.tokens?.cap ?? ''));
  const [perRun, setPerRun] = useState(String(row.capPerRun ?? ''));
  const [runsDay, setRunsDay] = useState(String(row.runs?.cap ?? ''));
  const [parallel, setParallel] = useState(row.parallel);
  const [warn, setWarn] = useState<number[]>(member?.warnAt ?? [80, 100]);
  const [atCap, setAtCap] = useState(row.atCap);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const save = useAiMutation((body: Record<string, unknown>) => aiApi.update(row.memberId, body));
  const overview = useAiOverview(projectId);
  const monthlyErr =
    metered && num(monthly) != null && num(daily) != null && num(monthly)! < num(daily)!
      ? `At least the daily budget ($${num(daily)!.toFixed(2)})`
      : null;
  const sumCaps = limits.agents.reduce(
    (s, a) => s + (a.memberId === row.memberId ? (num(monthly) ?? 0) : (a.monthly?.cap ?? 0)),
    0,
  );
  const boardBudget = overview.data?.settings.boardMonthlyBudget;
  const invalid = !!monthlyErr;
  return (
    <div className="ai-overlay" onClick={onClose}>
      <div
        className="ai-modal"
        style={{ width: 520 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Edit budget"
      >
        <div className="ai-modal-head">
          <h2 className="ai-modal-title">Edit budget · {row.name}</h2>
        </div>
        <div className="ai-modal-body">
          {metered ? (
            <>
              <div className="ai-grid2" style={{ gap: 12 }}>
                <NumberField label="Daily budget" prefix="$" value={daily} onChange={setDaily} />
                <NumberField label="Monthly cap" prefix="$" value={monthly} onChange={setMonthly} error={monthlyErr} />
                <NumberField
                  label="Tokens per day"
                  value={tokens}
                  onChange={setTokens}
                  step="1000"
                  placeholder="No limit"
                />
                <NumberField
                  label="Cap per run"
                  prefix="$"
                  value={perRun}
                  onChange={setPerRun}
                  placeholder="No limit"
                />
              </div>
            </>
          ) : (
            <NumberField label="Scheduled runs per day" value={runsDay} onChange={setRunsDay} step="1" />
          )}
          <div style={{ display: 'flex', gap: 24, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="ai-field">
              <span className="ai-label ai-label-dark">Parallel runs</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  type="button"
                  className="ai-icobtn"
                  onClick={() => setParallel(Math.max(1, parallel - 1))}
                  aria-label="Fewer"
                >
                  −
                </button>
                <b style={{ minWidth: 20, textAlign: 'center' }}>{parallel}</b>
                <button
                  type="button"
                  className="ai-icobtn"
                  onClick={() => setParallel(Math.min(10, parallel + 1))}
                  aria-label="More"
                >
                  +
                </button>
              </div>
            </div>
            {metered && (
              <div className="ai-field">
                <span className="ai-label ai-label-dark">Warn me at</span>
                <div className="ai-chips">
                  {[50, 80, 100].map((p) => (
                    <button
                      key={p}
                      type="button"
                      className={`ai-choice ${warn.includes(p) ? 'ai-choice-on' : ''}`}
                      onClick={() => setWarn(warn.includes(p) ? warn.filter((x) => x !== p) : [...warn, p].sort())}
                    >
                      {p}%
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="ai-field">
            <span className="ai-label ai-label-dark">When the cap is reached</span>
            <RadioRow
              on={atCap === 'pause'}
              onClick={() => setAtCap('pause')}
              title="Pause new runs"
              hint="Let the current one finish"
            />
            <RadioRow on={atCap === 'stop'} onClick={() => setAtCap('stop')} title="Stop everything now (hard stop)" />
            <RadioRow
              on={atCap === 'ask'}
              onClick={() => setAtCap('ask')}
              title="Ask an owner first (creates an approval)"
            />
          </div>
          {metered && (
            <div className="ai-hint">
              The board budget ({usd(boardBudget)} a month) still applies; agent caps add up to {usd(sumCaps)}
              {boardBudget != null && sumCaps > boardBudget
                ? ', which is more than the board can spend, so the board limit wins'
                : ', which is allowed'}
              .
            </div>
          )}
          {error && <div className="ai-error-text">{error}</div>}
        </div>
        <div className="ai-modal-foot">
          <button type="button" className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          <span className="ai-muted" style={{ flex: 1, textAlign: 'center' }}>
            Owners and admins · audited
          </span>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            disabled={invalid || save.isPending}
            data-testid="budget-save"
            onClick={async () => {
              const body: Record<string, unknown> = { maxParallel: parallel, config: { atCap } };
              if (metered) {
                Object.assign(body, {
                  dailyBudget: num(daily),
                  monthlyCap: num(monthly),
                  tokensPerDay: num(tokens),
                  capPerRun: num(perRun),
                  warnAt: warn,
                });
              } else Object.assign(body, { maxRunsPerDay: num(runsDay) });
              try {
                await save.mutateAsync(body);
                toast.success('Budget saved', `${row.name} · audited`);
                onClose();
              } catch (err) {
                setError(extractError(err));
              }
            }}
          >
            Save budget
          </button>
        </div>
      </div>
    </div>
  );
}

/** Board-wide limits: daily cap, monthly budget, tokens, parallel, runs per day and the policy at the cap. */
function BoardLimitsDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const overview = useAiOverview(projectId);
  const s = overview.data?.settings;
  const [f, setF] = useState<Record<string, string> | null>(null);
  const [atCap, setAtCap] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  if (!s) return null;
  const v = f ?? {
    daily: String(s.boardDailyCap ?? ''),
    monthly: String(s.boardMonthlyBudget ?? ''),
    tokens: String(s.boardTokensPerDay ?? ''),
    parallel: String(s.boardMaxParallel),
    runs: String(s.boardRunsPerDay ?? ''),
  };
  const set = (k: string) => (val: string) => setF({ ...v, [k]: val });
  const monthlyErr =
    num(v.monthly) != null && num(v.daily) != null && num(v.monthly)! < num(v.daily)!
      ? `At least the daily cap ($${num(v.daily)!.toFixed(2)})`
      : null;
  return (
    <div className="ai-overlay" onClick={onClose}>
      <div
        className="ai-modal"
        style={{ width: 520 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Board limits"
      >
        <div className="ai-modal-head">
          <h2 className="ai-modal-title">Board limits · all AI</h2>
        </div>
        <div className="ai-modal-body">
          <div className="ai-grid2" style={{ gap: 12 }}>
            <NumberField label="Daily cap" prefix="$" value={v.daily} onChange={set('daily')} />
            <NumberField
              label="Monthly budget"
              prefix="$"
              value={v.monthly}
              onChange={set('monthly')}
              error={monthlyErr}
            />
            <NumberField
              label="Tokens per day"
              value={v.tokens}
              onChange={set('tokens')}
              step="1000"
              placeholder="No limit"
            />
            <NumberField label="Parallel runs (total)" value={v.parallel} onChange={set('parallel')} step="1" />
            <NumberField
              label="Scheduled and AI-started runs per day"
              value={v.runs}
              onChange={set('runs')}
              step="1"
              placeholder="No limit"
            />
          </div>
          <div className="ai-field">
            <span className="ai-label ai-label-dark">When a board limit is reached</span>
            {(
              [
                ['pause', 'Pause new runs', 'Let the current one finish'],
                ['stop', 'Stop everything now (hard stop)', undefined],
                ['ask', 'Ask an owner first (creates an approval)', undefined],
              ] as const
            ).map(([id, title, hint]) => (
              <RadioRow
                key={id}
                on={(atCap ?? s.boardAtCap) === id}
                onClick={() => setAtCap(id)}
                title={title}
                hint={hint}
              />
            ))}
          </div>
          <div className="ai-hint">The lower of an agent’s limit and the board’s applies.</div>
          {error && <div className="ai-error-text">{error}</div>}
        </div>
        <div className="ai-modal-foot">
          <button type="button" className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          <span className="ai-muted" style={{ flex: 1, textAlign: 'center' }}>
            Owners and admins · audited
          </span>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            disabled={!!monthlyErr}
            data-testid="board-limits-save"
            onClick={async () => {
              try {
                await safetyApi.updateSettings(projectId, {
                  boardDailyCap: num(v.daily),
                  boardMonthlyBudget: num(v.monthly),
                  boardTokensPerDay: num(v.tokens),
                  boardMaxParallel: Number(v.parallel),
                  boardRunsPerDay: num(v.runs),
                  boardAtCap: atCap ?? s.boardAtCap,
                });
                void overview.refetch();
                toast.success('Board limits saved', 'Audited');
                onClose();
              } catch (err) {
                setError(extractError(err));
              }
            }}
          >
            Save limits
          </button>
        </div>
      </div>
    </div>
  );
}
