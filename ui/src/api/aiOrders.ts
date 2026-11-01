import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Firing, Order, OrderDraft, OrderPatch, OrderTemplates, Rule } from '../types/aiOrders';
import { client } from './client';
import { SAFETY_POLL_MS } from './pollIntervals';

export const orderKeys = {
  templates: ['ai', 'order-templates'] as const,
  list: (projectId: string) => ['ai', 'orders', projectId] as const,
  firings: (projectId: string, orderId?: string | null) => ['ai', 'firings', projectId, orderId ?? 'all'] as const,
};

export const ordersApi = {
  templates: async () => (await client.get<OrderTemplates>('/ai/order-templates')).data,
  parse: async (projectId: string, sentence: string) =>
    (await client.post<{ rule: Rule }>(`/projects/${projectId}/ai/orders/parse`, { sentence })).data.rule,
  list: async (projectId: string) => (await client.get<Order[]>(`/projects/${projectId}/ai/orders`)).data,
  create: async (projectId: string, body: OrderDraft) =>
    (await client.post<Order>(`/projects/${projectId}/ai/orders`, body)).data,
  patch: async (id: string, body: OrderPatch) => (await client.patch<Order>(`/ai/orders/${id}`, body)).data,
  remove: async (id: string) => {
    await client.delete(`/ai/orders/${id}`);
  },
  firings: async (projectId: string, orderId?: string | null, limit = 100) =>
    (
      await client.get<Firing[]>(`/projects/${projectId}/ai/firings`, {
        params: { order_id: orderId || undefined, limit },
      })
    ).data,
  undo: async (id: string) => (await client.post<{ text: string; firing: Firing }>(`/ai/firings/${id}/undo`)).data,
  tick: async (projectId: string) =>
    (await client.post<{ fired: Firing[] }>(`/projects/${projectId}/ai/orders/tick`)).data,
};

/** The ready-made rules, the actions and what each fits. */
export function useOrderTemplates() {
  return useQuery({ queryKey: orderKeys.templates, queryFn: ordersApi.templates, staleTime: Infinity });
}

/** The project's rules; counts and "last time" move while rules fire. */
export function useOrders(projectId: string) {
  return useQuery({
    queryKey: orderKeys.list(projectId),
    queryFn: () => ordersApi.list(projectId),
    enabled: !!projectId,
    refetchInterval: SAFETY_POLL_MS,
  });
}

/** Firings of one rule, or of all of them. */
export function useFirings(projectId: string, orderId: string | null, enabled = true) {
  return useQuery({
    queryKey: orderKeys.firings(projectId, orderId),
    queryFn: () => ordersApi.firings(projectId, orderId),
    enabled: enabled && !!projectId,
  });
}

/** Ends every write by refetching rules and firings (the counts are the server's). */
function useRefresh(projectId: string) {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: orderKeys.list(projectId) }),
      qc.invalidateQueries({ queryKey: ['ai', 'firings', projectId] }),
    ]);
}

/** A sentence read as a rule (422 when no signal fits). */
export function useParseSentence(projectId: string) {
  return useMutation({ mutationFn: (sentence: string) => ordersApi.parse(projectId, sentence) });
}

/** Saves a new rule (off) and starts its trial in one go. */
export function useCreateOrder(projectId: string) {
  const refresh = useRefresh(projectId);
  return useMutation({
    mutationFn: async ({ draft, trialDays }: { draft: OrderDraft; trialDays: number }) => {
      const made = await ordersApi.create(projectId, draft);
      return ordersApi.patch(made.id, { state: 'trial', trialDays });
    },
    onSuccess: refresh,
  });
}

/** Changes a rule: its state, trial length, name or body. */
export function usePatchOrder(projectId: string) {
  const refresh = useRefresh(projectId);
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: OrderPatch }) => ordersApi.patch(id, body),
    onSuccess: refresh,
  });
}

/** Removes a rule. */
export function useDeleteOrder(projectId: string) {
  const refresh = useRefresh(projectId);
  return useMutation({ mutationFn: (id: string) => ordersApi.remove(id), onSuccess: refresh });
}

/** Puts one firing back (409 when it cannot be). */
export function useUndoFiring(projectId: string) {
  const refresh = useRefresh(projectId);
  return useMutation({ mutationFn: (id: string) => ordersApi.undo(id), onSuccess: refresh });
}

/** "Look now": runs the signals once. */
export function useTick(projectId: string) {
  const refresh = useRefresh(projectId);
  return useMutation({ mutationFn: () => ordersApi.tick(projectId), onSuccess: refresh });
}
