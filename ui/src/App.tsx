import { useEffect, useState } from 'react';
import { Board } from './components/Board';
import { ProjectSidebar } from './components/ProjectSidebar';
import { TicketModal } from './components/TicketModal';
import { useProjects, useCreateProject, useDeleteProject } from './api/projects';
import type { ActivityEntry, Priority, Status, Ticket } from './types';

export default function App() {
  const { data: apiProjects = [], isLoading: projectsLoading } = useProjects();
  const createProjectMutation = useCreateProject();
  const deleteProjectMutation = useDeleteProject();

  const [currentProjectId, setCurrentProjectId] = useState<string>('');
  const [ticketsMap, setTicketsMap] = useState<Record<string, Ticket[]>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [activePriority, setActivePriority] = useState<Priority | 'all'>('all');

  useEffect(() => {
    if (apiProjects.length > 0 && !apiProjects.find((p) => p.id === currentProjectId)) {
      setCurrentProjectId(apiProjects[0].id);
    }
  }, [apiProjects, currentProjectId]);

  const currentProject = apiProjects.find((p) => p.id === currentProjectId) ?? apiProjects[0];
  const tickets = currentProject ? (ticketsMap[currentProject.id] ?? []) : [];

  const q = searchQuery.toLowerCase();
  const filteredTickets = tickets.filter((t) => {
    const matchesSearch = !q || t.title.toLowerCase().includes(q) || t.tags.some((tag) => tag.toLowerCase().includes(q));
    const matchesPriority = activePriority === 'all' || t.priority === activePriority;
    return matchesSearch && matchesPriority;
  });

  const [modalState, setModalState] = useState<
    | { mode: 'create' }
    | { mode: 'view'; ticket: Ticket }
    | { mode: 'edit'; ticket: Ticket }
    | null
  >(null);

  function updateCurrentProjectTickets(updater: (prev: Ticket[]) => Ticket[]) {
    if (!currentProject) return;
    setTicketsMap((prev) => ({
      ...prev,
      [currentProject.id]: updater(prev[currentProject.id] ?? []),
    }));
  }

  function handleDragEnd(ticketId: string, newStatus: Status) {
    const entry: ActivityEntry = {
      field: 'status',
      from: null,
      to: newStatus,
      at: new Date().toISOString(),
    };
    updateCurrentProjectTickets((prev) =>
      prev.map((t) =>
        t.id === ticketId
          ? { ...t, status: newStatus, updatedAt: new Date().toISOString(), activityLog: [...(t.activityLog ?? []), entry] }
          : t,
      ),
    );
  }

  function handleCreateTicket(data: Ticket) {
    if (!currentProject) return;
    const prefix = currentProject.prefix;
    updateCurrentProjectTickets((prev) => {
      const maxN = prev.reduce((max, t) => {
        const n = parseInt(t.id.replace(`${prefix}-`, ''), 10);
        return isNaN(n) ? max : Math.max(max, n);
      }, 0);
      return [...prev, { ...data, id: `${prefix}-${maxN + 1}` }];
    });
  }

  function handleEditTicket(data: Ticket) {
    updateCurrentProjectTickets((prev) =>
      prev.map((t) => {
        if (t.id !== data.id) return t;
        const newLog = [...(data.activityLog ?? [])];
        if (t.status !== data.status) {
          newLog.push({
            field: 'status',
            from: t.status,
            to: data.status,
            at: new Date().toISOString(),
          });
        }
        if (t.title !== data.title) {
          newLog.push({
            field: 'title',
            from: t.title,
            to: data.title,
            at: new Date().toISOString(),
          });
        }
        return { ...data, activityLog: newLog };
      }),
    );
    setModalState((prev) =>
      prev && prev.mode !== 'create' && prev.ticket.id === data.id
        ? { ...prev, ticket: data }
        : prev,
    );
  }

  function handleDeleteTicket(id: string) {
    updateCurrentProjectTickets((prev) => prev.filter((t) => t.id !== id));
  }

  function handleSelectProject(id: string) {
    setCurrentProjectId(id);
    setSearchQuery('');
    setActivePriority('all');
    setModalState(null);
  }

  async function handleCreateProject(data: { name: string; prefix: string; color: string }) {
    const newProject = await createProjectMutation.mutateAsync(data);
    setCurrentProjectId(newProject.id);
  }

  async function handleDeleteProject(id: string) {
    await deleteProjectMutation.mutateAsync(id);
    if (currentProjectId === id) {
      const remaining = apiProjects.filter((p) => p.id !== id);
      setCurrentProjectId(remaining[0]?.id ?? '');
    }
  }

  function handleOpenCreate() {
    setModalState({ mode: 'create' });
  }

  function handleOpenView(ticket: Ticket) {
    setModalState({ mode: 'view', ticket });
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
                  onOpenTicket={(t) => setModalState({ mode: 'view', ticket: t })}
                  onSaveOther={handleEditTicket}
                />
              ) : (
                <TicketModal
                  key={modalState.ticket.id}
                  mode={modalState.mode}
                  ticket={modalState.ticket}
                  onSave={handleEditTicket}
                  onDelete={handleDeleteTicket}
                  onClose={() => setModalState(null)}
                  allTickets={tickets}
                  onOpenTicket={(t) => setModalState({ mode: 'view', ticket: t })}
                  onSaveOther={handleEditTicket}
                />
              )
            )}
          </>
        )}
      </div>
    </div>
  );
}
