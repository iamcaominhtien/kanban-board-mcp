/**
 * A project's Docs settings (`GET/PATCH /projects/{id}/docs/settings`): how new pages look, the template gallery,
 * public links, highlights, upload limits, scripts in HTML embeds and how each AI team changes pages. Admins change
 * them; everyone who can read the project's Docs can read them.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';

/** How a page looks before anyone styles it (`newPage`). */
export interface NewPageStyle {
  width: 'narrow' | 'normal' | 'wide' | 'full';
  bodyFont: string;
  textSize: 's' | 'm' | 'l';
  background: 'white' | 'paper' | 'mist' | 'sepia' | 'night';
  titleAlign: 'left' | 'center';
  childCopiesParent: boolean;
}

/** The project's Docs settings, every key filled (the server sends the defaults for missing ones). */
export interface DocsSpaceSettings {
  newPage: NewPageStyle;
  defaultTemplate: string;
  hiddenTemplates: string[];
  allowPublicLinks: boolean;
  publicLinkExpiry: 'never' | '7d' | '30d' | '90d';
  highlights: 'on' | 'off';
  uploads: { imageMb: number; videoMb: number; fileMb: number };
  scriptsInEmbeds: 'on' | 'ask' | 'off';
  embedSites: string[];
  /** How each AI team (by member id) changes pages. */
  aiApply: Record<string, 'suggest' | 'direct'>;
}

/** A change: whole keys, or part of an object key (`newPage`, `uploads`, `aiApply` merge key by key). */
export type DocsSpacePatch = {
  [K in keyof DocsSpaceSettings]?: DocsSpaceSettings[K] extends unknown[]
    ? DocsSpaceSettings[K]
    : DocsSpaceSettings[K] extends object
      ? Partial<DocsSpaceSettings[K]>
      : DocsSpaceSettings[K];
};

/** The largest upload limits an admin can choose, in MB (the server's `MAX_LIMITS_MB`). */
export const MAX_UPLOAD_MB = { imageMb: 50, videoMb: 2048, fileMb: 1024 } as const;

/** The query key of a project's Docs settings. */
export const docsSpaceKey = (projectId: string) => ['docs', 'space-settings', projectId] as const;

/** The key the AI suggestions code reads the same settings under (kept in step after a change). */
const rawKey = (projectId: string) => ['docs', 'space-settings-raw', projectId] as const;

/**
 * Query a project's Docs settings.
 * @param projectId - The project; empty switches the query off.
 * @param enabled - False skips the request (Docs is off).
 */
export function useDocsSpaceSettings(projectId: string, enabled = true) {
  return useQuery({
    queryKey: docsSpaceKey(projectId),
    // keys as stored: `aiApply` is keyed by member ids, which camelCasing would change
    queryFn: async () =>
      (await client.get<DocsSpaceSettings>(`/projects/${projectId}/docs/settings`, { keepKeys: true })).data,
    enabled: !!projectId && enabled,
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * Sends a change of the project's Docs settings.
 * @returns The settings as stored after it.
 * @throws The request's error: 403 `admins_only`, 422 `invalid_settings`.
 */
export async function patchDocsSpaceSettings(projectId: string, patch: DocsSpacePatch): Promise<DocsSpaceSettings> {
  return (
    await client.patch<DocsSpaceSettings>(
      `/projects/${projectId}/docs/settings`,
      { settings: patch },
      { rawKeys: ['settings'], keepKeys: true },
    )
  ).data;
}

/**
 * Mutation: change the project's Docs settings. The choice shows at once; when the server refuses it, it goes back
 * (the caller says why).
 */
export function useUpdateDocsSpaceSettings(projectId: string) {
  const qc = useQueryClient();
  const key = docsSpaceKey(projectId);
  return useMutation({
    mutationFn: (patch: DocsSpacePatch) => patchDocsSpaceSettings(projectId, patch),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: key });
      const before = qc.getQueryData<DocsSpaceSettings>(key);
      if (before) {
        const next = { ...before } as Record<string, unknown>;
        for (const [k, v] of Object.entries(patch)) {
          const old = (before as unknown as Record<string, unknown>)[k];
          next[k] =
            v && typeof v === 'object' && !Array.isArray(v) && old && typeof old === 'object' && !Array.isArray(old)
              ? { ...old, ...v }
              : v;
        }
        qc.setQueryData(key, next as unknown as DocsSpaceSettings);
      }
      return { before };
    },
    onError: (_e, _patch, c) => {
      if (c?.before) qc.setQueryData(key, c.before);
    },
    onSuccess: (data) => {
      qc.setQueryData(key, data);
      qc.setQueryData(rawKey(projectId), data);
      void qc.invalidateQueries({ queryKey: ['docs', 'gallery', projectId] });
    },
  });
}
