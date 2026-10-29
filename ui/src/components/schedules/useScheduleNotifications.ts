import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { scheduleApi, scheduleKeys } from '../../api/schedules';
import type { ScheduleEvent } from '../../types/schedules';
import { useToast } from '../Toast';
import { currentPerson } from '../assist/assistUi';
import type { EditorOpts } from './ScheduleEditor';

const POLL_MS = 20000;

/** Last event id shown in this tab, kept in sessionStorage (it can be unavailable). */
function readLast(projectId: string): number | null {
  try {
    const v = sessionStorage.getItem(`kanban.schedules.lastEvent.${projectId}`);
    return v == null ? null : Number(v);
  } catch {
    return null;
  }
}

function writeLast(projectId: string, id: number) {
  try {
    sessionStorage.setItem(`kanban.schedules.lastEvent.${projectId}`, String(id));
  } catch {
    /* storage unavailable: events can show again after a reload */
  }
}

/** Whether the event is for the person at this browser (the board's own user is "user" until a name is set). */
export function isForMe(to: string[]): boolean {
  const me = currentPerson();
  return to.includes(me) || (me === 'You' && to.includes('user'));
}

/**
 * Toasts for schedule events (E4): polled every 20 s and when the window gets focus, shown only to the people the
 * event names. The first load only records the last id, so opening the board never replays old news.
 */
export function useScheduleNotifications(
  projectId: string,
  nav: {
    openTicket: (ticketId: string) => void;
    openDetail: (scheduleId: string) => void;
    openEditor: (opts?: EditorOpts) => void;
  },
) {
  const toast = useToast();
  const navRef = useRef(nav);
  const toastRef = useRef(toast);
  useEffect(() => {
    navRef.current = nav;
    toastRef.current = toast;
  });

  // The last event id shown, per project. React Query can cancel a fetch whose request still completes, so the id
  // is checked again after the wait: the same event never shows twice.
  const lastRef = useRef<{ project: string; id: number | null } | null>(null);

  useQuery({
    queryKey: scheduleKeys.events(projectId),
    enabled: !!projectId,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      if (lastRef.current?.project !== projectId) lastRef.current = { project: projectId, id: readLast(projectId) };
      const state = lastRef.current;
      const events = await scheduleApi.events(projectId, state.id ?? 0);
      const seen = state.id;
      const top = events.reduce((m, e) => Math.max(m, e.id), seen ?? 0);
      if (seen == null || top > seen) {
        state.id = top;
        writeLast(projectId, top);
      }
      // First load of this tab: remember where the log is, show nothing
      if (seen != null) show(events.filter((e) => e.id > seen && isForMe(e.to)));
      return events.length;
    },
  });

  function show(events: ScheduleEvent[]) {
    for (const e of events) {
      const go = navRef.current;
      const action =
        e.action === 'open_run'
          ? { label: 'Open run', onClick: () => go.openTicket(e.ticketId) }
          : e.action === 'reschedule'
            ? { label: 'Reschedule', onClick: () => go.openEditor({ scheduleId: e.scheduleId }) }
            : e.action === 'open'
              ? { label: 'Open', onClick: () => go.openDetail(e.scheduleId) }
              : undefined;
      const t = toastRef.current;
      const title = e.text;
      if (e.event === 'failed' || e.event === 'needs_input') t.warning(title, undefined, 12000, action);
      else if (e.event === 'finished') t.success(title, undefined, 9000, action);
      else t.info(title, undefined, 8000, action);
    }
  }
}
