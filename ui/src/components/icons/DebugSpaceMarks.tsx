import React from 'react';

interface IconProps extends React.SVGProps<SVGSVGElement> {
  size?: number;
}

export function DebugSpaceTabIcon({ size = 18, className, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flexShrink: 0, ...style }}
      aria-label="Debug Space"
      {...props}
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9L10 12L7 15" />
      <path d="M12 15H17" />
    </svg>
  );
}

export type DebugKind = 'investigation' | 'fix_attempt' | 'root_cause' | 'blocked' | 'resolved';

const DEBUG_KIND_COLORS: Record<DebugKind, string> = {
  investigation: '#2F6FB0',
  fix_attempt:   '#E2793D',
  root_cause:    '#6D5DD3',
  blocked:       '#C4432A',
  resolved:      '#2E6F40',
};

export function DebugEntryDot({
  kind,
  size = 13,
  className,
  style,
}: {
  kind: DebugKind | string;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const color = DEBUG_KIND_COLORS[kind as DebugKind] ?? '#5B6B60';

  return (
    <span
      className={className}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        backgroundColor: color,
        flexShrink: 0,
        ...style,
      }}
      aria-label={kind}
    />
  );
}
