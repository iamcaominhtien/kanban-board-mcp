import { MAX_LAYERS } from './limits.ts';

/** What a layer is for: the white page, a picture to draw on, or a layer of marks. */
export type LayerKind = 'paper' | 'picture' | 'layer';

/** A layer without its pixels; the order of a list is bottom to top. */
export interface LayerInfo {
  id: string;
  name: string;
  kind: LayerKind;
  visible: boolean;
  /** 0 to 1. */
  opacity: number;
  locked: boolean;
}

/** Thrown when a change would give a drawing more than 10 layers. */
export class LayerLimitError extends Error {
  /** The message says what to do about it. */
  constructor() {
    super(`A drawing can have ${MAX_LAYERS} layers. Merge or delete a layer first.`);
    this.name = 'LayerLimitError';
  }
}

/**
 * Whether one more layer fits.
 * @param count - Layers now.
 */
export function canAddLayer(count: number): boolean {
  return count < MAX_LAYERS;
}

/**
 * A name for a new layer that no other layer has: "Layer 2", "Layer 3"...
 * @param layers - The layers now.
 */
export function nextLayerName(layers: readonly { name: string }[]): string {
  const taken = new Set(layers.map((l) => l.name));
  for (let n = layers.length + 1; ; n++) {
    const name = `Layer ${n}`;
    if (!taken.has(name)) return name;
  }
}

/**
 * A layer id that is not used yet.
 * @param layers - The layers now.
 */
export function nextLayerId(layers: readonly { id: string }[]): string {
  const taken = new Set(layers.map((l) => l.id));
  for (let n = layers.length + 1; ; n++) {
    if (!taken.has(`l${n}`)) return `l${n}`;
  }
}

/**
 * Add a layer above another (above the top one when none is given).
 * @param layers - The layers now, bottom to top.
 * @param layer - The new layer.
 * @param aboveId - Id of the layer to put it above.
 * @returns The new list; the input is not changed.
 * @throws LayerLimitError When the drawing already has 10 layers.
 */
export function insertLayer<T extends { id: string }>(layers: readonly T[], layer: T, aboveId?: string): T[] {
  if (!canAddLayer(layers.length)) throw new LayerLimitError();
  const at = aboveId ? layers.findIndex((l) => l.id === aboveId) + 1 : layers.length;
  const next = layers.slice();
  next.splice(at <= 0 ? layers.length : at, 0, layer);
  return next;
}

/**
 * Move a layer one place up (towards the top) or down.
 * @param layers - The layers now, bottom to top.
 * @param id - The layer to move.
 * @param dir - 1 for up, -1 for down.
 * @returns The new list, or the same list when the layer is already at that end.
 */
export function moveLayer<T extends { id: string }>(layers: readonly T[], id: string, dir: 1 | -1): readonly T[] {
  const from = layers.findIndex((l) => l.id === id);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= layers.length) return layers;
  const next = layers.slice();
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/**
 * The layer to select after one is deleted: the one below it, else the one now at its place.
 * @param layers - The layers before the delete, bottom to top.
 * @param id - The layer being deleted.
 */
export function layerAfterDelete(layers: readonly { id: string }[], id: string): string | null {
  const i = layers.findIndex((l) => l.id === id);
  const rest = layers.filter((l) => l.id !== id);
  if (!rest.length) return null;
  return rest[Math.max(0, Math.min(i - 1, rest.length - 1))].id;
}
