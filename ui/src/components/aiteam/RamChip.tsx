import type { ResourceRun, ResourceSnapshot } from '../../types/aiResources';
import { LEVEL_COLOR, fmtMb, levelOf, limitPct } from './resourcesFormat';

const FILL = { ok: '#E6F2EA', warn: '#FEF3D9', bad: '#FDF3F0' } as const;

/** The live rows of a snapshot by run id, for the cards that show a chip. */
export function rowsByRun(snap: ResourceSnapshot | null): Map<string, ResourceRun> {
  return new Map((snap?.runs ?? []).filter((r) => r.live).map((r) => [r.runId, r]));
}

/**
 * RAM of a run's Claude Code on a team card and on the team page (design/screens/ai-resources.md, C1). Green below 65%
 * of the memory limit, amber from 65%, red from 90%; amber and red write the share ("76% of its limit") so the colour
 * is never the only signal. A restart by the system is written on it too. Nothing before the first reading.
 */
export function RamChip({
  run,
  limitMb,
  onOpen,
}: {
  run: ResourceRun | undefined;
  limitMb: number;
  /** Opens the Resources tab. */
  onOpen?: () => void;
}) {
  if (!run || !run.readable || run.cliRssMb == null) return null;
  const pct = limitPct(run.cliRssMb, limitMb);
  const level = limitMb > 0 ? levelOf(pct) : 'ok';
  const restarts = run.restarts.length;
  const title = [
    `Claude Code ${fmtMb(run.cliRssMb)}${limitMb > 0 ? ` of ${fmtMb(limitMb)} (${pct}%)` : ''}`,
    run.peakRssMb != null ? `peak ${fmtMb(run.peakRssMb)}` : null,
    run.extraMb ? `+${fmtMb(run.extraMb)} from what it started (not counted)` : null,
    restarts ? `${restarts} restart${restarts === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const body = (
    <>
      <span className="rs-chip-bar">
        <i style={{ width: `${Math.min(100, pct)}%`, background: LEVEL_COLOR[level].bar }} />
      </span>
      RAM {fmtMb(run.cliRssMb)}
      {level !== 'ok' && <span style={{ fontWeight: 500 }}>· {pct}% of its limit</span>}
      {restarts > 0 && (
        <span style={{ fontWeight: 500 }}>· restarted {restarts === 1 ? 'once' : `${restarts} times`}</span>
      )}
    </>
  );
  const style = { background: FILL[level], color: LEVEL_COLOR[level].text, border: 'none' } as const;
  return onOpen ? (
    <button
      type="button"
      className="rs-chip"
      style={{ ...style, cursor: 'pointer' }}
      title={title}
      data-testid="ram-chip"
      data-level={level}
      onClick={onOpen}
    >
      {body}
    </button>
  ) : (
    <span className="rs-chip" style={style} title={title} data-testid="ram-chip" data-level={level}>
      {body}
    </span>
  );
}
