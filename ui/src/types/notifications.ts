/** Notifications (docs/specs/notifications.md): the shapes of the `/notifications` API as the UI sees them (camelCase). */

export type NotificationKind =
  | 'question'
  | 'approval'
  | 'run_failed'
  | 'blocked'
  | 'account_signed_out'
  | 'mention'
  | 'run_stopped_memory'
  | 'budget'
  | 'page_proposal'
  | 'auto_trip'
  | 'offline'
  | 'ai_finished'
  | 'schedule'
  | 'page_published'
  | 'comment'
  | 'run_restarted'
  | 'run_cancelled'
  | 'budget_warning'
  | 'access_request'
  | 'day_card';

/** One event inside a grouped row. */
export interface NotificationItem {
  eventId: number;
  title: string;
  body?: string;
  ticketId?: string | null;
  memberId?: string | null;
  actor?: string | null;
  at: string;
}

export interface NotificationAction {
  id: string;
  label: string;
}

/** A row as the API returns it. */
export interface NotificationRow {
  id: string;
  kind: NotificationKind | (string & {});
  kindLabel: string;
  needs: boolean;
  projectId: string | null;
  title: string;
  body: string;
  targetKind: string | null;
  targetId: string | null;
  ticketId: string | null;
  pageId: string | null;
  memberId: string | null;
  memberName: string | null;
  actor: string | null;
  count: number;
  items: NotificationItem[];
  data: Record<string, unknown>;
  inapp: boolean;
  desktop: boolean;
  read: boolean;
  readAt?: string | null;
  done: boolean;
  doneAt?: string | null;
  doneText: string | null;
  doneBy?: string | null;
  gone: boolean;
  goneReason: string | null;
  snoozed: boolean;
  snoozedUntil: string | null;
  cleared: boolean;
  clearedAt?: string | null;
  groupKey?: string | null;
  eventId: number;
  lastEventId: number;
  createdAt: string;
  updatedAt: string;
  actions: NotificationAction[];
  dismissable: boolean;
}

export interface NotificationList {
  items: NotificationRow[];
  total: number;
  head: number;
  dayCard: NotificationRow | null;
  now: string;
}

export interface NotificationCounts {
  needs: number;
  needsUnread: number;
  updatesUnread: number;
  updates: number;
  snoozed: number;
  unread: number;
  head: number;
  oldestNeedsAt: string | null;
}

export interface NotificationFeed {
  head: number;
  cursorTooOld: boolean;
  items: NotificationRow[];
  resolved: string[];
  quiet?: boolean;
  dnd?: boolean;
  sound?: boolean;
}

export type NotificationFilter = 'all' | 'unread' | 'needs' | 'snoozed' | 'done' | 'cleared';
export type NotificationFamily = 'ai' | 'people' | 'schedules' | 'info';

export interface NotificationListParams {
  view: 'panel' | 'page';
  tab?: 'needs' | 'updates';
  filter?: NotificationFilter;
  q?: string;
  projectId?: string;
  kind?: string[];
  family?: NotificationFamily;
  days?: number;
  limit?: number;
}

export type FollowScope = 'ticket' | 'page' | 'space' | 'project' | 'kind';
export type FollowLevel = 'follow' | 'everything' | 'mentions' | 'mute';

export interface FollowBody {
  scope: FollowScope;
  scopeId: string;
  level: FollowLevel | null;
  projectId?: string | null;
  minutes?: number | null;
  label?: string;
}

/** What a day card row carries in `data`. */
export interface DayCardData {
  finished?: number;
  failed?: number;
  failedRuns?: string[];
  waiting?: number;
  waitingIds?: string[];
  snoozed?: number;
  spent?: number;
  projects?: number;
  quiet?: boolean;
  lines?: { kind: string; text: string; projectId?: string }[];
}
