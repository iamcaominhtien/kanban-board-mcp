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

/**
 * Search, status, priority and tag filters.
 * @param props.onSearchChange - Called with the new search text.
 * @param props.onTypeChange - Called with the selected type or `all`.
 * @param props.onPriorityChange - Called with the selected priority or `all`.
 * @param props.activeAssignee - Selected member id, `all` for none.
 * @param props.onAssigneeChange - Called with the selected member id or `all`.
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

  const activeMember = members.find((m) => m.id === activeAssignee);

  function getAssigneeLabel() {
    if (activeAssignee === 'all') return 'All';
    if (activeAssignee === 'unassigned') return 'Unassigned';
    return activeMember?.name ?? activeAssignee;
  }

  function getMemberInitials(name: string) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }

  return (
    <div className={styles.filterBar} ref={containerRef}>
      {/* Search Input Box */}
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
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21L16.5 16.5" />
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
                    {opt.value === 'task' && (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
                        <rect x="3" y="3" width="18" height="18" rx="5" stroke="#2F6FB0" strokeWidth="2.2" />
                        <path
                          d="M7.5 12.3L10.3 15L16.5 8.2"
                          stroke="#2F6FB0"
                          strokeWidth="2.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                    {opt.value === 'bug' && (
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#C4432A"
                        strokeWidth="2.1"
                        strokeLinecap="round"
                        style={{ flexShrink: 0 }}
                      >
                        <ellipse cx="12" cy="14" rx="5" ry="6.5" />
                        <circle cx="12" cy="6" r="2.6" />
                        <path d="M7 11H4M7 16H4M17 11H20M17 16H20" />
                      </svg>
                    )}
                    {opt.value === 'feature' && (
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#6D5DD3"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{ flexShrink: 0 }}
                      >
                        <path d="M12 3.5A6 6 0 0 0 8.5 14.3C9.3 15 9.8 15.8 9.8 16.8V17.5H14.2V16.8C14.2 15.8 14.7 15 15.5 14.3A6 6 0 0 0 12 3.5Z" />
                        <path d="M10 20.5H14" />
                      </svg>
                    )}
                    {opt.value === 'chore' && (
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#5B6B60"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        style={{ flexShrink: 0 }}
                      >
                        <rect x="4" y="4.5" width="4" height="4" rx="1" />
                        <path d="M10.5 6.5H20M10.5 12H20M10.5 17.5H20" />
                        <rect x="4" y="10" width="4" height="4" rx="1" />
                        <rect x="4" y="15.5" width="4" height="4" rx="1" />
                      </svg>
                    )}
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
          {activeMember && (
            <div
              className={styles.miniAvatar}
              style={{ background: activeMember.color || '#2E6F40', color: '#FFFFFF' }}
            >
              {getMemberInitials(activeMember.name)}
            </div>
          )}
          <span className={styles.labelMuted}>Assignee:</span> {getAssigneeLabel()}
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
    </div>
  );
}
