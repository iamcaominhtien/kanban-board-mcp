import { useRef, useState, type ReactNode } from 'react';
import { aiApi, useAiMutation, useAiSettings, useAiTeams } from '../../api/ai';
import { extractError } from '../../api/extractError';
import { useRestartRun, useResourcesStream } from '../../api/aiResources';
import type { AiTeam } from '../../types/ai';
import type { ResourceRun, ResourceSnapshot } from '../../types/aiResources';
import { hhmm, useNow } from '../ai/aiUi';
import { roleLook } from '../ai/roleLook';
import { NumberSetting } from '../ai/settings/settingsUi';
import { useToast } from '../Toast';
import {
  AUTO_RESTARTS,
  LEVEL_COLOR,
  fitEstimate,
  fmtGb,
  fmtGbOf,
  fmtMb,
  levelOf,
  limitPct,
  linePoints,
  verdictOf,
  type Verdict,
} from './resourcesFormat';
import { openRun } from './runLink';
import { openSettingsAt } from './settingsLink';
import { Badge, ICONS, Icon, TicketChip } from './teamUi';
import './resources.css';

interface Props {
  projectId: string;
  onOpenTicket: (ticketId: string) => void;
}

const WINDOW_S = 300;
const FALLBACK_COLORS = ['#2E6F40', '#C2417A', '#B8860B', '#5B5FA8', '#2F6FB0', '#C4432A'];

const VERDICT_LOOK: Record<Verdict['tone'], { bg: string; border: string; fg: string }> = {
  ok: { bg: '#E6F2EA', border: '#BFDCC8', fg: '#1F5A31' },
  idle: { bg: '#E6F2EA', border: '#BFDCC8', fg: '#1F5A31' },
  warn: { bg: '#FEF6E7', border: '#F0DBA8', fg: '#7A5A06' },
  bad: { bg: '#FDF3F0', border: '#F0C4B8', fg: '#A5321E' },
};

function runningFor(run: ResourceRun, nowMs: number): string {
  const start = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
  const end = run.endedAt ? Date.parse(run.endedAt) : nowMs;
  if (!Number.isFinite(start)) return '';
  const min = Math.max(0, Math.round((end - start) / 60000));
  return min < 1 ? '<1 min' : `${min} min`;
}

function Tile({
  label,
  value,
  hint,
  pct,
  level = 'ok',
}: {
  label: string;
  value: string;
  hint: string;
  pct?: number;
  level?: 'ok' | 'warn' | 'bad';
}) {
  return (
    <div className="at-tile">
      <div className="rs-h">{label}</div>
      <div className="rs-big">{value}</div>
      <div className="at-hint-sm">{hint}</div>
      {pct != null && (
        <div className="rs-meter" data-testid="rs-meter">
          <i style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: LEVEL_COLOR[level].bar }} />
        </div>
      )}
    </div>
  );
}

/** One line per running run: RAM of its Claude Code over the last 5 minutes, against the limit of one run. */
function RunsChart({
  snap,
  colors,
  label,
}: {
  snap: ResourceSnapshot;
  colors: Map<string, string>;
  label: (r: ResourceRun) => string;
}) {
  const W = 1000;
  const H = 150;
  const now = Date.parse(snap.at);
  const limit = snap.limits.runMemoryLimitMb;
  const live = snap.runs.filter((r) => r.live);
  const peak = Math.max(0, ...live.flatMap((r) => r.history.map((p) => p.rssMb)));
  // The axis runs up to the limit of one run, with the red dashed limit line at its top (design F1, B); without a
  // limit it is scaled to what the runs use
  const fitMb = Math.max(peak * 1.3, 512);
  const wantMb = limit > 0 ? Math.max(fitMb, limit) : fitMb;
  // Round the axis up to four even steps, so every label is a round number
  const step =
    [64, 128, 256, 512, 1024, 2048, 4096, 8192].find((s) => s * 4 >= wantMb) ?? Math.ceil(wantMb / 4096) * 1024;
  const maxMb = step * 4;
  const ticks = [0, 1, 2, 3, 4].map((i) => i * step);
  const limitY = H - (limit / maxMb) * H;
  return (
    <div className="rs-box" data-testid="rs-chart">
      <div className="rs-boxhead">
        <b>RAM of each run, last 5 minutes</b>
        <span className="rs-legend">
          {live.map((r) => (
            <span key={r.runId}>
              <i style={{ background: colors.get(r.runId) }} />
              {label(r)}
            </span>
          ))}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W + 60} ${H + 24}`}
        role="img"
        aria-label="RAM of each run, last 5 minutes"
        className="rs-chart"
      >
        {ticks.map((t) => {
          const y = H - (t / maxMb) * H;
          return (
            <g key={t}>
              <line x1="52" x2={W + 56} y1={y + 4} y2={y + 4} stroke="#EEF3EF" />
              <text x="46" y={y + 8} textAnchor="end" fontSize="11" fill="#8A998F">
                {t === 0 ? '0' : maxMb < 2048 ? `${t} MB` : `${Number((t / 1024).toFixed(1))} GB`}
              </text>
            </g>
          );
        })}
        {limit > 0 && (
          <g>
            <line x1="52" x2={W + 56} y1={limitY + 4} y2={limitY + 4} stroke="#C4432A" strokeDasharray="5 4" />
            <text x={W + 54} y={limitY < 12 ? limitY + 18 : limitY} textAnchor="end" fontSize="11" fill="#A5321E">
              limit per run {fmtGb(limit)}
            </text>
          </g>
        )}
        <g transform="translate(52 4)">
          {live.map((r) => (
            <polyline
              key={r.runId}
              fill="none"
              stroke={colors.get(r.runId)}
              strokeWidth="2"
              points={linePoints(r.history, now, WINDOW_S, maxMb, W, H)}
            />
          ))}
          {live.flatMap((r) =>
            r.restarts.map((x) => {
              const t = Date.parse(x.at);
              if (!Number.isFinite(t) || t < now - WINDOW_S * 1000) return null;
              const px = ((t - (now - WINDOW_S * 1000)) / (WINDOW_S * 1000)) * W;
              return (
                <g key={`${r.runId}-${x.n}`}>
                  <circle cx={px} cy={H - 6} r="8" fill="#E8861A" />
                  <text x={px} y={H - 2} textAnchor="middle" fontSize="10" fontWeight="700" fill="#fff">
                    {x.n}
                  </text>
                </g>
              );
            }),
          )}
        </g>
        {[1, 2, 3, 4].map((m) => (
          <text key={m} x={52 + (W * (5 - m)) / 5} y={H + 20} textAnchor="middle" fontSize="11" fill="#8A998F">
            {m}
          </text>
        ))}
        <text x="52" y={H + 20} fontSize="11" fill="#8A998F">
          5 min ago
        </text>
        <text x={W + 56} y={H + 20} textAnchor="end" fontSize="11" fill="#8A998F">
          now
        </text>
      </svg>
      {!live.length && (
        <div className="at-hint">Nothing is running. The last runs stay in the table below for 10 minutes.</div>
      )}
    </div>
  );
}

/** Stop and Restart of a running run, each behind a confirmation. */
function RowActions({ run, canAct, teamName }: { run: ResourceRun; canAct: boolean; teamName: string }) {
  const [asking, setAsking] = useState<'stop' | 'restart' | null>(null);
  const restart = useRestartRun();
  const toast = useToast();
  const stop = useAiMutation((id: string) => aiApi.cancel(id));
  // the newest row, for the check a few seconds after a Restart (the server says yes when the runner took the command,
  // not when a new Claude Code started: if the restart count did not grow, say so)
  const latest = useRef(run);
  latest.current = run;
  const checkRestarted = (before: number) =>
    window.setTimeout(() => {
      if (latest.current.live && latest.current.restarts.length <= before)
        toast.error(
          'Not restarted',
          `${latest.current.ticketId} has no Claude Code process to restart right now, or it is already restarting.`,
        );
    }, 8000);
  if (!run.live) return null;
  const who = `${teamName}’s run on ${run.ticketId}`;
  const tip = canAct ? undefined : 'The server is not answering';
  return (
    <div className="rs-actions">
      <button
        type="button"
        className="st-btn st-btn-sm"
        disabled={!canAct}
        title={tip}
        data-testid="rs-restart"
        onClick={() => setAsking('restart')}
      >
        Restart
      </button>
      <button
        type="button"
        className="st-btn st-btn-sm"
        style={{ color: '#C4432A' }}
        disabled={!canAct}
        title={tip}
        data-testid="rs-stop"
        onClick={() => setAsking('stop')}
      >
        Stop
      </button>
      {asking && (
        <div className="rs-pop" role="dialog" aria-label={asking === 'stop' ? 'Confirm stop' : 'Confirm restart'}>
          <b>{asking === 'stop' ? `Stop ${who}?` : `Restart ${who}?`}</b>
          <span>
            {asking === 'stop'
              ? 'Ends the run now. Partial work in the folder is kept; Retry on the run starts it again.'
              : 'Claude Code starts again inside the same run and continues its conversation. If that conversation is gone from this computer, it starts a new one and is told to read the ticket and the git history. Memory is released.'}
          </span>
          <div className="rs-pop-btns">
            <button type="button" className="st-btn st-btn-sm" onClick={() => setAsking(null)}>
              Cancel
            </button>
            <button
              type="button"
              className={`st-btn st-btn-sm ${asking === 'stop' ? 'rs-danger' : 'rs-primary'}`}
              disabled={stop.isPending || restart.isPending}
              data-testid="rs-confirm"
              onClick={() => {
                const done = () => {
                  setAsking(null);
                  if (asking === 'restart') checkRestarted(run.restarts.length);
                };
                const failed = (err: unknown) => toast.error("Couldn't do it", extractError(err));
                if (asking === 'stop') stop.mutate(run.runId, { onSuccess: done, onError: failed });
                else restart.mutate(run.runId, { onSuccess: done, onError: failed });
              }}
            >
              {asking === 'stop' ? 'Stop run' : 'Restart'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** What the system did to a run, written on its row: restarted (amber) or stopped for memory (red). */
function SystemNote({ run, limitMb }: { run: ResourceRun; limitMb: number }) {
  const last = run.restarts[run.restarts.length - 1];
  const stopped = run.stopCode === 'memory';
  if (!stopped && !(last && last.by === 'system')) return null;
  const red = stopped;
  const bySystem = run.restarts.filter((r) => r.by === 'system').length;
  return (
    <div
      className="rs-note"
      data-testid={red ? 'rs-note-stopped' : 'rs-note-restarted'}
      style={
        red ? { background: '#FDF3F0', borderColor: '#F0C4B8' } : { background: '#FFF4E5', borderColor: '#F0CDA0' }
      }
    >
      {red ? (
        <>
          <b style={{ color: '#A5321E' }}>Stopped automatically{run.endedAt ? ` at ${hhmm(run.endedAt)}` : ''}.</b> It
          went over {fmtGb(limitMb || last?.limitMb || 0)} again after {AUTO_RESTARTS} restarts
          {run.peakRssMb ? `; peak ${fmtMb(run.peakRssMb)}` : ''}. Partial work is kept: raise the limit, then Retry.
        </>
      ) : (
        <>
          <b style={{ color: '#8A4B08' }}>Restarted automatically at {hhmm(last.at)}.</b> It reached{' '}
          {last.rssMb != null ? fmtMb(last.rssMb) : 'the limit'}
          {last.limitMb ? `, over the ${fmtGb(last.limitMb)} limit` : ''}, so the system started it again in the same
          run (restart {bySystem} of {AUTO_RESTARTS}; after the second, the next time it goes over the run is stopped).
        </>
      )}{' '}
      <button type="button" className="ai-link" onClick={() => openRun(run.runId)}>
        Open run
      </button>
    </div>
  );
}

function RunRow({
  run,
  limitMb,
  canAct,
  nowMs,
  team,
  onOpenTicket,
}: {
  run: ResourceRun;
  limitMb: number;
  canAct: boolean;
  nowMs: number;
  team: AiTeam | undefined;
  onOpenTicket: (id: string) => void;
}) {
  const pct = limitPct(run.cliRssMb, limitMb);
  const level = levelOf(pct);
  const young = run.live && run.startedAt != null && nowMs - Date.parse(run.startedAt) < 15000;
  const last = run.restarts[run.restarts.length - 1];
  const roles = run.rolesWorking ?? [];
  const roleName = (key: string) => team?.roles.find((r) => r.key === key)?.name ?? key;
  return (
    <div data-testid={`rs-run-${run.ticketId}`}>
      <div className={`rs-row${run.live ? '' : ' rs-ended'}`}>
        <div>
          <TicketChip id={run.ticketId} onOpen={onOpenTicket} />
          <div className="at-hint-sm">{run.ticketTitle}</div>
        </div>
        <div className="rs-work">
          {!run.live ? (
            <span className="at-hint">{run.stopCode === 'memory' ? 'Stopped' : 'Ended'}</span>
          ) : roles.length ? (
            roles.map((key, i) => {
              const look = roleLook(key);
              return (
                <span
                  key={`${key}-${i}`}
                  className="at-chip"
                  style={{ background: look.bg, color: look.fg, border: `1px solid ${look.border}` }}
                >
                  {roleName(key)}
                </span>
              );
            })
          ) : (
            <span className="at-chip">Lead</span>
          )}
        </div>
        <div>
          <div>{runningFor(run, nowMs)}</div>
          <div className="at-hint-sm">since {hhmm(run.startedAt)}</div>
        </div>
        <div>
          {run.readable ? (
            <>
              <div style={{ width: 116 }}>
                <div className="rs-ramline">
                  <b>{fmtMb(run.cliRssMb)}</b>
                  {limitMb > 0 && <span style={{ color: LEVEL_COLOR[level].text }}>{pct}%</span>}
                </div>
                <div className="at-bar">
                  <i style={{ width: `${Math.min(100, pct)}%`, background: LEVEL_COLOR[level].bar }} />
                </div>
              </div>
              {run.extraMb != null && run.extraMb >= 50 && (
                <div className="at-hint-sm">+{fmtMb(run.extraMb)} it started (not counted)</div>
              )}
            </>
          ) : (
            <span className="at-hint">— not readable</span>
          )}
        </div>
        <div>{run.readable ? fmtMb(run.peakRssMb) : '—'}</div>
        <div>
          <b>{run.cpuPct != null ? `${Math.round(run.cpuPct)}%` : '—'}</b>
          {young && run.cpuPct != null && run.cpuPct > 100 && <span className="rs-starting">starting</span>}
        </div>
        <div>
          {run.restarts.length ? (
            <>
              <span style={{ color: '#7A5A06' }}>{run.restarts.length}</span>{' '}
              <span className="at-hint-sm">
                {last.by === 'system' ? 'restarted' : `restarted by ${last.by}`} {hhmm(last.at)}
              </span>
            </>
          ) : (
            <span className="at-hint">0</span>
          )}
        </div>
        <RowActions run={run} canAct={canAct} teamName={run.memberName ?? 'The team'} />
      </div>
      <SystemNote run={run} limitMb={limitMb} />
    </div>
  );
}

/** The two limits of the project and what they mean for this machine (design/screens/ai-resources.md, E). */
function LimitsCard({ projectId, snap }: { projectId: string; snap: ResourceSnapshot }) {
  const settings = useAiSettings(projectId).data;
  const toast = useToast();
  const save = useAiMutation((body: { runMemoryLimitMb?: number; boardMaxParallel?: number }) =>
    aiApi.updateSettings(projectId, body),
  );
  const limitMb = settings?.runMemoryLimitMb ?? snap.limits.runMemoryLimitMb;
  const parallel = settings?.boardMaxParallel ?? snap.limits.boardMaxParallel;
  const est = fitEstimate(parallel, limitMb, snap.machine);
  const onSave = (body: { runMemoryLimitMb?: number; boardMaxParallel?: number }) =>
    save.mutate(body, { onError: (err) => toast.error("Couldn't save the limit", extractError(err)) });
  return (
    <div className="rs-box" data-testid="rs-limits">
      <div className="rs-boxhead">
        <b>Limits</b>
        <button
          type="button"
          className="ai-link"
          onClick={() => openSettingsAt({ page: 'ai', setting: 'ai-limits' })}
          data-testid="rs-open-settings"
        >
          All AI limits in Settings →
        </button>
      </div>
      <div className="rs-limits">
        <label className="rs-field">
          <span>Memory of one run (MB)</span>
          <NumberSetting
            value={limitMb}
            min={0}
            width={96}
            label="Memory of one run (MB)"
            testId="rs-limit-memory"
            onSave={(n) => onSave({ runMemoryLimitMb: n })}
          />
          <span className="at-hint-sm">
            A run whose Claude Code goes over this is restarted, twice at most, then stopped. 0 is no limit.
          </span>
        </label>
        <label className="rs-field">
          <span>Runs at the same time</span>
          <NumberSetting
            value={parallel}
            min={1}
            width={96}
            label="Runs at the same time"
            testId="rs-limit-parallel"
            onSave={(n) => onSave({ boardMaxParallel: n })}
          />
          <span className="at-hint-sm">Runs past this wait in line; nothing is lost.</span>
        </label>
      </div>
      <div
        className="rs-estimate"
        data-testid="rs-estimate"
        style={est.fits ? undefined : { background: '#FEF6E7', borderColor: '#F0DBA8', color: '#7A5A06' }}
      >
        <Icon color={est.fits ? '#1F5A31' : '#B8860B'} size={15}>
          {est.fits ? ICONS.check : ICONS.info}
        </Icon>
        <span>
          <b>{est.fits ? 'It fits this machine. ' : 'It may not fit this machine. '}</b>
          {est.text}
        </span>
      </div>
    </div>
  );
}

/** AI Team › Resources (design/screens/ai-resources.md, B): the machine, RAM of every running run, Stop and Restart. */
export function ResourcesTab({ projectId, onOpenTicket }: Props) {
  const { data: snap, live, pushed } = useResourcesStream(projectId);
  const teamsQ = useAiTeams(projectId);
  const nowMs = useNow(1000);
  if (!snap) {
    return (
      <div className="rs-root" aria-busy="true" data-testid="resources-tab">
        <div className="rs-skel" />
        <div className="rs-skel" style={{ height: 90 }} />
        <div className="at-hint">Reading the machine…</div>
      </div>
    );
  }
  const teams = new Map((teamsQ.data ?? []).map((t) => [t.id, t]));
  const verdict = verdictOf(snap);
  const look = VERDICT_LOOK[verdict.tone];
  const { machine, limits } = snap;
  const usedPct = machine.ramTotalMb
    ? Math.round(((machine.ramTotalMb - machine.ramFreeMb) / machine.ramTotalMb) * 100)
    : 0;
  const liveRuns = snap.runs.filter((r) => r.live);
  const liveCount = liveRuns.length;
  const loadPct = machine.load1 != null && machine.cores ? Math.round((machine.load1 / machine.cores) * 100) : 0;
  const slotsPct = limits.boardMaxParallel ? Math.round((liveCount / limits.boardMaxParallel) * 100) : 0;
  const free = machine.ramTotalMb ? (machine.ramFreeMb / machine.ramTotalMb) * 100 : 100;
  // A line colour per run: the team's colour for its first run, the palette for another run of the same team
  const colors = new Map<string, string>();
  const taken = new Set<string>();
  liveRuns.forEach((r, i) => {
    let c = r.memberColor && !taken.has(r.memberColor) ? r.memberColor : '';
    if (!c) c = FALLBACK_COLORS.find((x) => !taken.has(x)) ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length];
    taken.add(c);
    colors.set(r.runId, c);
  });
  // The rows grouped by team, the team with a live run first
  const groups = new Map<string, ResourceRun[]>();
  for (const r of snap.runs) groups.set(r.memberId, [...(groups.get(r.memberId) ?? []), r]);
  const head: ReactNode[] = [
    'Ticket',
    'Working now',
    'Since',
    `CLI RAM now${limits.runMemoryLimitMb > 0 ? ` (of ${fmtGb(limits.runMemoryLimitMb)} limit)` : ''}`,
    'Peak',
    'CPU',
    'Restarts',
    '',
  ];
  return (
    <div className="rs-root" data-testid="resources-tab">
      <div className="rs-livebar">
        <span className="at-dot" style={{ background: live ? '#2E6F40' : '#A3B0A8' }} />
        <span className="at-hint" style={{ color: live ? '#1F5A31' : '#5B6B60' }}>
          {!live
            ? `Showing data from ${hhmm(snap.at)}`
            : pushed
              ? 'Live · every 2 s'
              : liveCount
                ? 'Last saved readings · every 4 s'
                : 'Live · every 4 s'}
        </span>
      </div>
      {!live && (
        <div className="rs-banner" style={{ background: '#FEF6E7', borderColor: '#F0DBA8', color: '#7A5A06' }}>
          <b>Can’t reach the server.</b> The chart has stopped, and Stop and Restart are off until it is back.
        </div>
      )}
      <div className="rs-banner" style={{ background: look.bg, borderColor: look.border }} data-testid="rs-verdict">
        <span style={{ color: look.fg, display: 'inline-flex', paddingTop: 1 }}>
          <Icon color={look.fg} size={16}>
            {verdict.tone === 'ok' || verdict.tone === 'idle' ? ICONS.check : ICONS.info}
          </Icon>
        </span>
        <div>
          <b style={{ color: look.fg }}>{verdict.title}</b>
          <div className="at-hint" style={{ color: '#3A4A3E' }}>
            {verdict.text}
          </div>
        </div>
      </div>
      <div className="at-tiles">
        <Tile
          label="Machine RAM"
          value={fmtGbOf(machine.ramTotalMb - machine.ramFreeMb, machine.ramTotalMb)}
          hint={`${fmtGb(machine.ramFreeMb)} free`}
          pct={usedPct}
          level={free < 10 ? 'bad' : levelOf(usedPct)}
        />
        <Tile
          label="Machine load"
          value={machine.load1 != null ? String(machine.load1) : '—'}
          hint={`on ${machine.cores} cores · 1 min average`}
          pct={loadPct}
          level={levelOf(loadPct)}
        />
        <Tile
          label="AI processes"
          value={fmtMb(machine.aiRssMb)}
          hint={`${machine.ramTotalMb ? Math.round((machine.aiRssMb / machine.ramTotalMb) * 100) : 0}% of the machine’s RAM · ${machine.cliCount} ${machine.cliCount === 1 ? 'CLI' : 'CLIs'}`}
        />
        <Tile
          label="Runs at the same time"
          value={`${liveCount} of ${limits.boardMaxParallel}`}
          hint={
            liveCount >= limits.boardMaxParallel
              ? 'project limit · no slot free'
              : `project limit · ${limits.boardMaxParallel - liveCount} free`
          }
          pct={slotsPct}
          level={levelOf(slotsPct)}
        />
      </div>
      <RunsChart snap={snap} colors={colors} label={(r) => `${r.memberName ?? 'Team'} · ${r.ticketId}`} />
      {snap.runs.length ? (
        <div className="rs-box rs-table" data-testid="rs-table">
          {[...groups.entries()].map(([memberId, rows]) => (
            <div key={memberId} data-testid={`rs-team-${rows[0].memberName ?? memberId}`}>
              <div className="rs-team">
                <Badge name={rows[0].memberName ?? ''} color={rows[0].memberColor} size={24} role="lead" />
                <b>{rows[0].memberName ?? 'Team'}</b>
                <span className="at-hint-sm">
                  {rows.filter((r) => r.live).length} running ·{' '}
                  {fmtMb(rows.reduce((a, r) => a + (r.live ? (r.cliRssMb ?? 0) : 0), 0))}
                </span>
              </div>
              <div className="rs-grid rs-head">
                {head.map((h, i) => (
                  <div key={i} className="rs-h">
                    {h}
                  </div>
                ))}
              </div>
              {rows.map((r) => (
                <RunRow
                  key={r.runId}
                  run={r}
                  limitMb={limits.runMemoryLimitMb}
                  canAct={live}
                  nowMs={nowMs}
                  team={teams.get(r.memberId)}
                  onOpenTicket={onOpenTicket}
                />
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="rs-empty" data-testid="rs-empty">
          Runs appear here when a team starts working on a ticket.
        </div>
      )}
      <LimitsCard projectId={projectId} snap={snap} />
    </div>
  );
}
