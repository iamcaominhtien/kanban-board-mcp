import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';

/**
 * What a project says about how its AI team runs (`ops` of GET /projects/{id}/ai/settings, over the defaults). Known keys only; the server keeps nothing else. Cards for other settings reuse this module.
 */
export interface ProjectOps {
  lessonsInPrompt: number;
  /** A run keeps its own notes (its role's, and on its ticket) and reads them back (issue #274). */
  aiNotes?: boolean;
  worktrees?: Record<string, unknown>;
  commands?: { test?: string; lint?: string; build?: string };
  /** Commands saved but not run as checks: names out of test, lint, build. */
  checksOff?: string[];
  /** Extra folders put in front of the PATH for everything this project runs. */
  envPath?: string[];
  /** A message reaches a running AI at its next turn (off: at its next board call). */
  liveMessages?: boolean;
  knowledgeShared?: boolean;
  /** The board's own skills switched off for the project or switched for one member; a skill not listed is on. */
  boardSkills?: BoardSkillSwitch[];
  github?: { on?: boolean; pollMin?: number; auto?: boolean };
  [key: string]: unknown;
}

/** A board skill's switches: the project's (`on`) and each member's own (`membersOn`, `membersOff`). */
export interface BoardSkillSwitch {
  skill: string;
  on?: boolean;
  membersOn?: string[];
  membersOff?: string[];
}

export const opsKeys = { project: (projectId: string) => ['ai', 'ops', projectId] as const };

/** What a project that never touched the settings reads (mirrors server/services/ai/ops.py DEFAULTS). */
export const OPS_DEFAULTS: ProjectOps = {
  lessonsInPrompt: 20,
  aiNotes: true,
  worktrees: { on: false, repo: null, prepare: '', basePort: 5180, handover: 'auto', baseBranch: null },
  commands: { test: '', lint: '', build: '' },
  checksOff: [],
  envPath: [],
  liveMessages: true,
  knowledgeShared: false,
  boardSkills: [],
  github: { on: false, pollMin: 5, auto: true },
};

/** The stored settings over the defaults, one level of nested objects merged. */
export function mergeOps(stored: Partial<ProjectOps> | null | undefined): ProjectOps {
  const out: Record<string, unknown> = { ...OPS_DEFAULTS };
  for (const [k, v] of Object.entries(stored ?? {})) {
    const base = out[k];
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && base && typeof base === 'object' && !Array.isArray(base)
        ? { ...(base as object), ...(v as object) }
        : v;
  }
  return out as ProjectOps;
}

/** The ops live in the project's AI settings (`ops`): the same endpoint, the same camel-cased keys. */
export const opsApi = {
  get: async (projectId: string) =>
    mergeOps((await client.get<{ ops?: Partial<ProjectOps> }>(`/projects/${projectId}/ai/settings`)).data.ops),
  /** A partial object: nested objects merge. */
  patch: async (projectId: string, body: Partial<ProjectOps>) =>
    mergeOps(
      (await client.patch<{ ops?: Partial<ProjectOps> }>(`/projects/${projectId}/ai/settings`, { ops: body })).data.ops,
    ),
};

/** The project's AI operations settings over the defaults. */
export function useProjectOps(projectId: string) {
  return useQuery({
    queryKey: opsKeys.project(projectId),
    queryFn: () => opsApi.get(projectId),
    enabled: !!projectId,
  });
}

/** Save a partial change; the cache takes the server's answer. */
export function usePatchProjectOps(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<ProjectOps>) => opsApi.patch(projectId, body),
    onSuccess: (data) => {
      qc.setQueryData(opsKeys.project(projectId), data);
      void qc.invalidateQueries({ queryKey: ['ai', 'settings', projectId] });
    },
  });
}
