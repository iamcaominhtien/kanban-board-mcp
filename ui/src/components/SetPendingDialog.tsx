import React, { useState, useEffect, useRef } from 'react';
import type { Ticket, Member, PendingReasonType } from '../types/ticket';
import { ModalShell } from './docs/docsShared';
import { Icon } from './docs/Icon';

interface SetPendingDialogProps {
  isOpen: boolean;
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
  }) => void;
  onResume?: () => void;
}

export const SetPendingDialog: React.FC<SetPendingDialogProps> = ({
  isOpen,
  ticket,
  allTickets = [],
  members = [],
  isSubmitting = false,
  error = null,
  onClose,
  onConfirm,
  onResume,
}) => {
  const isAlreadyPending = !!ticket.pending;

  const [activeTab, setActiveTab] = useState<'ticket' | 'person'>('ticket');
  const [selectedTicketId, setSelectedTicketId] = useState<string>('');
  const [ticketSearch, setTicketSearch] = useState<string>('');
  const [alsoAddBlockedBy, setAlsoAddBlockedBy] = useState<boolean>(true);

  const [selectedMemberId, setSelectedMemberId] = useState<string>('');
  const [customParty, setCustomParty] = useState<string>('');

  const [note, setNote] = useState<string>('');

  const searchInputRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isOpen) {
      if (ticket.pending) {
        setActiveTab(ticket.pendingReasonType === 'person' ? 'person' : 'ticket');
        setSelectedTicketId(ticket.pendingTicketId || '');
        setSelectedMemberId(ticket.pendingMemberId || '');
        setCustomParty(ticket.pendingParty || '');
        setNote(ticket.pendingNote || '');
        setAlsoAddBlockedBy(false);
      } else {
        setActiveTab('ticket');
        setSelectedTicketId('');
        setSelectedMemberId('');
        setCustomParty('');
        setNote('');
        setAlsoAddBlockedBy(true);
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
    // Exclude subtasks of this ticket
    if (t.parentId === ticket.id) return false;
    if (ticketSearch.trim()) {
      const q = ticketSearch.toLowerCase();
      return t.id.toLowerCase().includes(q) || t.title.toLowerCase().includes(q);
    }
    return true;
  });

  const selectedTicket = allTickets.find((t) => t.id === selectedTicketId);
  const selectedMember = members.find((m) => m.id === selectedMemberId);

  const canSubmit =
    activeTab === 'ticket'
      ? !!selectedTicketId
      : !!selectedMemberId || !!customParty.trim();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || isSubmitting) return;

    if (activeTab === 'ticket') {
      onConfirm({
        reasonType: 'ticket',
        pendingTicketId: selectedTicketId,
        note: note.trim() || undefined,
        alsoAddBlockedBy: alsoAddBlockedBy,
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

  return (
    <ModalShell
      width={520}
      onClose={isSubmitting ? () => {} : onClose}
      ariaLabel={isAlreadyPending ? `Change pending reason for ${ticket.id}` : `Mark ${ticket.id} as pending`}
      title={isAlreadyPending ? 'Change pending reason' : `Mark ${ticket.id} as pending`}
      subtitle={
        <>
          {ticket.title} · <span style={{ textTransform: 'capitalize' }}>{ticket.status.replace('_', ' ')}</span>
        </>
      }
    >
      <form onSubmit={handleSubmit} onKeyDown={handleKeyDown} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Existing Pending Info Box */}
        {isAlreadyPending && (
          <div
            style={{
              padding: '10px 14px',
              background: '#F4F6F9',
              border: '1px solid #B8C4D2',
              borderRadius: 8,
              fontSize: 12.5,
              color: '#34455A',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 600 }}>
                Pending since {ticket.pendingSince ? new Date(ticket.pendingSince).toLocaleDateString() : 'recent'}{' '}
                <span style={{ color: '#5B6F86', fontWeight: 400 }}>({daysPending}d)</span>
                {ticket.pendingBy ? ` by ${ticket.pendingBy}` : ''}
              </span>
            </div>
            <div style={{ fontSize: 12, color: '#5B6F86' }}>
              Waiting on:{' '}
              <strong style={{ color: '#34455A' }}>
                {ticket.pendingReasonType === 'ticket'
                  ? ticket.pendingTicketId || 'Ticket'
                  : ticket.pendingParty || ticket.pendingMemberId || 'Person'}
              </strong>
              {ticket.pendingNote ? ` — "${ticket.pendingNote}"` : ''}
            </div>
          </div>
        )}

        {/* Segmented Tabs */}
        <div
          style={{
            display: 'flex',
            background: '#F0F3F6',
            padding: 3,
            borderRadius: 8,
            gap: 4,
          }}
        >
          <button
            type="button"
            onClick={() => setActiveTab('ticket')}
            style={{
              flex: 1,
              padding: '7px 12px',
              fontSize: 13,
              fontWeight: activeTab === 'ticket' ? 600 : 500,
              color: activeTab === 'ticket' ? '#1E2A22' : '#5B6B60',
              background: activeTab === 'ticket' ? '#fff' : 'transparent',
              border: 'none',
              borderRadius: 6,
              boxShadow: activeTab === 'ticket' ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              transition: 'all 0.15s ease',
            }}
          >
            <Icon name="hash" size={14} />
            Waiting on a ticket
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('person')}
            style={{
              flex: 1,
              padding: '7px 12px',
              fontSize: 13,
              fontWeight: activeTab === 'person' ? 600 : 500,
              color: activeTab === 'person' ? '#1E2A22' : '#5B6B60',
              background: activeTab === 'person' ? '#fff' : 'transparent',
              border: 'none',
              borderRadius: 6,
              boxShadow: activeTab === 'person' ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              transition: 'all 0.15s ease',
            }}
          >
            <Icon name="i32" size={14} />
            Waiting on a person or party
          </button>
        </div>

        {/* Tab 1: Ticket Selection */}
        {activeTab === 'ticket' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#1E2A22' }}>Which ticket?</label>

            {selectedTicket ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 12px',
                  borderRadius: 6,
                  border: '1px solid #B8C4D2',
                  background: '#F4F6F9',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span style={{ fontWeight: 700, color: '#34455A', fontSize: 13 }}>
                    #{selectedTicket.id}
                  </span>
                  <span
                    style={{
                      fontSize: 13,
                      color: '#1E2A22',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {selectedTicket.title}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      padding: '1px 6px',
                      borderRadius: 4,
                      background: '#E8EDF3',
                      color: '#34455A',
                      textTransform: 'capitalize',
                      flexShrink: 0,
                    }}
                  >
                    {selectedTicket.status.replace('_', ' ')}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedTicketId('')}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#5B6F86',
                    cursor: 'pointer',
                    padding: 4,
                    display: 'flex',
                    alignItems: 'center',
                  }}
                  title="Change ticket"
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ position: 'relative' }}>
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={ticketSearch}
                    onChange={(e) => setTicketSearch(e.target.value)}
                    placeholder="Search by ticket ID or title..."
                    style={{
                      width: '100%',
                      padding: '8px 10px 8px 30px',
                      borderRadius: 6,
                      border: '1px solid #CBD5E1',
                      fontSize: 13,
                      outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                  <div
                    style={{
                      position: 'absolute',
                      left: 9,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      color: '#94A3B8',
                    }}
                  >
                    <Icon name="search" size={14} />
                  </div>
                </div>

                <div
                  style={{
                    maxHeight: 160,
                    overflowY: 'auto',
                    border: '1px solid #E2E8F0',
                    borderRadius: 6,
                    background: '#FAFAFA',
                  }}
                >
                  {eligibleTickets.length === 0 ? (
                    <div style={{ padding: '12px 14px', fontSize: 12.5, color: '#64748B', textAlign: 'center' }}>
                      No tickets found
                    </div>
                  ) : (
                    eligibleTickets.slice(0, 8).map((t) => (
                      <div
                        key={t.id}
                        onClick={() => setSelectedTicketId(t.id)}
                        style={{
                          padding: '8px 12px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 8,
                          cursor: 'pointer',
                          borderBottom: '1px solid #F1F5F9',
                          transition: 'background 0.1s ease',
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = '#EFF6FF')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <span style={{ fontWeight: 600, fontSize: 12.5, color: '#334155' }}>
                            #{t.id}
                          </span>
                          <span
                            style={{
                              fontSize: 12.5,
                              color: '#1E293B',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {t.title}
                          </span>
                        </div>
                        <span
                          style={{
                            fontSize: 11,
                            padding: '1px 6px',
                            borderRadius: 4,
                            background: '#E2E8F0',
                            color: '#475569',
                            textTransform: 'capitalize',
                            flexShrink: 0,
                          }}
                        >
                          {t.status.replace('_', ' ')}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* Checkbox: Also add as Blocked by */}
            <label
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                fontSize: 12.5,
                color: selectedTicketId ? '#34455A' : '#94A3B8',
                cursor: selectedTicketId ? 'pointer' : 'not-allowed',
                marginTop: 2,
              }}
            >
              <input
                type="checkbox"
                checked={alsoAddBlockedBy}
                disabled={!selectedTicketId}
                onChange={(e) => setAlsoAddBlockedBy(e.target.checked)}
                style={{ marginTop: 2 }}
              />
              <div>
                <strong>Also add as "Blocked by"</strong>
                <div style={{ fontSize: 11.5, color: '#64748B' }}>
                  {selectedTicketId
                    ? 'Adds the relation if missing (default on)'
                    : 'Pick a ticket first'}
                </div>
              </div>
            </label>
          </div>
        )}

        {/* Tab 2: Person or Party */}
        {activeTab === 'person' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#1E2A22' }}>
              Who or what are you waiting on?
            </label>

            {/* Member Chips */}
            {members.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {members.map((m) => {
                  const isSelected = selectedMemberId === m.id;
                  const initials = m.name
                    .split(' ')
                    .map((p) => p[0])
                    .join('')
                    .toUpperCase()
                    .slice(0, 2);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => {
                        if (isSelected) {
                          setSelectedMemberId('');
                        } else {
                          setSelectedMemberId(m.id);
                          setCustomParty('');
                        }
                      }}
                      style={{
                        padding: '5px 10px',
                        borderRadius: 16,
                        border: isSelected ? '1.5px solid #5B6F86' : '1px solid #CBD5E1',
                        background: isSelected ? '#E8EDF3' : '#fff',
                        color: isSelected ? '#34455A' : '#475569',
                        fontSize: 12,
                        fontWeight: isSelected ? 600 : 500,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      <span
                        style={{
                          width: 18,
                          height: 18,
                          borderRadius: '50%',
                          background: isSelected ? '#5B6F86' : '#E2E8F0',
                          color: isSelected ? '#fff' : '#475569',
                          fontSize: 10,
                          fontWeight: 700,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        {initials}
                      </span>
                      {m.name}
                      {isSelected && <Icon name="check" size={12} />}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Divider or custom name */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '2px 0' }}>
              <div style={{ flex: 1, height: 1, background: '#E2E8F0' }} />
              <span style={{ fontSize: 11.5, color: '#94A3B8' }}>or a name / external party</span>
              <div style={{ flex: 1, height: 1, background: '#E2E8F0' }} />
            </div>

            <input
              type="text"
              value={customParty}
              onChange={(e) => {
                setCustomParty(e.target.value);
                if (e.target.value) {
                  setSelectedMemberId('');
                }
              }}
              placeholder="e.g. Customer, Design team, Acme Corp, DevOps..."
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 6,
                border: '1px solid #CBD5E1',
                fontSize: 13,
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />

            {/* Notification Hint */}
            <div
              style={{
                fontSize: 12,
                color: selectedMemberId ? '#34455A' : '#94A3B8',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 8px',
                background: '#F8FAFC',
                borderRadius: 6,
              }}
            >
              <Icon name="i44" size={13} />
              <span>
                {selectedMember
                  ? `Notify them: ${selectedMember.name} will be notified in-app`
                  : 'Free-text names cannot be notified directly'}
              </span>
            </div>
          </div>
        )}

        {/* Note field (Both Tabs) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: '#1E2A22' }}>
              Note <span style={{ fontWeight: 400, color: '#64748B' }}>(optional)</span>
            </label>
            <span style={{ fontSize: 11.5, color: note.length > 220 ? '#DC2626' : '#64748B' }}>
              {note.length} / 240
            </span>
          </div>
          <textarea
            ref={noteRef}
            value={note}
            maxLength={240}
            onChange={(e) => setNote(e.target.value)}
            placeholder={
              activeTab === 'ticket'
                ? 'What is it waiting for? (e.g. Needs test fixtures from KAN-146)'
                : 'What is it waiting for? (e.g. Waiting for client API credentials)'
            }
            rows={2}
            style={{
              width: '100%',
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid #CBD5E1',
              fontSize: 13,
              fontFamily: 'inherit',
              resize: 'vertical',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Error message */}
        {error && (
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 6,
              background: '#FEF2F2',
              border: '1px solid #FCA5A5',
              color: '#991B1B',
              fontSize: 12.5,
              display: 'flex',
              gap: 8,
              alignItems: 'center',
            }}
          >
            <Icon name="i14" size={16} />
            <div style={{ flex: 1 }}>{error}</div>
          </div>
        )}

        {/* Footer actions */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: isAlreadyPending && onResume ? 'space-between' : 'flex-end',
            gap: 10,
            marginTop: 4,
          }}
        >
          {isAlreadyPending && onResume && (
            <button
              type="button"
              onClick={onResume}
              disabled={isSubmitting}
              style={{
                padding: '7px 14px',
                borderRadius: 6,
                border: '1px solid #B8C4D2',
                background: '#fff',
                color: '#34455A',
                fontSize: 13,
                fontWeight: 600,
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
              }}
            >
              Resume
            </button>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              style={{
                padding: '7px 14px',
                borderRadius: 6,
                border: '1px solid #CBD5E1',
                background: '#fff',
                color: '#475569',
                fontSize: 13,
                fontWeight: 500,
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit || isSubmitting}
              style={{
                padding: '7px 16px',
                borderRadius: 6,
                border: 'none',
                background: canSubmit && !isSubmitting ? '#5B6F86' : '#94A3B8',
                color: '#fff',
                fontSize: 13,
                fontWeight: 600,
                cursor: canSubmit && !isSubmitting ? 'pointer' : 'not-allowed',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              {isSubmitting
                ? isAlreadyPending
                  ? 'Saving changes...'
                  : 'Marking pending...'
                : isAlreadyPending
                ? 'Save changes'
                : 'Mark pending'}
            </button>
          </div>
        </div>
      </form>
    </ModalShell>
  );
};
