import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CatalogueEntry,
  Plugin,
  PluginAction,
  PluginChanges,
  PluginPreview,
  PreviewChoices,
  SourceBody,
  UpdateCheck,
} from '../types/aiPlugins';
import { client } from './client';

export const pluginKeys = {
  catalogue: ['ai', 'catalogue'] as const,
  list: (projectId: string) => ['ai', 'plugins', projectId] as const,
};

export interface InstallBody extends SourceBody {
  roles: string[];
  defaultOn: boolean;
}

export const aiPluginsApi = {
  catalogue: async () => (await client.get<CatalogueEntry[]>('/ai/catalogue')).data,
  list: async (projectId: string) => (await client.get<Plugin[]>(`/projects/${projectId}/ai/plugins`)).data,
  preview: async (projectId: string, body: SourceBody) =>
    (await client.post<PluginPreview | PreviewChoices>(`/projects/${projectId}/ai/plugins/preview`, body)).data,
  install: async (projectId: string, body: InstallBody) =>
    (await client.post<Plugin>(`/projects/${projectId}/ai/plugins`, body)).data,
  patch: async (id: string, body: { defaultOn?: boolean; roles?: string[] }) =>
    (await client.patch<Plugin>(`/ai/plugins/${id}`, body)).data,
  checkUpdate: async (id: string) => (await client.get<UpdateCheck>(`/ai/plugins/${id}/update`)).data,
  changes: async (id: string) => (await client.get<PluginChanges>(`/ai/plugins/${id}/changes`)).data,
  act: async (id: string, action: PluginAction) => (await client.post<Plugin>(`/ai/plugins/${id}/${action}`)).data,
  remove: async (id: string) => {
    await client.delete(`/ai/plugins/${id}`);
  },
};

/** One of the board's own skills (the design guide, permissions, the shared skills, a role's own skill). */
export interface BoardSkill {
  name: string;
  description: string;
  /** The role a role skill is for (issue #273); null or absent: every role. */
  role?: string | null;
  /** The roles that do this craft (a team gets the skill when one of its roles is listed); null: every team. */
  craftRoles?: string[] | null;
  /** The skill every run opens first: it cannot be switched off. */
  alwaysOn?: boolean;
}

/** The board's own skills; whether each is on lives in the project's ops (`boardSkills`). */
export function useBoardSkills() {
  return useQuery({
    queryKey: ['ai', 'board-skills'] as const,
    queryFn: async () => (await client.get<BoardSkill[]>('/ai/board-skills')).data,
    staleTime: 5 * 60_000,
  });
}

/** The "Suggested for a role" catalogue. */
export function useCatalogue() {
  return useQuery({ queryKey: pluginKeys.catalogue, queryFn: aiPluginsApi.catalogue, staleTime: 5 * 60_000 });
}

/** The plugins installed on a project. */
export function usePlugins(projectId: string) {
  return useQuery({ queryKey: pluginKeys.list(projectId), queryFn: () => aiPluginsApi.list(projectId) });
}

/** Run a change and refresh the list (and what depends on it) afterwards. */
export function usePluginMutation<A, R>(projectId: string, fn: (a: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: pluginKeys.list(projectId) });
    },
  });
}
