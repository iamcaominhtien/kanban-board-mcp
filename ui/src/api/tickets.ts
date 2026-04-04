import { client } from './client';
import type { IssueType, Priority, Status, Ticket } from '../types/ticket';

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
    due_date?: string | null;
    tags?: string[];
    parent_id?: string | null;
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
    due_date?: string | null;
    tags?: string[];
    parent_id?: string | null;
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
  data: { author: string; role: string; note: string },
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
