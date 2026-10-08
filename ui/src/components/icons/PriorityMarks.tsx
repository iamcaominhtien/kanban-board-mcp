import React from 'react';
import type { Priority } from '../../types';

interface PriorityMarkProps extends React.SVGProps<SVGSVGElement> {
  priority: Priority;
  width?: number;
  height?: number;
}

const PRIORITY_COLORS: Record<Priority, { active: string; count: number; label: string }> = {
  low: { active: '#9BB3A4', count: 1, label: 'Low priority' },
  medium: { active: '#E8B93A', count: 2, label: 'Medium priority' },
  high: { active: '#E2793D', count: 3, label: 'High priority' },
  critical: { active: '#D64545', count: 4, label: 'Critical priority' },
};

const INACTIVE_COLOR = '#DCE6DF';

/** Icon for a ticket priority. */
export function PriorityMark({ priority, width = 16, height = 15, className, style, ...props }: PriorityMarkProps) {
  const cfg = PRIORITY_COLORS[priority] ?? PRIORITY_COLORS.medium;
  const count = cfg.count;
  const activeColor = cfg.active;

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 26 24"
      fill="none"
      className={className}
      style={{ flexShrink: 0, ...style }}
      aria-label={cfg.label}
      role="img"
      {...props}
    >
      {/* Bar 1 */}
      <rect x="0" y="17" width="4.4" height="7" rx="1.5" fill={count >= 1 ? activeColor : INACTIVE_COLOR} />
      {/* Bar 2 */}
      <rect x="7.2" y="12" width="4.4" height="12" rx="1.5" fill={count >= 2 ? activeColor : INACTIVE_COLOR} />
      {/* Bar 3 */}
      <rect x="14.4" y="7" width="4.4" height="17" rx="1.5" fill={count >= 3 ? activeColor : INACTIVE_COLOR} />
      {/* Bar 4 */}
      <rect x="21.6" y="2" width="4.4" height="22" rx="1.5" fill={count >= 4 ? activeColor : INACTIVE_COLOR} />
    </svg>
  );
}
