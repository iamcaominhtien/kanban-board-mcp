import { useMemo, useState } from 'react';
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import type { IdeaStatus, IdeaTicket } from '../types';
import { IdeaColumn } from './IdeaColumn';
import type { IdeaColumnDef } from './IdeaColumn';
import { IdeaCard } from './IdeaCard';
import { IdeaTicketModal } from './IdeaTicketModal';
import styles from './IdeaBoard.module.css';

const IDEA_COLUMNS: IdeaColumnDef[] = [
  { id: 'draft',     label: 'Drafting',   emoji: '💭', headerBg: 'rgba(245,197,24,0.12)',  accentBg: 'var(--color-yellow)' },
  { id: 'in_review', label: 'In Review',  emoji: '👀', headerBg: 'rgba(91,184,245,0.12)',  accentBg: 'var(--color-blue)' },
  { id: 'approved',  label: 'Promoted',   emoji: '✅', headerBg: 'rgba(170,204,46,0.12)',  accentBg: 'var(--color-lime)' },
  { id: 'dropped',   label: 'Dropped',    emoji: '🗑️', headerBg: 'rgba(61,12,17,0.05)',    accentBg: 'rgba(61,12,17,0.2)' },
];

// Allowed drag transitions
const ALLOWED_TRANSITIONS: Record<IdeaStatus, IdeaStatus[]> = {
  draft:     ['in_review', 'dropped'],
  in_review: ['draft', 'approved', 'dropped'],
  approved:  [],
  dropped:   [],
};

const STATUS_ACTIVITY_LABELS: Record<IdeaStatus, string> = {
  draft: 'Moved back to Draft',
  in_review: 'Status changed to In Review',
  approved: 'Status changed to Promoted',
  dropped: 'Idea dropped',
};

function buildActivity(label: string, at: string) {
  return { id: `a-${crypto.randomUUID()}`, label, at };
}

function withActivity(ticket: IdeaTicket, label: string, at: string): IdeaTicket {
  return {
    ...ticket,
    lastTouchedAt: at,
    activityTrail: [...(ticket.activityTrail ?? []), buildActivity(label, at)],
  };
}

const MOCK_TICKETS: IdeaTicket[] = [
  {
    id: 'IDEA-1',
    title: 'Gamified Onboarding',
    description: 'Add a progress bar and confetti when users create their first 3 tasks.',
    ideaStatus: 'draft',
    ideaColor: 'purple',
    ideaEmoji: '🎮',
    ideaEnergy: 'seed',
    tags: ['onboarding', 'ux'],
    createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    updatedAt: new Date().toISOString(),
    problemStatement: 'New users abandon setup because they don\'t see value fast enough.',
    iceImpact: 4, iceEffort: 2, iceConfidence: 4,
    activityTrail: [
      { id: 'a1', label: 'Idea created', at: new Date(Date.now() - 3 * 86400000).toISOString() },
      { id: 'a2', label: 'Description updated', at: new Date(Date.now() - 1 * 86400000).toISOString() },
    ],
    microthoughts: [
      { id: 'm1', text: 'Check how Duolingo does streak celebrations', at: new Date(Date.now() - 2 * 86400000).toISOString() },
    ],
    assumptions: [
      { id: 'as1', text: 'Users reach "aha moment" faster with visual progress', status: 'untested' },
      { id: 'as2', text: 'Confetti doesn\'t feel childish for our audience', status: 'untested' },
    ],
    revisitDate: new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0],
    lastTouchedAt: new Date(Date.now() - 1 * 86400000).toISOString(),
  },
  {
    id: 'IDEA-2',
    title: 'Custom Team Emojis',
    description: 'Allow uploading custom team emojis for ticket reactions.',
    ideaStatus: 'draft',
    ideaColor: 'blue',
    ideaEmoji: '😎',
    ideaEnergy: 'concept',
    tags: ['emoji', 'customization'],
    createdAt: new Date(Date.now() - 5 * 86400000).toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'IDEA-3',
    title: 'Bento Grid Dashboard',
    description: 'Redesign the analytics page using a bento-style fluid grid system.',
    ideaStatus: 'in_review',
    ideaColor: 'pink',
    ideaEmoji: '🕹️',
    ideaEnergy: 'hot',
    tags: ['ui', 'dashboard'],
    createdAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    updatedAt: new Date().toISOString(),
    problemStatement: 'The current analytics page is a wall of numbers — users can\'t prioritize what to act on.',
    iceImpact: 5, iceEffort: 4, iceConfidence: 3,
    activityTrail: [
      { id: 'a1', label: 'Idea created', at: new Date(Date.now() - 2 * 86400000).toISOString() },
      { id: 'a2', label: 'Status changed to In Review', at: new Date(Date.now() - 1 * 86400000).toISOString() },
      { id: 'a3', label: 'Energy set to Hot', at: new Date(Date.now() - 12 * 3600000).toISOString() },
    ],
    assumptions: [
      { id: 'as1', text: 'Bento grid is more scannable than table layout', status: 'validated' },
      { id: 'as2', text: 'Users want to customize grid cell sizes', status: 'untested' },
      { id: 'as3', text: 'Drag-to-resize works well on mobile', status: 'invalidated' },
    ],
    revisitDate: new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0],
    lastTouchedAt: new Date(Date.now() - 12 * 3600000).toISOString(),
  },
  {
    id: 'IDEA-4',
    title: 'Offline Mode First',
    description: 'Port everything to CRDTs to allow seamless offline editing.',
    ideaStatus: 'in_review',
    ideaColor: 'teal',
    ideaEmoji: '🌊',
    ideaEnergy: 'big_bet',
    tags: ['offline', 'crdt'],
    createdAt: new Date(Date.now() - 7 * 86400000).toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'IDEA-5',
    title: 'Magic Auto-Sort',
    description: 'AI-powered ticket sorting by predicted effort and impact.',
    ideaStatus: 'approved',
    ideaColor: 'lime',
    ideaEmoji: '✨',
    tags: ['ai', 'sorting'],
    createdAt: new Date(Date.now() - 10 * 86400000).toISOString(),
    updatedAt: new Date().toISOString(),
    promotedToTicketId: 'ITC-42',
    promotedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    problemStatement: 'Teams waste time manually sorting backlog every sprint planning.',
    activityTrail: [
      { id: 'a1', label: 'Idea created', at: new Date(Date.now() - 10 * 86400000).toISOString() },
      { id: 'a2', label: 'Status changed to In Review', at: new Date(Date.now() - 7 * 86400000).toISOString() },
      { id: 'a3', label: 'Status changed to Promoted', at: new Date(Date.now() - 2 * 86400000).toISOString() },
      { id: 'a4', label: 'Promoted to ticket ITC-42', at: new Date(Date.now() - 2 * 86400000).toISOString() },
    ],
  },
  {
    id: 'IDEA-6',
    title: 'Voice Memos',
    description: 'Record voice notes directly on a ticket.',
    ideaStatus: 'dropped',
    ideaColor: 'orange',
    ideaEmoji: '🎤',
    tags: ['voice'],
    createdAt: new Date(Date.now() - 15 * 86400000).toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

interface IdeaBoardProps {
  projectId: string;
}

export function IdeaBoard({ projectId: _projectId }: IdeaBoardProps) {
  const [tickets, setTickets] = useState<IdeaTicket[]>(MOCK_TICKETS);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedTicket, setSelectedTicket] = useState<IdeaTicket | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const ticketsByStatus = useMemo(() => {
    const map: Record<string, IdeaTicket[]> = { draft: [], in_review: [], approved: [], dropped: [] };
    for (const t of tickets) { (map[t.ideaStatus] ??= []).push(t); }
    return map;
  }, [tickets]);

  const activeTicket = tickets.find(t => t.id === activeId) ?? null;

  function handleDragStart(e: DragStartEvent) { setActiveId(e.active.id as string); }
  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    setActiveId(null);
    if (!over) return;
    const newStatus = over.id as IdeaStatus;
    const ticket = tickets.find(t => t.id === active.id);
    if (!ticket || ticket.ideaStatus === newStatus) return;
    if (!ALLOWED_TRANSITIONS[ticket.ideaStatus]?.includes(newStatus)) return;
    const now = new Date().toISOString();
    setTickets(prev => prev.map(t =>
      t.id === ticket.id
        ? { ...withActivity(t, STATUS_ACTIVITY_LABELS[newStatus], now), ideaStatus: newStatus }
        : t
    ));
  }

  function handleSave(updated: IdeaTicket) {
    const now = new Date().toISOString();
    const enriched = withActivity(updated, 'Description updated', now);
    setTickets(prev => prev.map(t => t.id === enriched.id ? enriched : t));
  }

  function handleStatusChange(id: string, status: IdeaStatus) {
    const now = new Date().toISOString();
    setTickets(prev => prev.map(t =>
      t.id === id
        ? { ...withActivity(t, STATUS_ACTIVITY_LABELS[status], now), ideaStatus: status }
        : t
    ));
  }
  function handleDrop(id: string) {
    handleStatusChange(id, 'dropped');
  }

  function handleQuickCreate() {
    const title = newTitle.trim();
    if (!title) return;
    const newTicket: IdeaTicket = {
      id: `IDEA-${crypto.randomUUID()}`,
      title,
      description: '',
      ideaStatus: 'draft',
      ideaColor: 'yellow',
      ideaEmoji: '💡',
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setTickets(prev => [newTicket, ...prev]);
    setNewTitle('');
    setShowNewForm(false);
  }

  return (
    <div className={styles.wrapper}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.titleIcon}>✨</div>
          <h1 className={styles.title}>Idea Space</h1>
        </div>
        <button type="button" className={styles.newBtn} onClick={() => setShowNewForm(v => !v)}>
          + New Idea
        </button>
      </div>

      {/* Quick create */}
      {showNewForm && (
        <div className={styles.quickCreate}>
          <input
            type="text"
            className={styles.quickInput}
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleQuickCreate(); if (e.key === 'Escape') setShowNewForm(false); }}
            placeholder="What's the idea?"
            autoFocus
          />
          <div className={styles.quickActions}>
            <button type="button" className={styles.quickCancelBtn} onClick={() => setShowNewForm(false)}>Cancel</button>
            <button type="button" className={styles.quickSaveBtn} onClick={handleQuickCreate}>Add Idea</button>
          </div>
        </div>
      )}

      {/* Board */}
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className={styles.columns}>
          {IDEA_COLUMNS.map(col => (
            <IdeaColumn
              key={col.id}
              column={col}
              tickets={ticketsByStatus[col.id] ?? []}
              onCardClick={setSelectedTicket}
            />
          ))}
        </div>
        <DragOverlay>
          {activeTicket && <IdeaCard ticket={activeTicket} isDragging onClick={() => {}} />}
        </DragOverlay>
      </DndContext>

      {/* Detail panel */}
      {selectedTicket && (
        <IdeaTicketModal
          ticket={selectedTicket}
          onClose={() => setSelectedTicket(null)}
          onSave={handleSave}
          onDrop={handleDrop}
          onStatusChange={handleStatusChange}
        />
      )}
    </div>
  );
}
