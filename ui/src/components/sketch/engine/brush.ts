/** A pointer sample on the drawing: position and pen pressure (0 to 1, 0.5 when the device has none). */
export interface Sample {
  x: number;
  y: number;
  p: number;
}

/**
 * Distance between two stamps of a brush: a fraction of its size, so a soft line is smooth and a thin one is not wasteful.
 * @param size - Brush size in px.
 */
export function stampSpacing(size: number): number {
  return Math.max(0.75, size * 0.12);
}

/**
 * The stamps to lay along a segment, so the stroke is even however fast the pointer moved.
 * @param a - Segment start (with its pressure).
 * @param b - Segment end.
 * @param spacing - Distance between stamps.
 * @param carry - Distance already walked since the last stamp, from the previous segment.
 * @returns The stamps, and the carry for the next segment.
 */
export function stampsAlong(a: Sample, b: Sample, spacing: number, carry: number): { stamps: Sample[]; carry: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  const stamps: Sample[] = [];
  if (dist === 0) return { stamps, carry };
  let at = spacing - carry;
  while (at <= dist) {
    const t = at / dist;
    stamps.push({ x: a.x + dx * t, y: a.y + dy * t, p: a.p + (b.p - a.p) * t });
    at += spacing;
  }
  return { stamps, carry: dist - (at - spacing) };
}

/**
 * Pull a pointer position part of the way towards the new one: a smoother line, with more lag the higher the setting.
 * @param prev - The smoothed point so far.
 * @param next - The raw pointer position.
 * @param smoothing - 0 (follow the pointer exactly) to 100 (very smooth).
 */
export function smoothStep(prev: Sample, next: Sample, smoothing: number): Sample {
  const k = 1 - Math.min(0.92, (smoothing / 100) * 0.92);
  return { x: prev.x + (next.x - prev.x) * k, y: prev.y + (next.y - prev.y) * k, p: next.p };
}

/** What pen pressure changes. */
export type PressureTarget = 'size' | 'opacity';

/**
 * Size and flow of one stamp for a pressure.
 * @param size - Brush size in px.
 * @param p - Pressure, 0 to 1.
 * @param on - Whether pressure counts at all (off for a mouse by default).
 * @param target - What pressure changes.
 * @returns The size to stamp at and the share (0 to 1) of full strength.
 */
export function pressureStamp(
  size: number,
  p: number,
  on: boolean,
  target: PressureTarget,
): { size: number; flow: number } {
  if (!on) return { size, flow: 1 };
  const k = Math.max(0.05, Math.min(1, p));
  return target === 'size' ? { size: Math.max(1, size * (0.15 + 0.85 * k)), flow: 1 } : { size, flow: 0.1 + 0.9 * k };
}

/**
 * The pressure to use for a pointer event: a pen reports one; a mouse reports 0.5 while pressed.
 * @param pointerType - `mouse`, `pen` or `touch`.
 * @param pressure - The event's pressure.
 */
export function eventPressure(pointerType: string, pressure: number): number {
  if (pointerType === 'pen' && pressure > 0) return pressure;
  return 0.5;
}
