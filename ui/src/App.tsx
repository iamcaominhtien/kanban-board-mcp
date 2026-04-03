import { useState } from 'react';
import { Board } from './components/Board';
import { ProjectSidebar } from './components/ProjectSidebar';
import { TicketModal } from './components/TicketModal';
import { INITIAL_PROJECTS } from './data/mock-tickets';
import type { ActivityEntry, Priority, Project, Status, Ticket } from './types';

const STATUS_LABELS: Record<Status, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  'in-progress': 'In Progress',
  done: 'Done',
};

export default function App() {
  const [projects, setProjects] = useState<Project[]>(INITIAL_PROJECTS);
  const [currentProjectId, setCurrentProjectId] = useState<string>(INITIAL_PROJECTS[0].id);
  const [searchQuery, setSearchQuery] = useState('');
  const [activePriority, setActivePriority] = useState<Priority | 'all'>('all');

  const currentProject = projects.find((p) => p.id === currentProjectId) ?? projects[0];
  const tickets = currentProject.tickets;

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
    setProjects((prev) =>
      prev.map((p) => p.id === currentProjectId ? { ...p, tickets: updater(p.tickets) } : p)
    );
  }

  function handleDragEnd(ticketId: string, newStatus: Status) {
    const entry: ActivityEntry = {
      id: `${Date.now()}`,
      action: `Status changed to ${STATUS_LABELS[newStatus]}`,
      timestamp: new Date().toISOString(),
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
            id: `${Date.now()}`,
            action: `Status changed to ${STATUS_LABELS[data.status]}`,
            timestamp: new Date().toISOString(),
          });
        }
        if (t.title !== data.title) {
          newLog.push({
            id: `${Date.now() + 1}`,
            action: 'Title updated',
            timestamp: new Date().toISOString(),
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
  }

  function handleCreateProject(data: { name: string; prefix: string; color: string }) {
    const newProject: Project = {
      id: `proj-${Date.now()}`,
      name: data.name,
      prefix: data.prefix,
      color: data.color,
      tickets: [],
    };
    setProjects((prev) => [...prev, newProject]);
    setCurrentProjectId(newProject.id);
  }

  function handleDeleteProject(id: string) {
    const remaining = projects.filter((p) => p.id !== id);
    setProjects(remaining);
    if (currentProjectId === id) {
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
        projects={projects}
        currentProjectId={currentProjectId}
        onSelectProject={handleSelectProject}
        onCreateProject={handleCreateProject}
        onDeleteProject={handleDeleteProject}
      />
      <div style={{ flex: 1, overflowY: 'auto' }}>
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
          projectName={currentProject.name}
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
      </div>
    </div>
  );
}
