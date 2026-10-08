import React from 'react';

interface IconProps extends React.SVGProps<SVGSVGElement> {
  size?: number;
}

/** Due-date icon. */
export function DueDateIcon({ size = 14, className, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#5B6B60"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flexShrink: 0, ...style }}
      aria-label="Due date"
      {...props}
    >
      <rect x="3.5" y="5.5" width="17" height="15" rx="2.5" />
      <path d="M3.5 10H20.5" />
      <path d="M8 3V6.5" />
      <path d="M16 3V6.5" />
    </svg>
  );
}

/** Overdue icon. */
export function OverdueIcon({ size = 14, className, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#C4432A"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flexShrink: 0, ...style }}
      aria-label="Overdue"
      {...props}
    >
      <rect x="3.5" y="5.5" width="17" height="15" rx="2.5" />
      <path d="M3.5 10H20.5" />
      <path d="M8 3V6.5" />
      <path d="M16 3V6.5" />
    </svg>
  );
}

/** Blocked icon. */
export function BlockedIcon({ size = 14, className, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      style={{ flexShrink: 0, ...style }}
      aria-label="Blocked"
      {...props}
    >
      <rect x="5" y="11" width="14" height="10" rx="2" stroke="#C4432A" strokeWidth="1.5" />
      <path d="M8 11V8A4 4 0 0 1 16 8V11" stroke="#C4432A" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Drag-handle grip icon. */
export function DragHandleIcon({
  size = 14,
  fill = '#9AA8A0',
  className,
  style,
  ...props
}: IconProps & { fill?: string }) {
  // Ratio 10:16
  const height = size;
  const width = Math.round((size * 10) / 16);

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 10 16"
      fill={fill}
      className={className}
      style={{ flexShrink: 0, cursor: 'grab', ...style }}
      aria-hidden="true"
      {...props}
    >
      <circle cx="2" cy="2" r="1.3" />
      <circle cx="8" cy="2" r="1.3" />
      <circle cx="2" cy="8" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="2" cy="14" r="1.3" />
      <circle cx="8" cy="14" r="1.3" />
    </svg>
  );
}
