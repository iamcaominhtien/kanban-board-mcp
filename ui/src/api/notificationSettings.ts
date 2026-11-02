import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import { extractError } from './extractError';

/** Settings › Notifications and the follow bell (docs/specs/notifications.md): hooks, plain calls and their types. */

export interface EventSetting {
  kind: string;
  label: string;
  /** Needs you (may interrupt) or for information. */
  needs: boolean;
  inapp: boolean;
  /** In app cannot be switched off (every Needs you kind). */
  inappLocked: boolean;
  desktop: boolean;
}

export type FollowLevel = 'follow' | 'everything' | 'mentions' | 'mute';
export type FollowScope = 'ticket' | 'page' | 'space' | 'project' | 'kind';

export interface MutedItem {
  id: string;
  scope: FollowScope;
  scopeId: string;
  projectId: string | null;
  level: FollowLevel;
  until: string | null;
  label: string;
  createdAt: string;
}

export interface NotificationSettings {
  events: EventSetting[];
  quiet: { on: boolean; start: string; end: string };
  /** The master switch: no OS notification at all when off (each kind keeps its own choice). */
  desktopOn: boolean;
  dnd: boolean;
  sound: boolean;
  /** Which sound a Needs you event makes: chime, drop or bell. */
  soundName: string;
  /** Minutes a Needs you may stay unanswered before it reminds once; 0 = never. */
  remindAfterMin: number;
  dayCard: { on: boolean; time: string; days: number[] };
  retentionDays: number;
  /** Retention deletes everyone's history: only the board's own user or a project owner or admin may change it. */
  retentionEditable?: boolean;
  muted: MutedItem[];
}

/** What a PATCH may carry; each part is optional. */
export interface NotificationSettingsPatch {
  events?: { kind: string; inapp?: boolean; desktop?: boolean }[];
  quiet?: Partial<NotificationSettings['quiet']>;
  desktopOn?: boolean;
  dnd?: boolean;
  sound?: boolean;
  soundName?: string;
  remindAfterMin?: number;
  dayCard?: Partial<NotificationSettings['dayCard']>;
  retentionDays?: number;
}

export interface FollowState {
  scope: FollowScope;
  scopeId: string;
  level: FollowLevel | null;
  until: string | null;
  id: string | null;
}

export const notificationSettingsKey = ['notifications', 'settings'] as const;
/** Query key of the follow state of one ticket or page. */
export const followKey = (scope: FollowScope, scopeId: string) => ['notifications', 'follow', scope, scopeId] as const;

/** Read Settings › Notifications of the caller. */
export async function getNotificationSettings(): Promise<NotificationSettings> {
  const res = await client.get<NotificationSettings>('/notifications/settings');
  return res.data;
}

/**
 * Save part of the settings; rejects with the server's message (422) as an Error.
 * @param patch - The parts to change.
 */
export async function patchNotificationSettings(patch: NotificationSettingsPatch): Promise<NotificationSettings> {
  try {
    const res = await client.patch<NotificationSettings>('/notifications/settings', patch);
    return res.data;
  } catch (e) {
    throw new Error(extractError(e));
  }
}

/**
 * What the bell on a ticket, page or space shows.
 * @param scope - What is followed.
 * @param scopeId - Its id.
 */
export async function getFollow(scope: FollowScope, scopeId: string): Promise<FollowState> {
  const res = await client.get<FollowState>('/notifications/follow', { params: { scope, scope_id: scopeId } });
  return res.data;
}

/**
 * Follow, mute or forget (level null) a ticket, page or space.
 * @param body - Scope, id, level and, for "Mute for 1 hour", `minutes`.
 */
export async function putFollow(body: {
  scope: FollowScope;
  scopeId: string;
  level: FollowLevel | null;
  minutes?: number;
  projectId?: string;
}): Promise<FollowState> {
  const res = await client.put<FollowState>('/notifications/follow', body);
  return res.data;
}

/**
 * Unmute (or stop following) one line of the Muted list.
 * @param id - Id of the follow.
 */
export async function deleteFollow(id: string): Promise<void> {
  await client.delete(`/notifications/follow/${id}`);
}

/** The caller's notification settings. */
export function useNotificationSettings() {
  return useQuery({ queryKey: notificationSettingsKey, queryFn: getNotificationSettings });
}

/** Save part of the settings and take the server's answer as the new state. */
export function usePatchNotificationSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: patchNotificationSettings,
    onSuccess: (data) => qc.setQueryData(notificationSettingsKey, data),
  });
}

/** Unmute one line of the Muted list. */
export function useUnmute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteFollow,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
}

/**
 * The follow state of a ticket or page for the bell.
 * @param scope - ticket or page.
 * @param scopeId - Ticket key or page id.
 */
export function useFollow(scope: FollowScope, scopeId: string) {
  return useQuery({
    queryKey: followKey(scope, scopeId),
    queryFn: () => getFollow(scope, scopeId),
    enabled: !!scopeId,
  });
}

/**
 * Change the follow level of a ticket or page.
 * @param scope - ticket or page.
 * @param scopeId - Ticket key or page id.
 */
export function useSetFollow(scope: FollowScope, scopeId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { level: FollowLevel | null; minutes?: number; projectId?: string }) =>
      putFollow({ scope, scopeId, ...v }),
    onSuccess: (data) => {
      qc.setQueryData(followKey(scope, scopeId), data);
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
}
