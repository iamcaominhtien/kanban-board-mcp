import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Ticket } from '../../types';
import { ScheduleDetailLayer } from './ScheduleDetail';
import { ScheduleEditor, type EditorOpts } from './ScheduleEditor';
import { useScheduleNotifications } from './useScheduleNotifications';

/** What any screen can do with schedules: open the editor or one schedule, or show a ticket's schedules. */
export interface SchedulesApi {
  /** Create (optionally locked to a ticket and an AI) or edit a schedule. */
  openEditor: (opts?: EditorOpts) => void;
  openDetail: (scheduleId: string) => void;
  /** Open the Schedules tab filtered to one ticket (null: all). */
  viewForTicket: (ticketId: string | null) => void;
  /** The ticket the Schedules tab is filtered to. */
  ticketFilter: string | null;
  setTicketFilter: (ticketId: string | null) => void;
  openTicket: (ticketId: string) => void;
}

const NOOP: SchedulesApi = {
  openEditor: () => undefined,
  openDetail: () => undefined,
  viewForTicket: () => undefined,
  ticketFilter: null,
  setTicketFilter: () => undefined,
  openTicket: () => undefined,
};

const SchedulesContext = createContext<SchedulesApi>(NOOP);

/** Schedule actions of the open project. */
export function useSchedules(): SchedulesApi {
  return useContext(SchedulesContext);
}

/**
 * Provides the schedule actions and renders their layers (editor, detail) above the board, so a ticket, a card
 * and the Schedules tab all open the same ones. Also polls the notifications (E4).
 */
export function SchedulesProvider({
  projectId,
  tickets,
  onOpenTicket,
  onShowTab,
  children,
}: {
  projectId: string;
  tickets: Ticket[];
  onOpenTicket: (ticketId: string) => void;
  /** Switch the board to the Schedules tab. */
  onShowTab: () => void;
  children: ReactNode;
}) {
  const [editor, setEditor] = useState<EditorOpts | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [ticketFilter, setTicketFilter] = useState<string | null>(null);

  const openEditor = useCallback((opts: EditorOpts = {}) => setEditor(opts), []);
  const openDetail = useCallback((id: string) => setDetailId(id), []);
  const viewForTicket = useCallback(
    (ticketId: string | null) => {
      setTicketFilter(ticketId);
      onShowTab();
    },
    [onShowTab],
  );

  useScheduleNotifications(projectId, { openTicket: onOpenTicket, openDetail, openEditor });

  const api = useMemo<SchedulesApi>(
    () => ({ openEditor, openDetail, viewForTicket, ticketFilter, setTicketFilter, openTicket: onOpenTicket }),
    [openEditor, openDetail, viewForTicket, ticketFilter, onOpenTicket],
  );

  return (
    <SchedulesContext.Provider value={api}>
      {children}
      {detailId && projectId && (
        <ScheduleDetailLayer
          scheduleId={detailId}
          projectId={projectId}
          onClose={() => setDetailId(null)}
          onEdit={(id) => setEditor({ scheduleId: id })}
          onOpenTicket={(id) => {
            setDetailId(null);
            onOpenTicket(id);
          }}
        />
      )}
      {editor && projectId && (
        <ScheduleEditor projectId={projectId} tickets={tickets} opts={editor} onClose={() => setEditor(null)} />
      )}
    </SchedulesContext.Provider>
  );
}
