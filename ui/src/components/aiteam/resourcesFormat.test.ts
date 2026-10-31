import { describe, expect, it } from 'vitest';
import type { ResourceRun, ResourceSnapshot } from '../../types/aiResources';
import { fitEstimate, fmtGb, fmtMb, levelOf, limitPct, linePoints, verdictOf } from './resourcesFormat';

const run = (over: Partial<ResourceRun> = {}): ResourceRun => ({
  runId: 'run_1',
  number: 1,
  memberId: 'm1',
  memberName: 'Dev',
  memberColor: '#2E6F40',
  ticketId: 'KAN-212',
  ticketTitle: 'Cost on cards',
  state: 'running',
  startedAt: null,
  endedAt: null,
  live: true,
  readable: true,
  cliRssMb: 200,
  extraMb: 0,
  cpuPct: 10,
  peakRssMb: 210,
  restarts: [],
  history: [],
  ...over,
});

const snap = (runs: ResourceRun[], over: Partial<ResourceSnapshot['machine']> = {}): ResourceSnapshot => ({
  at: '2026-10-31T10:00:00Z',
  machine: { ramTotalMb: 16384, ramFreeMb: 9000, load1: 2, cores: 8, aiRssMb: 400, cliCount: runs.length, ...over },
  limits: { runMemoryLimitMb: 2048, autoRestarts: 2, boardMaxParallel: 6 },
  runs,
});

describe('formatting', () => {
  it('writes MB below a GB and GB above', () => {
    expect(fmtMb(200)).toBe('200 MB');
    expect(fmtMb(1556)).toBe('1.52 GB');
    expect(fmtMb(null)).toBe('—');
    expect(fmtGb(16384)).toBe('16 GB');
    expect(fmtGb(7270)).toBe('7.1 GB');
  });
  it('is green below 65%, amber from 65%, red from 90%', () => {
    expect(levelOf(64)).toBe('ok');
    expect(levelOf(65)).toBe('warn');
    expect(levelOf(89)).toBe('warn');
    expect(levelOf(90)).toBe('bad');
    expect(limitPct(1536, 2048)).toBe(75);
    expect(limitPct(1536, 0)).toBe(0);
  });
});

describe('verdictOf', () => {
  it('is amber and names the run that climbs', () => {
    const v = verdictOf(snap([run({ cliRssMb: 1556 }), run({ runId: 'run_2', cliRssMb: 180 })]));
    expect(v.tone).toBe('warn');
    expect(v.runId).toBe('run_1');
    expect(v.text).toContain('KAN-212');
  });
  it('is red when free RAM is under 10%', () => {
    expect(verdictOf(snap([run()], { ramFreeMb: 900 })).tone).toBe('bad');
  });
  it('says how many runs fit when nothing runs', () => {
    const v = verdictOf(snap([]));
    expect(v.tone).toBe('idle');
    expect(v.text).toContain('room for 6 runs');
  });
  it('is fine when every run is far from its limit', () => {
    expect(verdictOf(snap([run()])).tone).toBe('ok');
  });
  it('ignores ended rows and unreadable runs', () => {
    expect(verdictOf(snap([run({ live: false, cliRssMb: 2000 }), run({ readable: false, cliRssMb: null })])).tone).toBe(
      'ok',
    );
  });
});

describe('fitEstimate', () => {
  const machine = { ramTotalMb: 16384, ramFreeMb: 9000 };
  it('fits for normal runs', () => {
    const f = fitEstimate(6, 2048, machine);
    expect(f.fits).toBe(true);
    expect(f.text).toContain('6 runs at about 180 MB');
  });
  it('warns when the worst case is more than the machine', () => {
    const f = fitEstimate(6, 4096, machine);
    expect(f.fits).toBe(false);
    expect(f.text).toBe('6 runs at up to 4 GB can use 24 GB. This machine has 16 GB.');
  });
});

describe('linePoints', () => {
  it('draws only the last five minutes, bottom is 0 MB and top is the maximum', () => {
    const now = Date.parse('2026-10-31T10:05:00Z');
    const pts = linePoints(
      [
        { at: '2026-10-31T09:59:00Z', rssMb: 100, cpuPct: null },
        { at: '2026-10-31T10:02:30Z', rssMb: 1000, cpuPct: null },
        { at: '2026-10-31T10:05:00Z', rssMb: 2000, cpuPct: null },
      ],
      now,
      300,
      2000,
      300,
      100,
    );
    expect(pts).toBe('150.0,50.0 300.0,0.0');
  });
});
