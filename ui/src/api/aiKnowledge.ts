import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Knowledge, Lesson, MemoryNote, NoteScope } from '../types/aiKnowledge';
import { client } from './client';

export const knowledgeKeys = { project: (projectId: string) => ['ai', 'knowledge', projectId] as const };

export interface LessonPatch {
  text?: string;
  state?: 'kept' | 'dropped' | 'proposed';
}

export const aiKnowledgeApi = {
  get: async (projectId: string) => (await client.get<Knowledge>(`/projects/${projectId}/ai/knowledge`)).data,
  saveInstructions: async (projectId: string, instructions: string) =>
    (await client.put<Knowledge>(`/projects/${projectId}/ai/knowledge/instructions`, { instructions })).data,
  addLesson: async (projectId: string, text: string) =>
    (await client.post<Lesson>(`/projects/${projectId}/ai/lessons`, { text })).data,
  patchLesson: async (id: string, body: LessonPatch) => (await client.patch<Lesson>(`/ai/lessons/${id}`, body)).data,
  deleteLesson: async (id: string) => {
    await client.delete(`/ai/lessons/${id}`);
  },
  addNote: async (projectId: string, body: NoteBody) =>
    (await client.post<MemoryNote>(`/projects/${projectId}/ai/notes`, body)).data,
  patchNote: async (id: string, text: string) => (await client.patch<MemoryNote>(`/ai/notes/${id}`, { text })).data,
  deleteNote: async (id: string) => {
    await client.delete(`/ai/notes/${id}`);
  },
};

export interface NoteBody {
  text: string;
  scope: NoteScope;
  scopeKey: string;
  kind?: 'learned' | 'feedback';
}

/**
 *
 */
export function useKnowledge(projectId: string) {
  return useQuery({
    queryKey: knowledgeKeys.project(projectId),
    queryFn: () => aiKnowledgeApi.get(projectId),
    enabled: !!projectId,
  });
}

/** Every mutation ends by refetching the knowledge summary: the token counts are the server's. */
function useInvalidate(projectId: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: knowledgeKeys.project(projectId) });
}

/**
 *
 */
export function useSaveInstructions(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => aiKnowledgeApi.saveInstructions(projectId, text),
    onSuccess: (data) => qc.setQueryData(knowledgeKeys.project(projectId), data),
  });
}

/**
 *
 */
export function useAddLesson(projectId: string) {
  const invalidate = useInvalidate(projectId);
  return useMutation({
    mutationFn: (text: string) => aiKnowledgeApi.addLesson(projectId, text),
    onSuccess: invalidate,
  });
}

/**
 *
 */
export function usePatchLesson(projectId: string) {
  const invalidate = useInvalidate(projectId);
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: LessonPatch }) => aiKnowledgeApi.patchLesson(id, body),
    onSuccess: invalidate,
  });
}

/**
 *
 */
export function useDeleteLesson(projectId: string) {
  const invalidate = useInvalidate(projectId);
  return useMutation({ mutationFn: (id: string) => aiKnowledgeApi.deleteLesson(id), onSuccess: invalidate });
}

/** A person writes a note into an AI memory (a correction for a role, say). */
export function useAddNote(projectId: string) {
  const invalidate = useInvalidate(projectId);
  return useMutation({ mutationFn: (body: NoteBody) => aiKnowledgeApi.addNote(projectId, body), onSuccess: invalidate });
}

/** Edit a note an AI wrote. */
export function usePatchNote(projectId: string) {
  const invalidate = useInvalidate(projectId);
  return useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => aiKnowledgeApi.patchNote(id, text),
    onSuccess: invalidate,
  });
}

/** Remove a note. */
export function useDeleteNote(projectId: string) {
  const invalidate = useInvalidate(projectId);
  return useMutation({ mutationFn: (id: string) => aiKnowledgeApi.deleteNote(id), onSuccess: invalidate });
}
