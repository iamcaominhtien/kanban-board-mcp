import React from 'react';
import type { IssueType } from '../../types';

interface IconProps extends React.SVGProps<SVGSVGElement> {
  size?: number | 'sm' | 'full';
  simplified?: boolean;
}

export function TaskIcon({ size = 'sm', className, style, ...props }: IconProps) {
  const isSm = size === 'sm' || size === 15;
  const dimension = typeof size === 'number' ? size : isSm ? 15 : 24;
  const strokeW = isSm ? 2.2 : 1.7;

  return (
    <svg
      width={dimension}
      height={dimension}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      style={{ flexShrink: 0, ...style }}
      aria-label="Task"
      {...props}
    >
      <rect x="3" y="3" width="18" height="18" rx="5" stroke="#2F6FB0" strokeWidth={strokeW} />
      <path
        d="M7.5 12.3L10.3 15L16.5 8.2"
        stroke="#2F6FB0"
        strokeWidth={strokeW}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BugIcon({ size = 'sm', simplified, className, style, ...props }: IconProps) {
  const isSm = size === 'sm' || size === 15 || simplified;
  const dimension = typeof size === 'number' ? size : isSm ? 15 : 24;

  if (isSm) {
    return (
      <svg
        width={dimension}
        height={dimension}
        viewBox="0 0 24 24"
        fill="none"
        stroke="#C4432A"
        strokeWidth="2.2"
        strokeLinecap="round"
        className={className}
        style={{ flexShrink: 0, ...style }}
        aria-label="Bug"
        {...props}
      >
        <ellipse cx="12" cy="14" rx="5" ry="6.5" />
        <circle cx="12" cy="6" r="2.6" />
        <path d="M7 11H4" />
        <path d="M7 16H4" />
        <path d="M17 11H20" />
        <path d="M17 16H20" />
      </svg>
    );
  }

  return (
    <svg
      width={dimension}
      height={dimension}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#C4432A"
      strokeWidth="1.5"
      strokeLinecap="round"
      className={className}
      style={{ flexShrink: 0, ...style }}
      aria-label="Bug"
      {...props}
    >
      <ellipse cx="12" cy="14" rx="4.5" ry="6" />
      <circle cx="12" cy="6.5" r="2.2" />
      <path d="M12 4.3L9.5 1.5" />
      <path d="M12 4.3L14.5 1.5" />
      <path d="M7.5 10.5H4.5" />
      <path d="M7.5 14H4" />
      <path d="M7.5 17.5H4.5" />
      <path d="M16.5 10.5H19.5" />
      <path d="M16.5 14H20" />
      <path d="M16.5 17.5H19.5" />
    </svg>
  );
}

export function FeatureIcon({ size = 'sm', className, style, ...props }: IconProps) {
  const isSm = size === 'sm' || size === 15;
  const dimension = typeof size === 'number' ? size : isSm ? 15 : 24;

  if (isSm) {
    return (
      <svg
        width={dimension}
        height={dimension}
        viewBox="0 0 24 24"
        fill="none"
        stroke="#6D5DD3"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        style={{ flexShrink: 0, ...style }}
        aria-label="Feature"
        {...props}
      >
        <path d="M12 3.5A6 6 0 0 0 8.5 14.3C9.3 15 9.8 15.8 9.8 16.8V17.5H14.2V16.8C14.2 15.8 14.7 15 15.5 14.3A6 6 0 0 0 12 3.5Z" />
        <path d="M10 20.5H14" />
      </svg>
    );
  }

  return (
    <svg
      width={dimension}
      height={dimension}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#6D5DD3"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flexShrink: 0, ...style }}
      aria-label="Feature"
      {...props}
    >
      <path d="M12 3.5A6 6 0 0 0 8.5 14.3C9.3 15 9.8 15.8 9.8 16.8V17.5H14.2V16.8C14.2 15.8 14.7 15 15.5 14.3A6 6 0 0 0 12 3.5Z" />
      <path d="M10 20.5H14" />
      <path d="M10.5 17.5H13.5" />
    </svg>
  );
}

export function ChoreIcon({ size = 'sm', simplified, className, style, ...props }: IconProps) {
  const isSm = size === 'sm' || size === 15 || simplified;
  const dimension = typeof size === 'number' ? size : isSm ? 15 : 24;

  if (isSm) {
    return (
      <svg
        width={dimension}
        height={dimension}
        viewBox="0 0 24 24"
        fill="none"
        stroke="#5B6B60"
        strokeWidth="2"
        strokeLinecap="round"
        className={className}
        style={{ flexShrink: 0, ...style }}
        aria-label="Chore"
        {...props}
      >
        <rect x="4" y="6" width="4" height="4" rx="1" />
        <path d="M10.5 8H20" />
        <rect x="4" y="14" width="4" height="4" rx="1" />
        <path d="M10.5 16H20" />
      </svg>
    );
  }

  return (
    <svg
      width={dimension}
      height={dimension}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#5B6B60"
      strokeWidth="1.5"
      strokeLinecap="round"
      className={className}
      style={{ flexShrink: 0, ...style }}
      aria-label="Chore"
      {...props}
    >
      <rect x="4" y="4.5" width="4" height="4" rx="1" />
      <path d="M10.5 6.5H20" />
      <rect x="4" y="10" width="4" height="4" rx="1" />
      <path d="M10.5 12H20" />
      <rect x="4" y="15.5" width="4" height="4" rx="1" />
      <path d="M10.5 17.5H20" />
      <path d="M4.8 12L5.7 12.9L7.2 11.2" strokeWidth="1.3" />
    </svg>
  );
}

export function TicketTypeIcon({
  type,
  size = 'sm',
  ...props
}: { type: IssueType } & IconProps) {
  switch (type) {
    case 'bug':
      return <BugIcon size={size} {...props} />;
    case 'feature':
      return <FeatureIcon size={size} {...props} />;
    case 'task':
      return <TaskIcon size={size} {...props} />;
    case 'chore':
      return <ChoreIcon size={size} {...props} />;
    default:
      return <TaskIcon size={size} {...props} />;
  }
}
