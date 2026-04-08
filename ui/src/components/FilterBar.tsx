import type { Member, Priority } from '../types';
import styles from './FilterBar.module.css';

interface FilterBarProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  activePriority: Priority | 'all';
  onPriorityChange: (p: Priority | 'all') => void;
  members?: Member[];
  activeAssignee?: string | 'all';
  onAssigneeChange?: (id: string | 'all') => void;
}

const PRIORITY_CHIPS: { label: string; value: Priority | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Critical', value: 'critical' },
  { label: 'High', value: 'high' },
  { label: 'Medium', value: 'medium' },
  { label: 'Low', value: 'low' },
];

export function FilterBar({ searchQuery, onSearchChange, activePriority, onPriorityChange, members = [], activeAssignee = 'all', onAssigneeChange }: FilterBarProps) {
  return (
    <div className={styles.filterBar}>
      <input
        className={styles.searchInput}
        type="text"
        aria-label="Search tickets"
        placeholder="Search tickets…"
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
      />

      <div className={styles.chips}>
        {PRIORITY_CHIPS.map((chip) => (
          <button
            key={chip.value}
            type="button"
            className={`${styles.chip} ${activePriority === chip.value ? styles.chipActive : ''}`}
            onClick={() => onPriorityChange(chip.value)}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {members.length > 0 && (
        <div className={styles.chips}>
          <button
            type="button"
            className={`${styles.chip} ${activeAssignee === 'all' ? styles.chipActive : ''}`}
            onClick={() => onAssigneeChange?.('all')}
          >
            All Assignees
          </button>
          <button
            type="button"
            className={`${styles.chip} ${activeAssignee === 'unassigned' ? styles.chipActive : ''}`}
            onClick={() => onAssigneeChange?.('unassigned')}
          >
            Unassigned
          </button>
          {members.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`${styles.chip} ${activeAssignee === m.id ? styles.chipActive : ''}`}
              onClick={() => onAssigneeChange?.(m.id)}
              style={activeAssignee === m.id ? { borderColor: m.color, background: m.color, color: '#fff' } : {}}
            >
              {m.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
