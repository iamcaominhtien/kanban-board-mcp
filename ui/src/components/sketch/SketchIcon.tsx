const PATHS: Record<string, string> = {
  select: '<rect x="4" y="4" width="16" height="16" rx="1.5" stroke-dasharray="3 3"/>',
  pencil: '<path d="M16.5 3.5A2.1 2.1 0 0 1 19.5 6.5L7 19L3 20L4 16Z"/><path d="M14 6L18 10"/>',
  brush:
    '<path d="M18.5 3.5C14 6 10.5 10 9.5 13.5L11.5 15.5C15 14.5 19 11 20.5 5.5Z"/><path d="M9.5 13.5C7 13.5 5.5 15 5.5 17.5C5.5 19 4.5 20 3.5 20.5C7 21.5 11.5 20.5 11.5 15.5"/>',
  eraser:
    '<path d="M8 20H20"/><path d="M4.5 14L13 5.5A2 2 0 0 1 16 5.5L19 8.5A2 2 0 0 1 19 11.5L10.5 20H7L4.5 17A2 2 0 0 1 4.5 14Z"/><path d="M8.5 10L15 16.5"/>',
  fill: '<path d="M4 12L11 5L18 12L11 19Z"/><path d="M11 5L8.5 2.5"/><path d="M20 15C20 15 22 17.4 22 18.8A2 2 0 0 1 18 18.8C18 17.4 20 15 20 15Z"/>',
  picker:
    '<path d="M14 6L18 10"/><path d="M18.5 3.5A2.1 2.1 0 0 1 20.5 5.5L16 10L14 8L18.5 3.5Z"/><path d="M14 8L5 17L4 20L7 19L16 10"/>',
  line: '<path d="M5 19L19 5"/>',
  shape: '<rect x="4" y="5" width="16" height="14" rx="1.5"/>',
  rect: '<rect x="4" y="5" width="16" height="14" rx="1.5"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>',
  arrow: '<path d="M5 19L19 5"/><path d="M10 5H19V14"/>',
  text: '<path d="M5 6V4H19V6"/><path d="M12 4V20"/><path d="M9 20H15"/>',
  crop: '<path d="M4 9V4H9"/><path d="M20 9V4H15"/><path d="M4 15V20H9"/><path d="M20 15V20H15"/>',
  undo: '<path d="M9 7L4 12L9 17"/><path d="M4 12H15A5 5 0 0 1 15 22H11"/>',
  redo: '<path d="M15 7L20 12L15 17"/><path d="M20 12H9A5 5 0 0 0 9 22H13"/>',
  zoomIn: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16L21 21"/><path d="M8.5 11H13.5"/><path d="M11 8.5V13.5"/>',
  zoomOut: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16L21 21"/><path d="M8.5 11H13.5"/>',
  fit: '<path d="M4 9V4H9"/><path d="M20 9V4H15"/><path d="M4 15V20H9"/><path d="M20 15V20H15"/>',
  eye: '<path d="M2 12C4.5 7.5 8 5.5 12 5.5S19.5 7.5 22 12C19.5 16.5 16 18.5 12 18.5S4.5 16.5 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff:
    '<path d="M3 3L21 21"/><path d="M10.6 5.6A10 10 0 0 1 12 5.5C16 5.5 19.5 7.5 22 12A15 15 0 0 1 19 15.7"/><path d="M6.3 7A15 15 0 0 0 2 12C4.5 16.5 8 18.5 12 18.5A10 10 0 0 0 15 18"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8A4 4 0 0 1 16 8V11"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8A4 4 0 0 1 15 6"/>',
  plus: '<path d="M12 5V19"/><path d="M5 12H19"/>',
  up: '<path d="M6 14L12 8L18 14"/>',
  down: '<path d="M6 10L12 16L18 10"/>',
  merge:
    '<path d="M6 4V10A6 6 0 0 0 12 16A6 6 0 0 0 18 10V4"/><path d="M12 16V21"/><path d="M9 18.5L12 21.5L15 18.5"/>',
  trash:
    '<path d="M4 7H20"/><path d="M9 7V4H15V7"/><path d="M6 7L7 20H17L18 7"/><path d="M10 11V16"/><path d="M14 11V16"/>',
  check: '<path d="M5 12.5L10 17.5L19 7.5"/>',
  close: '<path d="M6 6L18 18"/><path d="M18 6L6 18"/>',
  warning: '<path d="M12 4L22 20H2Z"/><path d="M12 10V14"/><path d="M12 17V17.2"/>',
  refresh:
    '<path d="M20 11A8 8 0 0 0 5.5 7"/><path d="M5 3V7.5H9.5"/><path d="M4 13A8 8 0 0 0 18.5 17"/><path d="M19 21V16.5H14.5"/>',
  users:
    '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20C2.5 16 5.5 14 9 14S15.5 16 15.5 20"/><path d="M16 4.7A3.5 3.5 0 0 1 16 11.3"/><path d="M18 14.3C20.5 15 21.5 17 21.5 20"/>',
  palette:
    '<path d="M12 3A9 9 0 0 0 3 12A9 9 0 0 0 12 21C13.5 21 14 20 13.5 19C13 18 13.5 17 14.5 17H17A4 4 0 0 0 21 13C21 7.5 17 3 12 3Z"/><circle cx="7.5" cy="12" r="1"/><circle cx="10" cy="7.5" r="1"/><circle cx="15" cy="7.5" r="1"/>',
  layers: '<path d="M12 3L22 8.5L12 14L2 8.5Z"/><path d="M2 13L12 18.5L22 13"/>',
  sketch:
    '<path d="M18.5 3.5C14 6 10.5 10 9.5 13.5L11.5 15.5C15 14.5 19 11 20.5 5.5Z"/><path d="M9.5 13.5C7 13.5 5.5 15 5.5 17.5C5.5 19 4.5 20 3.5 20.5C7 21.5 11.5 20.5 11.5 15.5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5A1.5 1.5 0 0 1 6.5 3.5H15"/>',
  edit: '<path d="M12 20H21"/><path d="M16.5 3.5A2.1 2.1 0 0 1 19.5 6.5L7 19L3 20L4 16Z"/>',
  download: '<path d="M12 4V15"/><path d="M7 10.5L12 15.5L17 10.5"/><path d="M5 20H19"/>',
  expand: '<path d="M4 9V4H9"/><path d="M20 9V4H15"/><path d="M4 15V20H9"/><path d="M20 15V20H15"/>',
  spark:
    '<path d="M12 3L13.8 9.2L20 11L13.8 12.8L12 19L10.2 12.8L4 11L10.2 9.2Z"/><path d="M19 3.5V6.5"/><path d="M17.5 5H20.5"/>',
  clip: '<path d="M20 11.5L12 19.5A5 5 0 0 1 5 12.5L13 4.5A3.3 3.3 0 0 1 17.7 9.2L9.7 17.2A1.7 1.7 0 0 1 7.3 14.8L14.8 7.3"/>',
  send: '<path d="M4 12L20 4L14 20L11 13Z"/>',
  bold: '<path d="M7 4H13A4 4 0 0 1 13 12H7Z"/><path d="M7 12H14A4 4 0 0 1 14 20H7Z"/>',
};

/**
 * Small stroke icon for the sketch editor.
 * @param props.name - Icon name.
 * @param props.size - Pixel size.
 */
export function SketchIcon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
      dangerouslySetInnerHTML={{ __html: PATHS[name] ?? '' }}
    />
  );
}
