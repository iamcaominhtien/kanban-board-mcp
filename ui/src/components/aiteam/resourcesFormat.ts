import type { ResourceRun, ResourceSnapshot } from '../../types/aiResources';

/** A bar is green below 65% of the limit, amber from 65%, red from 90% (design/screens/ai-resources.md, B2). */
export type Level = 'ok' | 'warn' | 'bad';

export const LEVEL_COLOR: Record<Level, { bar: string; text: string }> = {
  ok: { bar: '#2E6F40', text: '#1F5A31' },
  warn: { bar: '#B8860B', text: '#7A5A06' },
  bad: { bar: '#C4432A', text: '#A5321E' },
};

/** Restarts by the system before the next breach stops the run (the server's `AUTO_RESTARTS`). */
export const AUTO_RESTARTS = 2;

/** "200 MB", "1.52 GB". */
export function fmtMb(mb: number | null | undefined): string {
  if (mb == null) return '—';
  return mb < 1000 ? `${Math.round(mb)} MB` : `${(mb / 1024).toFixed(2)} GB`;
}

/** "7.1 GB", "16 GB": one decimal, none when it is round. */
export function fmtGb(mb: number): string {
  const gb = mb / 1024;
  return Number.isInteger(Math.round(gb * 10) / 10) ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

/** The share of the limit a run's CLI is using (0 when there is no limit). */
export function limitPct(rssMb: number | null, limitMb: number): number {
  return rssMb != null && limitMb > 0 ? Math.round((rssMb / limitMb) * 100) : 0;
}

/** Green, amber or red for a share of the limit. */
export function levelOf(pct: number): Level {
  return pct >= 90 ? 'bad' : pct >= 65 ? 'warn' : 'ok';
}

export interface Verdict {
  tone: 'ok' | 'warn' | 'bad' | 'idle';
  title: string;
  text: string;
  /** The run to blame, for the "Restart now" button. */
  runId?: string;
}

/** The one-line answer of the tab: is the machine OK. Red when free RAM is under 10%, amber when a run is climbing. */
export function verdictOf(snap: ResourceSnapshot): Verdict {
  const { machine, limits } = snap;
  const live = snap.runs.filter((r) => r.live);
  const freePct = machine.ramTotalMb ? (machine.ramFreeMb / machine.ramTotalMb) * 100 : 100;
  if (freePct < 10) {
    return {
      tone: 'bad',
      title: `Free RAM is low: ${fmtGb(machine.ramFreeMb)} of ${fmtGb(machine.ramTotalMb)}`,
      text: `AI processes use ${fmtMb(machine.aiRssMb)}. Lower the runs at the same time or stop one run.`,
    };
  }
  const top = live
    .filter((r) => r.readable && r.cliRssMb != null)
    .map((r) => ({ run: r, pct: limitPct(r.cliRssMb, limits.runMemoryLimitMb) }))
    .sort((a, b) => b.pct - a.pct)[0];
  if (top && top.pct >= 65) {
    return {
      tone: 'warn',
      title: 'The machine is fine. One run is climbing.',
      text: `${top.run.memberName ?? 'An AI'} on ${top.run.ticketId} is at ${fmtMb(top.run.cliRssMb)} of its ${fmtGb(limits.runMemoryLimitMb)} limit (${top.pct}%).`,
      runId: top.run.runId,
    };
  }
  if (!live.length) {
    const room = Math.min(limits.boardMaxParallel, Math.max(0, Math.floor(machine.ramFreeMb / 1024)));
    return {
      tone: 'idle',
      title: 'No AI is running right now.',
      text: `The machine has room for ${room} ${room === 1 ? 'run' : 'runs'} at once: even at 1 GB each they fit in the ${fmtGb(machine.ramFreeMb)} that is free.`,
    };
  }
  return {
    tone: 'ok',
    title: 'The machine is fine.',
    text: `${live.length} ${live.length === 1 ? 'AI is' : 'AIs are'} running, using ${fmtMb(machine.aiRssMb)} in all.`,
  };
}

/** The settings estimate under "memory limit" and "runs at the same time". It warns, it never blocks saving. */
export function fitEstimate(
  runs: number,
  limitMb: number,
  machine: { ramTotalMb: number; ramFreeMb: number },
): { fits: boolean; text: string } {
  const normal = runs * 180;
  if (limitMb > 0 && runs * limitMb > machine.ramTotalMb) {
    return {
      fits: false,
      text: `${runs} runs at up to ${fmtGb(limitMb)} can use ${fmtGb(runs * limitMb)}. This machine has ${fmtGb(machine.ramTotalMb)}.`,
    };
  }
  return {
    fits: true,
    text: `${runs} runs at about 180 MB each use ${fmtMb(normal)}; ${fmtGb(machine.ramFreeMb)} of ${fmtGb(machine.ramTotalMb)} is free now.${limitMb > 0 ? ` A run that leaks is restarted at ${fmtGb(limitMb)}.` : ''}`,
  };
}

/** Points of a run's RAM line in a `width` x `height` box, the last `windowS` seconds up to `now`. */
export function linePoints(
  history: ResourceRun['history'],
  now: number,
  windowS: number,
  maxMb: number,
  width: number,
  height: number,
): string {
  const from = now - windowS * 1000;
  return history
    .map((p) => ({ t: Date.parse(p.at), v: p.rssMb }))
    .filter((p) => p.t >= from && Number.isFinite(p.t))
    .map((p) => {
      const x = ((p.t - from) / (windowS * 1000)) * width;
      const y = height - Math.min(1, p.v / maxMb) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}
