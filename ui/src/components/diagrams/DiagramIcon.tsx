const PATHS: Record<string, string> = {
  edit: '<path d="M12 20H21"/><path d="M16.5 3.5A2.1 2.1 0 0 1 19.5 6.5L7 19L3 20L4 16Z"/>',
  download: '<path d="M12 4V15"/><path d="M7 10.5L12 15.5L17 10.5"/><path d="M5 20H19"/>',
  expand: '<path d="M4 9V4H9"/><path d="M20 9V4H15"/><path d="M4 15V20H9"/><path d="M20 15V20H15"/>',
  link: '<path d="M10 14A4 4 0 0 0 15.7 14L19 10.7A4 4 0 0 0 13.3 5L12 6.3"/><path d="M14 10A4 4 0 0 0 8.3 10L5 13.3A4 4 0 0 0 10.7 19L12 17.7"/>',
  file: '<path d="M6 3H14L19 8V20A1 1 0 0 1 18 21H6A1 1 0 0 1 5 20V4A1 1 0 0 1 6 3Z"/><path d="M14 3V8H19"/>',
  image:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 15L16 10L5 20"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5A1.5 1.5 0 0 1 6.5 3.5H15"/>',
  plus: '<path d="M12 5V19"/><path d="M5 12H19"/>',
  minus: '<path d="M5 12H19"/>',
  check: '<path d="M5 12.5L10 17.5L19 7.5"/>',
  close: '<path d="M6 6L18 18"/><path d="M18 6L6 18"/>',
  upload: '<path d="M12 16V5"/><path d="M7 9L12 4L17 9"/><path d="M4 20H20"/>',
  drawio:
    '<rect x="3" y="3.5" width="7" height="6" rx="1.5"/><rect x="14" y="14.5" width="7" height="6" rx="1.5"/><path d="M10 6.5H14A3 3 0 0 1 17 9.5V14.5"/>',
  fit: '<rect x="4" y="6" width="16" height="12" rx="2"/><path d="M9 12H15"/>',
};

/**
 * Small stroke icon for the diagram controls.
 * @param props.name - Icon name.
 * @param props.size - Pixel size.
 */
export function DiagramIcon({ name, size = 15 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
      dangerouslySetInnerHTML={{ __html: PATHS[name] ?? '' }}
    />
  );
}
