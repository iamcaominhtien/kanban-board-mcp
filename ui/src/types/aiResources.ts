/** RAM and CPU of the running AIs (design/screens/ai-resources.md; server/services/ai/resources.py). */

/** One time the CLI was started again inside a run, by the system (over the memory limit) or by a person. */
export interface RestartEntry {
  at: string;
  rssMb: number | null;
  limitMb: number | null;
  /** "system" or the name of the person or AI who pressed Restart. */
  by: string;
  /** 1-based number of this restart in the run. */
  n: number;
}

export interface ResourcePoint {
  at: string;
  rssMb: number;
  cpuPct: number | null;
}

/** A row of the Resources tab: a run with the numbers of its CLI process. */
export interface ResourceRun {
  runId: string;
  number: number;
  memberId: string;
  memberName: string | null;
  memberColor: string | null;
  ticketId: string;
  ticketTitle: string | null;
  state: string;
  startedAt: string | null;
  endedAt: string | null;
  /** A CLI is running now (otherwise the run ended recently and the row shows its final values). */
  live: boolean;
  readable: boolean;
  /** The CLI process only: what the limit counts. */
  cliRssMb: number | null;
  /** What the CLI started (a test, a build): shown apart, never counted. */
  extraMb: number | null;
  /** Of one core (200 = two cores), the CLI and what it started together. */
  cpuPct: number | null;
  peakRssMb: number | null;
  restarts: RestartEntry[];
  history: ResourcePoint[];
}

export interface MachineNumbers {
  ramTotalMb: number;
  ramFreeMb: number;
  load1: number | null;
  cores: number;
  aiRssMb: number;
  cliCount: number;
}

export interface ResourceSnapshot {
  at: string;
  machine: MachineNumbers;
  limits: { runMemoryLimitMb: number; autoRestarts: number; boardMaxParallel: number };
  runs: ResourceRun[];
}

/** What a Now card shows of its current run: the chip. */
export interface CardMemory {
  cliRssMb: number | null;
  extraMb: number | null;
  cpuPct: number | null;
  peakRssMb: number | null;
  readable: boolean;
  restarts: number;
  limitMb: number;
}
