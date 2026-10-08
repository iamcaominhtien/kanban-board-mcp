import React from 'react';

interface IconProps extends React.SVGProps<SVGSVGElement> {
  size?: number;
}

export function TestCasesTabIcon({ size = 18, className, style, ...props }: IconProps) {
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
      aria-label="Test Cases"
      {...props}
    >
      <path d="M9 11L12 14L22 4" />
      <path d="M21 12V19A2 2 0 0 1 19 21H5A2 2 0 0 1 3 19V5A2 2 0 0 1 5 3H16" />
    </svg>
  );
}

export function PassIcon({ size = 14, className, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      className={className}
      style={{ flexShrink: 0, ...style }}
      aria-label="Pass"
      {...props}
    >
      <circle cx="7" cy="7" r="6" stroke="#2E6F40" strokeWidth="1.6" />
      <path d="M4.3 7.2L6.1 9L9.8 5" stroke="#2E6F40" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function FailIcon({ size = 14, className, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      className={className}
      style={{ flexShrink: 0, ...style }}
      aria-label="Fail"
      {...props}
    >
      <circle cx="7" cy="7" r="6" stroke="#C4432A" strokeWidth="1.6" />
      <path d="M5 5L9 9M9 5L5 9" stroke="#C4432A" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function RunningIcon({
  size = 15,
  className,
  style,
}: {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className={className}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        flexShrink: 0,
        ...style,
      }}
      aria-label="Running — live"
    >
      <span
        style={{
          position: 'absolute',
          width: size,
          height: size,
          borderRadius: '50%',
          border: '1.5px solid rgba(47,111,176,0.55)',
          animation: 'ic-ring 1.4s ease-out infinite',
          boxSizing: 'border-box',
        }}
      />
      <svg width={size} height={size} viewBox="0 0 15 15">
        <circle cx="7.5" cy="7.5" r="5" fill="#2F6FB0" />
      </svg>
    </span>
  );
}

export function PendingIcon({ size = 15, className, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 15 15"
      className={className}
      style={{ flexShrink: 0, ...style }}
      aria-label="Pending"
      {...props}
    >
      <circle cx="7.5" cy="7.5" r="6" fill="none" stroke="#9AA8A0" strokeWidth="1.6" />
    </svg>
  );
}

export type TestCaseStatus = 'pass' | 'fail' | 'running' | 'pending';

export function TestCaseStatusMark({ status, size = 14 }: { status: TestCaseStatus | string; size?: number }) {
  switch (status) {
    case 'pass':
      return <PassIcon size={size} />;
    case 'fail':
      return <FailIcon size={size} />;
    case 'running':
      return <RunningIcon size={size} />;
    case 'pending':
    default:
      return <PendingIcon size={size} />;
  }
}
