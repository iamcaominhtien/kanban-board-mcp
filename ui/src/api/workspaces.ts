import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import type { ConnectionBody } from './database';

/** One board kept on this computer: a name and a data folder (`kanban.db` and `uploads/`). */
export interface WorkspaceItem {
  id: string;
  name: string;
  folder: string;
  /** Where the board is kept. */
  engine: 'sqlite' | 'postgresql' | 'mysql';
  /** `host:port/name` of a database server, or the folder of a SQLite board. */
  place: string;
  /** The board the app shows now. */
  active: boolean;
  /** The folder holds a database already; a new workspace gets its board the first time it is opened. */
  hasBoard: boolean;
}

export interface WorkspacesData {
  items: WorkspaceItem[];
  activeId: string | null;
  /** False while `KANBAN_DATABASE_URL` decides the database. */
  switchable: boolean;
  /** Why a switch is not possible, when it is not. */
  reason: string | null;
}

export const workspacesKey = ['workspaces'] as const;

/** The workspaces of this computer, the one in use marked. */
export function useWorkspaces() {
  return useQuery<WorkspacesData>({
    queryKey: workspacesKey,
    queryFn: async () => (await client.get('/workspaces')).data,
    // the list only changes when this window changes it
    staleTime: 60_000,
  });
}

/**
 * Add a workspace; nothing is switched. `folder` empty: a new folder in `~/Kanban Boards`. `connection`: the
 * board lives in that PostgreSQL or MySQL/MariaDB database (tested by the server before it is saved).
 */
export function useAddWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; folder?: string; connection?: ConnectionBody }) =>
      (await client.post('/workspaces', body)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspacesKey }),
  });
}

/** Rename a workspace. */
export function useRenameWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) =>
      (await client.patch(`/workspaces/${encodeURIComponent(id)}`, { name })).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspacesKey }),
  });
}

/** Forget a workspace; its folder and data stay on disk. */
export function useRemoveWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await client.delete(`/workspaces/${encodeURIComponent(id)}`)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspacesKey }),
  });
}

/** Open another workspace on the server. The caller then calls `reloadAfterSwitch`. */
export function useSwitchWorkspace() {
  return useMutation({
    mutationFn: async (id: string) => (await client.post(`/workspaces/${encodeURIComponent(id)}/switch`)).data,
  });
}

/**
 * Show the board that was just opened: forget the project of the old board (it is not in the new one) and load the
 * page again, as an import does.
 */
export function reloadAfterSwitch(): void {
  try {
    localStorage.removeItem('activeProjectId');
  } catch {
    // storage can be blocked; the board then falls back to its first project
  }
  window.location.replace(window.location.pathname);
}

/** The server's reason for a refused call, or a fallback. */
export function workspaceError(error: unknown, fallback: string): string {
  const detail = (error as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (typeof detail === 'string' && detail) return detail;
  const message = (detail as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message ? message : fallback;
}

/** The workspace in use, or `undefined` while it is not known. */
export function activeWorkspace(data: WorkspacesData | undefined): WorkspaceItem | undefined {
  return data?.items.find((item) => item.active);
}

/**
 * The workspace this window was opened on, and the one the board was switched to since by another window, the
 * desktop app or an editor's MCP (`switchedTo`, null while nothing changed). A window that goes on would show and
 * change the other board without the person noticing, so the app asks them to reload.
 *
 * A switch changes both the id and the name of the workspace in use; adding the first workspace changes only the id
 * (the board in use gets its own entry) and a rename or a move of the folder only one of them, so those do not count.
 */
export function useWorkspaceSwitchedElsewhere(): { switchedTo: string | null } {
  const { data } = useWorkspaces();
  const first = useRef<WorkspaceItem | null>(null);
  const active = activeWorkspace(data);
  if (active && !first.current) first.current = active;
  const was = first.current;
  const switched = !!active && !!was && active.id !== was.id && active.name !== was.name;
  return { switchedTo: switched ? active.name : null };
}
