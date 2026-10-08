import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import type { Member } from '../types/ticket';

/** Fetch a project's members. */
export async function listMembers(projectId: string): Promise<Member[]> {
  const res = await client.get<Member[]>(`/projects/${projectId}/members`);
  return res.data;
}

/** Add a member. */
export async function addMember(projectId: string, data: { name: string; color?: string }): Promise<Member> {
  const res = await client.post<Member>(`/projects/${projectId}/members`, data);
  return res.data;
}

/** Remove a member. */
export async function removeMember(projectId: string, memberId: string): Promise<void> {
  await client.delete(`/projects/${projectId}/members/${memberId}`);
}

export const memberKeys = {
  all: (projectId: string) => ['members', projectId] as const,
};

/** Query a project's members. */
export function useMembers(projectId: string) {
  return useQuery({
    queryKey: memberKeys.all(projectId),
    queryFn: () => listMembers(projectId),
    enabled: !!projectId,
  });
}

/** Mutation: add a member. */
export function useAddMember(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; color?: string }) => addMember(projectId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: memberKeys.all(projectId) });
    },
  });
}

/** Mutation: remove a member. */
export function useRemoveMember(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (memberId: string) => removeMember(projectId, memberId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: memberKeys.all(projectId) });
    },
  });
}
