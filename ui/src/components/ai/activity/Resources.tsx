import { useState, type ReactNode } from 'react';
import { aiApi, isActive, useAiMutation, useAiSettings, useTicketRuns } from '../../../api/ai';
import { useRestartRun } from '../../../api/aiResources';
import { extractError } from '../../../api/extractError';
import type { AiRun } from '../../../types/ai';
import { AUTO_RESTARTS, fmtGb, levelOf, LEVEL_COLOR } from '../../aiteam/resourcesFormat';
import { useToast } from '../../Toast';
import { hhmm, useNow } from '../aiUi';
import { useRunResources, type RunResources } from './useResources';
import './design/designBlocks.css';

const GB = 1024;
const gb = (mb: number | null | undefined) => (mb == null ? '—' : `${(mb / GB).toFixed(2)} GB`);
const STALE_MS = 7000;

/** The ticket's newest team run, or nothing. */
function useNewestRun(ticketId: string): AiRun | undefined {
  return (useTicketRuns(ticketId).data ?? []).find((r) => r.kind === 'team');
}

function Tile({ label, value, hint, children }: { label: string; value: string; hint?: string; children?: ReactNode }) {
  return (
    <div
      style={{
        flex: '1 1 0',
        minWidth: '120px',
        border: '1px solid #E3E8E5',
        borderRadius: '12px',
        background: '#fff',
        padding: '12px 14px',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
      }}
    >
      <div className="id-h">{label}</div>
      <div style={{ fontSize: '22px', fontWeight: 800, color: '#1E2A22' }}>{value}</div>
      {hint && (
        <div className="st-hint" style={{ fontSize: '11.5px' }}>
          {hint}
        </div>
      )}
      {children}
    </div>
  );
}

/** The last five minutes of the CLI's RAM against the limit, drawn as in the design (x 44-628, 0 GB at y 128). */
function Chart({ feed, limitMb }: { feed: RunResources | null; limitMb: number }) {
  const history = feed?.run.history ?? [];
  const top = Math.max(limitMb, ...history.map((p) => p.rssMb), GB);
  const maxGb = Math.ceil(top / (GB / 2)) / 2;
  const y = (mb: number) => 128 - (mb / (maxGb * GB)) * 107.3;
  const end = Date.now();
  const x = (t: number) => 44 + Math.min(1, Math.max(0, (t - (end - 300000)) / 300000)) * 584;
  const points = history.map((p) => `${x(Date.parse(p.at)).toFixed(1)},${y(p.rssMb).toFixed(1)}`);
  const lines: number[] = [];
  for (let v = 0; v <= maxGb + 1e-9; v += 0.5) lines.push(v);
  const last = history[history.length - 1];
  return (
    <svg
      viewBox="0 0 640 150"
      style={{
        width: '100%',
        height: 'auto',
        display: 'block',
        fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
      }}
      role="img"
      aria-label="RAM of the run over the last 5 minutes"
    >
      {lines.map((v) => (
        <g key={v}>
          <line x1="44" y1={y(v * GB).toFixed(1)} x2="628" y2={y(v * GB).toFixed(1)} stroke="#EEF3EF" />
          <text x="36" y={(y(v * GB) + 3.5).toFixed(1)} fontSize="10" fill="#6B7A70" textAnchor="end">
            {v.toFixed(1)} GB
          </text>
        </g>
      ))}
      {['5 min ago', '4', '3', '2', '1', 'now'].map((label, i) => (
        <text key={label} x={(44 + i * 116.8).toFixed(1)} y="144" fontSize="10" fill="#6B7A70" textAnchor="middle">
          {label}
        </text>
      ))}
      {limitMb > 0 && (
        <>
          <line
            x1="44"
            y1={y(limitMb).toFixed(1)}
            x2="628"
            y2={y(limitMb).toFixed(1)}
            stroke="#C4432A"
            strokeWidth="1.3"
            strokeDasharray="5 3"
          />
          <text x="624" y={(y(limitMb) - 5).toFixed(1)} fontSize="10" fontWeight="700" fill="#A5321E" textAnchor="end">
            limit per run {(limitMb / GB).toFixed(limitMb % GB ? 1 : 0)} GB
          </text>
        </>
      )}
      {points.length > 1 && (
        <polyline points={points.join(' ')} fill="none" stroke="#2E6F40" strokeWidth="2" strokeLinejoin="round" />
      )}
      {last && <circle cx={x(Date.parse(last.at)).toFixed(1)} cy={y(last.rssMb).toFixed(1)} r="3.5" fill="#2E6F40" />}
    </svg>
  );
}

/**
 * The restart notice of the design (AiResources, "Restarted automatically at 10:50"): the newest time the CLI was
 * started again inside the run, from the run's own record. Nothing when it never was.
 */
export function RestartNotice({ ticketId, onOpenRun }: { ticketId: string; onOpenRun?: () => void }) {
  const run = useNewestRun(ticketId);
  const restarts = run?.restarts ?? [];
  const last = restarts[restarts.length - 1];
  // only while the run goes on: after it, the card keeps the restart count (design F4), and a run the system stopped
  // for memory says so on the run itself (design F8)
  if (!run || !last || !isActive(run.state)) return null;
  const system = last.by === 'system';
  const bySystem = restarts.filter((r) => r.by === 'system').length;
  return (
    <div className="dz dz-rs" data-testid="restart-notice">
      <div
        style={{
          padding: '11px 13px',
          border: '1px solid #F0CDA0',
          borderRadius: '10px',
          background: '#FFF4E5',
          display: 'flex',
          gap: '10px',
          alignItems: 'flex-start',
        }}
      >
        <span style={{ color: '#8A4B08', display: 'flex', marginTop: '1px' }}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#8A4B08"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ flexShrink: 0 }}
          >
            <path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4" />
          </svg>
        </span>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '13px', fontWeight: 700, color: '#8A4B08' }}>
            {system ? 'Restarted automatically' : `Restarted by ${last.by}`} at {hhmm(last.at)}
          </span>
          <span style={{ fontSize: '12.5px', lineHeight: 1.5, color: '#3A2A1E' }}>
            {system && last.rssMb != null && last.limitMb != null ? (
              <>
                It reached <b>{gb(last.rssMb)}</b>, over the {gb(last.limitMb)} limit, so the system restarted it.{' '}
              </>
            ) : null}
            It continues from its session.{' '}
            {system ? (
              <>
                <b>
                  Restart {bySystem} of {AUTO_RESTARTS}
                </b>
                {bySystem < AUTO_RESTARTS
                  ? ': after the last, the next time it goes over the limit the run is stopped.'
                  : ': the next time it goes over the limit the run is stopped.'}
              </>
            ) : (
              <>
                <b>Restart {last.n}</b>
                {restarts.length > 1 ? ` (${restarts.length} in this run)` : ''}.
              </>
            )}
          </span>
          <div style={{ display: 'flex', gap: '8px', marginTop: '4px', flexWrap: 'wrap', alignItems: 'center' }}>
            {onOpenRun && (
              <button type="button" className="st-btn st-btn-sm" onClick={onOpenRun}>
                Open run
              </button>
            )}
            {system && <RaiseLimitButton projectId={run.projectId} />}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The Resources card of the design: RAM and CPU of the run's CLI, live while it runs (the stream says it every 2 s),
 * its peak, its restarts and the last five minutes against the project's limit. After the run only the peak and the
 * last value (saved with the run) are left; a run with no reading at all shows no card.
 */
export function Resources({ ticketId }: { ticketId: string }) {
  const run = useNewestRun(ticketId);
  const streamed = useRunResources(run?.id);
  const [stopping, setStopping] = useState(false);
  const restart = useRestartRun();
  const toast = useToast();
  // a reading goes stale without another event: look at the clock now and then
  const now = useNow(2000);
  if (!run) return null;
  // once the run has ended only what was saved with it is left (the last value, the peak): no chart, no live numbers
  const feed = isActive(run.state) ? streamed : null;
  const live = !!feed && now - feed.at < STALE_MS && feed.run.live;
  const cli = live ? feed.run.cliRssMb : (feed?.run.cliRssMb ?? run.lastRssMb);
  const peak = feed?.run.peakRssMb ?? run.peakRssMb;
  if (cli == null && peak == null) return null;
  const limitMb = feed?.limitMb ?? 0;
  const pct = limitMb > 0 && cli != null ? Math.round((cli / limitMb) * 100) : null;
  const extra = live ? feed.run.extraMb : null;
  const active = ['starting', 'running'].includes(run.state);
  const restarts = (run.restarts ?? []).length;
  return (
    <div className="dz dz-rs" data-testid="resources">
      <div
        style={{
          border: '1px solid #E3E8E5',
          borderRadius: '10px',
          background: '#fff',
          padding: '12px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <b style={{ fontSize: '13px', flex: 1 }}>Resources</b>
          {live ? (
            <span
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#1F5A31' }}
            >
              <span
                style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  background: '#2E6F40',
                  boxShadow: '0 0 0 3px rgba(46,111,64,0.22)',
                  display: 'inline-block',
                }}
              />
              Live &middot; every 2 s
            </span>
          ) : (
            <span style={{ fontSize: '12px', color: '#6B7A70' }}>Last reading</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <Tile
            label={live ? 'CLI RAM now' : isActive(run.state) ? 'CLI RAM at the last reading' : 'CLI RAM at the end'}
            value={gb(cli)}
            hint={
              pct != null
                ? `${pct}% of the limit${extra ? ` · +${(extra / GB).toFixed(1)} GB it started` : ''}`
                : extra
                  ? `+${(extra / GB).toFixed(1)} GB it started`
                  : undefined
            }
          >
            {pct != null && (
              <div className="id-bar" style={{ marginTop: '6px' }}>
                <i
                  style={{
                    width: `${Math.min(100, pct)}%`,
                    // the same rule as the tab and the chip: green under 65 %, amber from 65 %, red from 90 %
                    background: LEVEL_COLOR[levelOf(pct)].bar,
                  }}
                />
              </div>
            )}
          </Tile>
          <Tile label="Peak" value={gb(peak)} hint="this run" />
          <Tile
            label="CPU"
            value={live && feed.run.cpuPct != null ? `${Math.round(feed.run.cpuPct)}%` : '—'}
            hint="of 1 core"
          />
          <Tile label="Restarts" value={String(restarts)} hint={feed ? `limit: ${feed.autoRestarts}` : undefined} />
        </div>
        {feed && feed.run.history.length > 1 && <Chart feed={feed} limitMb={limitMb} />}
        {active && (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="st-btn st-btn-sm"
              data-testid="resources-restart"
              disabled={!live || restart.isPending}
              title={live ? undefined : 'Restart needs a live reading of the CLI'}
              onClick={() =>
                restart.mutate(run.id, { onError: (err) => toast.error("Couldn't restart", extractError(err)) })
              }
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                style={{ flexShrink: 0 }}
              >
                <path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4" />
              </svg>
              Restart
            </button>
            <button
              type="button"
              className="st-btn st-btn-sm"
              style={{ color: '#C4432A', borderColor: '#E8B5A8' }}
              disabled={stopping}
              onClick={() => {
                setStopping(true);
                void aiApi.cancel(run.id).finally(() => setStopping(false));
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                style={{ flexShrink: 0 }}
              >
                <rect x="4" y="5" width="16" height="14" rx="1.5" />
              </svg>
              Stop
            </button>
            <span className="st-hint" style={{ fontSize: '11.5px' }}>
              Restart starts the CLI again inside this run: it resumes and its memory is released.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** The limit one step up: half as much again, in whole GB (4 GB when there is none). */
const nextLimit = (limitMb: number) => Math.round(((limitMb || 4096) * 1.5) / 1024) * 1024;

/**
 * "Raise limit to 3 GB": the project's memory limit of one run, half as much again. The server decides who may change
 * the project's AI settings and says so when it refuses.
 */
function RaiseLimitButton({ projectId }: { projectId: string }) {
  const settings = useAiSettings(projectId).data;
  const toast = useToast();
  const raise = useAiMutation((mb: number) => aiApi.updateSettings(projectId, { runMemoryLimitMb: mb }));
  // no limit at all: nothing to raise
  if (!settings || settings.runMemoryLimitMb <= 0) return null;
  const next = nextLimit(settings.runMemoryLimitMb);
  return (
    <button
      type="button"
      className="st-btn st-btn-sm"
      data-testid="raise-limit"
      disabled={raise.isPending}
      onClick={() =>
        raise.mutate(next, {
          onSuccess: () => toast.success(`Limit raised to ${fmtGb(next)}`),
          onError: (err) => toast.error("Couldn't raise the limit", extractError(err)),
        })
      }
    >
      Raise limit to {fmtGb(next)}
    </button>
  );
}

/**
 * The stop notice of the design (AiResources, "Stopped automatically at 10:58"): the ticket's newest run was stopped
 * by the system because its CLI went over the memory limit once more after its restarts. Partial work is kept; Retry
 * starts a new run, and the limit can be raised first. Nothing for any other run.
 */
export function StopNotice({ ticketId, onOpenRun }: { ticketId: string; onOpenRun?: () => void }) {
  const run = useNewestRun(ticketId);
  const toast = useToast();
  const retry = useAiMutation((id: string) => aiApi.retry(id));
  if (!run || run.stopCode !== 'memory' || isActive(run.state)) return null;
  const restarts = (run.restarts ?? []).filter((r) => r.by === 'system');
  const limitMb = restarts[restarts.length - 1]?.limitMb ?? null;
  return (
    <div className="dz dz-rs" data-testid="memory-stop">
      <div
        style={{
          padding: '11px 13px',
          border: '1px solid #F0C4B8',
          borderRadius: '10px',
          background: '#FDF3F0',
          display: 'flex',
          gap: '10px',
          alignItems: 'flex-start',
        }}
      >
        <span style={{ color: '#A5321E', display: 'flex', marginTop: '1px' }}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#A5321E"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ flexShrink: 0 }}
          >
            <rect x="4" y="5" width="16" height="14" rx="1.5" />
          </svg>
        </span>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '13px', fontWeight: 700, color: '#A5321E' }}>
            Stopped automatically{run.endedAt ? ` at ${hhmm(run.endedAt)}` : ''}
          </span>
          <span style={{ fontSize: '12.5px', lineHeight: 1.5, color: '#3A2A1E' }}>
            It went over {limitMb ? `the ${fmtGb(limitMb)} limit` : 'the memory limit'}
            {restarts.length ? ` again after ${restarts.length} restart${restarts.length === 1 ? '' : 's'}` : ''}
            {run.peakRssMb ? (
              <>
                {' '}
                (peak <b>{gb(run.peakRssMb)}</b>)
              </>
            ) : null}
            . Partial work in the folder is kept.
          </span>
          <div style={{ display: 'flex', gap: '8px', marginTop: '4px', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="st-btn st-btn-primary st-btn-sm"
              data-testid="memory-stop-retry"
              disabled={retry.isPending}
              onClick={() =>
                retry.mutate(run.id, { onError: (err) => toast.error("Couldn't retry", extractError(err)) })
              }
            >
              Retry
            </button>
            <RaiseLimitButton projectId={run.projectId} />
            {onOpenRun && (
              <button type="button" className="st-btn st-btn-sm" onClick={onOpenRun}>
                Open run
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
