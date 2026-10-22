import { useEffect, useRef, useState } from 'react';
import type { IssueType, Member, Priority } from '../types';
import styles from './FilterBar.module.css';

interface FilterBarProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  activeType?: IssueType | 'all';
  onTypeChange?: (t: IssueType | 'all') => void;
  activePriority: Priority | 'all';
  onPriorityChange: (p: Priority | 'all') => void;
  members?: Member[];
  activeAssignee?: string | 'all';
  onAssigneeChange?: (id: string | 'all') => void;
  reopenedCount?: number;
  filterReopened?: boolean;
  onFilterReopenedChange?: (v: boolean) => void;
  pendingCount?: number;
  filterPending?: boolean;
  onFilterPendingChange?: (v: boolean) => void;
  hidePending?: boolean;
  onHidePendingChange?: (v: boolean) => void;
  totalReopens30d?: number;
  waitingOnTicketsCount?: number;
  waitingOnPersonsCount?: number;
}

const TYPE_OPTIONS: { value: IssueType | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'task', label: 'Task' },
  { value: 'bug', label: 'Bug' },
  { value: 'feature', label: 'Feature' },
  { value: 'chore', label: 'Chore' },
];

const PRIORITY_OPTIONS: { value: Priority | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

function getMemberInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

/**
 * FilterBar strictly matching TicketReopen.dc.html (E1) and TicketPending.dc.html (F1).
 */
export function FilterBar({
  searchQuery,
  onSearchChange,
  activeType = 'all',
  onTypeChange,
  activePriority,
  onPriorityChange,
  members = [],
  activeAssignee = 'all',
  onAssigneeChange,
  reopenedCount = 0,
  filterReopened = false,
  onFilterReopenedChange,
  pendingCount = 0,
  filterPending = false,
  onFilterPendingChange,
  hidePending = false,
  onHidePendingChange,
  totalReopens30d = 0,
  waitingOnTicketsCount = 0,
  waitingOnPersonsCount = 0,
}: FilterBarProps) {
  const [openDropdown, setOpenDropdown] = useState<'type' | 'priority' | 'assignee' | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpenDropdown(null);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* Project hints: E1 (Reopened) and F1 (Pending); chips beside the secondary counts, link on the right */}
      {(reopenedCount > 0 || pendingCount > 0) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minHeight: 30 }}>
          {reopenedCount > 0 && (
            <>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 11px',
                  borderRadius: 999,
                  background: '#FFFAF0',
                  border: '1px solid #F0C77A',
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: '#8A4B00',
                }}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#C77700"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: 0 }}
                >
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
                {reopenedCount} {reopenedCount === 1 ? 'ticket is' : 'tickets are'} reopened rework
              </span>
              <span style={{ fontSize: 12.5, color: '#5B6B60' }}>
                {totalReopens30d} {totalReopens30d === 1 ? 'reopen' : 'reopens'} in the last 30 days
              </span>
              <span
                role="button"
                tabIndex={0}
                onClick={() => onFilterReopenedChange?.(!filterReopened)}
                onKeyDown={(e) => e.key === 'Enter' && onFilterReopenedChange?.(!filterReopened)}
                style={{ fontSize: 12.5, fontWeight: 700, color: '#2E6F40', cursor: 'pointer' }}
              >
                {filterReopened ? 'Show all' : 'Show only reopened'}
              </span>
            </>
          )}
          {pendingCount > 0 && (
            <>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 11px',
                  borderRadius: 999,
                  background: '#F4F6F9',
                  border: '1px solid #B8C4D2',
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: '#34455A',
                }}
              >
                <svg
                  width="13"
                  height="13"
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
                {pendingCount} {pendingCount === 1 ? 'ticket is' : 'tickets are'} pending
              </span>
              <span style={{ fontSize: 12.5, color: '#5B6B60' }}>
                {waitingOnTicketsCount} waiting on tickets, {waitingOnPersonsCount} on people or parties
              </span>
              <span
                role="button"
                tabIndex={0}
                onClick={() => {
                  onFilterPendingChange?.(!filterPending);
                  if (!filterPending && hidePending) onHidePendingChange?.(false);
                }}
                onKeyDown={(e) => e.key === 'Enter' && onFilterPendingChange?.(!filterPending)}
                style={{ fontSize: 12.5, fontWeight: 700, color: '#2E6F40', cursor: 'pointer' }}
              >
                {filterPending ? 'Show all' : 'Show only pending'}
              </span>
            </>
          )}
        </div>
      )}

      <div ref={containerRef} className={styles.filterBar}>
        {/* Search */}
        <div className={styles.searchBox}>
          <svg
            className={styles.searchIcon}
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21L16.65 16.65" />
          </svg>
          <input
            className={styles.searchInput}
            type="text"
            aria-label="Search tickets"
            placeholder="Search tickets…"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>

        <span className={styles.divider} />

        {/* Type Dropdown */}
        {onTypeChange && (
          <div className={styles.dropdownContainer}>
            <button
              type="button"
              className={`${styles.dropdownBtn} ${openDropdown === 'type' ? styles.dropdownBtnActive : ''}`}
              onClick={() => setOpenDropdown(openDropdown === 'type' ? null : 'type')}
              aria-expanded={openDropdown === 'type'}
            >
              <span className={styles.labelMuted}>Type:</span>{' '}
              {TYPE_OPTIONS.find((t) => t.value === activeType)?.label ?? 'All'}
              <svg
                className={`${styles.chevronIcon} ${openDropdown === 'type' ? styles.chevronRotated : ''}`}
                width="9"
                height="9"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M6 9L12 15L18 9" />
              </svg>
            </button>

            {openDropdown === 'type' && (
              <div className={styles.dropdownMenu}>
                {TYPE_OPTIONS.map((opt) => {
                  const isSelected = activeType === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      className={`${styles.dropdownItem} ${isSelected ? styles.dropdownItemActive : ''}`}
                      onClick={() => {
                        onTypeChange(opt.value);
                        setOpenDropdown(null);
                      }}
                    >
                      <span className={styles.itemLabel}>{opt.label}</span>
                      {isSelected && (
                        <svg className={styles.checkIcon} width="13" height="13" viewBox="0 0 14 14" fill="none">
                          <path
                            d="M3.5 7.2L5.7 9.5L10.5 4.3"
                            stroke="#2E6F40"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Priority Dropdown */}
        <div className={styles.dropdownContainer}>
          <button
            type="button"
            className={`${styles.dropdownBtn} ${openDropdown === 'priority' ? styles.dropdownBtnActive : ''}`}
            onClick={() => setOpenDropdown(openDropdown === 'priority' ? null : 'priority')}
            aria-expanded={openDropdown === 'priority'}
          >
            <span className={styles.labelMuted}>Priority:</span>{' '}
            {PRIORITY_OPTIONS.find((p) => p.value === activePriority)?.label ?? 'All'}
            <svg
              className={`${styles.chevronIcon} ${openDropdown === 'priority' ? styles.chevronRotated : ''}`}
              width="9"
              height="9"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 9L12 15L18 9" />
            </svg>
          </button>

          {openDropdown === 'priority' && (
            <div className={styles.dropdownMenu}>
              {PRIORITY_OPTIONS.map((opt) => {
                const isSelected = activePriority === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    className={`${styles.dropdownItem} ${isSelected ? styles.dropdownItemActive : ''}`}
                    onClick={() => {
                      onPriorityChange(opt.value);
                      setOpenDropdown(null);
                    }}
                  >
                    <span className={styles.itemLabel}>{opt.label}</span>
                    {isSelected && (
                      <svg className={styles.checkIcon} width="13" height="13" viewBox="0 0 14 14" fill="none">
                        <path
                          d="M3.5 7.2L5.7 9.5L10.5 4.3"
                          stroke="#2E6F40"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Assignee Dropdown */}
        <div className={styles.dropdownContainer}>
          <button
            type="button"
            className={`${styles.dropdownBtn} ${openDropdown === 'assignee' ? styles.dropdownBtnActive : ''}`}
            onClick={() => setOpenDropdown(openDropdown === 'assignee' ? null : 'assignee')}
            aria-expanded={openDropdown === 'assignee'}
          >
            <span className={styles.labelMuted}>Assignee:</span>{' '}
            {activeAssignee === 'all'
              ? 'All'
              : activeAssignee === 'unassigned'
                ? 'Unassigned'
                : (members.find((m) => m.id === activeAssignee)?.name ?? 'All')}
            <svg
              className={`${styles.chevronIcon} ${openDropdown === 'assignee' ? styles.chevronRotated : ''}`}
              width="9"
              height="9"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 9L12 15L18 9" />
            </svg>
          </button>

          {openDropdown === 'assignee' && (
            <div className={styles.dropdownMenu}>
              <button
                type="button"
                className={`${styles.dropdownItem} ${activeAssignee === 'all' ? styles.dropdownItemActive : ''}`}
                onClick={() => {
                  onAssigneeChange?.('all');
                  setOpenDropdown(null);
                }}
              >
                <span className={styles.itemLabel}>All Assignees</span>
                {activeAssignee === 'all' && (
                  <svg className={styles.checkIcon} width="13" height="13" viewBox="0 0 14 14" fill="none">
                    <path
                      d="M3.5 7.2L5.7 9.5L10.5 4.3"
                      stroke="#2E6F40"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
              <button
                type="button"
                className={`${styles.dropdownItem} ${activeAssignee === 'unassigned' ? styles.dropdownItemActive : ''}`}
                onClick={() => {
                  onAssigneeChange?.('unassigned');
                  setOpenDropdown(null);
                }}
              >
                <span className={styles.itemLabel}>Unassigned</span>
                {activeAssignee === 'unassigned' && (
                  <svg className={styles.checkIcon} width="13" height="13" viewBox="0 0 14 14" fill="none">
                    <path
                      d="M3.5 7.2L5.7 9.5L10.5 4.3"
                      stroke="#2E6F40"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
              {members.map((m) => {
                const isSelected = activeAssignee === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    className={`${styles.dropdownItem} ${isSelected ? styles.dropdownItemActive : ''}`}
                    onClick={() => {
                      onAssigneeChange?.(m.id);
                      setOpenDropdown(null);
                    }}
                  >
                    <div className={styles.miniAvatar} style={{ background: m.color || '#2E6F40', color: '#FFFFFF' }}>
                      {getMemberInitials(m.name)}
                    </div>
                    <span className={styles.itemLabel}>{m.name}</span>
                    {isSelected && (
                      <svg className={styles.checkIcon} width="13" height="13" viewBox="0 0 14 14" fill="none">
                        <path
                          d="M3.5 7.2L5.7 9.5L10.5 4.3"
                          stroke="#2E6F40"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <span className={styles.divider} />

        {/* E1 Reopened Filter Chip */}
        <button
          type="button"
          onClick={() => onFilterReopenedChange?.(!filterReopened)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 10px',
            borderRadius: 6,
            border: filterReopened ? '1.5px solid #C77700' : '1px solid #F0C77A',
            background: filterReopened ? '#FFE8BD' : '#FFFAF0',
            color: '#8A4B00',
            fontSize: 12.5,
            fontWeight: 600,
            cursor: 'pointer',
            boxShadow: filterReopened ? '0 0 0 2px rgba(199,119,0,0.15)' : 'none',
            transition: 'all 0.15s ease',
          }}
          title="Toggle Reopened tickets filter"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#C77700"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: 0 }}
          >
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
          </svg>
          Reopened
          {reopenedCount > 0 && (
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                fontWeight: 700,
                background: 'rgba(199,119,0,0.18)',
                padding: '0 5px',
                borderRadius: 999,
              }}
            >
              {reopenedCount}
            </span>
          )}
          {filterReopened && (
            <span aria-label="Clear" style={{ fontSize: 13, lineHeight: 1, marginLeft: 2 }}>
              ×
            </span>
          )}
        </button>

        {/* F1 Pending Filter Chip */}
        <button
          type="button"
          onClick={() => {
            onFilterPendingChange?.(!filterPending);
            if (!filterPending && hidePending) {
              onHidePendingChange?.(false);
            }
          }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 10px',
            borderRadius: 6,
            border: filterPending ? '1.5px solid #5B6F86' : '1px solid #B8C4D2',
            background: filterPending ? '#D8E2ED' : '#F4F6F9',
            color: '#34455A',
            fontSize: 12.5,
            fontWeight: 600,
            cursor: 'pointer',
            boxShadow: filterPending ? '0 0 0 2px rgba(91,111,134,0.15)' : 'none',
            transition: 'all 0.15s ease',
          }}
          title="Toggle Pending tickets filter"
        >
          <svg
            width="12"
            height="12"
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
          Pending
          {pendingCount > 0 && (
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                fontWeight: 700,
                background: 'rgba(52,69,90,0.14)',
                padding: '0 5px',
                borderRadius: 999,
              }}
            >
              {pendingCount}
            </span>
          )}
          {filterPending && (
            <span aria-label="Clear" style={{ fontSize: 13, lineHeight: 1, marginLeft: 2 }}>
              ×
            </span>
          )}
        </button>

        {/* F1 Hide Pending Toggle (switch) */}
        <button
          type="button"
          role="switch"
          aria-checked={hidePending}
          onClick={() => {
            onHidePendingChange?.(!hidePending);
            if (!hidePending && filterPending) {
              onFilterPendingChange?.(false);
            }
          }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '4px 6px',
            border: 'none',
            background: 'transparent',
            color: '#1E2A22',
            fontSize: 12.5,
            fontWeight: 500,
            cursor: 'pointer',
          }}
          title="Hide pending tickets"
        >
          <span
            style={{
              position: 'relative',
              width: 30,
              height: 18,
              borderRadius: 999,
              background: hidePending ? '#2E6F40' : '#D3DAE3',
              transition: 'background 0.15s ease',
              flexShrink: 0,
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: 2,
                left: hidePending ? 14 : 2,
                width: 14,
                height: 14,
                borderRadius: '50%',
                background: '#fff',
                boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
                transition: 'left 0.15s ease',
              }}
            />
          </span>
          Hide pending
        </button>
      </div>
    </div>
  );
}
