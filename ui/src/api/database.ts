import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { forgetBoardOfWindow } from './boardOfWindow';
import { client } from './client';

/**
 * App settings › Storage & backup › Database (design/screens/ai-databases.md B to E): the database in use, a test of
 * another one, and the move to it (check, copy, verify, switch) with an AI's help when a copy stops.
 */

export type Engine = 'sqlite' | 'postgresql' | 'mysql';
export type SslMode = 'off' | 'prefer' | 'require' | 'verify-full';
export type FindingLevel = 'ok' | 'warn' | 'error' | 'info';

/** The settings people may see (never the password). */
export interface DatabaseSettings {
  engine: Engine;
  host?: string | null;
  port?: number | null;
  name?: string | null;
  user?: string | null;
  ssl?: SslMode | null;
  path?: string | null;
}

/** A database as the server names it: its settings plus a label ("PostgreSQL") and where it is. */
export interface NamedTarget extends DatabaseSettings {
  label: string;
  display: string;
}

/** GET /database: the database in use. */
export interface DatabaseInfo {
  engine: Engine;
  label: string;
  /** "user@host:port/name", or the file's path. */
  display: string;
  settings: DatabaseSettings;
  source: 'environment' | 'settings' | 'default';
  /** KANBAN_DATABASE_URL is set: the card is read-only (B3). */
  locked: boolean;
  envVar: string;
  passwordStore: 'keychain' | 'file';
  passwordSaved: boolean;
  dataFolder: string;
  sqliteFile: { path: string; exists: boolean; size: number | null; modified: number | null };
  reachable: boolean;
  latencyMs?: number | null;
  tickets?: number;
  /** The schema's migration and whether it is the newest this app knows (null: could not tell). */
  revision?: string | null;
  atHead?: boolean | null;
  projects?: number;
  aiMembers?: number;
  tables?: number | null;
  /** Bytes (SQLite only). */
  size?: number | null;
  version?: string | null;
  /** Server only: is the connection encrypted. */
  secure?: boolean | null;
  /** Server only: other apps connected to the same database. */
  otherApps?: number | null;
  unreachable: { since: number; error: string; target: NamedTarget } | null;
  move: MoveJob | null;
}

/** One line of "What the test found". */
export interface Finding {
  key: string;
  level: FindingLevel;
  title: string;
  detail: string;
  /** SQL to copy; may be empty. */
  fix: string;
  fixLabel: string;
}

/** POST /database/test. */
export interface TestReport {
  target: DatabaseSettings;
  findings: Finding[];
  reached: boolean;
  version: string | null;
  latencyMs: number | null;
  state: 'empty' | 'board' | 'foreign' | 'newer' | 'unknown';
  tables: number | null;
  revision: string | null;
  /** Tickets of a board already there. */
  tickets: number | null;
  secure: boolean | null;
  otherApps: number | null;
  /** No red line: Next may go on. */
  ok: boolean;
}

/** The form's fields (or a connection string in `url`). */
export interface ConnectionBody {
  engine?: Engine;
  host?: string;
  port?: number;
  name?: string;
  user?: string;
  password?: string;
  ssl?: SslMode;
  path?: string;
  url?: string;
  /** Use the saved password of the database in use (Edit connection without typing it again). */
  keepPassword?: boolean;
}

export type MoveState =
  | 'new'
  | 'ready'
  | 'copying'
  | 'pausing'
  | 'paused'
  | 'stopped'
  | 'verifying'
  | 'verified'
  | 'verified_with_differences'
  | 'failed'
  | 'cancelled'
  | 'switching'
  | 'switched'
  | 'interrupted';

export interface PlanNote {
  key: string;
  title: string;
  detail: string;
}

export interface PlanProblem extends PlanNote {
  level: FindingLevel;
  table?: string;
  column?: string;
}

/** Step 2: what will be copied. */
export interface MovePlan {
  source: NamedTarget & {
    size: number | null;
    tables: number;
    rows: number;
    tickets: number;
    projects: number;
    aiMembers: number;
    atHead: boolean;
  };
  target: NamedTarget;
  tables: { name: string; rows: number }[];
  rows: number;
  /** The attachments that stay in the data folder. */
  attachments?: { folder: string; files: number; size: number };
  extraTables: string[];
  notes: PlanNote[];
  problems: PlanProblem[];
  tablesCount: number;
}

export interface MoveTable {
  name: string;
  rows: number;
  copied: number;
  state: 'waiting' | 'copying' | 'done' | 'stopped';
}

/** Where and why a copy stopped (D4). */
export interface MoveStop {
  table: string;
  row: number;
  copied: number;
  total: number;
  tablesDone: number;
  tablesTotal: number;
  error: string;
  code: string;
  column: string | null;
  valueLength: number | null;
  valueNull: boolean;
  sourceType: string | null;
  targetType: string | null;
  sourceEngine: string;
  targetEngine: string;
  targetVersion: string;
}

export interface VerifyResult {
  ok: boolean;
  checks: { key: string; ok: boolean; title: string }[];
  tables?: { name: string; source: number; target: number; same: boolean }[];
  rows?: number;
  differ?: string[];
  elapsedS?: number | null;
  empty?: boolean;
}

/** What the AI proposes for a stopped copy. */
export interface AiProposal {
  cause: string;
  statements: string[];
  affects: string;
  otherColumns: string[];
  confidence: string;
  answer: string;
  applicable: boolean;
  refused: string | null;
  /** The AI member that answered. */
  member: string;
  elapsedS: number | null;
  cost: number | null;
  /** The exact facts the AI was given. */
  shown: unknown;
}

export interface MoveAi {
  state: 'idle' | 'asking' | 'answered' | 'failed';
  message?: string;
  question?: string | null;
  /** The AI member asked (known as soon as the question is sent). */
  member?: string;
  proposal?: AiProposal;
}

/** GET /database/move: the move in progress (or one an interruption left). */
export interface MoveJob {
  id: string;
  state: MoveState;
  mode: 'copy' | 'empty' | null;
  source: NamedTarget;
  target: NamedTarget;
  plan: MovePlan | null;
  report: TestReport | null;
  tables: MoveTable[];
  tablesDone: number;
  tablesTotal: number;
  rowsTotal: number;
  rowsDone: number;
  current: string | null;
  elapsedS: number | null;
  leftS: number | null;
  stop: MoveStop | null;
  verify: VerifyResult | null;
  error: { code: string; message: string } | null;
  ai: MoveAi;
  resumeAt: string | null;
  applied: string[];
}

/** GET /database/command: the script that runs the same copy (D0, D3). */
export interface MoveCommand {
  dryRun: string;
  run: string;
  passwordEnv: string;
}

/** GET /database/health. */
export interface DatabaseHealth {
  ok: boolean;
  latencyMs?: number;
  error?: string;
  unreachable: unknown;
  retryS: number;
}

export const databaseKey = ['database'] as const;
export const moveKey = ['database', 'move'] as const;

/** The move states in which the page asks again every second. */
const RUNNING: MoveState[] = ['copying', 'pausing', 'verifying', 'switching'];

/** True while a copy runs (or the AI is answering): the wizard polls. */
export function moveIsBusy(job: MoveJob | null | undefined): boolean {
  if (!job) return false;
  return RUNNING.includes(job.state) || job.ai?.state === 'asking';
}

/** A move worth a strip on the card: started and not finished, closed or cancelled. */
export function moveIsOpen(job: MoveJob | null | undefined): boolean {
  if (!job) return false;
  return !['new', 'ready', 'cancelled', 'switched'].includes(job.state);
}

/** Read the database in use. */
export async function getDatabase(): Promise<DatabaseInfo> {
  return (await client.get<DatabaseInfo>('/database')).data;
}

/** Ask whether the database answers now (the reconnect screen). */
export async function getDatabaseHealth(): Promise<DatabaseHealth> {
  return (await client.get<DatabaseHealth>('/database/health')).data;
}

/** The database in use (the card). */
export function useDatabase() {
  return useQuery({ queryKey: databaseKey, queryFn: getDatabase, staleTime: 15_000 });
}

/** The move in progress; polls every second while it runs. */
export function useMove(enabled = true) {
  return useQuery({
    queryKey: moveKey,
    queryFn: async () => (await client.get<MoveJob | null>('/database/move')).data ?? null,
    enabled,
    refetchInterval: (q) => (moveIsBusy(q.state.data) ? 1000 : false),
  });
}

/** The CLI commands for the same copy, to a target given as a URL (without the password). */
export function useMoveCommand(target: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['database', 'command', target],
    queryFn: async () =>
      (await client.get<MoveCommand>('/database/command', { params: target ? { target } : {} })).data,
    enabled,
  });
}

/** Test a database; nothing is changed. */
export function useTestConnection() {
  return useMutation({
    mutationFn: async (body: ConnectionBody) => (await client.post<TestReport>('/database/test', body)).data,
  });
}

function setMove(qc: QueryClient, job: MoveJob | null) {
  qc.setQueryData(moveKey, job);
}

/** A move action that answers with the job: the answer replaces the cached move. */
function useMoveAction<B = void>(path: string, method: 'post' | 'delete' = 'post') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: B) => {
      const res = method === 'delete' ? await client.delete(path) : await client.post<MoveJob>(path, body ?? undefined);
      return res.data as MoveJob;
    },
    onSuccess: (job) => {
      if (method === 'delete') {
        setMove(qc, null);
        void qc.invalidateQueries({ queryKey: databaseKey, exact: true });
      } else setMove(qc, job);
    },
  });
}

/** Step 2: test the target again and read the plan (422 with detail.report when the target fails the test). */
export function useMoveCheck() {
  return useMoveAction<ConnectionBody>('/database/move/check');
}

/** Step 3: copy (or start empty); `confirm` is the target's name when `emptyFirst`. */
export function useMoveStart() {
  return useMoveAction<{ mode: 'copy' | 'empty'; emptyFirst?: boolean; confirm?: string }>('/database/move/start');
}

/** Pause the copy at the next batch. */
export function useMovePause() {
  return useMoveAction('/database/move/pause');
}

/** Resume from the table it stopped in (or `startAt`), or start over with `restart`. */
export function useMoveResume() {
  return useMoveAction<{ startAt?: string; restart?: boolean }>('/database/move/resume');
}

/** Cancel and clear the new database. */
export function useMoveCancel() {
  return useMoveAction('/database/move/cancel');
}

/** Close a move that is not running ("Keep SQLite, switch later", or closing the wizard before a copy). */
export function useForgetMove() {
  return useMoveAction('/database/move', 'delete');
}

/** Ask the AI about the stop (it answers in the background; the move polls). */
export function useMoveAsk() {
  return useMoveAction<{ question?: string }>('/database/move/ask');
}

/** Run statements on the new database and resume the copy (422 {code: refused | apply}). */
export function useMoveApply() {
  return useMoveAction<{ statements: string[] }>('/database/move/apply');
}

/** Switch the board to the new database now; every query is read again from it. */
export function useMoveSwitch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      (await client.post<{ move: MoveJob; database: DatabaseInfo }>('/database/move/switch')).data,
    onSuccess: (data) => {
      qc.setQueryData(moveKey, data.move);
      qc.setQueryData(databaseKey, data.database);
      // this window moved the board: it goes on with the board at its new place
      forgetBoardOfWindow();
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'database' });
    },
  });
}

/** Edit connection: the same server database reached another way (422 detail.code "not_this_board"). */
export function useSaveConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: ConnectionBody) => (await client.post<DatabaseInfo>('/database/connection', body)).data,
    onSuccess: (db) => {
      qc.setQueryData(databaseKey, db);
      // this window moved the board: it goes on with the board at its new place
      forgetBoardOfWindow();
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'database' });
    },
  });
}

/** Use the SQLite file in the data folder again, as it was when the board left it. */
export function useUseSqlite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await client.post<DatabaseInfo>('/database/use-sqlite')).data,
    onSuccess: (db) => {
      qc.setQueryData(databaseKey, db);
      // this window moved the board: it goes on with the board at its new place
      forgetBoardOfWindow();
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'database' });
    },
  });
}

/** The test report a failed check carries in its 422 detail, if any. */
export function reportOfError(err: unknown): TestReport | null {
  const detail = (err as { response?: { data?: { detail?: { report?: unknown } } } } | null)?.response?.data?.detail;
  const report = detail && typeof detail === 'object' ? detail.report : null;
  if (!report || typeof report !== 'object') return null;
  // error bodies are not camel-cased by the client
  const r = report as Record<string, unknown>;
  const findings = Array.isArray(r.findings) ? (r.findings as Record<string, unknown>[]) : [];
  return {
    ...(r as unknown as TestReport),
    latencyMs: (r.latency_ms as number | null) ?? null,
    otherApps: (r.other_apps as number | null) ?? null,
    findings: findings.map((f) => ({ ...(f as unknown as Finding), fixLabel: String(f.fix_label ?? '') })),
  };
}
