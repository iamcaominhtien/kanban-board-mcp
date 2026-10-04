import { useEffect, useMemo, useRef, useState } from 'react';
import { Board } from './components/Board';
import { IdeaBoard } from './components/IdeaBoard';
import { MembersPanel } from './components/MembersPanel';
import { ProjectSidebar } from './components/ProjectSidebar';
import { SettingsPanel } from './components/SettingsPanel';
import { TicketModal } from './components/TicketModal';
import { RecycleBin } from './components/RecycleBin';
import { useProjects, useCreateProject, useDeleteProject } from './api/projects';
import { useMembers } from './api/members';
import { useTickets, useCreateTicket, useDeleteTicket, useUpdateTicketStatus, useWontDoTickets, useRestoreTicket } from './api/tickets';
import { useSSEInvalidation } from './hooks/useSSEInvalidation';
import { useBackendStatus } from './hooks/useBackendStatus';
import { useTheme } from './hooks/useTheme';
import { extractError } from './api/extractError';
import { useToast } from './components/Toast';
import { FullPageSpinner } from './components/LoadingStates';
import { Splash } from './components/Splash';
import type { IssueType, Priority, Status, Ticket, Project, Member } from './types';

const EMPTY_PROJECTS: Project[] = [];
const EMPTY_TICKETS: Ticket[] = [];
const EMPTY_MEMBERS: Member[] = [];

export default function App() {
  useSSEInvalidation();
  const { status: backendStatus, errorMessage: backendError, retry: retryBackend } = useBackendStatus();
  const { data: apiProjects = EMPTY_PROJECTS, isLoading: projectsLoading } = useProjects();
  const createProjectMutation = useCreateProject();
  const deleteProjectMutation = useDeleteProject();

  const { theme, toggleTheme } = useTheme();
  const [currentProjectId, setCurrentProjectId] = useState<string>(
    () => localStorage.getItem('activeProjectId') ?? ''
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [activeType, setActiveType] = useState<IssueType | 'all'>('all');
  const [activePriority, setActivePriority] = useState<Priority | 'all'>('all');
  const [viewMode, setViewMode] = useState<'board' | 'list' | 'timeline'>('board');
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [recycleBinOpen, setRecycleBinOpen] = useState(false);
  const [membersPanelOpen, setMembersPanelOpen] = useState(false);
  const [settingsPanelOpen, setSettingsPanelOpen] = useState(false);
  const [activeAssignee, setActiveAssignee] = useState<string | 'all'>('all');
  const [blockedDragPending, setBlockedDragPending] = useState<{ ticketId: string; newStatus: Status } | null>(null);
  const [activeBoard, setActiveBoard] = useState<'main' | 'idea'>('main');

  const { data: members = EMPTY_MEMBERS } = useMembers(currentProjectId ?? '');
  const toast = useToast();

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
    [debouncedSearchQuery]
  );

  const { data: tickets = EMPTY_TICKETS, isLoading: ticketsLoading } = useTickets(
    currentProjectId ?? '',
    ticketQueryParams
  );
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

  // Search is applied server-side via `q`; only chip filters remain here
  const filteredTickets = localTickets
    .filter((t) => t.status !== 'wont_do')
    .filter((t) => {
      const matchesType = activeType === 'all' || t.type === activeType;
      const matchesPriority = activePriority === 'all' || t.priority === activePriority;
      const matchesAssignee =
        activeAssignee === 'all' ||
        (activeAssignee === 'unassigned' ? !t.assignee : t.assignee === activeAssignee);
      return matchesType && matchesPriority && matchesAssignee;
    });

  const [modalState, setModalState] = useState<
    | { mode: 'create' }
    | { mode: 'view'; ticketId: string }
    | null
  >(null);

  const deepLinkHandled = useRef(false);
  useEffect(() => {
    if (deepLinkHandled.current || tickets.length === 0) return;
    deepLinkHandled.current = true; // always mark handled after first run
    const params = new URLSearchParams(window.location.search);
    const ticketId = params.get('ticket');
    if (ticketId) {
      const found = tickets.find((t) => t.id.toLowerCase() === ticketId.toLowerCase());
      if (found) {
        setModalState({ mode: 'view', ticketId: found.id }); // URL already has the param — openTicketModal would double-replaceState
      }
    }
  }, [tickets]);

  function openTicketModal(ticketId: string) {
    setModalState({ mode: 'view', ticketId });
    const url = new URL(window.location.href);
    url.searchParams.set('ticket', ticketId);
    window.history.replaceState({}, '', url.toString());
  }

  function closeModal() {
    setModalState(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('ticket');
    window.history.replaceState({}, '', url.toString());
  }

  const modalTicket =
    modalState && modalState.mode !== 'create'
      ? tickets.find((t) => t.id === modalState.ticketId)
      : undefined;

  async function handleDragEnd(ticketId: string, newStatus: Status) {
    const dragged = localTickets.find((t) => t.id === ticketId);
    if (newStatus === 'in-progress') {
      if (dragged && (dragged.blockedBy ?? []).length > 0) {
        setBlockedDragPending({ ticketId, newStatus });
        return;
      }
    }
    
    // Update local state synchronously to prevent snap-back
    setLocalTickets((prev) =>
      prev.map((t) => (t.id === ticketId ? { ...t, status: newStatus } : t))
    );
    
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

  async function proceedBlockedDrag() {
    if (!blockedDragPending) return;
    const { ticketId, newStatus } = blockedDragPending;
    const dragged = localTickets.find((t) => t.id === ticketId);
    setBlockedDragPending(null);
    
    // Update local state synchronously to prevent snap-back
    setLocalTickets((prev) =>
      prev.map((t) => (t.id === ticketId ? { ...t, status: newStatus } : t))
    );
    
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
    data: Omit<Ticket, 'id' | 'projectId' | 'createdAt' | 'updatedAt' | 'comments' | 'acceptanceCriteria' | 'activityLog' | 'workLog' | 'testCases' | 'wontDoReason' | 'blocks' | 'blockedBy' | 'blockDoneIfAcsIncomplete' | 'blockDoneIfTcsIncomplete' | 'links'>,
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

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Splash status={backendStatus} errorMessage={backendError} onRetryBackend={retryBackend} />
      <ProjectSidebar
        projects={apiProjects}
        currentProjectId={currentProjectId}
        onSelectProject={handleSelectProject}
        onCreateProject={handleCreateProject}
        onDeleteProject={handleDeleteProject}
        onOpenRecycleBin={() => setRecycleBinOpen(true)}
        onOpenMembers={() => setMembersPanelOpen(true)}
        onOpenSettings={() => setSettingsPanelOpen(true)}
        wontDoCount={wontDoTickets.length}
        activeBoard={activeBoard}
        onBoardChange={setActiveBoard}
      />
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', height: '100vh' }}>
        {globalError && (
          <div style={{ background: '#DC2626', color: 'white', padding: '8px 16px', borderRadius: '8px', margin: '8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <span>{globalError}</span>
            <button type="button" onClick={() => setGlobalError(null)} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', fontSize: '1rem', lineHeight: 1, padding: '0 4px' }}>×</button>
          </div>
        )}
        {blockedDragPending && (
          <div style={{ position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)', zIndex: 1000, background: '#FEF3C7', border: '1.5px solid #F5C518', color: 'var(--color-dark)', padding: '12px 16px', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '12px', boxShadow: '0 4px 16px rgba(0,0,0,0.12)' }}>
            <span>⚠️ This ticket is blocked. Move to In Progress anyway?</span>
            <button type="button" onClick={proceedBlockedDrag} style={{ background: '#F5C518', border: 'none', borderRadius: '8px', padding: '6px 14px', cursor: 'pointer', fontWeight: 600, color: 'var(--color-dark)' }}>Move Anyway</button>
            <button type="button" onClick={() => setBlockedDragPending(null)} style={{ background: 'transparent', border: '1.5px solid #F5C518', borderRadius: '8px', padding: '6px 14px', cursor: 'pointer', fontWeight: 600, color: 'var(--color-dark)' }}>Cancel</button>
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {projectsLoading && apiProjects.length === 0 ? (
          <FullPageSpinner message="Loading projects…" />
        ) : activeBoard === 'idea' ? (
          <IdeaBoard projectId={currentProjectId ?? ''} />
        ) : ticketsLoading ? (
          <FullPageSpinner message="Loading board…" />
        ) : (
          <>
            <Board
                tickets={filteredTickets}
                allTickets={localTickets}
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
                members={members}
                activeAssignee={activeAssignee}
                onAssigneeChange={setActiveAssignee}
              />
            {modalState && (
              modalState.mode === 'create' ? (
                <TicketModal
                  key="create"
                  mode="create"
                  onSave={handleCreateTicket}
                  onClose={closeModal}
                  allTickets={tickets}
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
                  allTickets={tickets}
                  onOpenTicket={(t) => openTicketModal(t.id)}
                  members={members}
                />
              ) : null
            )}
            {recycleBinOpen && (
              <RecycleBin
                tickets={wontDoTickets}
                onRestore={(id) => restoreTicketMutation.mutate(id)}
                onClose={() => setRecycleBinOpen(false)}
              />
            )}
            {membersPanelOpen && currentProjectId && (
              <MembersPanel
                projectId={currentProjectId}
                members={members}
                onClose={() => setMembersPanelOpen(false)}
              />
            )}
            {settingsPanelOpen && (
              <SettingsPanel
                onClose={() => setSettingsPanelOpen(false)}
                theme={theme}
                onToggleTheme={toggleTheme}
              />
            )}
          </>
        )}
        </div>
      </div>
    </div>
  );
}
