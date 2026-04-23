import { useMemo, useState } from 'react';
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import type { IdeaStatus, IdeaTicket } from '../types';
import { useIdeaTickets, useCreateIdeaTicket, useUpdateIdeaTicket } from '../api/useIdeaTickets';
import { IdeaColumn } from './IdeaColumn';
import type { IdeaColumnDef } from './IdeaColumn';
import { IdeaCard } from './IdeaCard';
import styles from './IdeaBoard.module.css';

const IDEA_COLUMNS: IdeaColumnDef[] = [
  { id: 'draft',    label: 'Drafting',  emoji: '✏️', accentColor: 'var(--color-yellow)', colBg: 'rgba(245, 197, 24, 0.08)' },
  { id: 'approved', label: 'Approved',  emoji: '✅', accentColor: 'var(--color-lime)',   colBg: 'rgba(170, 204, 46, 0.08)' },
  { id: 'dropped',  label: 'Dropped',   emoji: '🗑️', accentColor: 'var(--color-dark)',   colBg: 'rgba(61, 12, 17, 0.04)' },
];

const VALID_IDEA_STATUSES = new Set<string>(['draft', 'approved', 'dropped']);

// Allowed transitions: from → set of allowed destinations
const ALLOWED_TRANSITIONS: Record<IdeaStatus, Set<IdeaStatus>> = {
  draft:    new Set(['approved', 'dropped']),
  approved: new Set(['draft', 'dropped']),
  dropped:  new Set(),
};

interface IdeaBoardProps {
  projectId: string;
  onCardClick: (ticket: IdeaTicket) => void;
}

export function IdeaBoard({ projectId, onCardClick }: IdeaBoardProps) {
  const { data: tickets = [], isLoading } = useIdeaTickets(projectId);
  const createMutation = useCreateIdeaTicket(projectId);
  const updateMutation = useUpdateIdeaTicket(projectId);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const [activeTicketId, setActiveTicketId] = useState<string | null>(null);
  const [showQuickCreate, setShowQuickCreate] = useState(false);
  const [quickTitle, setQuickTitle] = useState('');
  const [quickDesc, setQuickDesc] = useState('');

  const ticketsByStatus = useMemo(() => {
    const map: Record<string, IdeaTicket[]> = { draft: [], approved: [], dropped: [] };
    for (const t of tickets) {
      const key = t.ideaStatus ?? 'draft';
      if (map[key]) map[key].push(t);
    }
    return map;
  }, [tickets]);

  const activeTicket = tickets.find((t) => t.id === activeTicketId) ?? null;

  function handleDragStart(event: DragStartEvent) {
    setActiveTicketId(event.active.id as string);
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveTicketId(null);

    if (!over || !VALID_IDEA_STATUSES.has(over.id as string)) return;

    const ticketId = active.id as string;
    const newStatus = over.id as IdeaStatus;
    const ticket = tickets.find((t) => t.id === ticketId);
    if (!ticket) return;
    const currentStatus = ticket.ideaStatus ?? 'draft';
    if (currentStatus === newStatus) return;

    if (!ALLOWED_TRANSITIONS[currentStatus]?.has(newStatus)) {
      window.alert(`Cannot move from ${currentStatus} to ${newStatus}`);
      return;
    }

    try {
      await updateMutation.mutateAsync({ ticketId, data: { ideaStatus: newStatus } });
    } catch (err) {
      console.error('Failed to update idea status:', err);
      window.alert('Failed to move idea. Please try again.');
    }
  }

  async function handleQuickCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!quickTitle.trim()) return;
    try {
      await createMutation.mutateAsync({ title: quickTitle.trim(), description: quickDesc.trim() });
      setQuickTitle('');
      setQuickDesc('');
      setShowQuickCreate(false);
    } catch (err) {
      console.error('Failed to create idea:', err);
      window.alert('Failed to create idea. Please try again.');
    }
  }

  if (isLoading) {
    return (
      <div className={styles.loading}>Loading ideas…</div>
    );
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <h1 className={styles.title}>💡 Idea Board</h1>
        <button
          type="button"
          className={styles.newBtn}
          onClick={() => setShowQuickCreate((v) => !v)}
        >
          + New Idea
        </button>
      </div>

      {showQuickCreate && (
        <form className={styles.quickCreate} onSubmit={handleQuickCreate}>
          <input
            className={styles.quickInput}
            type="text"
            placeholder="Idea title (required)"
            value={quickTitle}
            onChange={(e) => setQuickTitle(e.target.value)}
            autoFocus
            required
          />
          <input
            className={styles.quickInput}
            type="text"
            placeholder="Description (optional)"
            value={quickDesc}
            onChange={(e) => setQuickDesc(e.target.value)}
          />
          <div className={styles.quickActions}>
            <button
              type="submit"
              className={styles.quickSubmit}
              disabled={createMutation.isPending || !quickTitle.trim()}
            >
              {createMutation.isPending ? 'Creating…' : 'Create'}
            </button>
            <button
              type="button"
              className={styles.quickCancel}
              onClick={() => { setShowQuickCreate(false); setQuickTitle(''); setQuickDesc(''); }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className={styles.columns}>
          {IDEA_COLUMNS.map((col) => (
            <IdeaColumn
              key={col.id}
              column={col}
              tickets={ticketsByStatus[col.id] ?? []}
              isTerminal={col.id === 'dropped'}
              onCardClick={onCardClick}
            />
          ))}
        </div>

        <DragOverlay>
          {activeTicket ? (
            <IdeaCard
              ticket={activeTicket}
              isDragging
              onClick={() => {}}
            />
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
