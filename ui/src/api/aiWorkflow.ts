import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import { LIVE_POLL_MS, SAFETY_POLL_MS } from './pollIntervals';
import type {
  ArbitrationResult,
  Pace,
  ReviewDepth,
  TddEvidence,
  TemplateDraft,
  WorkflowMetric,
  WorkflowTemplate,
  WorkflowView,
} from '../types/aiWorkflow';

export const workflowKeys = {
  templates: (projectId: string) => ['ai', 'workflows', projectId] as const,
  metrics: (projectId: string) => ['ai', 'workflow-metrics', projectId] as const,
  ticket: (ticketId: string) => ['ai', 'ticket-workflow', ticketId] as const,
  tdd: (ticketId: string) => ['ai', 'tdd', ticketId] as const,
};

export const workflowApi = {
  templates: async (projectId: string) =>
    (await client.get<WorkflowTemplate[]>(`/projects/${projectId}/ai/workflows`)).data,
  save: async (projectId: string, key: string, body: TemplateDraft) =>
    (await client.put<WorkflowTemplate>(`/projects/${projectId}/ai/workflows/${key}`, body)).data,
  metrics: async (projectId: string) =>
    (await client.get<WorkflowMetric[]>(`/projects/${projectId}/ai/workflow-metrics`, { params: { days: 30 } })).data,
  view: async (ticketId: string) => (await client.get<WorkflowView | null>(`/tickets/${ticketId}/ai/workflow`)).data,
  attach: async (ticketId: string, templateKey: string, depth?: ReviewDepth, pace?: Pace) =>
    (
      await client.post<WorkflowView>(`/tickets/${ticketId}/ai/workflow`, {
        template_key: templateKey,
        depth,
        ...(pace === 'fast' ? { pace } : {}),
      })
    ).data,
  detach: async (ticketId: string) => {
    await client.delete(`/tickets/${ticketId}/ai/workflow`);
  },
  decide: async (ticketId: string, approve: boolean, note?: string) =>
    (await client.post<WorkflowView>(`/tickets/${ticketId}/ai/workflow/decide`, { approve, note })).data,
  sendBack: async (ticketId: string, role: string, note: string) =>
    (await client.post<WorkflowView>(`/tickets/${ticketId}/ai/workflow/send-back`, { role, note })).data,
  reviewer: async (ticketId: string) =>
    (await client.get<{ ticketId: string; reviewerId: string | null }>(`/tickets/${ticketId}/ai/reviewer`)).data,
  setReviewer: async (ticketId: string, memberId: string | null) =>
    (
      await client.put<{ ticketId: string; reviewerId: string | null }>(`/tickets/${ticketId}/ai/reviewer`, {
        member_id: memberId,
      })
    ).data,
  skip: async (ticketId: string, stepId?: string) =>
    (await client.post<WorkflowView>(`/tickets/${ticketId}/ai/workflow/skip`, { step_id: stepId })).data,
  /** Fast mode on or off: the steps not reached yet are skipped or put back. */
  pace: async (ticketId: string, pace: Pace) =>
    (await client.patch<WorkflowView>(`/tickets/${ticketId}/ai/workflow/pace`, { pace })).data,
  depth: async (ticketId: string, depth: ReviewDepth) =>
    (await client.patch<WorkflowView>(`/tickets/${ticketId}/ai/workflow/depth`, { depth })).data,
  rule: async (ticketId: string, side: 'reviewer' | 'dev' | 'split', reason?: string) =>
    (await client.post<ArbitrationResult>(`/tickets/${ticketId}/ai/arbitration`, { side, reason })).data,
  tdd: async (ticketId: string) => (await client.get<TddEvidence>(`/tickets/${ticketId}/ai/tdd`)).data,
  /** Take the Dev step without test-first evidence just this once (with why), or (`ruleOff`) turn the rule off for the
   * project. */
  acceptTdd: async (ticketId: string, ruleOff = false, reason?: string) =>
    (
      await client.post<WorkflowView>(`/tickets/${ticketId}/ai/tdd/accept`, {
        ...(ruleOff ? { ruleOff: true } : {}),
        ...(reason ? { reason } : {}),
      })
    ).data,
  /** Accept a testing step that finished with nothing to show (outcome `no_evidence`); the reason is required. */
  acceptEvidence: async (ticketId: string, reason: string) =>
    (await client.post<WorkflowView>(`/tickets/${ticketId}/ai/evidence/accept`, { reason })).data,
  /** Let a workflow stopped at its token cap go on: the same cap again from now, or (`cap`) a higher one for this
   * ticket, counted from the start of its workflow. */
  resume: async (ticketId: string, cap?: number) =>
    (
      await (cap !== undefined
        ? client.post<WorkflowView>(`/tickets/${ticketId}/ai/workflow/resume`, { cap })
        : client.post<WorkflowView>(`/tickets/${ticketId}/ai/workflow/resume`))
    ).data,
};

/** The templates of a project: the four ready-made, then its own. */
export function useWorkflowTemplates(projectId: string) {
  return useQuery({
    queryKey: workflowKeys.templates(projectId),
    queryFn: () => workflowApi.templates(projectId),
    enabled: !!projectId,
  });
}

/** Used on / median / passed first, over the last 30 days. A failure here only hides those columns. */
export function useWorkflowMetrics(projectId: string) {
  return useQuery({
    queryKey: workflowKeys.metrics(projectId),
    queryFn: () => workflowApi.metrics(projectId),
    enabled: !!projectId,
    retry: false,
  });
}

/** Save a template (a new version of it, or a new one). */
export function useSaveTemplate(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, body }: { key: string; body: TemplateDraft }) => workflowApi.save(projectId, key, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: workflowKeys.templates(projectId) }),
  });
}

/** The ticket's workflow, polled while something is going on. */
export function useTicketWorkflow(ticketId: string, enabled = true) {
  return useQuery({
    queryKey: workflowKeys.ticket(ticketId),
    queryFn: () => workflowApi.view(ticketId),
    enabled: !!ticketId && enabled,
    refetchInterval: (q) => (q.state.data?.steps.some((s) => s.state === 'active') ? LIVE_POLL_MS : SAFETY_POLL_MS),
  });
}

/** An odd job's optional reviewer (an AI member id), or null. */
export function useOddJobReviewer(ticketId: string, enabled = true) {
  return useQuery({
    queryKey: ['ai', 'ticket-reviewer', ticketId],
    queryFn: () => workflowApi.reviewer(ticketId),
    enabled: !!ticketId && enabled,
    retry: false,
  });
}

/** The test-first evidence of a ticket. */
export function useTddEvidence(ticketId: string, enabled = true) {
  return useQuery({
    queryKey: workflowKeys.tdd(ticketId),
    queryFn: () => workflowApi.tdd(ticketId),
    enabled: !!ticketId && enabled,
    retry: false,
  });
}

/** Run one change to a ticket's workflow and refresh everything that shows it. */
export function useWorkflowMutation<T, V>(ticketId: string, fn: (v: V) => Promise<T>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: workflowKeys.ticket(ticketId) });
      void qc.invalidateQueries({ queryKey: workflowKeys.tdd(ticketId) });
      void qc.invalidateQueries({ queryKey: ['ai', 'ticket-flags'] });
      void qc.invalidateQueries({ queryKey: ['ai', 'ticket-runs', ticketId] });
      void qc.invalidateQueries({ queryKey: ['ai', 'workflow-board'] });
    },
  });
}
