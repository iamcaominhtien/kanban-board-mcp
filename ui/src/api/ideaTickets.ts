import { client } from './client';
import type { IdeaTicket } from '../types';

/**
 * Fetch a project's idea tickets, optionally by status.
 * @param projectId - Project to list idea tickets of.
 * @param ideaStatus - Optional idea status filter.
 * @returns Idea tickets, or an empty array if the response is not a list.
 */
export async function fetchIdeaTickets(projectId: string, ideaStatus?: string): Promise<IdeaTicket[]> {
  const params: Record<string, string> = { project_id: projectId };
  if (ideaStatus) params.idea_status = ideaStatus;
  const res = await client.get<IdeaTicket[]>('/api/idea-tickets', { params });
  return Array.isArray(res.data) ? res.data : [];
}

/**
 * Create an idea ticket.
 * @param projectId - Project the idea is created in.
 * @param data - Idea ticket fields.
 */
export async function createIdeaTicket(projectId: string, data: Partial<IdeaTicket>): Promise<IdeaTicket> {
  const res = await client.post<IdeaTicket>('/api/idea-tickets', { ...data, project_id: projectId });
  return res.data;
}

/**
 * Update an idea ticket.
 * @param ticketId - Idea ticket to update.
 * @param data - Fields to change.
 */
export async function updateIdeaTicket(ticketId: string, data: Partial<IdeaTicket>): Promise<IdeaTicket> {
  const res = await client.patch<IdeaTicket>(`/api/idea-tickets/${ticketId}`, data);
  return res.data;
}

/**
 * Change an idea's status.
 * @param ticketId - Idea ticket to move.
 * @param newStatus - Target idea status.
 */
export async function updateIdeaStatus(ticketId: string, newStatus: string): Promise<IdeaTicket> {
  const res = await client.patch<IdeaTicket>(`/api/idea-tickets/${ticketId}/status`, { new_status: newStatus });
  return res.data;
}

/** Delete an idea ticket. */
export async function deleteIdeaTicket(ticketId: string): Promise<void> {
  await client.delete(`/api/idea-tickets/${ticketId}`);
}

/**
 * Add a microthought.
 * @param ticketId - Idea ticket to add to.
 * @param text - Microthought text.
 */
export async function addMicrothought(ticketId: string, text: string): Promise<IdeaTicket> {
  const res = await client.post<IdeaTicket>(`/api/idea-tickets/${ticketId}/microthoughts`, { text });
  return res.data;
}

/**
 * Delete a microthought.
 * @param ticketId - Idea ticket owning the microthought.
 * @param microthoughtId - Microthought to delete.
 */
export async function deleteMicrothought(ticketId: string, microthoughtId: string): Promise<IdeaTicket> {
  const res = await client.delete<IdeaTicket>(`/api/idea-tickets/${ticketId}/microthoughts/${microthoughtId}`);
  return res.data;
}

/**
 * Add an assumption.
 * @param ticketId - Idea ticket to add to.
 * @param text - Assumption text.
 */
export async function addAssumption(ticketId: string, text: string): Promise<IdeaTicket> {
  const res = await client.post<IdeaTicket>(`/api/idea-tickets/${ticketId}/assumptions`, { text });
  return res.data;
}

/**
 * Change an assumption's status.
 * @param ticketId - Idea ticket owning the assumption.
 * @param assumptionId - Assumption to update.
 * @param status - New assumption status.
 */
export async function updateAssumptionStatus(
  ticketId: string,
  assumptionId: string,
  status: string,
): Promise<IdeaTicket> {
  const res = await client.patch<IdeaTicket>(`/api/idea-tickets/${ticketId}/assumptions/${assumptionId}`, { status });
  return res.data;
}

/**
 * Delete an assumption.
 * @param ticketId - Idea ticket owning the assumption.
 * @param assumptionId - Assumption to delete.
 */
export async function deleteAssumption(ticketId: string, assumptionId: string): Promise<IdeaTicket> {
  const res = await client.delete<IdeaTicket>(`/api/idea-tickets/${ticketId}/assumptions/${assumptionId}`);
  return res.data;
}

/**
 * Promote an approved idea to a ticket.
 * @param ticketId - Idea ticket to promote.
 * @param projectId - Project the new ticket is created in.
 * @returns Raw server response describing the created ticket.
 */
export async function promoteIdeaToTicket(ticketId: string, projectId: string): Promise<unknown> {
  const res = await client.post(`/api/idea-tickets/${ticketId}/promote`, { project_id: projectId });
  return res.data;
}
