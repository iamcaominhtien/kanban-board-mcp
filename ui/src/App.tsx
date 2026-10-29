import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Board } from './components/Board';
import { IdeaSpace } from './components/ideas/IdeaSpace';
import { IdeaCaptureProvider } from './components/ideas/IdeaCapture';
import { IdeaLinksProvider } from './components/ideas/ideaLinks';
import { useIdeaCounts } from './api/ideas';
import { MembersPanel } from './components/MembersPanel';
import { ProjectSidebar } from './components/ProjectSidebar';
import { SettingsPage, type SettingsTarget } from './components/settings/SettingsPage';
import { isSettingsPageId } from './components/settings/settingsIndex';
import { TicketModal } from './components/TicketModal';
import { RecycleBin } from './components/RecycleBin';
import { useProjects, useCreateProject, useDeleteProject } from './api/projects';
import { useMembers } from './api/members';
import {
  useTickets,
  getTicket,
  useCreateTicket,
  useDeleteTicket,
  useUpdateTicketStatus,
  useWontDoTickets,
  useRestoreTicket,
} from './api/tickets';
import { ReopenDialog } from './components/ReopenDialog';
import { SetPendingDialog } from './components/SetPendingDialog';
import { ResumeDialog } from './components/ResumeDialog';
import { ReopenDropPopover } from './components/ReopenDropPopover';
import { PendingCloseConfirm } from './components/PendingCloseConfirm';
import { pendingTarget, STATUS_NAMES, useMarkerActions } from './hooks/useMarkerActions';
import { useSSEInvalidation } from './hooks/useSSEInvalidation';
import { useBackendStatus } from './hooks/useBackendStatus';
import { useTheme } from './hooks/useTheme';
import { extractError } from './api/extractError';
import { useToast } from './components/Toast';
import { LoadingPill } from './components/LoadingPill';
import { LoadError } from './components/LoadError';
import { FirstRun } from './components/FirstRun';
import { useLoadingPill } from './hooks/useLoadingPill';
import { Splash } from './components/Splash';
import { UpdateNotice } from './components/UpdateNotice';
import { useAiBoard, useAiOverview, aiApi } from './api/ai';
import { AiBoardContext, type AiBoardState } from './components/ai/aiUi';
import { AiMembersPage } from './components/ai/AiMembersPage';
import { AiPausedBanner, PauseAllButton } from './components/ai/AiDialogs';
import { useAiRunNotifications } from './components/ai/useAiRunNotifications';
import { DragConfirm } from './components/ai/DragConfirm';
import { AiHoverHost } from './components/ai/MentionPill';
import type { AiRun } from './types/ai';
import { useAiSafetyNotifications } from './components/ai/useAiSafetyNotifications';
import { AssistProvider, useAssist, useAssistShortcut } from './components/assist/AssistContext';
import { AssistDock } from './components/assist/AssistDock';
import { AskAiButton, BoardHealthChip } from './components/assist/AssistEntry';
import { BoardHealthPanel, BoardHealthToast, InsightChipsProvider } from './components/assist/BoardHealth';
import { useAssistState, useInsightChips } from './api/assist';
import { SchedulesProvider } from './components/schedules/SchedulesContext';
import type { IssueType, Priority, Status, Ticket, Project, Member } from './types';

const EMPTY_PROJECTS: Project[] = [];
const EMPTY_TICKETS: Ticket[] = [];
const EMPTY_MEMBERS: Member[] = [];

/** ⌘J, the Board health panel and its toast (they read the dock's shared state). */
function AssistOverlays() {
  const ctx = useAssist();
  useAssistShortcut(true);
  if (!ctx?.projectId) return null;
  return (
    <>
      {ctx.healthOpen && <BoardHealthPanel onClose={() => ctx.setHealthOpen(false)} />}
      <BoardHealthToast />
    </>
  );
}

/** Sidebar "Ask AI" with the unseen-insight badge; hidden when chat is turned off. */
function useAskAiNav(projectId: string | null) {
  const ctx = useAssist();
  const st = useAssistState(projectId);
  // When the state cannot load the entry stays, so the dock can say what went wrong instead of AI just vanishing
  if (!ctx || (!st.data && !st.isError)) return null;
  const chat = st.data?.features.find((f) => f.key === 'chat');
  if (chat && !chat.on) return null;
  return { onClick: ctx.toggle, unseen: st.data?.unseenInsights ?? 0, active: ctx.open };
}

/** The sidebar, given the Ask AI entry from the dock's state. */
function SidebarWithAssist(props: Omit<Parameters<typeof ProjectSidebar>[0], 'askAi'> & { projectId: string | null }) {
  const { projectId, ...rest } = props;
  const askAi = useAskAiNav(projectId);
  return <ProjectSidebar {...rest} askAi={askAi} />;
}

/** The AI state and the schedule layers (editor, detail) for everything under them. */
function BoardProviders({
  ai,
  schedules,
  ideas,
  children,
}: {
  ai: AiBoardState;
  schedules: Omit<Parameters<typeof SchedulesProvider>[0], 'children'>;
  /** Idea Space: Quick add (Alt+N, "Make idea") and the links from tickets to their idea. */
  ideas: { projectId: string | null; openIdea: (id: string) => void };
  children: ReactNode;
}) {
  return (
    <AiBoardContext.Provider value={ai}>
      <SchedulesProvider {...schedules}>
        <IdeaLinksProvider value={{ openIdea: ideas.openIdea }}>
          <IdeaCaptureProvider projectId={ideas.projectId} onOpenIdea={ideas.openIdea}>
            {children}
          </IdeaCaptureProvider>
        </IdeaLinksProvider>
      </SchedulesProvider>
    </AiBoardContext.Provider>
  );
}

/** Application shell: project sidebar, board / list / timeline / Docs views and modals. */
export default function App() {
  useSSEInvalidation();
  const { status: backendStatus, errorMessage: backendError, retry: retryBackend } = useBackendStatus();
  const projectsQuery = useProjects();
  const { data: apiProjects = EMPTY_PROJECTS, isLoading: projectsLoading } = projectsQuery;
  const createProjectMutation = useCreateProject();
  const deleteProjectMutation = useDeleteProject();

  const { theme, toggleTheme } = useTheme();
  const [currentProjectId, setCurrentProjectId] = useState<string>(() => localStorage.getItem('activeProjectId') ?? '');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeType, setActiveType] = useState<IssueType | 'all'>('all');
  const [activePriority, setActivePriority] = useState<Priority | 'all'>('all');
  const [viewMode, setViewMode] = useState<'board' | 'list' | 'timeline' | 'docs' | 'schedules'>(() =>
    new URLSearchParams(window.location.search).has('docs') ? 'docs' : 'board',
  );
  const [docsRequest, setDocsRequest] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('docs'),
  );
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [recycleBinOpen, setRecycleBinOpen] = useState(false);
  const [membersPanelOpen, setMembersPanelOpen] = useState(false);
  // Settings page (null = closed); `?settings=<page>` opens it on that page
  const [settingsTarget, setSettingsTarget] = useState<SettingsTarget | null>(() => {
    const page = new URLSearchParams(window.location.search).get('settings');
    return page === '' || isSettingsPageId(page) ? { page: page || undefined } : null;
  });
  const openSettings = useCallback(() => setSettingsTarget({}), []);
  const [activeAssignee, setActiveAssignee] = useState<string | 'all'>('all');
  const [blockedDragPending, setBlockedDragPending] = useState<{ ticketId: string; newStatus: Status } | null>(null);
  const [activeBoard, setActiveBoard] = useState<'main' | 'idea'>('main');
  // An idea to open on its page (a link from a ticket or a toast)
  const [ideaRequest, setIdeaRequest] = useState<string | null>(null);
  const ideaInbox = useIdeaCounts().data?.totalInbox ?? 0;
  // The card of an AI's ticket was dropped on another column: a dialog asks before its run is cancelled
  const [dragConfirm, setDragConfirm] = useState<{
    run: AiRun;
    to: string;
    resolve: (move: boolean) => void;
  } | null>(null);

  const { data: members = EMPTY_MEMBERS } = useMembers(currentProjectId ?? '');
  const toast = useToast();
  // AI members page (null = the board); opened from the Members modal, Settings or a ticket
  const [aiPage, setAiPage] = useState<{
    memberId?: string | null;
    add?: boolean;
    tab?: 'approvals' | 'audit' | 'usage' | 'safety';
    auditMemberId?: string;
    key: number;
  } | null>(null);
  const aiOverview = useAiOverview(currentProjectId ?? '');
  const aiBoard = useAiBoard(currentProjectId ?? '');
  const aiState = useMemo<AiBoardState>(
    () => ({
      projectId: currentProjectId ?? '',
      members: new Map((aiOverview.data?.members ?? []).map((m) => [m.id, m])),
      runsByTicket: new Map((aiBoard.data?.runs ?? []).map((r) => [r.ticketId, r])),
      settings: aiBoard.data?.settings ?? aiOverview.data?.settings ?? null,
      openAiPage: (memberId?: string) => setAiPage({ memberId, key: Date.now() }),
      openAiTab: (tab, opts) => setAiPage({ tab, auditMemberId: opts?.memberId, key: Date.now() }),
    }),
    [currentProjectId, aiOverview.data, aiBoard.data],
  );
  useAiRunNotifications(aiBoard.data?.runs, (id) => openTicketModal(id), aiState.openAiPage);
  useAiSafetyNotifications(currentProjectId ?? '', () => setAiPage({ tab: 'approvals', key: Date.now() }));

  useEffect(() => {
    if (!globalError) return;
    const timer = setTimeout(() => setGlobalError(null), 5000);
    return () => clearTimeout(timer);
  }, [globalError]);

  // Debounce search input before sending it to the server (fuzzy match happens there)
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearchQuery(searchQuery.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    if (currentProjectId) {
      localStorage.setItem('activeProjectId', currentProjectId);
    } else {
      localStorage.removeItem('activeProjectId');
    }
  }, [currentProjectId]);

  useEffect(() => {
    if (apiProjects.length > 0 && !apiProjects.find((p) => p.id === currentProjectId)) {
      setCurrentProjectId(apiProjects[0].id);
    }
  }, [apiProjects, currentProjectId]);

  const currentProject = apiProjects.find((p) => p.id === currentProjectId);

  const ticketQueryParams = useMemo(
    () => (debouncedSearchQuery ? { q: debouncedSearchQuery } : undefined),
    [debouncedSearchQuery],
  );

  const ticketsQuery = useTickets(currentProjectId ?? '', ticketQueryParams);
  const { data: tickets = EMPTY_TICKETS, isLoading: ticketsLoading } = ticketsQuery;
  const { data: wontDoTickets = EMPTY_TICKETS } = useWontDoTickets(currentProjectId ?? '');
  const createTicketMutation = useCreateTicket(currentProjectId ?? '');
  const deleteTicketMutation = useDeleteTicket(currentProjectId ?? '');
  const updateStatusMutation = useUpdateTicketStatus();
  const restoreTicketMutation = useRestoreTicket(currentProjectId ?? '');

  // Local state for instant drag-and-drop updates (prevents snap-back)
  const [localTickets, setLocalTickets] = useState<Ticket[]>(tickets);

  // Sync local state with server state
  useEffect(() => {
    setLocalTickets(tickets);
  }, [tickets]);

  const [filterReopened, setFilterReopened] = useState(false);
  const [filterPending, setFilterPending] = useState(false);
  const [filterFromIdea, setFilterFromIdea] = useState(false);
  const [hidePending, setHidePending] = useState(false);

  const [reopenTargetTicket, setReopenTargetTicket] = useState<Ticket | null>(null);
  const [pendingTargetTicket, setPendingTargetTicket] = useState<Ticket | null>(null);
  const [resumeTargetTicket, setResumeTargetTicket] = useState<Ticket | null>(null);

  const markers = useMarkerActions(members);
  const [markerBusy, setMarkerBusy] = useState(false);
  const [reopenError, setReopenError] = useState<string | null>(null);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [lastReopenPayload, setLastReopenPayload] = useState<Parameters<typeof markers.reopen>[1] | null>(null);
  // Card dropped out of Done / Won't Do: the move waits for a confirm at the drop point (TicketReopen A3)
  const [dropReopen, setDropReopen] = useState<{ ticket: Ticket; x: number; y: number; reason: string } | null>(null);
  // Moving a pending ticket to Done: confirm first (TicketPending E2)
  const [closeConfirm, setCloseConfirm] = useState<{ ticketId: string; newStatus: Status } | null>(null);
  const lastPointer = useRef({ x: 400, y: 300 });
  const hoveredTicketId = useRef<string | null>(null);
  useEffect(() => {
    const track = (e: PointerEvent) => {
      lastPointer.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('pointermove', track);
    window.addEventListener('pointerup', track);
    return () => {
      window.removeEventListener('pointermove', track);
      window.removeEventListener('pointerup', track);
    };
  }, []);

  const fromIdeaCount = useMemo(
    () => localTickets.filter((t) => t.fromIdeaId && t.status !== 'wont_do').length,
    [localTickets],
  );
  const reopenedCount = useMemo(
    () => localTickets.filter((t) => t.status !== 'wont_do' && t.status !== 'done' && (t.reopenCount ?? 0) > 0).length,
    [localTickets],
  );
  const pendingCount = useMemo(
    () => localTickets.filter((t) => t.status !== 'wont_do' && t.pending).length,
    [localTickets],
  );
  const totalReopens30d = useMemo(() => {
    const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
    return localTickets.reduce(
      (acc, t) => acc + (t.reopenHistory ?? []).filter((h) => new Date(h.at).getTime() >= since).length,
      0,
    );
  }, [localTickets]);
  const waitingOnTicketsCount = useMemo(
    () => localTickets.filter((t) => t.status !== 'wont_do' && t.pending && t.pendingReasonType === 'ticket').length,
    [localTickets],
  );
  const waitingOnPersonsCount = useMemo(
    () => localTickets.filter((t) => t.status !== 'wont_do' && t.pending && t.pendingReasonType !== 'ticket').length,
    [localTickets],
  );

  // Search is applied server-side via `q`; only chip filters remain here
  const filteredTickets = localTickets
    .filter((t) => t.status !== 'wont_do')
    .filter((t) => {
      const matchesType = activeType === 'all' || t.type === activeType;
      const matchesPriority = activePriority === 'all' || t.priority === activePriority;
      const matchesAssignee =
        activeAssignee === 'all' || (activeAssignee === 'unassigned' ? !t.assignee : t.assignee === activeAssignee);
      const matchesReopened =
        !filterReopened || ((t.reopenCount ?? 0) > 0 && t.status !== 'done' && t.status !== 'wont_do');
      const matchesPending = !filterPending || Boolean(t.pending);
      const matchesFromIdea = !filterFromIdea || Boolean(t.fromIdeaId);
      const matchesHidePending = !hidePending || !t.pending;
      return (
        matchesType &&
        matchesPriority &&
        matchesAssignee &&
        matchesReopened &&
        matchesPending &&
        matchesFromIdea &&
        matchesHidePending
      );
    });

  async function handleConfirmReopen(payload: Parameters<typeof markers.reopen>[1]) {
    const target = reopenTargetTicket ?? dropReopen?.ticket;
    if (!target) return;
    setMarkerBusy(true);
    setReopenError(null);
    setLastReopenPayload(payload);
    try {
      await markers.reopen(target, payload);
      setReopenTargetTicket(null);
      setDropReopen(null);
    } catch (err) {
      setReopenError(extractError(err));
    } finally {
      setMarkerBusy(false);
    }
  }

  async function handleConfirmPending(payload: Parameters<typeof markers.setPending>[1]) {
    if (!pendingTargetTicket) return;
    setMarkerBusy(true);
    setPendingError(null);
    try {
      await markers.setPending(pendingTargetTicket, payload);
      setPendingTargetTicket(null);
    } catch (err) {
      setPendingError(extractError(err));
    } finally {
      setMarkerBusy(false);
    }
  }

  async function handleConfirmResume(payload: { reason?: string; addComment?: boolean }) {
    if (!resumeTargetTicket) return;
    setMarkerBusy(true);
    setResumeError(null);
    try {
      await markers.resume(resumeTargetTicket, payload);
      setResumeTargetTicket(null);
    } catch (err) {
      setResumeError(extractError(err));
    } finally {
      setMarkerBusy(false);
    }
  }

  const [modalState, setModalState] = useState<{ mode: 'create' } | { mode: 'view'; ticketId: string } | null>(null);

  // R / P on the hovered card (TicketReopen A4, TicketPending A3); the ticket modal has its own handler
  useEffect(() => {
    const over = (e: MouseEvent) => {
      hoveredTicketId.current =
        (e.target as HTMLElement | null)?.closest?.('[data-ticket-id]')?.getAttribute('data-ticket-id') ?? null;
    };
    const key = (e: KeyboardEvent) => {
      if (modalState || reopenTargetTicket || pendingTargetTicket || resumeTargetTicket || dropReopen || closeConfirm)
        return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        (document.activeElement as HTMLElement)?.isContentEditable
      )
        return;
      const k = e.key.toLowerCase();
      if (k !== 'r' && k !== 'p') return;
      const t = localTickets.find((x) => x.id === hoveredTicketId.current);
      if (!t) return;
      const closed = t.status === 'done' || t.status === 'wont_do';
      if (k === 'r' && closed) {
        e.preventDefault();
        setReopenTargetTicket(t);
      } else if (k === 'p' && !closed) {
        e.preventDefault();
        if (t.pending) setResumeTargetTicket(t);
        else setPendingTargetTicket(t);
      }
      // R on an open ticket and P on a closed one are ignored (no toast)
    };
    window.addEventListener('mouseover', over);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mouseover', over);
      window.removeEventListener('keydown', key);
    };
  }, [modalState, reopenTargetTicket, pendingTargetTicket, resumeTargetTicket, dropReopen, closeConfirm, localTickets]);

  const allAvailableTickets = useMemo(() => {
    const wontDoIds = new Set(wontDoTickets.map((t) => t.id));
    return [...tickets.filter((t) => !wontDoIds.has(t.id)), ...wontDoTickets];
  }, [tickets, wontDoTickets]);

  const deepLinkHandled = useRef(false);
  useEffect(() => {
    if (deepLinkHandled.current || allAvailableTickets.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const ticketId = params.get('ticket');
    if (ticketId) {
      const found = allAvailableTickets.find((t) => t.id.toLowerCase() === ticketId.toLowerCase());
      if (found) {
        deepLinkHandled.current = true;
        setModalState({ mode: 'view', ticketId: found.id }); // URL already has the param — openTicketModal would double-replaceState
      }
    }
  }, [allAvailableTickets]);

  function openDocsPage(pageId: string) {
    setViewMode('docs');
    setDocsRequest(pageId);
    closeModal();
  }

  /** Open an idea's page in the Idea Space. */
  function openIdea(ideaId: string) {
    closeModal();
    setActiveBoard('idea');
    setIdeaRequest(ideaId);
  }

  /** Open a ticket from the Idea Space: switch to its project and the board first when needed. */
  async function openTicketFromIdeas(ticketId: string) {
    try {
      const t = await getTicket(ticketId);
      if (t.projectId !== currentProjectId) setCurrentProjectId(t.projectId);
    } catch {
      /* the modal then shows nothing: the ticket is gone */
    }
    setActiveBoard('main');
    setViewMode('board');
    openTicketModal(ticketId);
  }

  function openTicketModal(ticketId: string) {
    setModalState({ mode: 'view', ticketId });
    const url = new URL(window.location.href);
    url.searchParams.set('ticket', ticketId);
    window.history.replaceState({}, '', url.toString());
  }

  /** Show the Schedules tab (a ticket's "View schedules" closes the ticket first). */
  function showSchedulesTab() {
    setAiPage(null);
    setViewMode('schedules');
    closeModal();
  }

  function closeModal() {
    setModalState(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('ticket');
    window.history.replaceState({}, '', url.toString());
  }

  const modalTicket =
    modalState && modalState.mode !== 'create'
      ? allAvailableTickets.find((t) => t.id === modalState.ticketId)
      : undefined;

  async function handleDragEnd(ticketId: string, newStatus: Status, confirmed = false) {
    const dragged = localTickets.find((t) => t.id === ticketId);
    if (dragged && (dragged.status === 'done' || dragged.status === 'wont_do')) {
      // Not applied until confirmed: the card snaps back and a popover opens at the drop point
      setDropReopen({ ticket: dragged, ...lastPointer.current, reason: '' });
      return;
    }

    const heldBy = aiState.runsByTicket.get(ticketId);
    if (
      heldBy &&
      heldBy.mode === 'work' &&
      ['queued', 'starting', 'running', 'needs_input'].includes(heldBy.state) &&
      dragged?.status !== newStatus &&
      !confirmed
    ) {
      // Dragging a card an AI holds asks first (AI work on tickets, A4)
      const move = await new Promise<boolean>((resolve) => setDragConfirm({ run: heldBy, to: newStatus, resolve }));
      if (!move) return;
      try {
        await aiApi.cancel(heldBy.id, 'The card was moved by a person');
      } catch {
        /* it ended meanwhile */
      }
    }

    if (dragged?.pending && newStatus === 'done' && !confirmed) {
      setCloseConfirm({ ticketId, newStatus });
      return;
    }

    if (newStatus === 'in-progress') {
      if (dragged && (dragged.blockedBy ?? []).length > 0) {
        setBlockedDragPending({ ticketId, newStatus });
        return;
      }
    }

    // Update local state synchronously to prevent snap-back
    setLocalTickets((prev) =>
      prev.map((t) =>
        t.id === ticketId
          ? {
              ...t,
              status: newStatus,
              // If moved to done, backend clears pending
              pending: newStatus === 'done' ? false : t.pending,
            }
          : t,
      ),
    );

    try {
      await updateStatusMutation.mutateAsync({ ticketId, status: newStatus });
      if (newStatus === 'done' && dragged) {
        toast.success('Moved to Done', `${dragged.id} · ${dragged.title}`);
      } else if (dragged?.pending) {
        toast.success(
          `${dragged.id} moved to ${STATUS_NAMES[newStatus] ?? newStatus}`,
          `Still pending - waiting on ${pendingTarget(dragged, members)}`,
          8000,
          {
            label: 'Undo',
            onClick: () => updateStatusMutation.mutate({ ticketId, status: dragged.status }),
          },
        );
      }
    } catch (err) {
      // Rollback local state on error
      setLocalTickets(tickets);
      const errMsg = extractError(err);
      setGlobalError(errMsg);
      toast.error("Couldn't save changes", errMsg);
    }
  }

  async function proceedBlockedDrag() {
    if (!blockedDragPending) return;
    const { ticketId, newStatus } = blockedDragPending;
    const dragged = localTickets.find((t) => t.id === ticketId);
    setBlockedDragPending(null);

    // Update local state synchronously to prevent snap-back
    setLocalTickets((prev) => prev.map((t) => (t.id === ticketId ? { ...t, status: newStatus } : t)));

    try {
      await updateStatusMutation.mutateAsync({ ticketId, status: newStatus });
      if (newStatus === 'done' && dragged) {
        toast.success('Moved to Done', `${dragged.id} · ${dragged.title}`);
      }
    } catch (err) {
      // Rollback local state on error
      setLocalTickets(tickets);
      const errMsg = extractError(err);
      setGlobalError(errMsg);
      toast.error("Couldn't save changes", errMsg);
    }
  }

  async function handleCreateTicket(
    data: Omit<
      Ticket,
      | 'id'
      | 'projectId'
      | 'createdAt'
      | 'updatedAt'
      | 'comments'
      | 'acceptanceCriteria'
      | 'subTasks'
      | 'activityLog'
      | 'workLog'
      | 'testCases'
      | 'wontDoReason'
      | 'blocks'
      | 'blockedBy'
      | 'blockDoneIfAcsIncomplete'
      | 'blockDoneIfTcsIncomplete'
      | 'links'
    >,
  ) {
    if (!currentProjectId) return;
    try {
      await createTicketMutation.mutateAsync(data);
      closeModal();
    } catch (err) {
      setGlobalError(`Create ticket failed: ${extractError(err)}`);
    }
  }

  async function handleDeleteTicket(id: string) {
    try {
      await deleteTicketMutation.mutateAsync(id);
      closeModal();
    } catch (err) {
      console.error('Failed to delete ticket:', err);
      setGlobalError('Failed to delete ticket. Please try again.');
    }
  }

  function handleSelectProject(id: string) {
    setCurrentProjectId(id);
    setAiPage(null);
    setSearchQuery('');
    setActiveType('all');
    setActivePriority('all');
    setActiveAssignee('all');
    closeModal();
  }

  async function handleCreateProject(data: { name: string; prefix: string; color: string }) {
    try {
      const newProject = await createProjectMutation.mutateAsync(data);
      setCurrentProjectId(newProject.id);
    } catch (err) {
      setGlobalError(`Create project failed: ${extractError(err)}`);
    }
  }

  async function handleDeleteProject(id: string) {
    try {
      await deleteProjectMutation.mutateAsync(id);
      // useEffect handles selecting the next project when apiProjects updates
    } catch (err) {
      console.error('Failed to delete project:', err);
      setGlobalError('Failed to delete project. Please try again.');
    }
  }

  function handleOpenCreate() {
    setModalState({ mode: 'create' });
    const url = new URL(window.location.href);
    url.searchParams.delete('ticket');
    window.history.replaceState({}, '', url.toString());
  }

  function handleOpenView(ticket: Ticket) {
    openTicketModal(ticket.id);
  }

  // ── Loading phases (see design/screens/app-loading.md) ──
  const projectsPhase = projectsLoading && apiProjects.length === 0;
  const projectsError = projectsQuery.isError && apiProjects.length === 0;
  const noProjects = projectsQuery.isSuccess && apiProjects.length === 0;
  const projectsOk = !projectsPhase && !projectsError && !noProjects;
  const ticketsPhase = projectsOk && ticketsLoading;
  const ticketsError = projectsOk && ticketsQuery.isError && tickets.length === 0 && !ticketsLoading;
  const pillPhase = projectsPhase ? 'projects' : ticketsPhase && activeBoard === 'main' ? 'tickets' : null;
  const pillState = useLoadingPill(pillPhase);
  const boardLoadState: 'projects' | 'tickets' | undefined =
    projectsPhase || projectsError ? 'projects' : ticketsPhase || ticketsError ? 'tickets' : undefined;
  const lanesOverride = projectsError ? (
    <LoadError
      title="Couldn't load your projects"
      onRetry={() => void projectsQuery.refetch()}
      lastAttempt={projectsQuery.errorUpdatedAt ? new Date(projectsQuery.errorUpdatedAt) : null}
    />
  ) : ticketsError ? (
    <LoadError
      title="Couldn't load your tickets"
      onRetry={() => void ticketsQuery.refetch()}
      lastAttempt={ticketsQuery.errorUpdatedAt ? new Date(ticketsQuery.errorUpdatedAt) : null}
    />
  ) : undefined;
  const loadingPill = (
    <LoadingPill
      state={pillState}
      what={pillPhase ?? 'projects'}
      onRetry={() => void (projectsPhase ? projectsQuery.refetch() : ticketsQuery.refetch())}
    />
  );

  const aiMemberCount = aiOverview.data?.members.length ?? 0;
  const insightChips = useInsightChips(currentProjectId);
  const humanMembers = members.filter((m) => (m.kind ?? 'human') === 'human');

  return (
    <BoardProviders
      ai={aiState}
      schedules={{
        projectId: currentProjectId,
        tickets: allAvailableTickets,
        onOpenTicket: openTicketModal,
        onShowTab: showSchedulesTab,
      }}
      ideas={{ projectId: currentProjectId || null, openIdea }}
    >
      <AssistProvider
        projectId={currentProjectId}
        projectName={currentProject?.name ?? ''}
        filters={{
          assignee: activeAssignee === 'all' ? null : activeAssignee,
          type: activeType === 'all' ? null : activeType,
          priority: activePriority === 'all' ? null : activePriority,
          q: searchQuery || null,
        }}
        currentTicketId={modalTicket?.id ?? null}
        onOpenTicket={openTicketModal}
        onOpenSettings={() => openSettings()}
        onOpenAiMembers={() => setAiPage({ key: Date.now() })}
        onOpenDoc={(pageId) => openDocsPage(pageId)}
      >
        <InsightChipsProvider chips={insightChips.data ?? []}>
          <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
            <Splash status={backendStatus} errorMessage={backendError} onRetryBackend={retryBackend} />
            <UpdateNotice />
            <AssistOverlays />
            <SidebarWithAssist
              projectId={currentProjectId}
              projects={apiProjects}
              currentProjectId={currentProjectId}
              onSelectProject={handleSelectProject}
              onCreateProject={handleCreateProject}
              onDeleteProject={handleDeleteProject}
              onOpenRecycleBin={() => setRecycleBinOpen(true)}
              onOpenMembers={() => setMembersPanelOpen(true)}
              memberCounts={{ humans: humanMembers.length, ai: aiMemberCount }}
              ideaInbox={ideaInbox}
              onOpenSettings={() => openSettings()}
              wontDoCount={wontDoTickets.length}
              activeBoard={activeBoard}
              onBoardChange={setActiveBoard}
              loadState={projectsPhase ? 'loading' : projectsError ? 'error' : noProjects ? 'empty' : undefined}
              onRetryProjects={() => void projectsQuery.refetch()}
            />
            <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', height: '100vh' }}>
              {globalError && (
                <div
                  style={{
                    background: '#DC2626',
                    color: 'white',
                    padding: '8px 16px',
                    borderRadius: '8px',
                    margin: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px',
                  }}
                >
                  <span>{globalError}</span>
                  <button
                    type="button"
                    onClick={() => setGlobalError(null)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'white',
                      cursor: 'pointer',
                      fontSize: '1rem',
                      lineHeight: 1,
                      padding: '0 4px',
                    }}
                  >
                    ×
                  </button>
                </div>
              )}
              {blockedDragPending && (
                <div
                  style={{
                    position: 'fixed',
                    top: '16px',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    zIndex: 1000,
                    background: '#FEF3C7',
                    border: '1.5px solid #F5C518',
                    color: 'var(--color-dark)',
                    padding: '12px 16px',
                    borderRadius: '12px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
                  }}
                >
                  <span>⚠️ This ticket is blocked. Move to In Progress anyway?</span>
                  <button
                    type="button"
                    onClick={proceedBlockedDrag}
                    style={{
                      background: '#F5C518',
                      border: 'none',
                      borderRadius: '8px',
                      padding: '6px 14px',
                      cursor: 'pointer',
                      fontWeight: 600,
                      color: 'var(--color-dark)',
                    }}
                  >
                    Move Anyway
                  </button>
                  <button
                    type="button"
                    onClick={() => setBlockedDragPending(null)}
                    style={{
                      background: 'transparent',
                      border: '1.5px solid #F5C518',
                      borderRadius: '8px',
                      padding: '6px 14px',
                      cursor: 'pointer',
                      fontWeight: 600,
                      color: 'var(--color-dark)',
                    }}
                  >
                    Cancel
                  </button>
                </div>
              )}

              {aiState.settings?.pausedAll && (
                <AiPausedBanner settings={aiState.settings} onResume={() => setAiPage({ key: Date.now() })} />
              )}
              <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                {settingsTarget ? (
                  <SettingsPage
                    onClose={() => setSettingsTarget(null)}
                    theme={theme}
                    onToggleTheme={toggleTheme}
                    projectId={currentProjectId}
                    target={settingsTarget}
                    onManageAi={() => {
                      setSettingsTarget(null);
                      setAiPage({ key: Date.now() });
                    }}
                  />
                ) : aiPage && currentProjectId && !noProjects ? (
                  <AiMembersPage
                    key={aiPage.key}
                    projectId={currentProjectId}
                    projectName={currentProject?.name ?? ''}
                    humans={humanMembers}
                    initialMemberId={aiPage.memberId}
                    initialAdd={aiPage.add}
                    initialTab={aiPage.tab}
                    initialAuditMemberId={aiPage.auditMemberId}
                    onBack={() => setAiPage(null)}
                    onOpenTicket={(id) => {
                      setAiPage(null);
                      openTicketModal(id);
                    }}
                    onOpenMembersModal={() => setMembersPanelOpen(true)}
                    onOpenSettings={() => openSettings()}
                    onViewOnBoard={(id) => {
                      setAiPage(null);
                      setActiveAssignee(id);
                    }}
                  />
                ) : noProjects ? (
                  <FirstRun
                    onCreate={async (data) => {
                      const created = await createProjectMutation.mutateAsync(data);
                      setCurrentProjectId(created.id);
                    }}
                  />
                ) : activeBoard === 'idea' && !boardLoadState ? (
                  <IdeaSpace
                    projects={apiProjects}
                    currentProjectId={currentProjectId ?? ''}
                    requestedIdeaId={ideaRequest}
                    onRequestHandled={() => setIdeaRequest(null)}
                    onOpenTicket={(id) => void openTicketFromIdeas(id)}
                    onOpenSettings={() => setSettingsTarget({ page: 'ideas' })}
                  />
                ) : (
                  <>
                    <Board
                      tickets={filteredTickets}
                      allTickets={allAvailableTickets}
                      onDragEnd={handleDragEnd}
                      onNewTicket={handleOpenCreate}
                      onCardClick={handleOpenView}
                      searchQuery={searchQuery}
                      onSearchChange={setSearchQuery}
                      activeType={activeType}
                      onTypeChange={setActiveType}
                      activePriority={activePriority}
                      onPriorityChange={setActivePriority}
                      projectName={currentProject?.name ?? ''}
                      projectId={currentProjectId ?? ''}
                      viewMode={viewMode}
                      onViewModeChange={setViewMode}
                      docsRequestedPageId={docsRequest}
                      onDocsRequestHandled={() => setDocsRequest(null)}
                      onOpenSettings={() => setSettingsTarget({ page: 'docs' })}
                      members={members}
                      activeAssignee={activeAssignee}
                      onAssigneeChange={setActiveAssignee}
                      loadState={boardLoadState}
                      lanesOverride={lanesOverride}
                      statusSlot={loadingPill}
                      headerExtra={
                        <>
                          <BoardHealthChip />
                          {aiState.settings && currentProjectId ? (
                            <PauseAllButton
                              projectId={currentProjectId}
                              settings={aiState.settings}
                              members={aiOverview.data?.members ?? []}
                            />
                          ) : null}
                          <AskAiButton />
                        </>
                      }
                      filterReopened={filterReopened}
                      onFilterReopenedChange={setFilterReopened}
                      filterPending={filterPending}
                      onFilterPendingChange={setFilterPending}
                      hidePending={hidePending}
                      onHidePendingChange={setHidePending}
                      reopenedCount={reopenedCount}
                      fromIdeaCount={fromIdeaCount}
                      filterFromIdea={filterFromIdea}
                      onFilterFromIdeaChange={setFilterFromIdea}
                      pendingCount={pendingCount}
                      totalReopens30d={totalReopens30d}
                      waitingOnTicketsCount={waitingOnTicketsCount}
                      waitingOnPersonsCount={waitingOnPersonsCount}
                      onReopen={setReopenTargetTicket}
                      onPending={setPendingTargetTicket}
                      onResume={setResumeTargetTicket}
                      onDelete={(t) => handleDeleteTicket(t.id)}
                    />
                    {!boardLoadState &&
                      modalState &&
                      (modalState.mode === 'create' ? (
                        <TicketModal
                          key="create"
                          mode="create"
                          onSave={handleCreateTicket}
                          onClose={closeModal}
                          allTickets={allAvailableTickets}
                          onOpenTicket={(t) => openTicketModal(t.id)}
                          members={members}
                        />
                      ) : modalTicket ? (
                        <TicketModal
                          key={modalTicket.id}
                          mode="view"
                          ticket={modalTicket}
                          onDelete={handleDeleteTicket}
                          onClose={closeModal}
                          onOpenDocsPage={openDocsPage}
                          allTickets={allAvailableTickets}
                          onOpenTicket={(t) => openTicketModal(t.id)}
                          members={members}
                        />
                      ) : null)}

                    {/* Standalone Dialogs opened from Card menus */}
                    {reopenTargetTicket && (
                      <ReopenDialog
                        ticket={reopenTargetTicket}
                        allTickets={allAvailableTickets}
                        members={members}
                        onClose={() => {
                          setReopenTargetTicket(null);
                          setReopenError(null);
                        }}
                        onConfirm={handleConfirmReopen}
                        isSubmitting={markerBusy}
                        error={reopenError}
                        onRetry={() => lastReopenPayload && handleConfirmReopen(lastReopenPayload)}
                        onViewTicket={() => {
                          const t = reopenTargetTicket;
                          setReopenTargetTicket(null);
                          setReopenError(null);
                          openTicketModal(t.id);
                        }}
                        initialReason={dropReopen?.reason}
                      />
                    )}
                    {dropReopen && !reopenTargetTicket && (
                      <ReopenDropPopover
                        ticket={dropReopen.ticket}
                        x={dropReopen.x}
                        y={dropReopen.y}
                        isSubmitting={markerBusy}
                        onCancel={() => setDropReopen(null)}
                        onMoreOptions={(reason) => {
                          setReopenTargetTicket(dropReopen.ticket);
                          setDropReopen({ ...dropReopen, reason });
                        }}
                        onConfirm={(reason) => handleConfirmReopen({ reason: reason || undefined })}
                      />
                    )}
                    {pendingTargetTicket && (
                      <SetPendingDialog
                        ticket={pendingTargetTicket}
                        allTickets={allAvailableTickets}
                        members={members}
                        onClose={() => {
                          setPendingTargetTicket(null);
                          setPendingError(null);
                        }}
                        onConfirm={handleConfirmPending}
                        onResumeClick={() => {
                          const t = pendingTargetTicket;
                          setPendingTargetTicket(null);
                          setResumeTargetTicket(t);
                        }}
                        isSubmitting={markerBusy}
                        error={pendingError}
                      />
                    )}
                    {resumeTargetTicket && (
                      <ResumeDialog
                        ticket={resumeTargetTicket}
                        members={members}
                        onClose={() => {
                          setResumeTargetTicket(null);
                          setResumeError(null);
                        }}
                        onConfirm={handleConfirmResume}
                        isSubmitting={markerBusy}
                        error={resumeError}
                      />
                    )}
                    {closeConfirm &&
                      (() => {
                        const t = localTickets.find((x) => x.id === closeConfirm.ticketId);
                        if (!t) return null;
                        return (
                          <PendingCloseConfirm
                            ticket={t}
                            targetStatus="done"
                            allTickets={allAvailableTickets}
                            members={members}
                            onCancel={() => setCloseConfirm(null)}
                            onResumeFirst={() => {
                              setCloseConfirm(null);
                              setResumeTargetTicket(t);
                            }}
                            onProceed={() => {
                              const c = closeConfirm;
                              setCloseConfirm(null);
                              void handleDragEnd(c.ticketId, c.newStatus, true);
                            }}
                          />
                        );
                      })()}
                  </>
                )}
                {recycleBinOpen && (
                  <RecycleBin
                    tickets={wontDoTickets}
                    projectId={currentProjectId}
                    onRestore={(id) => restoreTicketMutation.mutate(id)}
                    onClose={() => setRecycleBinOpen(false)}
                  />
                )}
                {membersPanelOpen && currentProjectId && (
                  <MembersPanel
                    projectId={currentProjectId}
                    members={members}
                    onClose={() => setMembersPanelOpen(false)}
                    onOpenAiPage={(opts) => {
                      setMembersPanelOpen(false);
                      setAiPage({ memberId: opts?.memberId, add: opts?.add, key: Date.now() });
                    }}
                  />
                )}
              </div>
            </div>
            <AssistDock />
            {!modalState && <AiHoverHost />}
            {dragConfirm && (
              <DragConfirm
                run={dragConfirm.run}
                to={dragConfirm.to}
                onCancel={() => {
                  dragConfirm.resolve(false);
                  setDragConfirm(null);
                }}
                onConfirm={() => {
                  dragConfirm.resolve(true);
                  setDragConfirm(null);
                }}
              />
            )}
          </div>
        </InsightChipsProvider>
      </AssistProvider>
    </BoardProviders>
  );
}
