import { useEffect, useRef, useState } from 'react';
import { Board } from './components/Board';
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
import { useBoardSelection } from './hooks/useBoardSelection';
import { extractError } from './api/extractError';
import type { Priority, Status, Ticket } from './types';

export default function App() {
  useSSEInvalidation();
  const { status: backendStatus, errorMessage: backendError } = useBackendStatus();
  const { data: apiProjects = [], isLoading: projectsLoading } = useProjects();
  const createProjectMutation = useCreateProject();
  const deleteProjectMutation = useDeleteProject();

  const { theme, toggleTheme } = useTheme();
  const [currentProjectId, setCurrentProjectId] = useState<string>(
    () => localStorage.getItem('activeProjectId') ?? ''
  );
  const [selectedBoard, setSelectedBoard] = useBoardSelection(currentProjectId || null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activePriority, setActivePriority] = useState<Priority | 'all'>('all');
  const [viewMode, setViewMode] = useState<'board' | 'list' | 'timeline'>('board');
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [recycleBinOpen, setRecycleBinOpen] = useState(false);
  const [membersPanelOpen, setMembersPanelOpen] = useState(false);
  const [settingsPanelOpen, setSettingsPanelOpen] = useState(false);
  const [activeAssignee, setActiveAssignee] = useState<string | 'all'>('all');
  const [blockedDragPending, setBlockedDragPending] = useState<{ ticketId: string; newStatus: Status } | null>(null);

  const { data: members = [] } = useMembers(currentProjectId ?? '');

  useEffect(() => {
    if (!globalError) return;
    const timer = setTimeout(() => setGlobalError(null), 5000);
    return () => clearTimeout(timer);
  }, [globalError]);

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

  const { data: tickets = [], isLoading: ticketsLoading } = useTickets(currentProjectId ?? '');
  const { data: wontDoTickets = [] } = useWontDoTickets(currentProjectId ?? '');
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

  const q = searchQuery.toLowerCase();
  const filteredTickets = localTickets
    .filter((t) => t.status !== 'wont_do')
    .filter((t) => {
      const matchesSearch = !q || t.title.toLowerCase().includes(q) || t.tags.some((tag) => tag.toLowerCase().includes(q));
      const matchesPriority = activePriority === 'all' || t.priority === activePriority;
      const matchesAssignee =
        activeAssignee === 'all' ||
        (activeAssignee === 'unassigned' ? !t.assignee : t.assignee === activeAssignee);
      return matchesSearch && matchesPriority && matchesAssignee;
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
    if (newStatus === 'in-progress') {
      const dragged = localTickets.find((t) => t.id === ticketId);
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
    } catch (err) {
      // Rollback local state on error
      setLocalTickets(tickets);
      setGlobalError(extractError(err));
    }
  }

  async function proceedBlockedDrag() {
    if (!blockedDragPending) return;
    const { ticketId, newStatus } = blockedDragPending;
    setBlockedDragPending(null);
    
    // Update local state synchronously to prevent snap-back
    setLocalTickets((prev) =>
      prev.map((t) => (t.id === ticketId ? { ...t, status: newStatus } : t))
    );
    
    try {
      await updateStatusMutation.mutateAsync({ ticketId, status: newStatus });
    } catch (err) {
      // Rollback local state on error
      setLocalTickets(tickets);
      setGlobalError(extractError(err));
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
      {/* Backend connecting / error overlay — only shown in Electron before Python is ready */}
      {backendStatus !== 'ready' && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'var(--color-bg)',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          gap: '20px',
        }}>
          {backendStatus === 'connecting' ? (
            <>
              <div style={{
                width: 40, height: 40,
                border: '4px solid var(--color-dark)',
                borderTopColor: 'transparent',
                borderRadius: '50%',
                animation: 'spin 0.8s linear infinite',
              }} />
              <p style={{ fontFamily: 'var(--font-body)', fontSize: '1rem', color: 'var(--color-dark)', fontWeight: 500 }}>
                Starting backend…
              </p>
            </>
          ) : (
            <>
              <p style={{ fontFamily: 'var(--font-body)', fontSize: '1.1rem', color: '#DC2626', fontWeight: 700 }}>
                Backend failed to start
              </p>
              {backendError && (
                <pre style={{ fontFamily: 'monospace', fontSize: '0.8rem', color: 'var(--color-dark)', maxWidth: 520, whiteSpace: 'pre-wrap', textAlign: 'left', background: '#eee', padding: '12px', borderRadius: 8 }}>
                  {backendError}
                </pre>
              )}
              <p style={{ fontFamily: 'var(--font-body)', fontSize: '0.9rem', color: 'var(--color-dark)' }}>
                Please restart the app. If the problem persists, check the logs.
              </p>
            </>
          )}
        </div>
      )}
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
        selectedBoard={selectedBoard}
        onBoardChange={setSelectedBoard}
      />
      <div style={{ flex: 1, overflowY: 'auto' }}>
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
        {projectsLoading && apiProjects.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted, #888)' }}>
            Loading projects…
          </div>
        ) : ticketsLoading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted, #888)' }}>
            Loading tickets…
          </div>
        ) : (
          <>
            {selectedBoard === 'idea' ? (
              <div style={{ padding: '2rem', color: 'var(--color-dark)', opacity: 0.5 }}>💡 Idea Board — coming soon</div>
            ) : (
              <Board
                tickets={filteredTickets}
                allTickets={localTickets}
                onDragEnd={handleDragEnd}
                onNewTicket={handleOpenCreate}
                onCardClick={handleOpenView}
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
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
            )}
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
  );
}
