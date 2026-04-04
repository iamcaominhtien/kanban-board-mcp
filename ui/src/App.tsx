import { useEffect, useState } from 'react';
import { Board } from './components/Board';
import { ProjectSidebar } from './components/ProjectSidebar';
import { TicketModal } from './components/TicketModal';
import { useProjects, useCreateProject, useDeleteProject } from './api/projects';
import { useTickets, useCreateTicket, useDeleteTicket, useUpdateTicketStatus } from './api/tickets';
import type { Priority, Status, Ticket } from './types';

export default function App() {
  const { data: apiProjects = [], isLoading: projectsLoading } = useProjects();
  const createProjectMutation = useCreateProject();
  const deleteProjectMutation = useDeleteProject();

  const [currentProjectId, setCurrentProjectId] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activePriority, setActivePriority] = useState<Priority | 'all'>('all');

  useEffect(() => {
    if (apiProjects.length > 0 && !apiProjects.find((p) => p.id === currentProjectId)) {
      setCurrentProjectId(apiProjects[0].id);
    }
  }, [apiProjects, currentProjectId]);

  const currentProject = apiProjects.find((p) => p.id === currentProjectId);

  const { data: tickets = [], isLoading: ticketsLoading } = useTickets(currentProjectId ?? '');
  const createTicketMutation = useCreateTicket(currentProjectId ?? '');
  const deleteTicketMutation = useDeleteTicket(currentProjectId ?? '');
  const updateStatusMutation = useUpdateTicketStatus();

  const q = searchQuery.toLowerCase();
  const filteredTickets = tickets.filter((t) => {
    const matchesSearch = !q || t.title.toLowerCase().includes(q) || t.tags.some((tag) => tag.toLowerCase().includes(q));
    const matchesPriority = activePriority === 'all' || t.priority === activePriority;
    return matchesSearch && matchesPriority;
  });

  const [modalState, setModalState] = useState<
    | { mode: 'create' }
    | { mode: 'view'; ticketId: string }
    | null
  >(null);

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
    data: Omit<Ticket, 'id' | 'projectId' | 'createdAt' | 'updatedAt' | 'comments' | 'acceptanceCriteria' | 'activityLog' | 'workLog' | 'testCases'>,
  ) {
    if (!currentProjectId) return;
    try {
      await createTicketMutation.mutateAsync(data);
      setModalState(null);
    } catch (err) {
      console.error('Failed to create ticket:', err);
      window.alert('Failed to create ticket. Please try again.');
    }
  }

  async function handleDeleteTicket(id: string) {
    try {
      await deleteTicketMutation.mutateAsync(id);
      setModalState(null);
    } catch (err) {
      console.error('Failed to delete ticket:', err);
      window.alert('Failed to delete ticket. Please try again.');
    }
  }

  function handleSelectProject(id: string) {
    setCurrentProjectId(id);
    setSearchQuery('');
    setActivePriority('all');
    setModalState(null);
  }

  async function handleCreateProject(data: { name: string; prefix: string; color: string }) {
    try {
      const newProject = await createProjectMutation.mutateAsync(data);
      setCurrentProjectId(newProject.id);
    } catch (err) {
      console.error('Failed to create project:', err);
      window.alert('Failed to create project. Please try again.');
    }
  }

  async function handleDeleteProject(id: string) {
    try {
      await deleteProjectMutation.mutateAsync(id);
      // useEffect handles selecting the next project when apiProjects updates
    } catch (err) {
      console.error('Failed to delete project:', err);
      window.alert('Failed to delete project. Please try again.');
    }
  }

  function handleOpenCreate() {
    setModalState({ mode: 'create' });
  }

  function handleOpenView(ticket: Ticket) {
    setModalState({ mode: 'view', ticketId: ticket.id });
  }

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <ProjectSidebar
        projects={apiProjects}
        currentProjectId={currentProjectId}
        onSelectProject={handleSelectProject}
        onCreateProject={handleCreateProject}
        onDeleteProject={handleDeleteProject}
      />
      <div style={{ flex: 1, overflowY: 'auto' }}>
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
            />
            {modalState && (
              modalState.mode === 'create' ? (
                <TicketModal
                  key="create"
                  mode="create"
                  onSave={handleCreateTicket}
                  onClose={() => setModalState(null)}
                  allTickets={tickets}
                  onOpenTicket={(t) => setModalState({ mode: 'view', ticketId: t.id })}
                />
              ) : modalTicket ? (
                <TicketModal
                  key={modalTicket.id}
                  mode="view"
                  ticket={modalTicket}
                  onDelete={handleDeleteTicket}
                  onClose={() => setModalState(null)}
                  allTickets={tickets}
                  onOpenTicket={(t) => setModalState({ mode: 'view', ticketId: t.id })}
                />
              ) : null
            )}
          </>
        )}
      </div>
    </div>
  );
}
