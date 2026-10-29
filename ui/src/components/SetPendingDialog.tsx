import React, { useState, useEffect, useRef } from 'react';
import type { Ticket, Member, PendingReasonType } from '../types/ticket';
import { DOCS_SCRIM, useEscape } from './docs/docsShared';

interface SetPendingDialogProps {
  isOpen?: boolean;
  ticket: Ticket;
  allTickets?: Ticket[];
  members?: Member[];
  isSubmitting?: boolean;
  error?: string | null;
  onClose: () => void;
  onConfirm: (payload: {
    reasonType: PendingReasonType;
    pendingTicketId?: string;
    pendingMemberId?: string;
    pendingParty?: string;
    note?: string;
    alsoAddBlockedBy?: boolean;
    notify?: boolean;
  }) => void;
  onResume?: () => void;
  onResumeClick?: () => void;
  onRetry?: () => void;
}

const STATUS_CONFIG: Record<string, { label: string; dotColor: string }> = {
  backlog: { label: 'Backlog', dotColor: '#C7D2CB' },
  todo: { label: 'To Do', dotColor: '#9AA8A0' },
  'in-progress': { label: 'In Progress', dotColor: '#2F6FB0' },
  review: { label: 'Review', dotColor: '#6D5DD3' },
  testing: { label: 'Testing', dotColor: '#B4571F' },
  done: { label: 'Done', dotColor: '#2E6F40' },
  wont_do: { label: "Won't Do", dotColor: '#C4432A' },
};

/**
 * Pixel-perfect SetPendingDialog strictly matching design/source/TicketPending.dc.html (B1-B6).
 * Width: 376px, tokens: #E8EDF3, #B8C4D2, #34455A, #5B6F86, #6B7F96, #F4F6F9.
 */
export const SetPendingDialog: React.FC<SetPendingDialogProps> = ({
  isOpen = true,
  ticket,
  allTickets = [],
  members = [],
  isSubmitting = false,
  error = null,
  onClose,
  onConfirm,
  onResume,
  onResumeClick,
  onRetry,
}) => {
  useEscape(isSubmitting ? () => {} : onClose);

  const isAlreadyPending = !!ticket.pending;

  const [activeTab, setActiveTab] = useState<'ticket' | 'person'>('ticket');
  const [selectedTicketId, setSelectedTicketId] = useState<string>('');
  const [ticketSearch, setTicketSearch] = useState<string>('');
  const [alsoAddBlockedBy, setAlsoAddBlockedBy] = useState<boolean>(true);

  const [selectedMemberId, setSelectedMemberId] = useState<string>('');
  const [customParty, setCustomParty] = useState<string>('');
  const [notifyThem, setNotifyThem] = useState<boolean>(false);

  const [note, setNote] = useState<string>('');

  const searchInputRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      if (ticket.pending) {
        setActiveTab(ticket.pendingReasonType === 'ticket' ? 'ticket' : 'person');
        setSelectedTicketId(ticket.pendingTicketId || '');
        setSelectedMemberId(ticket.pendingMemberId || '');
        setCustomParty(ticket.pendingParty || '');
        setNote(ticket.pendingNote || '');
        setAlsoAddBlockedBy(false);
        setNotifyThem(!!ticket.pendingMemberId);
      } else {
        setActiveTab('ticket');
        setSelectedTicketId('');
        setSelectedMemberId('');
        setCustomParty('');
        setNote('');
        setAlsoAddBlockedBy(true);
        setNotifyThem(false);
      }
      setTicketSearch('');
      setTimeout(() => {
        if (!ticket.pending) {
          searchInputRef.current?.focus();
        } else {
          noteRef.current?.focus();
        }
      }, 80);
    }
  }, [isOpen, ticket]);

  if (!isOpen) return null;

  // Filter candidates for waiting on ticket
  const eligibleTickets = allTickets.filter((t) => {
    if (t.id === ticket.id) return false;
    if (ticket.parentId && t.id === ticket.parentId) return false;
    if (t.parentId === ticket.id) return false;
    if (ticketSearch.trim()) {
      const q = ticketSearch.toLowerCase();
      return t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q);
    }
    return true;
  });

  const selectedTicket = allTickets.find((t) => t.id === selectedTicketId);
  const selectedMember = members.find((m) => m.id === selectedMemberId);

  const canSubmit = activeTab === 'ticket' ? !!selectedTicketId : !!selectedMemberId || !!customParty.trim();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isSubmitting || !canSubmit) return;
    if (error && onRetry) {
      onRetry();
      return;
    }

    if (activeTab === 'ticket') {
      onConfirm({
        reasonType: 'ticket',
        pendingTicketId: selectedTicketId,
        note: note.trim() || undefined,
        alsoAddBlockedBy,
      });
    } else {
      onConfirm({
        reasonType: 'person',
        pendingMemberId: selectedMemberId || undefined,
        pendingParty: customParty.trim() || undefined,
        note: note.trim() || undefined,
      });
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      handleSubmit(e);
    }
  }

  const daysPending = ticket.pendingSince
    ? Math.max(0, Math.floor((Date.now() - new Date(ticket.pendingSince).getTime()) / (1000 * 60 * 60 * 24)))
    : 0;

  const currentStatusConfig = STATUS_CONFIG[ticket.status] || {
    label: ticket.status,
    dotColor: '#9AA8A0',
  };

  const charCount = note.length;
  const counterColor = charCount >= 240 ? '#C4432A' : charCount >= 220 ? '#C77700' : '#9AA8A0';

  const pendingBlockerTicket =
    ticket.pendingReasonType === 'ticket' && ticket.pendingTicketId
      ? allTickets.find((t) => t.id === ticket.pendingTicketId)
      : null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1100,
        background: DOCS_SCRIM,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={isSubmitting ? undefined : onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={isAlreadyPending ? `Change pending reason for ${ticket.id}` : `Mark ${ticket.id} as pending`}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 376,
          maxWidth: '100%',
          boxSizing: 'border-box',
          background: '#FFFFFF',
          borderRadius: 14,
          border: '1px solid #E3E8E5',
          boxShadow: '0 24px 64px rgba(30,42,34,0.16)',
          overflow: 'hidden',
          fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
          color: '#1E2A22',
        }}
      >
        <form onSubmit={handleSubmit} onKeyDown={handleKeyDown} style={{ margin: 0, padding: 0 }}>
          <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 11 }}>
            {/* Header: 32x32 #E8EDF3 circle + Title + Subtitle + Close */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  background: '#E8EDF3',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#5B6F86"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0 }}
                >
                  <path d="M8.5 5.5V18.5" />
                  <path d="M15.5 5.5V18.5" />
                </svg>
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1, minWidth: 0 }}>
                <span style={{ fontSize: 16, fontWeight: 700, color: '#1E2A22' }}>
                  {isAlreadyPending ? 'Change pending reason' : `Mark ${ticket.id} as pending`}
                </span>
                <span
                  style={{
                    fontSize: 12.5,
                    color: '#5B6B60',
                    lineHeight: 1.35,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {isAlreadyPending ? ticket.title : `${ticket.title} - ${currentStatusConfig.label}`}
                </span>
              </div>
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                style={{
                  border: 'none',
                  background: 'none',
                  color: '#9AA8A0',
                  display: 'flex',
                  padding: 0,
                  cursor: isSubmitting ? 'not-allowed' : 'pointer',
                }}
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0 }}
                >
                  <path d="M6 6L18 18" />
                  <path d="M18 6L6 18" />
                </svg>
              </button>
            </div>

            {/* B3: Already pending info box */}
            {isAlreadyPending && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                  padding: '10px 12px',
                  borderRadius: 8,
                  background: '#F4F6F9',
                  border: '1px solid #B8C4D2',
                  fontSize: 12.5,
                  color: '#34455A',
                  lineHeight: 1.45,
                }}
              >
                <span>
                  <b>
                    Pending since{' '}
                    {ticket.pendingSince
                      ? new Date(ticket.pendingSince).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                      : 'recently'}
                  </b>{' '}
                  ({daysPending} {daysPending === 1 ? 'day' : 'days'}) by {ticket.pendingBy || 'user'}
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  Waiting on{' '}
                  <strong
                    style={{
                      fontFamily: ticket.pendingReasonType === 'ticket' ? "'JetBrains Mono', monospace" : 'inherit',
                    }}
                  >
                    {ticket.pendingReasonType === 'ticket'
                      ? ticket.pendingTicketId
                      : ticket.pendingParty ||
                        (ticket.pendingMemberId && members.find((m) => m.id === ticket.pendingMemberId)?.name) ||
                        'Person'}
                  </strong>
                  {pendingBlockerTicket && (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                        padding: '2px 8px',
                        borderRadius: 999,
                        border: '1px solid #E3E8E5',
                        background: '#FFFFFF',
                        fontSize: 11,
                        fontWeight: 700,
                        color: '#1E2A22',
                      }}
                    >
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: STATUS_CONFIG[pendingBlockerTicket.status]?.dotColor || '#9AA8A0',
                          flexShrink: 0,
                        }}
                      />
                      {STATUS_CONFIG[pendingBlockerTicket.status]?.label || pendingBlockerTicket.status}
                    </span>
                  )}
                </span>
              </div>
            )}

            {/* Segmented Tabs: Waiting on a ticket | Waiting on a person or party */}
            <div style={{ display: 'flex', gap: 2, padding: 3, borderRadius: 8, background: '#EEF3EF' }}>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => setActiveTab('ticket')}
                style={{
                  flex: 1,
                  textAlign: 'center',
                  padding: '6px 8px',
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  background: activeTab === 'ticket' ? '#FFFFFF' : 'transparent',
                  color: activeTab === 'ticket' ? '#1E2A22' : '#5B6B60',
                  boxShadow: activeTab === 'ticket' ? '0 1px 2px rgba(30,42,34,0.10)' : 'none',
                  border: 'none',
                  cursor: isSubmitting ? 'not-allowed' : 'pointer',
                  fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
                }}
              >
                Waiting on a ticket
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => setActiveTab('person')}
                style={{
                  flex: 1,
                  textAlign: 'center',
                  padding: '6px 8px',
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  background: activeTab === 'person' ? '#FFFFFF' : 'transparent',
                  color: activeTab === 'person' ? '#1E2A22' : '#5B6B60',
                  boxShadow: activeTab === 'person' ? '0 1px 2px rgba(30,42,34,0.10)' : 'none',
                  border: 'none',
                  cursor: isSubmitting ? 'not-allowed' : 'pointer',
                  fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
                }}
              >
                Waiting on a person or party
              </button>
            </div>

            {/* TAB 1: Ticket Selection */}
            {activeTab === 'ticket' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'baseline' }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: '#1E2A22', flexGrow: 1 }}>Which ticket?</span>
                </div>

                {!selectedTicket ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div
                      style={{
                        width: '100%',
                        boxSizing: 'border-box',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '8px 10px',
                        borderRadius: 8,
                        border: '1px solid #2E6F40',
                        background: '#FFFFFF',
                        boxShadow: '0 0 0 3px rgba(46,111,64,0.12)',
                      }}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#9AA8A0"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{ flexShrink: 0 }}
                      >
                        <circle cx="11" cy="11" r="6.5" />
                        <path d="M20 20L15.8 15.8" />
                      </svg>
                      <input
                        ref={searchInputRef}
                        type="text"
                        disabled={isSubmitting}
                        value={ticketSearch}
                        onChange={(e) => setTicketSearch(e.target.value)}
                        placeholder="Search tickets by key or title..."
                        style={{
                          border: 'none',
                          outline: 'none',
                          fontSize: 13,
                          color: '#1E2A22',
                          width: '100%',
                          background: 'transparent',
                          fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
                        }}
                      />
                    </div>

                    {/* Results dropdown */}
                    <div
                      style={{
                        width: '100%',
                        boxSizing: 'border-box',
                        border: '1px solid #E3E8E5',
                        borderRadius: 8,
                        background: '#FFFFFF',
                        boxShadow: '0 8px 20px rgba(30,42,34,0.10)',
                        overflow: 'hidden',
                        maxHeight: 180,
                        overflowY: 'auto',
                      }}
                    >
                      {eligibleTickets.slice(0, 6).map((t) => {
                        const tStatus = STATUS_CONFIG[t.status] || { label: t.status, dotColor: '#9AA8A0' };
                        return (
                          <div
                            key={t.id}
                            onClick={() => {
                              setSelectedTicketId(t.id);
                              setTicketSearch('');
                            }}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 9,
                              padding: '8px 11px',
                              borderBottom: '1px solid #EEF3EF',
                              cursor: 'pointer',
                              background: '#FFFFFF',
                              transition: 'background 0.1s ease',
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.background = '#F6FAF7')}
                            onMouseLeave={(e) => (e.currentTarget.style.background = '#FFFFFF')}
                          >
                            <span
                              style={{
                                fontFamily: "'JetBrains Mono', monospace",
                                fontSize: 11,
                                color: '#9AA8A0',
                                flexShrink: 0,
                              }}
                            >
                              #{t.id}
                            </span>
                            <span
                              style={{
                                fontSize: 13,
                                color: '#1E2A22',
                                flex: 1,
                                minWidth: 0,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {t.title}
                            </span>
                            <span
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 5,
                                padding: '2px 8px',
                                borderRadius: 999,
                                border: '1px solid #E3E8E5',
                                background: '#FFFFFF',
                                fontSize: 11,
                                fontWeight: 700,
                                color: '#1E2A22',
                                whiteSpace: 'nowrap',
                                flexShrink: 0,
                              }}
                            >
                              <span
                                style={{
                                  width: 6,
                                  height: 6,
                                  borderRadius: '50%',
                                  background: tStatus.dotColor,
                                  flexShrink: 0,
                                  display: 'inline-block',
                                }}
                              />
                              {tStatus.label}
                            </span>
                          </div>
                        );
                      })}
                      {eligibleTickets.length === 0 && (
                        <div style={{ padding: '12px', fontSize: 12, color: '#9AA8A0', textAlign: 'center' }}>
                          No tickets found
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  /* B2 Ticket mode, filled - live status */
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 9,
                      padding: '9px 11px',
                      borderRadius: 8,
                      border: '1px solid #2E6F40',
                      background: '#FFFFFF',
                      boxShadow: '0 0 0 3px rgba(46,111,64,0.10)',
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 11,
                        color: '#9AA8A0',
                        flexShrink: 0,
                      }}
                    >
                      {selectedTicket.id}
                    </span>
                    <span
                      style={{
                        fontSize: 13,
                        color: '#1E2A22',
                        flex: 1,
                        minWidth: 0,
                        lineHeight: 1.35,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {selectedTicket.title}
                    </span>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                        padding: '2px 8px',
                        borderRadius: 999,
                        border: '1px solid #E3E8E5',
                        background: '#FFFFFF',
                        fontSize: 11,
                        fontWeight: 700,
                        color: '#1E2A22',
                        whiteSpace: 'nowrap',
                        flexShrink: 0,
                      }}
                    >
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: STATUS_CONFIG[selectedTicket.status]?.dotColor || '#9AA8A0',
                          flexShrink: 0,
                          display: 'inline-block',
                        }}
                      />
                      {STATUS_CONFIG[selectedTicket.status]?.label || selectedTicket.status}
                    </span>
                    <button
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => setSelectedTicketId('')}
                      style={{
                        border: 'none',
                        background: 'none',
                        cursor: isSubmitting ? 'not-allowed' : 'pointer',
                        color: '#9AA8A0',
                        display: 'flex',
                        padding: 0,
                      }}
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#9AA8A0"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{ flexShrink: 0 }}
                      >
                        <path d="M6 6L18 18" />
                        <path d="M18 6L6 18" />
                      </svg>
                    </button>
                  </div>
                )}

                {/* Note (optional) */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline' }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: '#1E2A22', flexGrow: 1 }}>
                      Note <span style={{ fontWeight: 500, color: '#9AA8A0' }}>(optional)</span>
                    </span>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: counterColor }}>
                      {charCount} / 240
                    </span>
                  </div>
                  <input
                    ref={noteRef}
                    type="text"
                    maxLength={240}
                    disabled={isSubmitting}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="What is it waiting for?"
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      height: 40,
                      padding: '8px 10px',
                      borderRadius: 8,
                      border: '1px solid #E3E8E5',
                      background: isSubmitting ? '#F6FAF7' : '#FFFFFF',
                      fontSize: 13,
                      color: '#1E2A22',
                      outline: 'none',
                      fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
                    }}
                  />
                </div>

                {/* Also add as Blocked by */}
                <div
                  onClick={() => {
                    if (isSubmitting || !selectedTicket) return;
                    setAlsoAddBlockedBy((b) => !b);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 9,
                    cursor: isSubmitting || !selectedTicket ? 'default' : 'pointer',
                    opacity: !selectedTicket ? 0.55 : 1,
                    marginTop: 4,
                  }}
                >
                  <span
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: 4,
                      boxSizing: 'border-box',
                      flexShrink: 0,
                      marginTop: 1,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: alsoAddBlockedBy && selectedTicket ? '#2E6F40' : '#FFFFFF',
                      border: alsoAddBlockedBy && selectedTicket ? '1.4px solid #2E6F40' : '1.4px solid #C7D2CB',
                    }}
                  >
                    {alsoAddBlockedBy && selectedTicket && (
                      <svg
                        width="11"
                        height="11"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#FFFFFF"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{ flexShrink: 0 }}
                      >
                        <path d="M5 12.5L10 17.5L19 7" />
                      </svg>
                    )}
                  </span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    <span style={{ fontSize: 13, color: '#1E2A22', fontWeight: 500, lineHeight: 1.4 }}>
                      Also add as <b>Blocked by</b>
                    </span>
                    <span style={{ fontSize: 12, color: '#9AA8A0', lineHeight: 1.4 }}>
                      {selectedTicket ? 'Adds the relation if missing (default on)' : 'Pick a ticket first'}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 2: Person or Party (B4a & B4b) */}
            {activeTab === 'person' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                <div style={{ display: 'flex', alignItems: 'baseline' }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: '#1E2A22', flexGrow: 1 }}>
                    Who or what are you waiting on?
                  </span>
                </div>

                {/* Member chips row */}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {members.slice(0, 4).map((m) => {
                    const isSelected = selectedMemberId === m.id;
                    const initials = m.name
                      .split(' ')
                      .map((p) => p[0])
                      .join('')
                      .toUpperCase()
                      .slice(0, 2);
                    return (
                      <span
                        key={m.id}
                        onClick={() => {
                          if (isSubmitting) return;
                          if (isSelected) {
                            setSelectedMemberId('');
                          } else {
                            setSelectedMemberId(m.id);
                            setCustomParty('');
                            setNotifyThem(true);
                          }
                        }}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '3px 10px 3px 4px',
                          borderRadius: 999,
                          border: isSelected ? '1.5px solid #2E6F40' : '1px solid #E3E8E5',
                          background: isSelected ? '#F1F8F3' : '#FFFFFF',
                          boxShadow: isSelected ? '0 0 0 2px rgba(46,111,64,0.12)' : 'none',
                          fontSize: 12.5,
                          fontWeight: isSelected ? 600 : 500,
                          color: '#1E2A22',
                          cursor: isSubmitting ? 'not-allowed' : 'pointer',
                          transition: 'all 0.1s ease',
                        }}
                      >
                        <div
                          title={m.name}
                          style={{
                            width: 20,
                            height: 20,
                            borderRadius: '50%',
                            background: '#DCEEE1',
                            color: '#2E6F40',
                            fontSize: 10,
                            fontWeight: 700,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0,
                          }}
                        >
                          {initials}
                        </div>
                        {m.name}
                        {isSelected && (
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="#2E6F40"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            style={{ flexShrink: 0 }}
                          >
                            <path d="M5 12.5L10 17.5L19 7" />
                          </svg>
                        )}
                      </span>
                    );
                  })}
                </div>

                {/* Divider: or a name */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '2px 0' }}>
                  <div style={{ height: 1, flexGrow: 1, background: '#EEF3EF' }} />
                  <span
                    style={{
                      fontSize: 11,
                      color: '#9AA8A0',
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                    }}
                  >
                    or a name
                  </span>
                  <div style={{ height: 1, flexGrow: 1, background: '#EEF3EF' }} />
                </div>

                {/* Free text input */}
                <div
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: '1px solid #E3E8E5',
                    background: '#FFFFFF',
                  }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#9AA8A0"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ flexShrink: 0 }}
                  >
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                  <input
                    type="text"
                    disabled={isSubmitting}
                    value={customParty}
                    onChange={(e) => {
                      setCustomParty(e.target.value);
                      if (e.target.value.trim()) {
                        setSelectedMemberId('');
                        setNotifyThem(false);
                      }
                    }}
                    placeholder="Customer, Design team, vendor name..."
                    style={{
                      border: 'none',
                      outline: 'none',
                      fontSize: 13,
                      color: '#1E2A22',
                      width: '100%',
                      background: 'transparent',
                      fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
                    }}
                  />
                </div>

                {/* Note (optional) */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline' }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: '#1E2A22', flexGrow: 1 }}>
                      Note <span style={{ fontWeight: 500, color: '#9AA8A0' }}>(optional)</span>
                    </span>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: counterColor }}>
                      {charCount} / 240
                    </span>
                  </div>
                  <input
                    ref={noteRef}
                    type="text"
                    maxLength={240}
                    disabled={isSubmitting}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="What is it waiting for?"
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      height: 40,
                      padding: '8px 10px',
                      borderRadius: 8,
                      border: '1px solid #E3E8E5',
                      background: isSubmitting ? '#F6FAF7' : '#FFFFFF',
                      fontSize: 13,
                      color: '#1E2A22',
                      outline: 'none',
                      fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
                    }}
                  />
                </div>

                {/* Toggle: Notify them */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    marginTop: 4,
                    opacity: selectedMember ? 1 : 0.6,
                  }}
                >
                  <span
                    onClick={() => {
                      if (isSubmitting || !selectedMember) return;
                      setNotifyThem((n) => !n);
                    }}
                    style={{
                      position: 'relative',
                      width: 30,
                      height: 18,
                      borderRadius: 999,
                      background: notifyThem && selectedMember ? '#2E6F40' : '#C7D2CB',
                      flexShrink: 0,
                      display: 'inline-block',
                      cursor: isSubmitting || !selectedMember ? 'default' : 'pointer',
                      transition: 'background 0.15s ease',
                    }}
                  >
                    <span
                      style={{
                        position: 'absolute',
                        top: 2,
                        left: notifyThem && selectedMember ? 14 : 2,
                        width: 14,
                        height: 14,
                        borderRadius: '50%',
                        background: '#FFFFFF',
                        transition: 'left 0.15s ease',
                      }}
                    />
                  </span>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontSize: 13, fontWeight: 500, color: '#1E2A22' }}>Notify them</span>
                    <span style={{ fontSize: 12, color: '#9AA8A0' }}>
                      {selectedMember
                        ? `${selectedMember.name} gets an in-app notification`
                        : 'Free-text names cannot be notified'}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {isAlreadyPending && (
              <div style={{ fontSize: 12, color: '#9AA8A0', lineHeight: 1.45 }}>
                Changing the reason keeps the original date and logs one activity entry.
              </div>
            )}

            {/* B6 Error State Box */}
            {error && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '10px 12px',
                  borderRadius: 8,
                  background: '#FBE7E4',
                  border: '1px solid #F1C4BC',
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#C4432A"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0, marginTop: 2 }}
                >
                  <path d="M12 9V13" />
                  <path d="M12 17H12.01" />
                  <path d="M10.29 3.86L1.82 18A2 2 0 0 0 3.54 21H20.46A2 2 0 0 0 22.18 18L13.71 3.86A2 2 0 0 0 10.29 3.86Z" />
                </svg>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: '#C4432A' }}>
                    Could not mark {ticket.id} pending
                  </span>
                  <span style={{ fontSize: 12, color: '#8A3220', lineHeight: 1.4 }}>
                    {`The server returned an error. Nothing was changed - the ticket is still ${currentStatusConfig.label}.`}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Footer (FBFCFB) */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: isAlreadyPending && (onResume || onResumeClick) ? 'space-between' : 'flex-end',
              gap: 8,
              padding: '12px 20px',
              borderTop: '1px solid #EEF3EF',
              background: '#FBFCFB',
            }}
          >
            {isAlreadyPending && (onResume || onResumeClick) && (
              <button
                type="button"
                disabled={isSubmitting}
                onClick={onResumeClick || onResume}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '7px 12px',
                  borderRadius: 8,
                  border: '1px solid #E3E8E5',
                  background: '#FFFFFF',
                  color: '#2E6F40',
                  fontSize: 13,
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  cursor: isSubmitting ? 'not-allowed' : 'pointer',
                  fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
                }}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#2E6F40"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0 }}
                >
                  <path d="M7.5 4.8V19.2L19 12Z" />
                </svg>
                Resume
              </button>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={onClose}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  padding: '7px 13px',
                  borderRadius: 8,
                  border: '1px solid #E3E8E5',
                  background: '#FFFFFF',
                  color: isSubmitting ? '#9AA8A0' : '#1E2A22',
                  fontSize: 13,
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  cursor: isSubmitting ? 'not-allowed' : 'pointer',
                  fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting || !canSubmit}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  padding: '8px 14px',
                  borderRadius: 8,
                  background: '#2E6F40',
                  color: '#FFFFFF',
                  fontSize: 13,
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  border: 'none',
                  cursor: isSubmitting || !canSubmit ? 'not-allowed' : 'pointer',
                  opacity: isSubmitting || !canSubmit ? 0.55 : 1,
                  fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
                }}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#FFFFFF"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0 }}
                >
                  <path d="M8.5 5.5V18.5" />
                  <path d="M15.5 5.5V18.5" />
                </svg>
                {isSubmitting ? 'Saving...' : error ? 'Retry' : isAlreadyPending ? 'Save changes' : 'Mark pending'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
