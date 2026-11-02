import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CatalogueEntry,
  Plugin,
  PluginAction,
  PluginChanges,
  PluginPreview,
  PreviewChoices,
  SkillUsage,
  SourceBody,
  UpdateCheck,
} from '../types/aiPlugins';
import { client } from './client';

export const pluginKeys = {
  catalogue: ['ai', 'catalogue'] as const,
  list: (projectId: string) => ['ai', 'plugins', projectId] as const,
  usage: (projectId: string) => ['ai', 'skills-usage', projectId] as const,
};

export interface InstallBody extends SourceBody {
  roles: string[];
  defaultOn: boolean;
}

export const aiPluginsApi = {
  catalogue: async () => (await client.get<CatalogueEntry[]>('/ai/catalogue')).data,
  list: async (projectId: string) => (await client.get<Plugin[]>(`/projects/${projectId}/ai/plugins`)).data,
  usage: async (projectId: string) =>
    (await client.get<SkillUsage[]>('/ai/skills/usage', { params: { project_id: projectId } })).data,
  installEntry: async (projectId: string, key: string, memberIds?: string[]) =>
    (
      await client.post<{ plugin?: Plugin; mcpAddedTo?: string[] }>(
        `/projects/${projectId}/ai/catalogue/${key}/install`,
        memberIds ? { memberIds } : {},
      )
    ).data,
  preview: async (projectId: string, body: SourceBody) =>
    (await client.post<PluginPreview | PreviewChoices>(`/projects/${projectId}/ai/plugins/preview`, body)).data,
  install: async (projectId: string, body: InstallBody) =>
    (await client.post<Plugin>(`/projects/${projectId}/ai/plugins`, body)).data,
  patch: async (id: string, body: { defaultOn?: boolean; roles?: string[] }) =>
    (await client.patch<Plugin>(`/ai/plugins/${id}`, body)).data,
  setMember: async (id: string, memberId: string, on: boolean | null) =>
    (await client.put<Plugin>(`/ai/plugins/${id}/members/${memberId}`, { on })).data,
  checkUpdate: async (id: string) => (await client.get<UpdateCheck>(`/ai/plugins/${id}/update`)).data,
  changes: async (id: string) => (await client.get<PluginChanges>(`/ai/plugins/${id}/changes`)).data,
  act: async (id: string, action: PluginAction) => (await client.post<Plugin>(`/ai/plugins/${id}/${action}`)).data,
  remove: async (id: string) => {
    await client.delete(`/ai/plugins/${id}`);
  },
};

/** The "Suggested for a role" catalogue. */
export function useCatalogue() {
  return useQuery({ queryKey: pluginKeys.catalogue, queryFn: aiPluginsApi.catalogue, staleTime: 5 * 60_000 });
}

/** The plugins installed on a project. */
export function usePlugins(projectId: string) {
  return useQuery({ queryKey: pluginKeys.list(projectId), queryFn: () => aiPluginsApi.list(projectId) });
}

/** Real use per skill, counted from the run streams. */
export function useSkillsUsage(projectId: string) {
  return useQuery({ queryKey: pluginKeys.usage(projectId), queryFn: () => aiPluginsApi.usage(projectId) });
}

/** Run a change and refresh the list (and what depends on it) afterwards. */
export function usePluginMutation<A, R>(projectId: string, fn: (a: A) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: pluginKeys.list(projectId) });
      void qc.invalidateQueries({ queryKey: pluginKeys.usage(projectId) });
    },
  });
}
