import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import type { Member } from '../types/ticket';

/** Fetch a project's members. */
export async function listMembers(projectId: string): Promise<Member[]> {
  const res = await client.get<Member[]>(`/projects/${projectId}/members`);
  return res.data;
}

/**
 * Add a member.
 * @param projectId - Project to add the member to.
 * @param data - Member name and optional color.
 */
export async function addMember(projectId: string, data: { name: string; color?: string }): Promise<Member> {
  const res = await client.post<Member>(`/projects/${projectId}/members`, data);
  return res.data;
}

/**
 * Remove a member.
 * @param projectId - Project owning the member.
 * @param memberId - Member to remove.
 */
export async function removeMember(projectId: string, memberId: string): Promise<void> {
  await client.delete(`/projects/${projectId}/members/${memberId}`);
}

/**
 * Change a member's Docs role.
 * @param projectId - Project owning the member.
 * @param memberId - Member to change.
 * @param role - New role.
 */
export async function setMemberRole(
  projectId: string,
  memberId: string,
  role: 'viewer' | 'member' | 'admin',
): Promise<Member> {
  const res = await client.patch<Member>(`/projects/${projectId}/members/${memberId}`, { role });
  return res.data;
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

/** Mutation: change a member's Docs role. */
export function useSetMemberRole(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (v: { memberId: string; role: 'viewer' | 'member' | 'admin' }) =>
      setMemberRole(projectId, v.memberId, v.role),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: memberKeys.all(projectId) });
      queryClient.invalidateQueries({ queryKey: ['docs', 'comments'] });
    },
  });
}
