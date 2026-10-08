import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import { resolveOrigin } from './resolveOrigin';
import type {
  BranchGraphData,
  DebugAttachment,
  CommitDetail,
  IssueType,
  Priority,
  RelationType,
  Status,
  TestCase,
  Ticket,
  TicketBranch,
  TicketLink,
  TicketWorkspaceInfo,
  WorkLogEntry,
  WorkLogRole,
  WorkspaceFilePreview,
  WorkspaceSettings,
  WorkspaceSweepResult,
} from '../types/ticket';

export interface DescriptionImageUpload {
  url: string;
  markdown: string;
  filename: string;
  contentType: string;
  size: number;
}

/** Fetch a project's tickets with optional filters. */
export async function listTickets(
  projectId: string,
  params?: { status?: string; priority?: string; q?: string },
): Promise<Ticket[]> {
  const res = await client.get<Ticket[]>(`/projects/${projectId}/tickets`, { params, timeout: 15000 });
  return res.data;
}

/** Create a ticket in a project. */
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
    startDate?: string | null;
    tags?: string[];
    parentId?: string | null;
  },
): Promise<Ticket> {
  const res = await client.post<Ticket>(`/projects/${projectId}/tickets`, data);
  return res.data;
}

/** Fetch one ticket. */
export async function getTicket(ticketId: string): Promise<Ticket> {
  const res = await client.get<Ticket>(`/tickets/${ticketId}`);
  return res.data;
}

/** Update ticket fields. */
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
    startDate?: string | null;
    tags?: string[];
    parentId?: string | null;
    wontDoReason?: string | null;
    assignee?: string | null;
    blockDoneIfAcsIncomplete?: boolean;
    blockDoneIfTcsIncomplete?: boolean;
    repoPath?: string | null;
  },
): Promise<Ticket> {
  const res = await client.patch<Ticket>(`/tickets/${ticketId}`, data);
  return res.data;
}

/** Move a ticket to another status. */
export async function updateTicketStatus(ticketId: string, status: Status): Promise<Ticket> {
  const res = await client.patch<Ticket>(`/tickets/${ticketId}/status`, { status });
  return res.data;
}

/** Delete a ticket. */
export async function deleteTicket(ticketId: string): Promise<void> {
  await client.delete(`/tickets/${ticketId}`);
}

export interface AttachmentUpload {
  id: string;
  url: string;
  name: string;
  size: number;
  type: string;
  markdown: string;
}

/** Upload an image for Markdown text and return its URL. */
export async function uploadDescriptionImage(file: File): Promise<DescriptionImageUpload> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await client.post<DescriptionImageUpload>('/uploads/images', formData);
  return res.data;
}

/** Upload any file (doc, sheet, presentation, pdf, json, text, code, archive, image…) */
export async function uploadAnyFile(file: File): Promise<AttachmentUpload> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await client.post<AttachmentUpload>('/uploads/files', formData);
  return res.data;
}

/** Backwards-compatible alias for debug/entry attachments */
export async function uploadAttachment(file: File): Promise<DebugAttachment> {
  return uploadAnyFile(file);
}

/** Absolute URL for a stored upload (the UI may be served from another origin). */
export function uploadUrl(url?: string | null, downloadName?: string, download?: boolean, inline?: boolean): string {
  if (!url || typeof url !== 'string' || !url.startsWith('/uploads/')) return '';
  const base = `${resolveOrigin()}${url}`;
  const params = new URLSearchParams();
  if (downloadName) params.set('name', downloadName);
  if (download) params.set('download', '1');
  if (inline) params.set('inline', '1');
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Fetch a project's "Won't do" tickets. */
export async function listWontDoTickets(projectId: string): Promise<Ticket[]> {
  const res = await client.get<Ticket[]>(`/projects/${projectId}/tickets`, {
    params: { include_wont_do: true, status: 'wont_do' },
  });
  return res.data;
}

// Comments
/** Add a comment to a ticket. */
export async function addComment(ticketId: string, text: string, author = 'user'): Promise<Ticket> {
  const res = await client.post<Ticket>(`/tickets/${ticketId}/comments`, { text, author });
  return res.data;
}

/** Edit a comment. */
export async function updateComment(ticketId: string, commentId: string, text: string): Promise<Ticket> {
  const res = await client.patch<Ticket>(`/tickets/${ticketId}/comments/${commentId}`, { text });
  return res.data;
}

/** Delete a comment (restorable). */
export async function deleteComment(ticketId: string, commentId: string): Promise<Ticket> {
  const res = await client.delete<Ticket>(`/tickets/${ticketId}/comments/${commentId}`);
  return res.data;
}

/** Restore a deleted comment. */
export async function restoreComment(ticketId: string, commentId: string): Promise<Ticket> {
  const res = await client.post<Ticket>(`/tickets/${ticketId}/comments/${commentId}/restore`);
  return res.data;
}

// Acceptance criteria
/** Add an acceptance criterion. */
export async function addAcceptanceCriterion(ticketId: string, text: string): Promise<Ticket> {
  const res = await client.post<Ticket>(`/tickets/${ticketId}/acceptance-criteria`, { text });
  return res.data;
}

/** Toggle an acceptance criterion. */
export async function toggleAcceptanceCriterion(ticketId: string, criterionId: string): Promise<Ticket> {
  const res = await client.patch<Ticket>(`/tickets/${ticketId}/acceptance-criteria/${criterionId}/toggle`);
  return res.data;
}

/** Delete an acceptance criterion. */
export async function deleteAcceptanceCriterion(ticketId: string, criterionId: string): Promise<Ticket> {
  const res = await client.delete<Ticket>(`/tickets/${ticketId}/acceptance-criteria/${criterionId}`);
  return res.data;
}

// Sub-tasks (checklist items)
/** Add a sub-task. */
export async function addSubTask(ticketId: string, text: string): Promise<Ticket> {
  const res = await client.post<Ticket>(`/tickets/${ticketId}/sub-tasks`, { text });
  return res.data;
}

/** Toggle a sub-task. */
export async function toggleSubTask(ticketId: string, subTaskId: string): Promise<Ticket> {
  const res = await client.patch<Ticket>(`/tickets/${ticketId}/sub-tasks/${subTaskId}/toggle`);
  return res.data;
}

/** Delete a sub-task. */
export async function deleteSubTask(ticketId: string, subTaskId: string): Promise<Ticket> {
  const res = await client.delete<Ticket>(`/tickets/${ticketId}/sub-tasks/${subTaskId}`);
  return res.data;
}

// Work log
/** Add a work-log entry. */
export async function addWorkLog(
  ticketId: string,
  data: { author: string; role: WorkLogRole | string; note: string } & Partial<WorkLogEntry>,
): Promise<Ticket> {
  const res = await client.post<Ticket>(`/tickets/${ticketId}/work-log`, data);
  return res.data;
}

/** Edit a work-log entry. */
export async function updateWorkLog(ticketId: string, entryId: string, data: Partial<WorkLogEntry>): Promise<Ticket> {
  const res = await client.patch<Ticket>(`/tickets/${ticketId}/work-log/${entryId}`, data);
  return res.data;
}

/** Delete a work-log entry. */
export async function deleteWorkLog(ticketId: string, entryId: string): Promise<Ticket> {
  const res = await client.delete<Ticket>(`/tickets/${ticketId}/work-log/${entryId}`);
  return res.data;
}

// Test cases
/** Add a test case. */
export async function addTestCase(ticketId: string, title: string, extra?: Partial<TestCase>): Promise<Ticket> {
  const res = await client.post<Ticket>(`/tickets/${ticketId}/test-cases`, { title, ...extra });
  return res.data;
}

/** Update a test case. */
export async function updateTestCase(ticketId: string, testCaseId: string, data: Partial<TestCase>): Promise<Ticket> {
  const res = await client.patch<Ticket>(`/tickets/${ticketId}/test-cases/${testCaseId}`, data);
  return res.data;
}

/** Delete a test case. */
export async function deleteTestCase(ticketId: string, testCaseId: string): Promise<Ticket> {
  const res = await client.delete<Ticket>(`/tickets/${ticketId}/test-cases/${testCaseId}`);
  return res.data;
}

// Links
/** Link two tickets with a relation type. */
export async function addTicketLink(
  ticketId: string,
  targetId: string,
  relationType: RelationType,
): Promise<TicketLink> {
  const res = await client.post<TicketLink>(`/tickets/${ticketId}/links`, {
    target_id: targetId,
    relation_type: relationType,
  });
  return res.data;
}

/** Remove a ticket link. */
export async function removeTicketLink(ticketId: string, linkId: string): Promise<void> {
  await client.delete(`/tickets/${ticketId}/links/${linkId}`);
}

// Branches
/** Fetch a ticket's branches. */
export async function listBranches(ticketId: string): Promise<TicketBranch[]> {
  const res = await client.get<TicketBranch[]>(`/tickets/${ticketId}/branches`);
  return res.data;
}

/** Add a branch to a ticket. */
export async function createBranch(
  ticketId: string,
  data: {
    name: string;
    branch_from?: string;
    status?: string;
    pr_url?: string | null;
    commit_hash?: string | null;
    linked_ticket_id?: string | null;
    ahead_count?: number;
    behind_count?: number;
    create_worktree?: boolean;
    worktree_path?: string | null;
  },
): Promise<Ticket> {
  const res = await client.post<Ticket>(`/tickets/${ticketId}/branches`, data);
  return res.data;
}

/** Update a branch. */
export async function updateBranch(
  ticketId: string,
  branchId: string,
  data: Partial<TicketBranch> & { remove_worktree?: boolean; worktree_path?: string | null },
): Promise<Ticket> {
  const res = await client.patch<Ticket>(`/tickets/${ticketId}/branches/${branchId}`, data);
  return res.data;
}

/** Delete a branch record. */
export async function deleteBranch(
  ticketId: string,
  branchId: string,
  opts: { removeWorktree?: boolean; deleteGitBranch?: boolean; force?: boolean } = {},
): Promise<Ticket> {
  const params: Record<string, boolean> = {};
  if (opts.removeWorktree) params.remove_worktree = true;
  if (opts.deleteGitBranch) params.delete_git_branch = true;
  if (opts.force) params.force = true;
  const res = await client.delete<Ticket>(`/tickets/${ticketId}/branches/${branchId}`, { params });
  return res.data;
}

/** Fetch the commit graph of the ticket's repo. */
export async function getBranchGraph(ticketId: string, limit: number): Promise<BranchGraphData> {
  const res = await client.get<BranchGraphData>(`/tickets/${ticketId}/graph`, { params: { limit } });
  return res.data;
}

/** Fetch details of one commit. */
export async function getCommitDetail(ticketId: string, rev: string): Promise<CommitDetail> {
  const res = await client.get<CommitDetail>(`/tickets/${ticketId}/commits/${rev}`);
  return res.data;
}

/** Check out a ticket's branch in the linked repo. */
export async function checkoutBranch(ticketId: string, branchId: string): Promise<Ticket> {
  const res = await client.post<Ticket>(`/tickets/${ticketId}/branches/${branchId}/checkout`);
  return res.data;
}

// Workspace
/** Fetch the workspace settings. */
export async function getWorkspaceSettings(): Promise<WorkspaceSettings> {
  const res = await client.get<WorkspaceSettings>('/workspace/settings');
  return res.data;
}

/** Update the workspace settings. */
export async function updateWorkspaceSettings(data: Partial<WorkspaceSettings>): Promise<WorkspaceSettings> {
  const res = await client.patch<WorkspaceSettings>('/workspace/settings', data);
  return res.data;
}

/** Fetch a ticket's workspace folder and entries. */
export async function getTicketWorkspace(ticketId: string): Promise<TicketWorkspaceInfo> {
  const res = await client.get<TicketWorkspaceInfo>(`/tickets/${ticketId}/workspace`);
  return res.data;
}

/** Set a ticket's workspace retention override. */
export async function setTicketWorkspaceRetention(ticketId: string, retentionDays: number | null): Promise<Ticket> {
  const res = await client.patch<Ticket>(`/tickets/${ticketId}/workspace/retention`, { retention_days: retentionDays });
  return res.data;
}

/** Create a ticket's workspace folder. */
export async function initTicketWorkspace(ticketId: string): Promise<void> {
  await client.post(`/tickets/${ticketId}/workspace/init`);
}

/** Open a ticket's workspace in the file manager. */
export async function openTicketWorkspace(ticketId: string): Promise<void> {
  await client.post(`/tickets/${ticketId}/workspace/open`);
}

/** Create a folder in a ticket's workspace. */
export async function createWorkspaceFolder(ticketId: string, path: string): Promise<void> {
  await client.post(`/tickets/${ticketId}/workspace/folders`, { path });
}

/** Upload a file to a ticket's workspace. */
export async function uploadWorkspaceFile(ticketId: string, file: File, directory = ''): Promise<void> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('directory', directory);
  await client.post(`/tickets/${ticketId}/workspace/files`, formData);
}

/** Delete a file or folder from a ticket's workspace. */
export async function deleteWorkspaceEntry(ticketId: string, path: string): Promise<void> {
  await client.delete(`/tickets/${ticketId}/workspace/entry`, { params: { path } });
}

/** Fetch a text preview of a workspace file. */
export async function getWorkspacePreview(ticketId: string, path: string): Promise<WorkspaceFilePreview> {
  const res = await client.get<WorkspaceFilePreview>(`/tickets/${ticketId}/workspace/file`, {
    params: { path },
  });
  return res.data;
}

/** URL of a workspace file, usable in <img src> or as a download link. */
export function workspaceFileUrl(ticketId: string, path: string, download = false): string {
  const qs = new URLSearchParams({ path });
  if (download) qs.set('download', 'true');
  return `${resolveOrigin()}/tickets/${encodeURIComponent(ticketId)}/workspace/file?${qs}`;
}

/** Delete (or with `dryRun`, list) expired workspaces. */
export async function sweepWorkspaces(dryRun: boolean): Promise<WorkspaceSweepResult> {
  const res = await client.post<WorkspaceSweepResult>('/workspace/sweep', { dry_run: dryRun });
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

/** Query a project's tickets. */
export function useTickets(projectId: string, params?: { status?: string; priority?: string; q?: string }) {
  return useQuery({
    queryKey: [...ticketKeys.all(projectId), params],
    queryFn: () => listTickets(projectId, params),
    enabled: !!projectId,
    retry: false,
    // `q` changes on every search keystroke (debounced), which changes the
    // query key — keep showing the previous results while the new query
    // fetches instead of flashing a loading state / unmounting the board.
    placeholderData: keepPreviousData,
  });
}

/** Query one ticket. */
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

/** Mutation: create a ticket. */
export function useCreateTicket(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Parameters<typeof createTicket>[1]) => createTicket(projectId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ticketKeys.all(projectId) });
    },
  });
}

/** Mutation: update a ticket. */
export function useUpdateTicket() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, data }: { ticketId: string; data: Parameters<typeof updateTicket>[1] }) =>
      updateTicket(ticketId, data),
    onSuccess: (ticket) => {
      queryClient.invalidateQueries({ queryKey: ticketKeys.all(ticket.projectId) });
      queryClient.invalidateQueries({ queryKey: ['wont_do_tickets', ticket.projectId] });
      queryClient.setQueryData(ticketKeys.detail(ticket.id), ticket);
    },
  });
}

/** Mutation: change a ticket's status (optimistic). */
export function useUpdateTicketStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, status }: { ticketId: string; status: Status }) => updateTicketStatus(ticketId, status),
    onSuccess: (ticket) => {
      queryClient.setQueryData(ticketKeys.detail(ticket.id), ticket);
      queryClient.invalidateQueries({ queryKey: ticketKeys.all(ticket.projectId) });
    },
  });
}

/** Mutation: delete a ticket. */
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

/** Mutation: add a comment. */
export function useAddComment() {
  return useTicketSubMutation(({ ticketId, text, author }: { ticketId: string; text: string; author?: string }) =>
    addComment(ticketId, text, author),
  );
}

/** Mutation: edit a comment. */
export function useUpdateComment() {
  return useTicketSubMutation(({ ticketId, commentId, text }: { ticketId: string; commentId: string; text: string }) =>
    updateComment(ticketId, commentId, text),
  );
}

/** Mutation: restore a deleted comment. */
export function useRestoreComment() {
  return useTicketSubMutation(({ ticketId, commentId }: { ticketId: string; commentId: string }) =>
    restoreComment(ticketId, commentId),
  );
}

/** Mutation: delete a comment. */
export function useDeleteComment() {
  return useTicketSubMutation(({ ticketId, commentId }: { ticketId: string; commentId: string }) =>
    deleteComment(ticketId, commentId),
  );
}

/** Mutation: add an acceptance criterion. */
export function useAddAcceptanceCriterion() {
  return useTicketSubMutation(({ ticketId, text }: { ticketId: string; text: string }) =>
    addAcceptanceCriterion(ticketId, text),
  );
}

/** Mutation: toggle an acceptance criterion. */
export function useToggleAcceptanceCriterion() {
  return useTicketSubMutation(({ ticketId, criterionId }: { ticketId: string; criterionId: string }) =>
    toggleAcceptanceCriterion(ticketId, criterionId),
  );
}

/** Mutation: delete an acceptance criterion. */
export function useDeleteAcceptanceCriterion() {
  return useTicketSubMutation(({ ticketId, criterionId }: { ticketId: string; criterionId: string }) =>
    deleteAcceptanceCriterion(ticketId, criterionId),
  );
}

/** Mutation: add a sub-task. */
export function useAddSubTask() {
  return useTicketSubMutation(({ ticketId, text }: { ticketId: string; text: string }) => addSubTask(ticketId, text));
}

/** Mutation: toggle a sub-task. */
export function useToggleSubTask() {
  return useTicketSubMutation(({ ticketId, subTaskId }: { ticketId: string; subTaskId: string }) =>
    toggleSubTask(ticketId, subTaskId),
  );
}

/** Mutation: delete a sub-task. */
export function useDeleteSubTask() {
  return useTicketSubMutation(({ ticketId, subTaskId }: { ticketId: string; subTaskId: string }) =>
    deleteSubTask(ticketId, subTaskId),
  );
}

/** Mutation: add a work-log entry. */
export function useAddWorkLog() {
  return useTicketSubMutation(({ ticketId, data }: { ticketId: string; data: Parameters<typeof addWorkLog>[1] }) =>
    addWorkLog(ticketId, data),
  );
}

/** Mutation: edit a work-log entry. */
export function useUpdateWorkLog() {
  return useTicketSubMutation(
    ({ ticketId, entryId, data }: { ticketId: string; entryId: string; data: Parameters<typeof updateWorkLog>[2] }) =>
      updateWorkLog(ticketId, entryId, data),
  );
}

/** Mutation: delete a work-log entry. */
export function useDeleteWorkLog() {
  return useTicketSubMutation(({ ticketId, entryId }: { ticketId: string; entryId: string }) =>
    deleteWorkLog(ticketId, entryId),
  );
}

/** Mutation: add a test case. */
export function useAddTestCase() {
  return useTicketSubMutation(
    ({ ticketId, title, ...extra }: { ticketId: string; title: string } & Partial<TestCase>) =>
      addTestCase(ticketId, title, extra),
  );
}

/** Mutation: update a test case. */
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

/** Mutation: delete a test case. */
export function useDeleteTestCase() {
  return useTicketSubMutation(({ ticketId, testCaseId }: { ticketId: string; testCaseId: string }) =>
    deleteTestCase(ticketId, testCaseId),
  );
}

/** Query a project's "Won't do" tickets. */
export function useWontDoTickets(projectId: string) {
  return useQuery({
    queryKey: ['wont_do_tickets', projectId],
    queryFn: () => listWontDoTickets(projectId),
    enabled: !!projectId,
  });
}

/** Mutation: restore a "Won't do" ticket. */
export function useRestoreTicket(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ticketId: string) => updateTicket(ticketId, { status: 'backlog', wontDoReason: null }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ticketKeys.all(projectId) });
      queryClient.invalidateQueries({ queryKey: ['wont_do_tickets', projectId] });
    },
  });
}

// Block / Blocked-by relationships

/** Mark a ticket as blocking another. */
export async function linkBlock(ticketId: string, targetId: string): Promise<{ blocker: Ticket; blocked: Ticket }> {
  const res = await client.post<{ blocker: Ticket; blocked: Ticket }>(`/tickets/${ticketId}/blocks/${targetId}`);
  return res.data;
}

/** Remove a blocks relation. */
export async function unlinkBlock(ticketId: string, targetId: string): Promise<{ blocker: Ticket; blocked: Ticket }> {
  const res = await client.delete<{ blocker: Ticket; blocked: Ticket }>(`/tickets/${ticketId}/blocks/${targetId}`);
  return res.data;
}

/** Mutation: mark a ticket as blocking another. */
export function useLinkBlock() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ blockerId, blockedId }: { blockerId: string; blockedId: string }) => linkBlock(blockerId, blockedId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ticketKeys.all(data.blocker.projectId) });
      if (data.blocked.projectId !== data.blocker.projectId) {
        queryClient.invalidateQueries({ queryKey: ticketKeys.all(data.blocked.projectId) });
      }
      queryClient.setQueryData(ticketKeys.detail(data.blocker.id), data.blocker);
      queryClient.setQueryData(ticketKeys.detail(data.blocked.id), data.blocked);
    },
  });
}

/** Mutation: remove a blocks relation. */
export function useUnlinkBlock() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ blockerId, blockedId }: { blockerId: string; blockedId: string }) =>
      unlinkBlock(blockerId, blockedId),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ticketKeys.all(data.blocker.projectId) });
      if (data.blocked.projectId !== data.blocker.projectId) {
        queryClient.invalidateQueries({ queryKey: ticketKeys.all(data.blocked.projectId) });
      }
      queryClient.setQueryData(ticketKeys.detail(data.blocker.id), data.blocker);
      queryClient.setQueryData(ticketKeys.detail(data.blocked.id), data.blocked);
    },
  });
}

// ---------------------------------------------------------------------------
// Project activities (for event timeline)
// ---------------------------------------------------------------------------

export interface ActivityEvent {
  ticketId: string;
  ticketTitle: string;
  eventType: string;
  at: string;
  detail: string | null;
}

/** Fetch a project's recent activity. */
export async function listProjectActivities(projectId: string): Promise<ActivityEvent[]> {
  const res = await client.get<ActivityEvent[]>(`/projects/${projectId}/activities`);
  return res.data;
}

/** Query a project's recent activity. */
export function useProjectActivities(projectId: string) {
  return useQuery({
    queryKey: ['project_activities', projectId],
    queryFn: () => listProjectActivities(projectId),
    enabled: !!projectId,
  });
}

/** Mutation: link two tickets. */
export function useAddTicketLink(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      ticketId,
      targetId,
      relationType,
    }: {
      ticketId: string;
      targetId: string;
      relationType: RelationType;
    }) => addTicketLink(ticketId, targetId, relationType),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ticketKeys.all(projectId) });
    },
  });
}

/** Mutation: remove a ticket link. */
export function useRemoveTicketLink(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, linkId }: { ticketId: string; linkId: string }) => removeTicketLink(ticketId, linkId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ticketKeys.all(projectId) });
    },
  });
}

/** Query a ticket's workspace. */
export function useTicketWorkspace(ticketId: string) {
  return useQuery({
    queryKey: ['ticket_workspace', ticketId],
    queryFn: () => getTicketWorkspace(ticketId),
    enabled: !!ticketId,
  });
}

/** Query a text preview of a workspace file. */
export function useWorkspacePreview(ticketId: string, path: string, enabled = true) {
  return useQuery({
    queryKey: ['ticket_workspace', ticketId, 'preview', path],
    queryFn: () => getWorkspacePreview(ticketId, path),
    enabled,
  });
}

/** Query the workspace settings. */
export function useWorkspaceSettings() {
  return useQuery({ queryKey: ['workspace_settings'], queryFn: getWorkspaceSettings });
}

/** Mutation: update the workspace settings. */
export function useUpdateWorkspaceSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<WorkspaceSettings>) => updateWorkspaceSettings(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace_settings'] });
      queryClient.invalidateQueries({ queryKey: ['ticket_workspace'] });
    },
  });
}

/** Run a workspace mutation and refresh that ticket's file listing afterwards. */
export function useWorkspaceAction<TVars>(ticketId: string, fn: (vars: TVars) => Promise<void>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['ticket_workspace', ticketId] });
    },
  });
}

/** Mutation: set a ticket's workspace retention. */
export function useSetTicketWorkspaceRetention() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, retentionDays }: { ticketId: string; retentionDays: number | null }) =>
      setTicketWorkspaceRetention(ticketId, retentionDays),
    onSuccess: (_, { ticketId }) => {
      queryClient.invalidateQueries({ queryKey: ['ticket_workspace', ticketId] });
      queryClient.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) });
    },
  });
}

/** Query a ticket's branches. */
export function useTicketBranches(ticketId: string) {
  return useQuery({
    queryKey: ['ticket_branches', ticketId],
    queryFn: () => listBranches(ticketId),
    enabled: !!ticketId,
  });
}

/** Query the commit graph of the ticket's repo. */
export function useBranchGraph(ticketId: string, limit: number) {
  return useQuery({
    // shares the ['ticket_branches', ticketId] prefix so branch mutations refresh it too
    queryKey: ['ticket_branches', ticketId, 'graph', limit],
    queryFn: () => getBranchGraph(ticketId, limit),
    enabled: !!ticketId,
    placeholderData: keepPreviousData,
  });
}

/** Query details of one commit (disabled while `rev` is null). */
export function useCommitDetail(ticketId: string, rev: string | null) {
  return useQuery({
    queryKey: ['ticket_branches', ticketId, 'commit', rev],
    queryFn: () => getCommitDetail(ticketId, rev as string),
    enabled: !!ticketId && !!rev,
    staleTime: Infinity, // a commit never changes
  });
}

/** Mutation: add a branch. */
export function useCreateBranch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, data }: { ticketId: string; data: Parameters<typeof createBranch>[1] }) =>
      createBranch(ticketId, data),
    onSuccess: (_, { ticketId }) => {
      queryClient.invalidateQueries({ queryKey: ['ticket_branches', ticketId] });
      queryClient.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) });
    },
  });
}

/** Mutation: update a branch. */
export function useUpdateBranch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      ticketId,
      branchId,
      data,
    }: {
      ticketId: string;
      branchId: string;
      data: Parameters<typeof updateBranch>[2];
    }) => updateBranch(ticketId, branchId, data),
    onSuccess: (_, { ticketId }) => {
      queryClient.invalidateQueries({ queryKey: ['ticket_branches', ticketId] });
      queryClient.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) });
    },
  });
}

/** Mutation: check out a branch. */
export function useCheckoutBranch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ticketId, branchId }: { ticketId: string; branchId: string }) => checkoutBranch(ticketId, branchId),
    onSuccess: (_, { ticketId }) => {
      queryClient.invalidateQueries({ queryKey: ['ticket_branches', ticketId] });
      queryClient.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) });
    },
  });
}

/** Mutation: delete a branch record. */
export function useDeleteBranch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      ticketId,
      branchId,
      ...opts
    }: {
      ticketId: string;
      branchId: string;
      removeWorktree?: boolean;
      deleteGitBranch?: boolean;
      force?: boolean;
    }) => deleteBranch(ticketId, branchId, opts),
    onSuccess: (_, { ticketId }) => {
      queryClient.invalidateQueries({ queryKey: ['ticket_branches', ticketId] });
      queryClient.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) });
    },
  });
}
