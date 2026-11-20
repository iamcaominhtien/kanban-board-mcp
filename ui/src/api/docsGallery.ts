/**
 * The New page gallery and saved templates (`/projects/{id}/docs/gallery`, `/docs/templates/{id}`), and creating a
 * page from one (`/projects/{id}/docs/pages/from-template`).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import { docsKeys } from './docs';
import type { DocsPage, DocsTemplate } from '../types/docs';
import type {
  DocsGallery,
  GallerySaved,
  TemplateCategory,
  TemplateSaveRequest,
  TemplateScope,
} from '../types/docsGallery';

/** The query key of a project's gallery. */
export const galleryKey = (projectId: string) => ['docs', 'gallery', projectId] as const;

/** Query a project's template gallery (built-in, yours and shared with the project). */
export function useDocsGallery(projectId: string) {
  return useQuery({
    queryKey: galleryKey(projectId),
    queryFn: async () => (await client.get<DocsGallery>(`/projects/${projectId}/docs/gallery`)).data,
    enabled: !!projectId,
    staleTime: 30_000,
    retry: 1,
  });
}

/**
 * The older template list (`GET /docs/templates`), used only while the gallery cannot be read (a server from before
 * the gallery): its pages are created with `POST /projects/{id}/docs/pages` as before.
 * @param enabled - Ask for it (the gallery failed).
 */
export function useLegacyTemplates(enabled: boolean) {
  return useQuery({
    queryKey: docsKeys.templates,
    queryFn: async () => (await client.get<DocsTemplate[]>('/docs/templates')).data,
    staleTime: Infinity,
    enabled,
  });
}

/**
 * Saves a page as a template.
 * @param projectId - The project the page belongs to.
 * @param req - Name, what it keeps and who can use it.
 * @returns The saved template.
 * @throws The request's error: 409 `name_taken` (with `templateId`), 422 `name_required` or `name_too_long`.
 */
export async function saveTemplate(projectId: string, req: TemplateSaveRequest): Promise<GallerySaved> {
  return (await client.post<GallerySaved>(`/projects/${projectId}/docs/gallery`, req)).data;
}

/**
 * Creates a page from a gallery template (built-in or saved): the page starts as a draft with the template's text and
 * settings.
 * @param projectId - The project.
 * @param v - Title, parent (`null`: top level) and the template id.
 */
export async function createFromTemplate(
  projectId: string,
  v: { title: string; parentId: string | null; template: string },
): Promise<DocsPage> {
  return (await client.post<DocsPage>(`/projects/${projectId}/docs/pages/from-template`, v)).data;
}

/** Mutations on saved templates: rename / re-share, and delete. Both refresh the gallery. */
export function useTemplateActions(projectId: string) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: galleryKey(projectId) });
  const update = useMutation({
    mutationFn: async (v: {
      id: string;
      name?: string;
      description?: string | null;
      category?: TemplateCategory | null;
      scope?: TemplateScope;
    }) => {
      const { id, ...body } = v;
      return (await client.patch<GallerySaved>(`/docs/templates/${id}`, body)).data;
    },
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: async (id: string) => (await client.delete(`/docs/templates/${id}`)).data,
    onSuccess: refresh,
  });
  return { update, remove };
}

/** Returns a function to call after a page was made from a template: the tree and the gallery's counts refresh. */
export function useAfterCreate(projectId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: docsKeys.tree(projectId) });
    void qc.invalidateQueries({ queryKey: galleryKey(projectId) });
  };
}
