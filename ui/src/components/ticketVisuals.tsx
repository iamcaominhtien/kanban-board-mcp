// Small shared visual pieces (type icon, priority bars, due-date calendar icon)
// used by both TicketCard.tsx and TicketModal.tsx, so the two stay visually
// consistent instead of maintaining two copies of the same SVG generation logic.
import type { IssueType, Priority } from '../types';

export interface TypeIconProps {
  type: IssueType;
  color: string;
}

export function TypeIcon({ type, color }: TypeIconProps) {
  switch (type) {
    case 'task':
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
          <rect x="3" y="3" width="18" height="18" rx="5" stroke={color} strokeWidth="2.2" />
          <path d="M7.5 12.3L10.3 15L16.5 8.2" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'bug':
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round">
          <ellipse cx="12" cy="14" rx="5" ry="6.5" />
          <circle cx="12" cy="6" r="2.6" />
          <path d="M7 11H4" />
          <path d="M7 16H4" />
          <path d="M17 11H20" />
          <path d="M17 16H20" />
        </svg>
      );
    case 'feature':
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3.5A6 6 0 0 0 8.5 14.3C9.3 15 9.8 15.8 9.8 16.8V17.5H14.2V16.8C14.2 15.8 14.7 15 15.5 14.3A6 6 0 0 0 12 3.5Z" />
          <path d="M10 20.5H14" />
        </svg>
      );
    case 'chore':
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round">
          <rect x="4" y="6" width="4" height="4" rx="1" />
          <path d="M10.5 8H20" />
          <rect x="4" y="14" width="4" height="4" rx="1" />
          <path d="M10.5 16H20" />
        </svg>
      );
    default:
      return null;
  }
}

export const PRIORITY_BAR_COLORS: Record<Priority, string> = {
  low:      '#9BB3A4',
  medium:   'var(--color-yellow)',
  high:     'var(--color-orange)',
  critical: 'var(--color-danger)',
};

export const PRIORITY_BAR_COUNT: Record<Priority, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export interface PriorityBarsProps {
  priority: Priority;
}

export function PriorityBars({ priority }: PriorityBarsProps) {
  const litCount = PRIORITY_BAR_COUNT[priority];
  const litColor = PRIORITY_BAR_COLORS[priority];
  const greyColor = 'var(--color-border)';
  const bars = [
    { x: 0, y: 10, height: 4 },
    { x: 4.2, y: 7, height: 7 },
    { x: 8.4, y: 4, height: 10 },
    { x: 12.6, y: 1, height: 13 },
  ];
  return (
    <svg width="15" height="14" viewBox="0 0 15 14" fill="none" aria-label={`Priority: ${priority}`}>
      {bars.map((bar, i) => (
        <rect
          key={i}
          x={bar.x}
          y={bar.y}
          width="2.6"
          height={bar.height}
          rx="1"
          fill={i < litCount ? litColor : greyColor}
        />
      ))}
    </svg>
  );
}

export function CalendarIcon({ overdue }: { overdue: boolean }) {
  const color = overdue ? 'var(--color-danger)' : 'var(--color-text-secondary)';
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="5.5" width="17" height="15" rx="2.5" />
      <path d="M3.5 10H20.5" />
      <path d="M8 3V6.5" />
      <path d="M16 3V6.5" />
    </svg>
  );
}
