import { MAX_LAYERS, MAX_SIDE } from './limits.ts';
import type { LayerKind } from './layers.ts';

/** A piece of text on a layer. It stays editable until the layer is merged or the drawing is flattened. */
export interface SourceText {
  id: string;
  x: number;
  y: number;
  text: string;
  size: number;
  color: string;
  bold?: boolean;
}

/** One layer of the editable source. `png` is a `data:image/png;base64,` address, or null for an empty layer. */
export interface SourceLayer {
  id: string;
  name: string;
  kind: LayerKind;
  visible: boolean;
  opacity: number;
  locked: boolean;
  png: string | null;
  texts: SourceText[];
}

/**
 * The editable source of a sketch: the file the editor opens again. Layers run bottom to top.
 * Written to `<id>.sketch.json` next to the PNG (see docs/specs/sketch-tool.md).
 */
export interface SketchSource {
  format: 'kanban-sketch';
  version: 1;
  width: number;
  height: number;
  background: 'white' | 'clear';
  layers: SourceLayer[];
  activeLayer?: string;
  /** The colours picked last, newest first. */
  recent?: string[];
}

/** Thrown for a source that cannot be opened; the message is fit to show. */
export class SourceError extends Error {
  /** @param message - What is wrong with the file. */
  constructor(message: string) {
    super(message);
    this.name = 'SourceError';
  }
}

/**
 * Write a source as the JSON text that is stored.
 * @param src - The source.
 */
export function serializeSource(src: SketchSource): string {
  return JSON.stringify(src);
}

/**
 * Size of a text in bytes as it is stored (UTF-8).
 * @param text - The text.
 */
export function byteLength(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4; // a surrogate pair is one 4-byte character
      i++;
    } else n += 3;
  }
  return n;
}

const PNG_URL = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
const COLOUR = /^#[0-9a-fA-F]{6}$/;

function num(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
}

function str(v: unknown, fallback: string, max = 200): string {
  return typeof v === 'string' ? v.slice(0, max) : fallback;
}

function parseText(raw: unknown, i: number): SourceText | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.text !== 'string') return null;
  return {
    id: str(t.id, `t${i + 1}`, 40),
    x: num(t.x, 0, -MAX_SIDE, MAX_SIDE * 2),
    y: num(t.y, 0, -MAX_SIDE, MAX_SIDE * 2),
    text: t.text.slice(0, 5000),
    size: num(t.size, 24, 4, 512),
    color: typeof t.color === 'string' && COLOUR.test(t.color) ? t.color : '#000000',
    bold: t.bold === true ? true : undefined,
  };
}

/**
 * Read and check a source. Unknown fields are dropped, numbers are put in range, and anything that
 * would not open (wrong format, too many layers, a picture that is not a PNG) is refused.
 * @param text - The JSON text of a `.sketch.json` file.
 * @returns The source, cleaned.
 * @throws SourceError When the file is not a sketch source this version can open.
 */
export function parseSource(text: string): SketchSource {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SourceError('This is not a sketch file (it is not valid JSON).');
  }
  const d = raw as Record<string, unknown> | null;
  if (!d || typeof d !== 'object' || d.format !== 'kanban-sketch' || !Array.isArray(d.layers)) {
    throw new SourceError('This is not a sketch file.');
  }
  if (d.version !== 1) {
    throw new SourceError(`This sketch was saved by a newer version of the board (file version ${String(d.version)}).`);
  }
  const width = d.width;
  const height = d.height;
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_SIDE ||
    height > MAX_SIDE
  ) {
    throw new SourceError(`The canvas size is not valid (1 to ${MAX_SIDE} px).`);
  }
  if (d.layers.length < 1 || d.layers.length > MAX_LAYERS) {
    throw new SourceError(`A drawing has 1 to ${MAX_LAYERS} layers (this one has ${d.layers.length}).`);
  }
  const seen = new Set<string>();
  const layers: SourceLayer[] = d.layers.map((l: unknown, i: number) => {
    const o = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
    let id = str(o.id, `l${i + 1}`, 40);
    if (seen.has(id)) id = `l${i + 1}-${seen.size}`;
    seen.add(id);
    if (o.png != null && (typeof o.png !== 'string' || !PNG_URL.test(o.png))) {
      throw new SourceError(`Layer ${i + 1} holds a picture that is not a PNG.`);
    }
    const kind: LayerKind = o.kind === 'paper' || o.kind === 'picture' ? o.kind : 'layer';
    return {
      id,
      name: str(o.name, `Layer ${i + 1}`, 60),
      kind,
      visible: o.visible !== false,
      opacity: num(o.opacity, 1, 0, 1),
      locked: o.locked === true,
      png: (o.png as string | null | undefined) ?? null,
      texts: Array.isArray(o.texts) ? o.texts.map(parseText).filter((t): t is SourceText => t !== null) : [],
    };
  });
  const active = typeof d.activeLayer === 'string' && seen.has(d.activeLayer) ? d.activeLayer : undefined;
  return {
    format: 'kanban-sketch',
    version: 1,
    width,
    height,
    background: d.background === 'clear' ? 'clear' : 'white',
    layers,
    activeLayer: active,
    recent: Array.isArray(d.recent)
      ? d.recent.filter((c): c is string => typeof c === 'string' && COLOUR.test(c)).slice(0, 12)
      : undefined,
  };
}
