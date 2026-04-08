import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import type { IssueType, Priority, Status, Ticket, WorkLogRole } from '../types/ticket';

export async function listTickets(
  projectId: string,
  params?: { status?: string; priority?: string; q?: string },
): Promise<Ticket[]> {
  const res = await client.get<Ticket[]>(`/projects/${projectId}/tickets`, { params });
  return res.data;
}

export async function createTicket(
  projectId: string,
  data: {
    title: string;
    description?: string;
    type?: IssueType;
    priority?: Priority;
    status?: Status;
    estimate?: number | null;
    dueDate?: string | null;
    tags?: string[];
    parentId?: string | null;
  },
): Promise<Ticket> {
  const res = await client.post<Ticket>(`/projects/${projectId}/tickets`, data);
  return res.data;
}

export async function getTicket(ticketId: string): Promise<Ticket> {
  const res = await client.get<Ticket>(`/tickets/${ticketId}`);
  return res.data;
}

export async function updateTicket(
  ticketId: string,
  data: {
    title?: string;
    description?: string;
    type?: IssueType;
    status?: Status;
    priority?: Priority;
    estimate?: number | null;
    dueDate?: string | null;
    tags?: string[];
    parentId?: string | null;
    wontDoReason?: string | null;
  },
): Promise<Ticket> {
  const res = await client.patch<Ticket>(`/tickets/${ticketId}`, data);
  return res.data;
}

export async function updateTicketStatus(
  ticketId: string,
  status: Status,
): Promise<Ticket> {
  const res = await client.patch<Ticket>(`/tickets/${ticketId}/status`, { status });
  return res.data;
}

export async function deleteTicket(ticketId: string): Promise<void> {
  await client.delete(`/tickets/${ticketId}`);
}

export async function listWontDoTickets(projectId: string): Promise<Ticket[]> {
  const res = await client.get<Ticket[]>(`/projects/${projectId}/tickets`, {
    params: { include_wont_do: true, status: 'wont_do' },
  });
  return res.data;
}

// Comments
export async function addComment(
  ticketId: string,
  text: string,
  author = 'user',
): Promise<Ticket> {
  const res = await client.post<Ticket>(`/tickets/${ticketId}/comments`, { text, author });
  return res.data;
}

export async function deleteComment(
  ticketId: string,
  commentId: string,
): Promise<Ticket> {
  const res = await client.delete<Ticket>(`/tickets/${ticketId}/comments/${commentId}`);
  return res.data;
}

// Acceptance criteria
export async function addAcceptanceCriterion(
  ticketId: string,
  text: string,
): Promise<Ticket> {
  const res = await client.post<Ticket>(`/tickets/${ticketId}/acceptance-criteria`, { text });
  return res.data;
}

export async function toggleAcceptanceCriterion(
  ticketId: string,
  criterionId: string,
): Promise<Ticket> {
  const res = await client.patch<Ticket>(
    `/tickets/${ticketId}/acceptance-criteria/${criterionId}/toggle`,
  );
  return res.data;
}

export async function deleteAcceptanceCriterion(
  ticketId: string,
  criterionId: string,
): Promise<Ticket> {
  const res = await client.delete<Ticket>(
    `/tickets/${ticketId}/acceptance-criteria/${criterionId}`,
  );
  return res.data;
}

// Work log
export async function addWorkLog(
  ticketId: string,
  data: { author: string; role: WorkLogRole; note: string },
): Promise<Ticket> {
  const res = await client.post<Ticket>(`/tickets/${ticketId}/work-log`, data);
  return res.data;
}

export async function deleteWorkLog(
  ticketId: string,
  entryId: string,
): Promise<Ticket> {
  const res = await client.delete<Ticket>(`/tickets/${ticketId}/work-log/${entryId}`);
  return res.data;
}

// Test cases
export async function addTestCase(
  ticketId: string,
  title: string,
): Promise<Ticket> {
  const res = await client.post<Ticket>(`/tickets/${ticketId}/test-cases`, { title });
  return res.data;
}

export async function updateTestCase(
  ticketId: string,
  testCaseId: string,
  data: { title?: string; status?: string; proof?: string | null; note?: string | null },
): Promise<Ticket> {
  const res = await client.patch<Ticket>(
    `/tickets/${ticketId}/test-cases/${testCaseId}`,
    data,
  );
  return res.data;
}

export async function deleteTestCase(
  ticketId: string,
  testCaseId: string,
): Promise<Ticket> {
  const res = await client.delete<Ticket>(`/tickets/${ticketId}/test-cases/${testCaseId}`);
  return res.data;
}

// ---------------------------------------------------------------------------
// Query key factory
// ---------------------------------------------------------------------------

export const ticketKeys = {
  all: (projectId: string) => ['tickets', projectId] as const,
  detail: (ticketId: string) => ['ticket', ticketId] as const,
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function useTickets(
  projectId: string,
  params?: { status?: string; priority?: string; q?: string },
) {
  return useQuery({
    queryKey: [...ticketKeys.all(projectId), params],
    queryFn: () => listTickets(projectId, params),
    enabled: !!projectId,
  });
}

export function useTicket(ticketId: string) {
  return useQuery({
    queryKey: ticketKeys.detail(ticketId),
    queryFn: () => getTicket(ticketId),
    enabled: !!ticketId,
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function useCreateTicket(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof createTicket>[1]) => createTicket(projectId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ticketKeys.all(projectId) });
    },
  });
}

export function useUpdateTicket() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      ticketId,
      data,
    }: {
      ticketId: string;
      data: Parameters<typeof updateTicket>[1];
    }) => updateTicket(ticketId, data),
    onSuccess: (ticket) => {
      queryClient.invalidateQueries({ queryKey: ticketKeys.all(ticket.projectId) });
      queryClient.setQueryData(ticketKeys.detail(ticket.id), ticket);
    },
  });
}

export function useUpdateTicketStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, status }: { ticketId: string; status: Status }) =>
      updateTicketStatus(ticketId, status),
    onSuccess: (ticket) => {
      queryClient.invalidateQueries({ queryKey: ticketKeys.all(ticket.projectId) });
      queryClient.setQueryData(ticketKeys.detail(ticket.id), ticket);
    },
  });
}

export function useDeleteTicket(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ticketId: string) => deleteTicket(ticketId),
    onSuccess: (_, ticketId) => {
      queryClient.invalidateQueries({ queryKey: ticketKeys.all(projectId) });
      queryClient.removeQueries({ queryKey: ticketKeys.detail(ticketId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Sub-entity mutations (all return updated ticket, update cache)
// ---------------------------------------------------------------------------

function useTicketSubMutation<T>(mutationFn: (arg: T) => Promise<Ticket>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (ticket) => {
      queryClient.invalidateQueries({ queryKey: ticketKeys.all(ticket.projectId) });
      queryClient.setQueryData(ticketKeys.detail(ticket.id), ticket);
    },
  });
}

export function useAddComment() {
  return useTicketSubMutation(
    ({ ticketId, text, author }: { ticketId: string; text: string; author?: string }) =>
      addComment(ticketId, text, author),
  );
}

export function useDeleteComment() {
  return useTicketSubMutation(
    ({ ticketId, commentId }: { ticketId: string; commentId: string }) =>
      deleteComment(ticketId, commentId),
  );
}

export function useAddAcceptanceCriterion() {
  return useTicketSubMutation(
    ({ ticketId, text }: { ticketId: string; text: string }) =>
      addAcceptanceCriterion(ticketId, text),
  );
}

export function useToggleAcceptanceCriterion() {
  return useTicketSubMutation(
    ({ ticketId, criterionId }: { ticketId: string; criterionId: string }) =>
      toggleAcceptanceCriterion(ticketId, criterionId),
  );
}

export function useDeleteAcceptanceCriterion() {
  return useTicketSubMutation(
    ({ ticketId, criterionId }: { ticketId: string; criterionId: string }) =>
      deleteAcceptanceCriterion(ticketId, criterionId),
  );
}

export function useAddWorkLog() {
  return useTicketSubMutation(
    ({ ticketId, data }: { ticketId: string; data: Parameters<typeof addWorkLog>[1] }) =>
      addWorkLog(ticketId, data),
  );
}

export function useDeleteWorkLog() {
  return useTicketSubMutation(
    ({ ticketId, entryId }: { ticketId: string; entryId: string }) =>
      deleteWorkLog(ticketId, entryId),
  );
}

export function useAddTestCase() {
  return useTicketSubMutation(
    ({ ticketId, title }: { ticketId: string; title: string }) =>
      addTestCase(ticketId, title),
  );
}

export function useUpdateTestCase() {
  return useTicketSubMutation(
    ({
      ticketId,
      testCaseId,
      data,
    }: {
      ticketId: string;
      testCaseId: string;
      data: Parameters<typeof updateTestCase>[2];
    }) => updateTestCase(ticketId, testCaseId, data),
  );
}

export function useDeleteTestCase() {
  return useTicketSubMutation(
    ({ ticketId, testCaseId }: { ticketId: string; testCaseId: string }) =>
      deleteTestCase(ticketId, testCaseId),
  );
}

export function useWontDoTickets(projectId: string) {
  return useQuery({
    queryKey: ['wont_do_tickets', projectId],
    queryFn: () => listWontDoTickets(projectId),
    enabled: !!projectId,
  });
}

export function useRestoreTicket(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ticketId: string) =>
      updateTicket(ticketId, { status: 'backlog', wontDoReason: null }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ticketKeys.all(projectId) });
      queryClient.invalidateQueries({ queryKey: ['wont_do_tickets', projectId] });
    },
  });
}
