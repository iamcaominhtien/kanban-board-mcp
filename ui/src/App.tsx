import { useEffect, useRef, useState } from 'react';
import { Board } from './components/Board';
import { MembersPanel } from './components/MembersPanel';
import { ProjectSidebar } from './components/ProjectSidebar';
import { TicketModal } from './components/TicketModal';
import { RecycleBin } from './components/RecycleBin';
import { useProjects, useCreateProject, useDeleteProject } from './api/projects';
import { useMembers } from './api/members';
import { useTickets, useCreateTicket, useDeleteTicket, useUpdateTicketStatus, useWontDoTickets, useRestoreTicket } from './api/tickets';
import type { Priority, Status, Ticket } from './types';

export default function App() {
  const { data: apiProjects = [], isLoading: projectsLoading } = useProjects();
  const createProjectMutation = useCreateProject();
  const deleteProjectMutation = useDeleteProject();

  const [currentProjectId, setCurrentProjectId] = useState<string>(
    () => localStorage.getItem('activeProjectId') ?? ''
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [activePriority, setActivePriority] = useState<Priority | 'all'>('all');
  const [viewMode, setViewMode] = useState<'board' | 'list' | 'timeline'>('board');
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [recycleBinOpen, setRecycleBinOpen] = useState(false);
  const [membersPanelOpen, setMembersPanelOpen] = useState(false);
  const [activeAssignee, setActiveAssignee] = useState<string | 'all'>('all');

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

  const q = searchQuery.toLowerCase();
  const filteredTickets = tickets
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
    try {
      await updateStatusMutation.mutateAsync({ ticketId, status: newStatus });
    } catch (err) {
      console.error('Failed to update status:', err);
    }
  }

  async function handleCreateTicket(
    data: Omit<Ticket, 'id' | 'projectId' | 'createdAt' | 'updatedAt' | 'comments' | 'acceptanceCriteria' | 'activityLog' | 'workLog' | 'testCases' | 'wontDoReason'>,
  ) {
    if (!currentProjectId) return;
    await createTicketMutation.mutateAsync(data);
    closeModal();
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
    const newProject = await createProjectMutation.mutateAsync(data);
    setCurrentProjectId(newProject.id);
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
      <ProjectSidebar
        projects={apiProjects}
        currentProjectId={currentProjectId}
        onSelectProject={handleSelectProject}
        onCreateProject={handleCreateProject}
        onDeleteProject={handleDeleteProject}
        onOpenRecycleBin={() => setRecycleBinOpen(true)}
        onOpenMembers={() => setMembersPanelOpen(true)}
        wontDoCount={wontDoTickets.length}
      />
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {globalError && (
          <div style={{ background: '#DC2626', color: 'white', padding: '8px 16px', borderRadius: '8px', margin: '8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <span>{globalError}</span>
            <button type="button" onClick={() => setGlobalError(null)} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', fontSize: '1rem', lineHeight: 1, padding: '0 4px' }}>×</button>
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
            <Board
              tickets={filteredTickets}
              allTickets={tickets}
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
          </>
        )}
      </div>
    </div>
  );
}
