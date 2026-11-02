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
  own: (projectId: string) => ['ai', 'own-plugins', projectId] as const,
};

/** One of the person's own Claude Code plugins (read from their Claude Code folder; nothing there is changed). */
export interface OwnPlugin {
  name: string;
  scope: string;
  skills: number;
  path: string;
  /** A Claude Code run loads it (installed for the user and not switched off). */
  loaded: boolean;
  /** Why it is not loaded. */
  reason: string | null;
  /** The roles it is narrowed to; null: every role. */
  roles: string[] | null;
}

/** The switch (`own_claude`) and the plugins. */
export interface OwnPlugins {
  on: boolean;
  plugins: OwnPlugin[];
}

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
  own: async (projectId: string) => (await client.get<OwnPlugins>(`/projects/${projectId}/ai/own-plugins`)).data,
};

/** The person's own Claude Code plugins, whether a run loads each, and which roles each is narrowed to. */
export function useOwnPlugins(projectId: string) {
  return useQuery({
    queryKey: pluginKeys.own(projectId),
    queryFn: () => aiPluginsApi.own(projectId),
    enabled: !!projectId,
    retry: false,
  });
}

/** One of the board's own skills (the design guide, permissions, the shared skills, a role's own skill). */
export interface BoardSkill {
  name: string;
  description: string;
  /** The role a role skill is for (issue #273); null or absent: every role. */
  role?: string | null;
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
