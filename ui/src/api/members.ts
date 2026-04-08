import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import type { Member } from '../types/ticket';

export async function listMembers(projectId: string): Promise<Member[]> {
  const res = await client.get<Member[]>(`/projects/${projectId}/members`);
  return res.data;
}

export async function addMember(
  projectId: string,
  data: { name: string; color?: string },
): Promise<Member> {
  const res = await client.post<Member>(`/projects/${projectId}/members`, data);
  return res.data;
}

export async function removeMember(projectId: string, memberId: string): Promise<void> {
  await client.delete(`/projects/${projectId}/members/${memberId}`);
}

export const memberKeys = {
  all: (projectId: string) => ['members', projectId] as const,
};

export function useMembers(projectId: string) {
  return useQuery({
    queryKey: memberKeys.all(projectId),
    queryFn: () => listMembers(projectId),
    enabled: !!projectId,
  });
}

export function useAddMember(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; color?: string }) => addMember(projectId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: memberKeys.all(projectId) });
    },
  });
}

export function useRemoveMember(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (memberId: string) => removeMember(projectId, memberId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: memberKeys.all(projectId) });
    },
  });
}
