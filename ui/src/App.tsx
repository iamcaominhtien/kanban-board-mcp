import { useState } from 'react';
import { Board } from './components/Board';
import { TicketModal } from './components/TicketModal';
import { INITIAL_TICKETS } from './data/mock-tickets';
import type { ActivityEntry, Priority, Status, Ticket } from './types';

const STATUS_LABELS: Record<Status, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  'in-progress': 'In Progress',
  done: 'Done',
};

export default function App() {
  const [tickets, setTickets] = useState<Ticket[]>(INITIAL_TICKETS);
  const [searchQuery, setSearchQuery] = useState('');
  const [activePriority, setActivePriority] = useState<Priority | 'all'>('all');

  const filteredTickets = tickets.filter((t) => {
    const matchesSearch = t.title.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesPriority = activePriority === 'all' || t.priority === activePriority;
    return matchesSearch && matchesPriority;
  });
  const [modalState, setModalState] = useState<
    | { mode: 'create' }
    | { mode: 'view'; ticket: Ticket }
    | { mode: 'edit'; ticket: Ticket }
    | null
  >(null);

  function handleDragEnd(ticketId: string, newStatus: Status) {
    const entry: ActivityEntry = {
      id: `${Date.now()}`,
      action: `Status changed to ${STATUS_LABELS[newStatus]}`,
      timestamp: new Date().toISOString(),
    };
    setTickets((prev) =>
      prev.map((t) =>
        t.id === ticketId
          ? { ...t, status: newStatus, updatedAt: new Date().toISOString(), activityLog: [...(t.activityLog ?? []), entry] }
          : t,
      ),
    );
  }

  function handleCreateTicket(data: Ticket) {
    const maxN = tickets.reduce((max, t) => {
      const n = parseInt(t.id.replace('IAM-', ''), 10);
      return isNaN(n) ? max : Math.max(max, n);
    }, 0);
    setTickets((prev) => [...prev, { ...data, id: `IAM-${maxN + 1}` }]);
  }

  function handleEditTicket(data: Ticket) {
    setTickets((prev) =>
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
    setTickets((prev) => prev.filter((t) => t.id !== id));
  }

  function handleOpenCreate() {
    setModalState({ mode: 'create' });
  }

  function handleOpenView(ticket: Ticket) {
    setModalState({ mode: 'view', ticket });
  }

  return (
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
      />
      {modalState && (
        <TicketModal
          key={modalState.mode !== 'create' ? modalState.ticket.id : 'create'}
          mode={modalState.mode}
          ticket={modalState.mode !== 'create' ? modalState.ticket : undefined}
          onSave={modalState.mode === 'create' ? handleCreateTicket : handleEditTicket}
          onDelete={modalState.mode !== 'create' ? handleDeleteTicket : undefined}
          onClose={() => setModalState(null)}
        />
      )}
    </>
  );
}
