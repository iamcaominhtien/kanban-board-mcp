import { useState } from 'react';
import { aiApi, useAiBoard, useAiMutation } from '../../api/ai';
import { useRestartRun, useResourcesStream } from '../../api/aiResources';
import type { ResourceRun, ResourceSnapshot } from '../../types/aiResources';
import { LEVEL_COLOR, fmtGb, fmtMb, levelOf, limitPct, linePoints, verdictOf, type Verdict } from './resourcesFormat';
import { Badge, TicketChip } from './teamUi';
import './resources.css';

interface Props {
  projectId: string;
  onOpenTicket: (ticketId: string) => void;
}

const WINDOW_S = 300;
const FALLBACK_COLORS = ['#2E6F40', '#C2417A', '#B8860B', '#5B5FA8', '#2F6FB0'];

const VERDICT_LOOK: Record<Verdict['tone'], { bg: string; border: string; fg: string }> = {
  ok: { bg: '#E6F2EA', border: '#BFDCC8', fg: '#1F5A31' },
  idle: { bg: '#E6F2EA', border: '#BFDCC8', fg: '#1F5A31' },
  warn: { bg: '#FEF6E7', border: '#F0DBA8', fg: '#7A5A06' },
  bad: { bg: '#FDF3F0', border: '#F0C4B8', fg: '#A5321E' },
};

function clock(iso: string | null | undefined): string {
  const t = iso ? new Date(iso) : null;
  return t && !Number.isNaN(t.getTime()) ? t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}

function runningFor(run: ResourceRun, nowMs: number): string {
  const start = run.startedAt ? Date.parse(run.startedAt) : NaN;
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
        <div className="at-bar">
          <i style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: LEVEL_COLOR[level].bar }} />
        </div>
      )}
    </div>
  );
}

function RunsChart({ snap, colors }: { snap: ResourceSnapshot; colors: Map<string, string> }) {
  const W = 1000;
  const H = 150;
  const now = Date.parse(snap.at);
  const limit = snap.limits.runMemoryLimitMb;
  const peak = Math.max(0, ...snap.runs.flatMap((r) => r.history.map((p) => p.rssMb)));
  const maxMb = Math.max(limit > 0 ? limit : 0, peak * 1.15, 512);
  const live = snap.runs.filter((r) => r.live);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxMb);
  return (
    <div className="rs-box">
      <div className="rs-boxhead">
        <b>RAM of each run, last 5 minutes</b>
        <span className="rs-legend">
          {live.map((r) => (
            <span key={r.runId}>
              <i style={{ background: colors.get(r.memberId) }} />
              {r.memberName}
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
                {t === 0 ? '0.0 GB' : `${(t / 1024).toFixed(1)} GB`}
              </text>
            </g>
          );
        })}
        {limit > 0 && limit <= maxMb && (
          <g>
            <line
              x1="52"
              x2={W + 56}
              y1={H - (limit / maxMb) * H + 4}
              y2={H - (limit / maxMb) * H + 4}
              stroke="#C4432A"
              strokeDasharray="5 4"
            />
            <text x={W + 54} y={H - (limit / maxMb) * H} textAnchor="end" fontSize="11" fill="#A5321E">
              limit per run {fmtGb(limit)}
            </text>
          </g>
        )}
        <g transform="translate(52 4)">
          {live.map((r) => (
            <polyline
              key={r.runId}
              fill="none"
              stroke={colors.get(r.memberId)}
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

function RowActions({ run, canAct, onDone }: { run: ResourceRun; canAct: boolean; onDone: () => void }) {
  const [asking, setAsking] = useState<'stop' | 'restart' | null>(null);
  const restart = useRestartRun();
  const stop = useAiMutation((id: string) => aiApi.cancel(id, 'Stopped from the Resources tab'));
  if (!run.live) return null;
  const who = `${run.memberName ?? 'This AI'}’s run on ${run.ticketId}`;
  const tip = canAct ? undefined : 'You can look, not act';
  return (
    <div className="rs-actions">
      <button
        type="button"
        className="st-btn st-btn-sm"
        disabled={!canAct}
        title={tip}
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
        onClick={() => setAsking('stop')}
      >
        Stop
      </button>
      {asking && (
        <div className="rs-pop" role="dialog" aria-label={asking === 'stop' ? 'Confirm stop' : 'Confirm restart'}>
          <b>{asking === 'stop' ? `Stop ${who}?` : `Restart ${who}?`}</b>
          <span>
            {asking === 'stop'
              ? `Ends the run now. Partial work in the folder is kept. The ticket stays assigned to ${run.memberName ?? 'the AI'}.`
              : 'The CLI starts again inside the same run and picks up the session. Memory is released.'}
          </span>
          <div className="rs-pop-btns">
            <button type="button" className="st-btn st-btn-sm" onClick={() => setAsking(null)}>
              Cancel
            </button>
            <button
              type="button"
              className={asking === 'stop' ? 'st-btn st-btn-sm st-btn-danger' : 'st-btn st-btn-sm st-btn-primary'}
              onClick={() => {
                const done = () => {
                  setAsking(null);
                  onDone();
                };
                if (asking === 'stop') stop.mutate(run.runId, { onSuccess: done });
                else restart.mutate(run.runId, { onSuccess: done });
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

function RunRow({
  run,
  limitMb,
  canAct,
  nowMs,
  onOpenTicket,
}: {
  run: ResourceRun;
  limitMb: number;
  canAct: boolean;
  nowMs: number;
  onOpenTicket: (id: string) => void;
}) {
  const pct = limitPct(run.cliRssMb, limitMb);
  const level = levelOf(pct);
  const young = run.live && run.startedAt != null && nowMs - Date.parse(run.startedAt) < 15000;
  const last = run.restarts[run.restarts.length - 1];
  return (
    <div className={`rs-row${run.live ? '' : ' rs-ended'}`}>
      <div className="rs-who">
        <Badge name={run.memberName ?? ''} color={run.memberColor} size={26} />
        <b>{run.memberName}</b>
      </div>
      <div>
        <TicketChip id={run.ticketId} onOpen={onOpenTicket} />
        <div className="at-hint-sm">{run.ticketTitle}</div>
      </div>
      <div>{runningFor(run, nowMs)}</div>
      <div>
        {run.readable ? (
          <>
            <div className="rs-ram">
              <div style={{ width: 116 }}>
                <div className="rs-ramline">
                  <b>{fmtMb(run.cliRssMb)}</b>
                  {limitMb > 0 && <span style={{ color: LEVEL_COLOR[level].text }}>{pct}%</span>}
                </div>
                <div className="at-bar">
                  <i style={{ width: `${Math.min(100, pct)}%`, background: LEVEL_COLOR[level].bar }} />
                </div>
              </div>
            </div>
            {run.extraMb != null && run.extraMb >= 50 && (
              <div className="at-hint-sm">+{fmtMb(run.extraMb)} from what it started (not counted)</div>
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
              {last.by === 'system' ? 'restarted' : `restarted by ${last.by}`} {clock(last.at)}
            </span>
          </>
        ) : (
          <span className="at-hint">0</span>
        )}
      </div>
      <RowActions run={run} canAct={canAct} onDone={() => undefined} />
    </div>
  );
}

/** AI Team › Resources (design/screens/ai-resources.md, B): the machine, RAM of every run and Stop / Restart. */
export function ResourcesTab({ projectId, onOpenTicket }: Props) {
  const { data: snap, live } = useResourcesStream(projectId);
  const board = useAiBoard(projectId);
  const role = board.data?.settings.myRole;
  const canAct = !!live && role !== 'viewer';
  if (!snap) {
    return (
      <div className="rs-root" aria-busy="true">
        <div className="rs-skel" />
        <div className="rs-skel" style={{ height: 90 }} />
        <div className="at-hint">Reading the machine…</div>
      </div>
    );
  }
  const verdict = verdictOf(snap);
  const look = VERDICT_LOOK[verdict.tone];
  const { machine, limits } = snap;
  const nowMs = Date.parse(snap.at);
  const usedPct = machine.ramTotalMb
    ? Math.round(((machine.ramTotalMb - machine.ramFreeMb) / machine.ramTotalMb) * 100)
    : 0;
  const colors = new Map<string, string>();
  snap.runs.forEach((r, i) => {
    if (!colors.has(r.memberId)) colors.set(r.memberId, r.memberColor || FALLBACK_COLORS[i % FALLBACK_COLORS.length]);
  });
  const liveCount = snap.runs.filter((r) => r.live).length;
  const loadPct = machine.load1 != null && machine.cores ? Math.round((machine.load1 / machine.cores) * 100) : 0;
  const slotsPct = limits.boardMaxParallel ? Math.round((liveCount / limits.boardMaxParallel) * 100) : 0;
  const free = machine.ramTotalMb ? (machine.ramFreeMb / machine.ramTotalMb) * 100 : 100;
  return (
    <div className="rs-root" data-testid="resources-tab">
      <div className="rs-livebar">
        <span className="at-dot" style={{ background: live ? '#2E6F40' : '#A3B0A8' }} />
        <span className="at-hint" style={{ color: live ? '#1F5A31' : '#5B6B60' }}>
          {live ? 'Live · every 2 s' : `Showing data from ${clock(snap.at)}`}
        </span>
      </div>
      {!live && (
        <div className="rs-banner" style={{ background: '#FEF6E7', borderColor: '#F0DBA8', color: '#7A5A06' }}>
          <b>Can’t reach the server.</b> The chart has stopped, and Stop and Restart are off until it is back.
        </div>
      )}
      <div className="rs-banner" style={{ background: look.bg, borderColor: look.border }}>
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
          value={`${fmtGb(machine.ramTotalMb - machine.ramFreeMb)} / ${fmtGb(machine.ramTotalMb)}`}
          hint={`${fmtGb(machine.ramFreeMb)} free`}
          pct={usedPct}
          level={free < 10 ? 'bad' : usedPct >= 80 ? 'warn' : 'ok'}
        />
        <Tile
          label="Machine load"
          value={machine.load1 != null ? String(machine.load1) : '—'}
          hint={`on ${machine.cores} cores · 1 min average`}
          pct={loadPct}
          level={loadPct >= 100 ? 'bad' : loadPct >= 70 ? 'warn' : 'ok'}
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
          level={slotsPct >= 100 ? 'warn' : 'ok'}
        />
      </div>
      <RunsChart snap={snap} colors={colors} />
      {snap.runs.length ? (
        <div className="rs-box rs-table">
          <div className="rs-grid rs-head">
            <div className="rs-h">AI</div>
            <div className="rs-h">Run</div>
            <div className="rs-h">Running</div>
            <div className="rs-h">
              CLI RAM now{limits.runMemoryLimitMb > 0 ? ` (of ${fmtGb(limits.runMemoryLimitMb)} limit)` : ''}
            </div>
            <div className="rs-h">Peak</div>
            <div className="rs-h">CPU</div>
            <div className="rs-h">Restarts</div>
            <div className="rs-h" />
          </div>
          {snap.runs.map((r) => (
            <RunRow
              key={r.runId}
              run={r}
              limitMb={limits.runMemoryLimitMb}
              canAct={canAct}
              nowMs={nowMs}
              onOpenTicket={onOpenTicket}
            />
          ))}
        </div>
      ) : (
        <div className="rs-empty">Runs appear here when an AI starts working on a ticket.</div>
      )}
    </div>
  );
}
