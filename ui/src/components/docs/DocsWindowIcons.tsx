/** The two icons of the Docs window feature, 14 px line icons in the app's stroke style. */
export function PopOutIcon({ size = 14 }: { size?: number }) {
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
      aria-hidden="true"
    >
      <rect x="3" y="7" width="14" height="14" rx="2" />
      <path d="M14 3h7v7" />
      <path d="M21 3l-9 9" />
    </svg>
  );
}

export function DockIcon({ size = 14 }: { size?: number }) {
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
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
      <path d="M15 13l-4 4" />
      <path d="M11 13v4h4" />
    </svg>
  );
}
