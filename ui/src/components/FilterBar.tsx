import type { Priority } from '../types';
import styles from './FilterBar.module.css';

interface FilterBarProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  activePriority: Priority | 'all';
  onPriorityChange: (p: Priority | 'all') => void;
}

const PRIORITY_CHIPS: { label: string; value: Priority | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Critical', value: 'critical' },
  { label: 'High', value: 'high' },
  { label: 'Medium', value: 'medium' },
  { label: 'Low', value: 'low' },
];

export function FilterBar({ searchQuery, onSearchChange, activePriority, onPriorityChange }: FilterBarProps) {
  return (
    <div className={styles.filterBar}>
      <input
        className={styles.searchInput}
        type="search"
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
    </div>
  );
}
