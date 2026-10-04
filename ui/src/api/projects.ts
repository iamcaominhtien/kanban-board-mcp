import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import type { Project } from '../types/ticket';

/** A first-load request that takes longer than this is abandoned and the error state is shown. */
export const LIST_TIMEOUT_MS = 15000;

export async function listProjects(): Promise<Project[]> {
  const res = await client.get<Project[]>('/projects', { timeout: LIST_TIMEOUT_MS });
  return res.data;
}

export async function getProject(id: string): Promise<Project> {
  const res = await client.get<Project>(`/projects/${id}`);
  return res.data;
}

export async function createProject(data: {
  name: string;
  prefix: string;
  color: string;
}): Promise<Project> {
  const res = await client.post<Project>('/projects', data);
  return res.data;
}

export async function updateProject(
  id: string,
  data: {
    name?: string;
    color?: string;
    repo_path?: string | null;
    worktree_template?: string | null;
    worktree_by_default?: boolean;
  },
): Promise<Project> {
  const res = await client.patch<Project>(`/projects/${id}`, data);
  return res.data;
}

export async function deleteProject(id: string): Promise<void> {
  await client.delete(`/projects/${id}`);
}

export const projectKeys = {
  all: ['projects'] as const,
  detail: (id: string) => ['projects', id] as const,
};

export function useProjects() {
  return useQuery({
    queryKey: projectKeys.all,
    queryFn: listProjects,
    retry: false, // a failure is shown (with Try again) instead of retrying silently for a long time
  });
}

export function useProject(id: string) {
  return useQuery({
    queryKey: projectKeys.detail(id),
    queryFn: () => getProject(id),
    enabled: !!id,
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createProject,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectKeys.all });
    },
  });
}

export function useUpdateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Parameters<typeof updateProject>[1]) =>
      updateProject(id, data),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: projectKeys.all });
      queryClient.invalidateQueries({ queryKey: projectKeys.detail(id) });
    },
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteProject(id),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: projectKeys.all });
      queryClient.removeQueries({ queryKey: projectKeys.detail(id) });
    },
  });
}
