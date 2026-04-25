import { client } from './client';
import type { IdeaTicket } from '../types';

export async function fetchIdeaTickets(projectId: string, ideaStatus?: string): Promise<IdeaTicket[]> {
  const params: Record<string, string> = { project_id: projectId };
  if (ideaStatus) params.idea_status = ideaStatus;
  const res = await client.get<IdeaTicket[]>('/api/idea-tickets', { params });
  return res.data;
}

export async function createIdeaTicket(projectId: string, data: Partial<IdeaTicket>): Promise<IdeaTicket> {
  const res = await client.post<IdeaTicket>('/api/idea-tickets', { ...data, project_id: projectId });
  return res.data;
}

export async function updateIdeaTicket(ticketId: string, data: Partial<IdeaTicket>): Promise<IdeaTicket> {
  const res = await client.patch<IdeaTicket>(`/api/idea-tickets/${ticketId}`, data);
  return res.data;
}

export async function updateIdeaStatus(ticketId: string, newStatus: string): Promise<IdeaTicket> {
  const res = await client.patch<IdeaTicket>(`/api/idea-tickets/${ticketId}/status`, { new_status: newStatus });
  return res.data;
}

export async function deleteIdeaTicket(ticketId: string): Promise<void> {
  await client.delete(`/api/idea-tickets/${ticketId}`);
}

export async function addMicrothought(ticketId: string, text: string): Promise<IdeaTicket> {
  const res = await client.post<IdeaTicket>(`/api/idea-tickets/${ticketId}/microthoughts`, { text });
  return res.data;
}

export async function deleteMicrothought(ticketId: string, microthoughtId: string): Promise<IdeaTicket> {
  const res = await client.delete<IdeaTicket>(`/api/idea-tickets/${ticketId}/microthoughts/${microthoughtId}`);
  return res.data;
}

export async function addAssumption(ticketId: string, text: string): Promise<IdeaTicket> {
  const res = await client.post<IdeaTicket>(`/api/idea-tickets/${ticketId}/assumptions`, { text });
  return res.data;
}

export async function updateAssumptionStatus(
  ticketId: string,
  assumptionId: string,
  status: string,
): Promise<IdeaTicket> {
  const res = await client.patch<IdeaTicket>(
    `/api/idea-tickets/${ticketId}/assumptions/${assumptionId}`,
    { status },
  );
  return res.data;
}

export async function deleteAssumption(ticketId: string, assumptionId: string): Promise<IdeaTicket> {
  const res = await client.delete<IdeaTicket>(
    `/api/idea-tickets/${ticketId}/assumptions/${assumptionId}`,
  );
  return res.data;
}

export async function promoteIdeaToTicket(ticketId: string, projectId: string): Promise<unknown> {
  const res = await client.post(`/api/idea-tickets/${ticketId}/promote`, { project_id: projectId });
  return res.data;
}
