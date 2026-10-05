import React from 'react';

interface IconProps extends React.SVGProps<SVGSVGElement> {
  size?: number;
}

export function WorkspaceTabIcon({ size = 18, className, style, ...props }: IconProps) {
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
      aria-label="Workspace"
      {...props}
    >
      <path d="M3 7C3 5.9 3.9 5 5 5H9.2L11.2 7.5H19C20.1 7.5 21 8.4 21 9.5V17C21 18.1 20.1 19 19 19H5C3.9 19 3 18.1 3 17V7Z" />
    </svg>
  );
}

export function AutoDeletePendingIcon({ size = 16, className, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#B4571F"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flexShrink: 0, ...style }}
      aria-label="Auto-delete pending"
      {...props}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7V12L15.5 14.5" />
    </svg>
  );
}

export function KeptForeverIcon({ size = 16, className, style, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#2E6F40"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flexShrink: 0, ...style }}
      aria-label="Kept forever"
      {...props}
    >
      <path d="M12 2L14.4 8.6L21.5 9.2L16 13.8L17.8 20.8L12 16.8L6.2 20.8L8 13.8L2.5 9.2L9.6 8.6Z" />
    </svg>
  );
}
