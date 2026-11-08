import { useResourcesStream } from '../../api/aiResources';
import type { AiRun } from '../../types/ai';
import { LEVEL_COLOR, fmtGb, fmtMb, levelOf, limitPct, linePoints } from '../aiteam/resourcesFormat';
import '../aiteam/resources.css';

function clock(iso: string | null | undefined): string {
  const t = iso ? new Date(iso) : null;
  return t && !Number.isNaN(t.getTime()) ? t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}

/** "Restarted automatically at 10:50" on a run whose CLI was started again inside it (design/screens/ai-resources.md, D1). */
export function RestartNotice({ run }: { run: AiRun }) {
  const last = run.restarts?.[run.restarts.length - 1];
  if (!last) return null;
  const system = last.by === 'system';
  const limit = last.limitMb ? fmtGb(last.limitMb) : null;
  return (
    <div
      className="rs-notice"
      style={{ borderColor: '#F0CDA0', background: '#FFF4E5' }}
      role="status"
      data-testid="restart-notice"
    >
      <b style={{ color: '#8A4B08' }}>
        {system ? 'Restarted automatically' : `Restarted by ${last.by}`} at {clock(last.at)}
      </b>
      <span>
        {system
          ? `It reached ${fmtMb(last.rssMb)}${limit ? `, over the ${limit} limit` : ''}, so the system restarted it. It continues from its session. `
          : 'It continues from its session. '}
        {system && (
          <>
            <b>Restart {run.restarts?.filter((r) => r.by === 'system').length} of 2</b>: after the second, the next time
            it goes over the limit the run is stopped.
          </>
        )}
      </span>
    </div>
  );
}

function Mini({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rs-mini">
      <div className="rs-h">{label}</div>
      <div className="rs-big">{value}</div>
      {hint && <div className="at-hint-sm">{hint}</div>}
    </div>
  );
}

/** The Resources strip of a running run: RAM now, peak, CPU, restarts and a 5-minute line (design F1). Stop is on the run card; Restart is in the tab. */
export function RunResourcesStrip({ run }: { run: AiRun }) {
  const { data: snap, live } = useResourcesStream(run.projectId);
  const row = snap?.runs.find((r) => r.runId === run.id);
  if (!snap || !row || !row.readable) return null;
  const limit = snap.limits.runMemoryLimitMb;
  const pct = limitPct(row.cliRssMb, limit);
  const level = levelOf(pct);
  const maxMb = Math.max(limit > 0 ? limit : 0, ...row.history.map((p) => p.rssMb), 512);
  const W = 600;
  const H = 70;
  return (
    <div className="rs-strip" data-testid="run-resources">
      <div className="rs-strip-head">
        <b>Resources</b>
        <span className="at-hint" style={{ color: live ? '#1F5A31' : '#5B6B60' }}>
          {live ? 'Live · every 2 s' : 'Not live'}
        </span>
      </div>
      <div className="rs-minis">
        <Mini
          label="CLI RAM now"
          value={fmtMb(row.cliRssMb)}
          hint={`${limit > 0 ? `${pct}% of the limit` : 'no limit'}${row.extraMb && row.extraMb >= 50 ? ` · +${fmtMb(row.extraMb)} it started` : ''}`}
        />
        <Mini label="Peak" value={fmtMb(row.peakRssMb)} hint="this run" />
        <Mini label="CPU" value={row.cpuPct != null ? `${Math.round(row.cpuPct)}%` : '—'} hint="of 1 core" />
        <Mini label="Restarts" value={String(row.restarts.length)} hint={`limit: ${snap.limits.autoRestarts}`} />
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="rs-chart" role="img" aria-label="RAM of this run, last 5 minutes">
        {limit > 0 && limit <= maxMb && (
          <line
            x1="0"
            x2={W}
            y1={H - (limit / maxMb) * H}
            y2={H - (limit / maxMb) * H}
            stroke="#C4432A"
            strokeDasharray="5 4"
          />
        )}
        <polyline
          fill="none"
          stroke={LEVEL_COLOR[level].bar}
          strokeWidth="2"
          points={linePoints(row.history, Date.parse(snap.at), 300, maxMb, W, H)}
        />
      </svg>
    </div>
  );
}
