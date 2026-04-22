import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import type { IdeaColor, IdeaStatus, IdeaTicket } from '../types';

// ---------------------------------------------------------------------------
// Query key factory
// ---------------------------------------------------------------------------

const ideaKeys = {
  all: (projectId: string) => ['tickets', projectId, 'idea'] as const,
};

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

async function listIdeaTickets(projectId: string): Promise<IdeaTicket[]> {
  const res = await client.get<IdeaTicket[]>(`/projects/${projectId}/tickets`, {
    params: { board: 'idea' },
  });
  return res.data;
}

async function createIdeaTicket(
  projectId: string,
  data: { title: string; description?: string; ideaEmoji?: string; ideaColor?: IdeaColor },
): Promise<IdeaTicket> {
  const res = await client.post<IdeaTicket>(`/projects/${projectId}/idea-tickets`, data);
  return res.data;
}

async function updateIdeaTicket(
  ticketId: string,
  data: {
    title?: string;
    description?: string;
    ideaStatus?: IdeaStatus;
    ideaEmoji?: string;
    ideaColor?: IdeaColor;
    tags?: string[];
  },
): Promise<IdeaTicket> {
  const res = await client.patch<IdeaTicket>(`/idea-tickets/${ticketId}`, data);
  return res.data;
}

async function dropIdeaTicket(ticketId: string): Promise<IdeaTicket> {
  const res = await client.patch<IdeaTicket>(`/idea-tickets/${ticketId}/drop`);
  return res.data;
}

async function promoteIdeaTicket(ticketId: string): Promise<IdeaTicket> {
  const res = await client.patch<IdeaTicket>(`/idea-tickets/${ticketId}/promote`);
  return res.data;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function useInvalidateIdeaTickets(projectId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ideaKeys.all(projectId) });
}

export function useIdeaTickets(projectId: string) {
  return useQuery({
    queryKey: ideaKeys.all(projectId),
    queryFn: () => listIdeaTickets(projectId),
    enabled: !!projectId,
  });
}

export function useCreateIdeaTicket(projectId: string) {
  const invalidate = useInvalidateIdeaTickets(projectId);
  return useMutation({
    mutationFn: (data: Parameters<typeof createIdeaTicket>[1]) =>
      createIdeaTicket(projectId, data),
    onSuccess: invalidate,
  });
}

export function useUpdateIdeaTicket(projectId: string) {
  const invalidate = useInvalidateIdeaTickets(projectId);
  return useMutation({
    mutationFn: ({
      ticketId,
      data,
    }: {
      ticketId: string;
      data: Parameters<typeof updateIdeaTicket>[1];
    }) => updateIdeaTicket(ticketId, data),
    onSuccess: invalidate,
  });
}

export function useDropIdeaTicket(projectId: string) {
  const invalidate = useInvalidateIdeaTickets(projectId);
  return useMutation({
    mutationFn: (ticketId: string) => dropIdeaTicket(ticketId),
    onSuccess: invalidate,
  });
}

export function usePromoteIdeaTicket(projectId: string) {
  const invalidate = useInvalidateIdeaTickets(projectId);
  return useMutation({
    mutationFn: (ticketId: string) => promoteIdeaTicket(ticketId),
    onSuccess: invalidate,
  });
}
