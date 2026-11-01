import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { client } from './client';
import { SAFETY_POLL_MS } from './pollIntervals';
import type {
  FollowBody,
  NotificationCounts,
  NotificationFeed,
  NotificationFamily,
  NotificationFilter,
  NotificationList,
  NotificationListParams,
} from '../types/notifications';

export const notificationKeys = {
  all: ['notifications'] as const,
  counts: ['notifications', 'counts'] as const,
  list: (p: NotificationListParams) => ['notifications', 'list', p] as const,
  settings: ['notifications', 'settings'] as const,
  follow: (scope: string, scopeId: string) => ['notifications', 'follow', scope, scopeId] as const,
};

function listQuery(p: NotificationListParams) {
  return {
    view: p.view,
    tab: p.tab,
    filter: p.filter,
    q: p.q || undefined,
    project_id: p.projectId,
    kind: p.kind,
    family: p.family,
    days: p.days,
    limit: p.limit,
  };
}

export const notificationsApi = {
  list: async (p: NotificationListParams) =>
    (
      await client.get<NotificationList>('/notifications', {
        params: listQuery(p),
        paramsSerializer: { indexes: null },
      })
    ).data,
  counts: async () => (await client.get<NotificationCounts>('/notifications/counts')).data,
  /** Without `since` only `head` comes back. */
  feed: async (since?: number) =>
    (await client.get<NotificationFeed>('/notifications/feed', { params: since === undefined ? {} : { since } })).data,
  /** With `all`, the page's filters narrow what is marked (same fields as `GET /notifications?view=page`). */
  read: async (body: {
    ids?: string[];
    all?: boolean;
    tab?: 'needs' | 'updates';
    filter?: NotificationFilter;
    q?: string;
    projectId?: string;
    kind?: string[];
    family?: NotificationFamily;
    days?: number;
  }) => {
    const { projectId, q, ...rest } = body;
    return (
      await client.post<{ read: number }>('/notifications/read', {
        ...rest,
        q: q || undefined,
        project_id: projectId,
      })
    ).data;
  },
  opened: async (targetKind: string, targetId: string) =>
    (await client.post<{ read: number }>('/notifications/opened', { targetKind, targetId })).data,
  dismiss: async (id: string) => (await client.post(`/notifications/${id}/dismiss`)).data,
  /** `until` is an ISO time; null brings the row back now. */
  snooze: async (id: string, until: string | null) =>
    (await client.post(`/notifications/${id}/snooze`, { until })).data,
  clear: async (id: string, on = true) => (await client.post(`/notifications/${id}/clear`, { on })).data,
  clearRead: async () => (await client.post<{ cleared: number }>('/notifications/clear-read')).data,
  settings: async () => (await client.get<Record<string, unknown>>('/notifications/settings')).data,
  patchSettings: async (body: Record<string, unknown>) =>
    (await client.patch<Record<string, unknown>>('/notifications/settings', body)).data,
  followState: async (scope: string, scopeId: string) =>
    (await client.get<Record<string, unknown>>('/notifications/follow', { params: { scope, scope_id: scopeId } })).data,
  setFollow: async (body: FollowBody) =>
    (await client.put<Record<string, unknown>>('/notifications/follow', body)).data,
  unmute: async (followId: string) => (await client.delete(`/notifications/follow/${followId}`)).data,
  dayCard: async (preview = false) =>
    (await client.get<{ card: unknown; preview: unknown }>('/notifications/day-card', { params: { preview } })).data,
  writeDayCard: async () => (await client.post<{ written: number }>('/notifications/day-card')).data,
};

/** The bell's numbers; the server announces changes over SSE (topic `notifications`), a poll every 30 s is the fallback. */
export function useNotificationCounts() {
  return useQuery({
    queryKey: notificationKeys.counts,
    queryFn: notificationsApi.counts,
    refetchInterval: SAFETY_POLL_MS,
    retry: false,
  });
}

/** Rows for the panel or the page. */
export function useNotificationList(params: NotificationListParams, enabled = true) {
  return useQuery({
    queryKey: notificationKeys.list(params),
    queryFn: () => notificationsApi.list(params),
    refetchInterval: SAFETY_POLL_MS,
    placeholderData: keepPreviousData,
    retry: false,
    enabled,
  });
}
