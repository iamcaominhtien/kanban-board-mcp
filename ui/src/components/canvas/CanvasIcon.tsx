const PATHS: Record<string, string> = {
  canvas: '<path d="M12 3L22 8.5L12 14L2 8.5Z"/><path d="M2 13L12 18.5L22 13"/>',
  layers: '<path d="M12 3L22 8.5L12 14L2 8.5Z"/><path d="M2 13L12 18.5L22 13"/>',
  select: '<path d="M5 3L19 11.5L12 13L9 20Z"/>',
  hand: '<path d="M8 12V6.5A1.5 1.5 0 0 1 11 6.5V11"/><path d="M11 11V4.5A1.5 1.5 0 0 1 14 4.5V11"/><path d="M14 11V6A1.5 1.5 0 0 1 17 6V13"/><path d="M8 12L6.2 10.2A1.5 1.5 0 0 0 4 12.3L8 19H17A3 3 0 0 0 20 16V10.5A1.5 1.5 0 0 0 17 10.5"/>',
  board: '<rect x="4" y="4" width="16" height="16" rx="1" stroke-dasharray="3 3"/>',
  frame: '<rect x="4" y="5" width="16" height="14" rx="1.5"/><path d="M4 9H20"/>',
  note: '<path d="M5 4H19V15L14 20H5Z"/><path d="M14 20V15H19"/>',
  arrow: '<path d="M5 19L19 5"/><path d="M10 5H19V14"/>',
  text: '<path d="M5 6V4H19V6"/><path d="M12 4V20"/><path d="M9 20H15"/>',
  comment: '<path d="M4 5H20V16H11L6.5 20V16H4Z"/>',
  zoomIn: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16L21 21"/><path d="M8.5 11H13.5"/><path d="M11 8.5V13.5"/>',
  zoomOut: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16L21 21"/><path d="M8.5 11H13.5"/>',
  fit: '<path d="M4 9V4H9"/><path d="M20 9V4H15"/><path d="M4 15V20H9"/><path d="M20 15V20H15"/>',
  map: '<path d="M3 6L9 4L15 6L21 4V18L15 20L9 18L3 20Z"/><path d="M9 4V18"/><path d="M15 6V20"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
  eye: '<path d="M2 12C4.5 7.5 8 5.5 12 5.5S19.5 7.5 22 12C19.5 16.5 16 18.5 12 18.5S4.5 16.5 2 12Z"/><circle cx="12" cy="12" r="2.8"/>',
  edit: '<path d="M16.5 3.5A2.1 2.1 0 0 1 19.5 6.5L7 19L3 20L4 16Z"/><path d="M14 6L18 10"/>',
  spark:
    '<path d="M12 3L13.8 9.2L20 11L13.8 12.8L12 19L10.2 12.8L4 11L10.2 9.2Z"/><path d="M19 3.5V6.5"/><path d="M17.5 5H20.5"/>',
  history: '<path d="M4 12A8 8 0 1 0 7 5.8"/><path d="M4 4V8.5H8.5"/><path d="M12 8V12L15 14"/>',
  present:
    '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M12 16V20"/><path d="M8 20H16"/><path d="M10.5 7.5L14.5 10L10.5 12.5Z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5A1.5 1.5 0 0 1 6.5 3.5H15"/>',
  download: '<path d="M12 4V15"/><path d="M7 10.5L12 15.5L17 10.5"/><path d="M5 20H19"/>',
  link: '<path d="M10 14A4 4 0 0 0 15.7 14L19 10.7A4 4 0 0 0 13.3 5L12 6.3"/><path d="M14 10A4 4 0 0 0 8.3 10L5 13.3A4 4 0 0 0 10.7 19L12 17.7"/>',
  expand: '<path d="M4 9V4H9"/><path d="M20 9V4H15"/><path d="M4 15V20H9"/><path d="M20 15V20H15"/>',
  close: '<path d="M6 6L18 18"/><path d="M18 6L6 18"/>',
  plus: '<path d="M12 5V19"/><path d="M5 12H19"/>',
  trash:
    '<path d="M4 7H20"/><path d="M9 7V4H15V7"/><path d="M6 7L7 20H17L18 7"/><path d="M10 11V16"/><path d="M14 11V16"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8A4 4 0 0 1 16 8V11"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  check: '<path d="M5 12.5L10 17.5L19 7.5"/>',
  warning: '<path d="M12 4L22 20H2Z"/><path d="M12 10V14"/><path d="M12 17V17.2"/>',
  refresh:
    '<path d="M20 11A8 8 0 0 0 5.5 7"/><path d="M5 3V7.5H9.5"/><path d="M4 13A8 8 0 0 0 18.5 17"/><path d="M19 21V16.5H14.5"/>',
  left: '<path d="M15 6L9 12L15 18"/>',
  right: '<path d="M9 6L15 12L9 18"/>',
  up: '<path d="M6 14L12 8L18 14"/>',
  down: '<path d="M6 10L12 16L18 10"/>',
  image:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M4 18L9.5 13L13 16L16 13L20 17"/>',
  code: '<path d="M8 7L3 12L8 17"/><path d="M16 7L21 12L16 17"/><path d="M14 5L10 19"/>',
  file: '<path d="M6 3H14L19 8V21H6Z"/><path d="M14 3V8H19"/>',
  upload: '<path d="M12 16V5"/><path d="M7 9.5L12 4.5L17 9.5"/><path d="M5 20H19"/>',
  sketch:
    '<path d="M18.5 3.5C14 6 10.5 10 9.5 13.5L11.5 15.5C15 14.5 19 11 20.5 5.5Z"/><path d="M9.5 13.5C7 13.5 5.5 15 5.5 17.5C5.5 19 4.5 20 3.5 20.5C7 21.5 11.5 20.5 11.5 15.5"/>',
  diagram:
    '<rect x="3" y="4" width="7" height="5" rx="1"/><rect x="14" y="15" width="7" height="5" rx="1"/><path d="M10 6.5H14A3 3 0 0 1 17 9.5V15"/>',
  keyboard:
    '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10H6.1M10 10H10.1M14 10H14.1M18 10H18.1M7 14H17"/>',
  focus:
    '<path d="M4 9V4H9"/><path d="M20 9V4H15"/><path d="M4 15V20H9"/><path d="M20 15V20H15"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
  desktop: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20H16"/><path d="M12 16V20"/>',
  tablet: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M11 18H13"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5H13"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M4.5 20C4.5 16 8 14 12 14S19.5 16 19.5 20"/>',
  send: '<path d="M4 12L20 4L14 20L11 13Z"/>',
  mouse: '<path d="M5 3L19 11.5L12 13L9 20Z"/>',
  swap: '<path d="M7 8H20"/><path d="M16 4L20 8L16 12"/><path d="M17 16H4"/><path d="M8 12L4 16L8 20"/>',
};

interface Props {
  name: keyof typeof PATHS | string;
  size?: number;
  className?: string;
}

/**
 * Small stroke icon for the canvas.
 * @param props.name - Icon name.
 * @param props.size - Pixel size (default 16).
 * @param props.className - Optional class.
 */
export function CanvasIcon({ name, size = 16, className }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={{ flexShrink: 0 }}
      dangerouslySetInnerHTML={{ __html: PATHS[name] ?? PATHS.frame }}
    />
  );
}
