import { useQuery } from '@tanstack/react-query';
import { client } from '../../../api/client';
import type { AiConfig } from '../../../types/ai';

/** One problem found in a (draft) configuration; errors block Save. */
export interface ConfigIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
  line?: number | null;
  hint?: string | null;
  tool?: string;
}

export interface DocumentedItem {
  key: string;
  label: string;
  group: string;
  done: boolean;
  stale: boolean;
  by: string | null;
  at: string | null;
  empty: boolean;
}

export interface ConfigStatus {
  version: number;
  syncedAt: string | null;
  syncedFiles: number;
  declares: number;
  groupsTotal: number;
  runner: { online: boolean; reason: string | null; folder: string | null };
  documented: DocumentedItem[];
  documentedDone: number;
  skipped: { group: string; names: string[] }[];
  hooksConfirmed: boolean;
  hooksBy: string | null;
  instructionsTokens: number;
  undo: { at: string; by: string | null; daysLeft: number } | null;
  issues: ConfigIssue[];
  endpoint: string;
}

export interface DiffRow {
  t: '+' | '-' | ' ' | '…';
  n: number | null;
  text: string;
}

export interface PlannedFile {
  path: string;
  action: 'new' | 'modified' | 'delete' | 'error';
  added: number;
  removed: number;
  diff: DiffRow[];
  error: string | null;
  foreign: boolean;
  conflict: boolean;
}

export interface Backup {
  id: string;
  at: string;
  size: number;
}

export interface ConflictInfo {
  path: string;
  unit: string;
  kind: 'edited' | 'removed' | 'exists';
  writtenAt: string | null;
  editedAt: string | null;
  diff: DiffRow[];
  backups: Backup[];
}

export interface SyncPreview {
  mode: 'synced' | 'experimental' | 'none';
  runner: { online: boolean; reason: string | null; folder: string | null };
  files: PlannedFile[];
  conflicts: ConflictInfo[];
  hooksPending: boolean;
  hooksHash: string;
  pending: number;
  backups: { path: string; items: Backup[] }[];
  syncedAt: string | null;
  syncedFiles: number;
}

export interface WriteResult {
  ok: boolean;
  written: string[];
  conflicts: ConflictInfo[];
  error: { path: string; message: string } | null;
  offline?: boolean;
  hooksPending?: boolean;
}

export interface ProbeResult {
  ok: boolean | null;
  tools: number;
  seconds: number;
  error: string | null;
  state: 'checked' | 'documented';
}

export interface ToolCheck {
  ok: boolean;
  problems: { path: string; message: string; line: number | null; hint: string | null }[];
  name: string | null;
  method: string;
  url: string | null;
  sampleArgs: string;
}

export interface ToolTestResult {
  ok: boolean;
  status: number | null;
  body: string;
  seconds: number;
  method: string;
  url: string;
}

export interface PromptPreview {
  system: string;
  user: string;
  used: string[];
  promptTokens: number;
  systemTokens: number;
  userTokens: number;
  sources: { ticket: number; docs: number; comments: number; subTickets: number };
  docs: { pageId: string; title: string; tokens: number; cut: boolean }[];
  ticketId: string;
}

export interface DryRunRow {
  step: number;
  name: string;
  detail: string;
  tokensIn: number | null;
  tokensOut: number | null;
  seconds: number;
  tone: 'plain' | 'blocked' | 'simulated' | 'error';
}

export interface DryRunResult {
  ticketId: string;
  state: 'finished' | 'step_limit' | 'token_limit' | 'timed_out' | 'error';
  stepsUsed: number;
  maxSteps: number;
  seconds: number;
  rows: DryRunRow[];
  tokensIn: number;
  tokensOut: number;
  maxTokens: number;
  costUsd: number;
  estimateMaxUsd: number;
  finalText: string;
  notes: string[];
}

export interface ImportPreview {
  adapterMatches: boolean;
  summary: string;
  added: Record<string, number>;
  secretsMissing: string[];
  config: AiConfig;
  errors: ConfigIssue[];
  skipped: { group: string; names: string[] }[];
}

export interface ModelList {
  source: 'aliases' | 'provider' | 'builtin' | 'none';
  models: { id: string; label: string }[];
  error: string | null;
}

export interface CapabilityMatrix {
  groups: { key: string; label: string }[];
  adapters: {
    key: string;
    label: string;
    sub: string;
    cells: Record<string, { mode: 'synced' | 'documented' | 'not_supported'; note: string }>;
  }[];
}

export type LibraryType = 'skill' | 'snippet' | 'mcp_server' | 'tool';

export interface LibraryRow {
  id: string;
  type: LibraryType;
  typeLabel: string;
  name: string;
  description: string;
  version: number;
  usedBy: number;
  behind: number;
  updatedAt: string;
}

export interface LibraryUser {
  memberId: string;
  name: string;
  provider: string;
  adapter: string;
  version: number;
  mode: 'synced' | 'documented' | 'skipped';
  behind: boolean;
}

export interface LibraryItem extends LibraryRow {
  content: string;
  history: { version: number; at: string; by: string | null; note: string | null }[];
  users: LibraryUser[];
}

export const configKeys = {
  status: (id: string) => ['ai', 'config-status', id] as const,
  matrix: ['ai', 'providers-matrix'] as const,
  library: (projectId: string, type?: string, q?: string) => ['ai', 'library', projectId, type ?? '', q ?? ''] as const,
  libraryItem: (id: string) => ['ai', 'library-item', id] as const,
};

/** Version, last sync, ticks, runner state of a member's configuration. */
export function useConfigStatus(memberId: string) {
  return useQuery({
    queryKey: configKeys.status(memberId),
    queryFn: async () => (await client.get<ConfigStatus>(`/ai/members/${memberId}/config/status`)).data,
  });
}

/** The capability matrix of the adapters (A2). */
export function useCapabilityMatrix() {
  return useQuery({
    queryKey: configKeys.matrix,
    queryFn: async () =>
      (await client.get<{ capabilityMatrix: CapabilityMatrix }>('/ai/providers')).data.capabilityMatrix,
    staleTime: 60 * 60 * 1000,
  });
}

/** The board library (E1). */
export function useLibrary(projectId: string, type?: string, q?: string) {
  return useQuery({
    queryKey: configKeys.library(projectId, type, q),
    queryFn: async () =>
      (
        await client.get<{ items: LibraryRow[]; counts: Record<string, number> }>(`/projects/${projectId}/ai/library`, {
          params: { type: type || undefined, q: q || undefined },
        })
      ).data,
    enabled: !!projectId,
  });
}

/** One library item with content, history and users. */
export function useLibraryItem(id: string | null) {
  return useQuery({
    queryKey: configKeys.libraryItem(id ?? ''),
    queryFn: async () => (await client.get<LibraryItem>(`/ai/library/${id}`)).data,
    enabled: !!id,
  });
}

/** Calls of the Configuration tab that are not plain queries. */
export const configApi = {
  validate: async (id: string, config: AiConfig, workingDir?: string) =>
    (await client.post<{ issues: ConfigIssue[] }>(`/ai/members/${id}/config/validate`, { config, workingDir })).data
      .issues,
  preview: async (id: string, config?: AiConfig) =>
    (await client.post<SyncPreview>(`/ai/members/${id}/config/preview`, config ? { config } : {})).data,
  write: async (
    id: string,
    body: { resolutions?: { path: string; choice: 'keep' | 'overwrite' }[]; confirmHooks?: string },
  ) => (await client.post<WriteResult>(`/ai/members/${id}/config/write`, body)).data,
  restore: async (id: string, path: string, backupId: string) =>
    (await client.post(`/ai/members/${id}/config/restore`, { path, backupId })).data,
  tick: async (id: string, item: string, done: boolean) =>
    (await client.post(`/ai/members/${id}/config/tick`, { item, done })).data,
  exportJson: async (id: string, config?: AiConfig) =>
    (await client.post<{ filename: string; text: string }>(`/ai/members/${id}/config/export`, config ? { config } : {}))
      .data,
  importPreview: async (id: string, text: string, config: AiConfig, mode: 'merge' | 'replace') =>
    (await client.post<ImportPreview>(`/ai/members/${id}/config/import-preview`, { text, config, mode })).data,
  reset: async (id: string) => (await client.post(`/ai/members/${id}/config/reset`)).data,
  undoReset: async (id: string) => (await client.post(`/ai/members/${id}/config/undo-reset`)).data,
  models: async (id: string) => (await client.get<ModelList>(`/ai/members/${id}/models`)).data,
  probe: async (id: string, kind: 'kanban' | 'mcp_servers' | 'remote_mcp', server?: unknown) =>
    (await client.post<ProbeResult>(`/ai/members/${id}/mcp/probe`, { kind, server })).data,
  promptPreview: async (id: string, config: AiConfig, ticketId?: string) =>
    (await client.post<PromptPreview>(`/ai/members/${id}/prompt/preview`, { config, ticketId })).data,
  sampleTickets: async (projectId: string) =>
    (await client.get<{ id: string; title: string; status: string }[]>(`/projects/${projectId}/ai/sample-tickets`))
      .data,
  checkTool: async (spec: string) => (await client.post<ToolCheck>('/ai/tools/check', { spec })).data,
  testTool: async (
    id: string,
    body: {
      spec: string;
      toolId?: string;
      headers: { name: string; value: string; secret: boolean }[];
      argsText: string;
    },
  ) => (await client.post<ToolTestResult>(`/ai/members/${id}/tools/test`, body)).data,
  dryRun: async (id: string, ticketId: string, config: AiConfig) =>
    (await client.post<DryRunResult>(`/ai/members/${id}/dry-run`, { ticketId, config })).data,
  libraryCreate: async (
    projectId: string,
    body: { type: LibraryType; name: string; description: string; content: string },
  ) => (await client.post<LibraryItem>(`/projects/${projectId}/ai/library`, body)).data,
  libraryVersion: async (id: string, body: { content: string; description?: string; note?: string }) =>
    (await client.post<LibraryItem>(`/ai/library/${id}/versions`, body)).data,
  libraryDelete: async (id: string) => (await client.delete(`/ai/library/${id}`)).data,
  libraryDiff: async (id: string, fromVersion: number) =>
    (
      await client.get<{ fromVersion: number; toVersion: number; changes: DiffRow[] }>(`/ai/library/${id}/diff`, {
        params: { from_version: fromVersion },
      })
    ).data,
  libraryPropagate: async (id: string, memberIds: string[]) =>
    (
      await client.post<{ updated: string[]; failed: { memberId: string; message: string }[] }>(
        `/ai/library/${id}/propagate`,
        { memberIds },
      )
    ).data,
  libraryEdit: async (memberId: string, how: 'attach' | 'update' | 'detach', itemId: string, config: AiConfig) =>
    (
      await client.post<{ config: AiConfig; item: { name: string; version: number; type: LibraryType } }>(
        `/ai/members/${memberId}/library/${how}`,
        { itemId, config },
      )
    ).data,
};
