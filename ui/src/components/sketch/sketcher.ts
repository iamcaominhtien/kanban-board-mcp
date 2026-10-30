import {
  stampSpacing,
  stampsAlong,
  smoothStep,
  pressureStamp,
  eventPressure,
  type PressureTarget,
  type Sample,
} from './engine/brush.ts';
import { SWATCHES, hexToRgb, normaliseHex, pushRecent, rgbToHex } from './engine/colour.ts';
import { AI_LAYER_NAME, aiTexts, drawAiShapes, type AiOp } from './engine/aiOps.ts';
import { fitInside } from './engine/chatFiles.ts';
import { floodMask, growMask, maskToPatch } from './engine/floodFill.ts';
import { arrowHead, clampZoom, fitZoom, snapAngle, squareCorner } from './engine/geometry.ts';
import { History } from './engine/history.ts';
import {
  LayerLimitError,
  canAddLayer,
  insertLayer,
  layerAfterDelete,
  moveLayer,
  nextLayerId,
  nextLayerName,
  type LayerInfo,
} from './engine/layers.ts';
import { MAX_LAYERS, MAX_SIDE, clampSide, fitWithin } from './engine/limits.ts';
import {
  clipRect,
  contentBounds,
  growRect,
  rectContains,
  rectFromCorners,
  unionRect,
  type Raster,
  type Rect,
} from './engine/raster.ts';
import type { SketchSource, SourceLayer, SourceText } from './engine/sourceFormat.ts';
import { TileSnapshot, type Surface } from './engine/tiles.ts';

/** The tools, in the order of the tool bar. */
export type ToolId = 'select' | 'pencil' | 'brush' | 'eraser' | 'fill' | 'picker' | 'line' | 'shape' | 'text' | 'crop';

/** Sizes are kept per tool, so switching from the thin pencil to the wide eraser does not change either. */
export type SizedTool = 'pencil' | 'brush' | 'eraser' | 'line' | 'shape' | 'text';

/** Everything the options bar changes. */
export interface ToolOptions {
  sizes: Record<SizedTool, number>;
  softness: number;
  opacity: number;
  pressure: boolean;
  pressureTarget: PressureTarget;
  smoothing: number;
  tolerance: number;
  arrow: boolean;
  shape: 'rect' | 'ellipse';
  filled: boolean;
  bold: boolean;
}

/** A layer with its pixels. */
interface Layer extends LayerInfo {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texts: SourceText[];
  /** True until something is drawn, so an empty layer is saved as `null`. */
  blank: boolean;
  /** Changes whenever the pixels or texts do; keys the cached PNG. */
  rev: number;
  cache: { rev: number; png: string | null } | null;
}

/** The text being typed or edited, with where to show the box. */
export interface TextEdit {
  id: string | null;
  text: string;
  size: number;
  color: string;
  bold: boolean;
  /** Position of the box in the editor, in CSS px. */
  left: number;
  top: number;
  /** Font size on screen. */
  px: number;
}

/** What the screen shows; replaced (not changed) on each change so React can compare it. */
export interface SketchState {
  tool: ToolId;
  options: ToolOptions;
  colour: string;
  recent: string[];
  layers: LayerInfo[];
  activeId: string;
  width: number;
  height: number;
  zoom: number;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  depth: number;
  dirty: boolean;
  hasSelection: boolean;
  hasCropBox: boolean;
  selectedText: boolean;
  textEdit: TextEdit | null;
  background: 'white' | 'clear';
  revision: number;
  /** Shapes from the AI are shown and wait for Accept or Discard. */
  aiPreview: boolean;
}

/** What the editor asks of the page around it. */
export interface SketcherHooks {
  /** A short message about something that did not happen (locked layer, limit reached). */
  notice(message: string): void;
  /** The pointer moved over the drawing (null when it left). */
  cursor(pos: { x: number; y: number } | null): void;
}

const DEFAULT_OPTIONS: ToolOptions = {
  sizes: { pencil: 2, brush: 12, eraser: 20, line: 4, shape: 3, text: 28 },
  softness: 40,
  opacity: 100,
  pressure: false,
  pressureTarget: 'size',
  smoothing: 30,
  tolerance: 12,
  arrow: false,
  shape: 'rect',
  filled: false,
  bold: false,
};

const SIZE_RANGE: Record<SizedTool, [number, number]> = {
  pencil: [1, 40],
  brush: [1, 200],
  eraser: [1, 200],
  line: [1, 60],
  shape: [1, 60],
  text: [8, 200],
};

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const PALM_MS = 1500;
const TAP_MS = 350;

function isSized(tool: ToolId): tool is SizedTool {
  return tool in SIZE_RANGE;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

function ctxOf(c: HTMLCanvasElement): CanvasRenderingContext2D {
  // layers are read often (undo, fill, picker), so keep them where the CPU can reach them
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('This browser cannot draw on a canvas.');
  return ctx;
}

function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

function fontOf(t: { size: number; bold?: boolean }): string {
  return `${t.bold ? '700 ' : ''}${t.size}px ${FONT}`;
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
  await img.decode();
  return img;
}

type Drag =
  | { kind: 'stroke'; tool: 'pencil' | 'brush' | 'eraser'; layer: Layer; stroke: StrokeState }
  | { kind: 'shape'; x0: number; y0: number; x1: number; y1: number; shift: boolean }
  | { kind: 'marquee'; x0: number; y0: number }
  | { kind: 'crop'; x0: number; y0: number }
  | { kind: 'move'; dx: number; dy: number }
  | { kind: 'resize'; handle: string; start: Rect }
  | { kind: 'textmove'; layer: Layer; id: string; dx: number; dy: number; before: SourceText[] }
  | { kind: 'pan'; sx: number; sy: number; px: number; py: number }
  | { kind: 'click'; x: number; y: number; sx: number; sy: number };

interface StrokeState {
  last: Sample;
  smoothed: Sample;
  carry: number;
  bounds: Rect | null;
  snap: TileSnapshot | null;
  opacity: number;
}

interface Selection {
  layer: Layer;
  /** Where the pixels came from, and where they are drawn now. */
  rect: Rect;
  dest: Rect;
  floating: HTMLCanvasElement | null;
  snap: TileSnapshot | null;
}

interface ShapeSpec {
  kind: 'line' | 'rect' | 'ellipse';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  colour: string;
  width: number;
  arrow: boolean;
  filled: boolean;
  opacity: number;
}

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;

/**
 * The drawing engine behind the editor: layers on canvases, tools, undo and the view. It has no React
 * in it; the editor reads `getState()` through `subscribe` and calls its methods.
 */
export class Sketcher {
  private view: HTMLCanvasElement;
  private hooks: SketcherHooks;
  private history = new History();
  private layers: Layer[] = [];
  private activeId = '';
  private width = 840;
  private height = 500;
  private background: 'white' | 'clear' = 'white';
  private tool: ToolId = 'brush';
  private options: ToolOptions = structuredClone(DEFAULT_OPTIONS);
  private colour = '#e8441a';
  private recent: string[] = [];
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private viewW = 0;
  private viewH = 0;
  private dpr = 1;
  private dirty = false;
  private revision = 0;
  private strokeCanvas: HTMLCanvasElement | null = null;
  private stamps = new Map<string, HTMLCanvasElement>();
  private drag: Drag | null = null;
  private selection: Selection | null = null;
  private cropBox: Rect | null = null;
  private selectedTextId: string | null = null;
  private textEdit: { id: string | null; layer: Layer; x: number; y: number } | null = null;
  private textDraft = '';
  private pointer: { x: number; y: number; show: boolean } | null = null;
  private spaceDown = false;
  private penUntil = 0;
  private touches = new Map<number, { x: number; y: number }>();
  private gesture: {
    dist: number;
    zoom: number;
    mx: number;
    my: number;
    panX: number;
    panY: number;
    fingers: number;
    t0: number;
    moved: boolean;
  } | null = null;
  private tempTool: ToolId | null = null;
  private listeners = new Set<() => void>();
  private state: SketchState;
  private raf = 0;
  private emitRaf = 0;
  private disposed = false;
  private ro: ResizeObserver | null = null;
  private cleanup: Array<() => void> = [];
  private measure: CanvasRenderingContext2D | null = null;
  private loadId = 0;
  /** True until the person zooms or pans: then the drawing stays fitted when the window is resized. */
  private autoFit = true;
  private checker: CanvasPattern | null = null;
  /** Shapes the AI proposed, shown above the drawing until the person accepts or discards them. */
  private aiPreview: { layer: Layer; w: number; h: number } | null = null;

  /**
   * @param view - The canvas the drawing is shown on.
   * @param hooks - Messages and the pointer position for the page around.
   */
  constructor(view: HTMLCanvasElement, hooks: SketcherHooks) {
    this.view = view;
    this.hooks = hooks;
    this.state = this.buildState();
    this.history.onChange(() => this.changed());
    this.attach();
  }

  // --- setting up -------------------------------------------------------------

  /**
   * Start a blank drawing.
   * @param width - Width in px.
   * @param height - Height in px.
   * @param background - A white page, or a clear one.
   */
  newDocument(width: number, height: number, background: 'white' | 'clear'): void {
    this.loadId++;
    this.reset(clampSide(width, 840), clampSide(height, 500), background);
    if (background === 'white') this.pushLayer('Background', 'paper', true, true);
    const top = this.pushLayer('Sketch', 'layer', false, false);
    this.activeId = top.id;
    this.finishLoad();
  }

  /**
   * Start from a picture: it goes on its own locked layer and the marks go on a layer above it.
   * @param image - The picture.
   * @param name - Name for the picture layer.
   * @returns True when the picture was larger than the limit and was scaled down.
   */
  openImage(image: HTMLImageElement, name = 'Picture'): boolean {
    const fit = fitWithin(image.naturalWidth, image.naturalHeight);
    this.loadId++;
    this.reset(fit.w, fit.h, 'clear');
    const base = this.pushLayer(name, 'picture', true, true);
    base.ctx.imageSmoothingQuality = 'high';
    base.ctx.drawImage(image, 0, 0, fit.w, fit.h);
    base.blank = false;
    const top = this.pushLayer('Marks', 'layer', false, false);
    this.activeId = top.id;
    this.finishLoad();
    return fit.scaled;
  }

  /**
   * Open a saved drawing.
   * @param source - The editable source, already checked by `parseSource`.
   */
  async openSource(source: SketchSource): Promise<void> {
    const load = ++this.loadId;
    this.reset(source.width, source.height, source.background);
    for (const sl of source.layers) {
      const layer = this.pushLayer(sl.name, sl.kind, sl.locked, false, sl.id);
      layer.visible = sl.visible;
      layer.opacity = sl.opacity;
      layer.texts = sl.texts.map((t) => ({ ...t }));
      if (sl.png) {
        const img = await loadImage(sl.png);
        if (load !== this.loadId || this.disposed) return; // another drawing was opened while this one loaded
        layer.ctx.drawImage(img, 0, 0);
        layer.blank = false;
      }
    }
    this.activeId = source.activeLayer ?? this.layers[this.layers.length - 1].id;
    if (source.recent) this.recent = source.recent.slice();
    this.finishLoad();
  }

  private reset(w: number, h: number, background: 'white' | 'clear'): void {
    this.layers = [];
    this.width = w;
    this.height = h;
    this.background = background;
    this.history.clear();
    this.selection = null;
    this.cropBox = null;
    this.selectedTextId = null;
    this.textEdit = null;
    this.strokeCanvas = null;
    this.aiPreview = null;
  }

  private pushLayer(name: string, kind: Layer['kind'], locked: boolean, white: boolean, id?: string): Layer {
    const canvas = makeCanvas(this.width, this.height);
    const ctx = ctxOf(canvas);
    if (white) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, this.width, this.height);
    }
    const layer: Layer = {
      id: id ?? nextLayerId(this.layers),
      name,
      kind,
      visible: true,
      opacity: 1,
      locked,
      canvas,
      ctx,
      texts: [],
      blank: !white,
      rev: 1,
      cache: null,
    };
    this.layers = [...this.layers, layer];
    return layer;
  }

  private finishLoad(): void {
    this.dirty = false;
    this.fit();
    this.changed(false);
  }

  /** Remove the listeners and stop drawing. */
  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    cancelAnimationFrame(this.emitRaf);
    this.ro?.disconnect();
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
    this.listeners.clear();
  }

  // --- state for React --------------------------------------------------------

  /**
   * Call `fn` after every change of the state.
   * @param fn - Listener.
   * @returns A function that removes it.
   */
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** The current state; the same object until something changes. */
  getState = (): SketchState => this.state;

  private buildState(): SketchState {
    const sel = this.selection;
    let textEdit: TextEdit | null = null;
    if (this.textEdit) {
      const e = this.textEdit;
      const existing = e.id ? e.layer.texts.find((t) => t.id === e.id) : null;
      const size = existing?.size ?? this.options.sizes.text;
      textEdit = {
        id: e.id,
        text: this.textDraft,
        size,
        color: existing?.color ?? this.colour,
        bold: existing?.bold ?? this.options.bold,
        left: this.panX + e.x * this.zoom,
        top: this.panY + e.y * this.zoom,
        px: size * this.zoom,
      };
    }
    return {
      tool: this.tool,
      options: this.options,
      colour: this.colour,
      recent: this.recent,
      layers: this.layers.map(({ id, name, kind, visible, opacity, locked }) => ({
        id,
        name,
        kind,
        visible,
        opacity,
        locked,
      })),
      activeId: this.activeId,
      width: this.width,
      height: this.height,
      zoom: this.zoom,
      canUndo: this.history.canUndo || !!sel?.floating,
      canRedo: this.history.canRedo,
      undoLabel: this.history.undoLabel,
      depth: this.history.depth,
      dirty: this.dirty,
      hasSelection: !!sel,
      hasCropBox: !!this.cropBox,
      selectedText: !!this.selectedTextId,
      textEdit,
      background: this.background,
      revision: this.revision,
      aiPreview: !!this.aiPreview,
    };
  }

  /** Rebuild the state, tell the listeners and redraw. `dirty` says whether this change is an edit. */
  private changed(edit = true): void {
    if (edit) {
      this.dirty = true;
      this.revision++;
    }
    this.state = this.buildState();
    for (const fn of this.listeners) fn();
    this.render();
  }

  /** Same, once per frame: for zoom and pan, which change many times in a row. */
  private changedSoon(): void {
    if (this.emitRaf) return;
    this.emitRaf = requestAnimationFrame(() => {
      this.emitRaf = 0;
      if (!this.disposed) this.changed(false);
    });
  }

  // --- reading the drawing out --------------------------------------------------

  /** The layers, for the source file. Empty layers are written as `null`. */
  exportSource(): SketchSource {
    const layers: SourceLayer[] = this.layers.map((l) => {
      if (!l.cache || l.cache.rev !== l.rev) {
        l.cache = { rev: l.rev, png: l.blank ? null : l.canvas.toDataURL('image/png') };
      }
      return {
        id: l.id,
        name: l.name,
        kind: l.kind,
        visible: l.visible,
        opacity: l.opacity,
        locked: l.locked,
        png: l.cache.png,
        texts: l.texts.map((t) => ({ ...t })),
      };
    });
    return {
      format: 'kanban-sketch',
      version: 1,
      width: this.width,
      height: this.height,
      background: this.background,
      layers,
      activeLayer: this.activeId,
      recent: this.recent,
    };
  }

  private flatten(): HTMLCanvasElement {
    const out = makeCanvas(this.width, this.height);
    const ctx = ctxOf(out);
    for (const l of this.layers) this.drawLayer(ctx, l);
    return out;
  }

  /** The finished picture, every visible layer in one PNG. */
  exportPng(): Promise<Blob> {
    this.commitSelection();
    const flat = this.flatten();
    return new Promise((resolve, reject) =>
      flat.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be made.'))), 'image/png'),
    );
  }

  /** Mark the drawing as having unsaved changes (after a draft was restored). */
  markDirty(): void {
    this.dirty = true;
    this.revision++;
    this.changed(false);
  }

  /** Mark the drawing as saved. */
  markSaved(): void {
    this.dirty = false;
    this.changed(false);
  }

  /** The number of layers. */
  get layerCount(): number {
    return this.layers.length;
  }

  /** True while the pointer is in the middle of a stroke, a shape or a drag (the drawing is not at rest). */
  get busy(): boolean {
    return this.drag !== null && this.drag.kind !== 'pan';
  }

  // --- tools and options ----------------------------------------------------------

  /**
   * Choose a tool.
   * @param tool - The tool.
   */
  setTool(tool: ToolId): void {
    if (tool === this.tool) return;
    this.commitSelection();
    this.endText(true);
    this.tool = tool;
    this.cropBox = null;
    this.selectedTextId = null;
    this.updateCursor();
    this.changed(false);
  }

  /**
   * Change an option; only what is given changes.
   * @param patch - New values.
   */
  setOptions(patch: Partial<Omit<ToolOptions, 'sizes'>>): void {
    this.options = { ...this.options, ...patch };
    this.changed(false);
  }

  /**
   * Set the size of a tool (the font size for text), within that tool's range.
   * @param tool - The tool, or the current one.
   * @param size - New size.
   */
  setSize(size: number, tool: ToolId = this.tool): void {
    if (!isSized(tool)) return;
    const [lo, hi] = SIZE_RANGE[tool];
    const v = Math.max(lo, Math.min(hi, Math.round(size)));
    this.options = { ...this.options, sizes: { ...this.options.sizes, [tool]: v } };
    // a text being edited takes the new size too
    if (tool === 'text' && this.selectedTextId) this.restyleSelectedText({ size: v });
    this.changed(false);
  }

  /**
   * Make the current tool's size bigger or smaller by a step ([ and ]).
   * @param dir - 1 for bigger, -1 for smaller.
   */
  nudgeSize(dir: 1 | -1): void {
    if (!isSized(this.tool)) return;
    const s = this.options.sizes[this.tool];
    const step = s < 10 ? 1 : s < 40 ? 2 : s < 100 ? 5 : 10;
    this.setSize(s + dir * step);
  }

  /**
   * Choose the drawing colour.
   * @param hex - `#rrggbb`.
   * @param remember - Add it to the recent colours (when the choice is final, not while a colour is being dragged).
   */
  setColour(hex: string, remember = true): void {
    const c = normaliseHex(hex);
    if (!c) return;
    this.colour = c;
    if (remember) this.recent = pushRecent(this.recent, c);
    if (this.selectedTextId) this.restyleSelectedText({ color: c });
    this.changed(false);
  }

  /** The swatches offered next to the colour field. */
  get swatches(): readonly string[] {
    return SWATCHES;
  }

  // --- history ------------------------------------------------------------------

  /** Take back the last change. */
  undo(): void {
    this.endText(true);
    if (this.selection?.floating) this.commitSelection();
    this.selection = null;
    this.history.undo();
    this.afterHistory();
  }

  /** Do again what was taken back. */
  redo(): void {
    this.endText(true);
    this.selection = null;
    this.history.redo();
    this.afterHistory();
  }

  private afterHistory(): void {
    if (!this.layers.some((l) => l.id === this.activeId)) this.activeId = this.layers[this.layers.length - 1].id;
    this.dirty = true;
    this.revision++;
    this.changed(false);
  }

  private surface(layer: Layer): Surface {
    return {
      width: this.width,
      height: this.height,
      read: (r) => layer.ctx.getImageData(r.x, r.y, r.w, r.h),
      write: (x, y, patch) =>
        layer.ctx.putImageData(
          new ImageData(patch.data as Uint8ClampedArray<ArrayBuffer>, patch.width, patch.height),
          x,
          y,
        ),
    };
  }

  private touch(layer: Layer): void {
    layer.rev++;
    layer.blank = false;
  }

  /** Record that pixels changed, with the snapshot that can put them back. */
  private pushPixels(layer: Layer, snap: TileSnapshot, label: string): void {
    if (snap.empty) return;
    const surface = this.surface(layer);
    const swap = () => {
      snap.swap(surface);
      layer.rev++;
    };
    this.touch(layer);
    this.history.push({ label, bytes: snap.bytes, undo: swap, redo: swap });
  }

  /** Record a change that has already been made and can be switched back and forth. */
  private pushToggle(label: string, undo: () => void, redo: () => void, bytes = 0): void {
    this.history.push({
      label,
      bytes,
      undo: () => {
        undo();
        this.touchAll();
      },
      redo: () => {
        redo();
        this.touchAll();
      },
    });
  }

  private touchAll(): void {
    for (const l of this.layers) l.rev++;
  }

  // --- layers --------------------------------------------------------------------

  private activeLayer(): Layer {
    return this.layers.find((l) => l.id === this.activeId) ?? this.layers[this.layers.length - 1];
  }

  /**
   * Select the layer the next marks go on.
   * @param id - Layer id.
   */
  setActive(id: string): void {
    if (!this.layers.some((l) => l.id === id)) return;
    this.commitSelection();
    this.endText(true);
    this.activeId = id;
    this.selectedTextId = null;
    this.changed(false);
  }

  /** Add an empty layer above the selected one. */
  addLayer(): void {
    if (!canAddLayer(this.layers.length)) {
      this.hooks.notice(`A drawing can have ${MAX_LAYERS} layers. Merge or delete one first.`);
      return;
    }
    this.commitSelection();
    const before = this.layers;
    const beforeActive = this.activeId;
    const canvas = makeCanvas(this.width, this.height);
    const layer: Layer = {
      id: nextLayerId(before),
      name: nextLayerName(before),
      kind: 'layer',
      visible: true,
      opacity: 1,
      locked: false,
      canvas,
      ctx: ctxOf(canvas),
      texts: [],
      blank: true,
      rev: 1,
      cache: null,
    };
    try {
      this.layers = insertLayer(before, layer, this.activeId);
    } catch (e) {
      if (e instanceof LayerLimitError) this.hooks.notice(e.message);
      return;
    }
    const after = this.layers;
    this.activeId = layer.id;
    this.pushToggle(
      'Add layer',
      () => {
        this.layers = before;
        this.activeId = beforeActive;
      },
      () => {
        this.layers = after;
        this.activeId = layer.id;
      },
    );
  }

  /**
   * Put a picture (one attached in the AI chat, say) on a new layer above the selected one, centred and scaled down to
   * fit the canvas, never enlarged. One undoable step; the other layers are not touched.
   * @param image - The picture.
   * @param name - Name for the layer.
   * @returns False when the drawing already has 10 layers (a notice says so).
   */
  addImageLayer(image: HTMLImageElement, name = 'Picture'): boolean {
    if (!canAddLayer(this.layers.length)) {
      this.hooks.notice(`A drawing can have ${MAX_LAYERS} layers. Merge or delete one first.`);
      return false;
    }
    this.commitSelection();
    const before = this.layers;
    const beforeActive = this.activeId;
    const canvas = makeCanvas(this.width, this.height);
    const ctx = ctxOf(canvas);
    const box = fitInside(image.naturalWidth, image.naturalHeight, this.width, this.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, box.x, box.y, box.w, box.h);
    const layer: Layer = {
      id: nextLayerId(before),
      name: name.replace(/\s+/g, ' ').trim().slice(0, 40) || 'Picture',
      kind: 'layer',
      visible: true,
      opacity: 1,
      locked: false,
      canvas,
      ctx,
      texts: [],
      blank: false,
      rev: 1,
      cache: null,
    };
    try {
      this.layers = insertLayer(before, layer, this.activeId);
    } catch (e) {
      if (e instanceof LayerLimitError) this.hooks.notice(e.message);
      return false;
    }
    const after = this.layers;
    this.activeId = layer.id;
    this.pushToggle(
      'Add picture',
      () => {
        this.layers = before;
        this.activeId = beforeActive;
      },
      () => {
        this.layers = after;
        this.activeId = layer.id;
      },
    );
    return true;
  }

  // --- AI help ------------------------------------------------------------------------

  /**
   * The picture the AI is shown: every visible layer flattened, scaled down so its longest side is at most `maxSide`.
   * A shape proposed by the AI and not yet accepted is not part of it.
   * @param maxSide - Longest side in px.
   * @returns The PNG and its size.
   */
  async exportForAi(maxSide = 1280): Promise<{ blob: Blob; width: number; height: number }> {
    this.commitSelection();
    const flat = this.flatten();
    const k = Math.min(1, maxSide / Math.max(flat.width, flat.height));
    let out = flat;
    if (k < 1) {
      out = makeCanvas(Math.max(1, Math.round(flat.width * k)), Math.max(1, Math.round(flat.height * k)));
      const c = ctxOf(out);
      c.imageSmoothingQuality = 'high';
      c.drawImage(flat, 0, 0, out.width, out.height);
    }
    const blob = await new Promise<Blob>((resolve, reject) =>
      out.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be made.'))), 'image/png'),
    );
    return { blob, width: out.width, height: out.height };
  }

  /**
   * Show shapes the AI proposed above the drawing, without changing it. They stay a preview until `acceptAiOps`
   * puts them on a new layer; `discardAiOps` throws them away. A new preview replaces the old one.
   * @param ops - Ops already checked by `cleanAiOps`.
   * @returns False when a new layer would not fit (10 layers), with a notice.
   */
  previewAiOps(ops: readonly AiOp[]): boolean {
    this.aiPreview = null;
    if (!canAddLayer(this.layers.length)) {
      this.hooks.notice(`A drawing can have ${MAX_LAYERS} layers. Merge or delete one first, then try again.`);
      this.changed(false);
      return false;
    }
    const canvas = makeCanvas(this.width, this.height);
    const ctx = ctxOf(canvas);
    drawAiShapes(ctx, ops);
    const texts = aiTexts(ops, `ai${Date.now().toString(36)}`);
    const layer: Layer = {
      id: '',
      name: AI_LAYER_NAME,
      kind: 'layer',
      visible: true,
      opacity: 1,
      locked: false,
      canvas,
      ctx,
      texts,
      blank: ops.length === texts.length,
      rev: 1,
      cache: null,
    };
    this.aiPreview = { layer, w: this.width, h: this.height };
    this.changed(false);
    return true;
  }

  /** Whether shapes from the AI are waiting to be accepted. */
  get hasAiPreview(): boolean {
    return !!this.aiPreview;
  }

  /** Throw away the shapes the AI proposed. */
  discardAiOps(): void {
    if (!this.aiPreview) return;
    this.aiPreview = null;
    this.changed(false);
  }

  /**
   * Put the previewed shapes on a new layer named "AI" on top of the drawing, as ONE undoable step. Nothing of the
   * person's own layers is touched.
   * @returns True when the layer was added.
   */
  acceptAiOps(): boolean {
    const p = this.aiPreview;
    if (!p) return false;
    if (p.w !== this.width || p.h !== this.height) {
      this.aiPreview = null;
      this.hooks.notice('The canvas size changed, so the AI shapes were dropped. Ask again.');
      this.changed(false);
      return false;
    }
    if (!canAddLayer(this.layers.length)) {
      this.hooks.notice(`A drawing can have ${MAX_LAYERS} layers. Merge or delete one first.`);
      return false;
    }
    this.commitSelection();
    this.endText(true);
    const before = this.layers;
    const beforeActive = this.activeId;
    const taken = new Set(before.map((l) => l.name));
    let name: string = AI_LAYER_NAME;
    for (let n = 2; taken.has(name); n++) name = `${AI_LAYER_NAME} ${n}`;
    const layer = p.layer;
    layer.id = nextLayerId(before);
    layer.name = name;
    const after = insertLayer(before, layer);
    this.aiPreview = null;
    this.layers = after;
    this.activeId = layer.id;
    this.selectedTextId = null;
    this.pushToggle(
      'AI drawing',
      () => {
        this.layers = before;
        this.activeId = beforeActive;
      },
      () => {
        this.layers = after;
        this.activeId = layer.id;
      },
    );
    return true;
  }

  /**
   * Add a line of text (an idea from the AI, say) to the selected layer, at the left edge below the labels already
   * there. One undoable step; the text stays editable.
   * @param text - The words.
   * @returns False when the selected layer is hidden or locked (a notice says so).
   */
  addTextLabel(text: string): boolean {
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, 140);
    const layer = this.activeLayer();
    if (!clean || !this.canDraw(layer)) return false;
    this.commitSelection();
    const size = Math.min(this.options.sizes.text, 24);
    const before = layer.texts;
    const y = Math.min(this.height - size * 1.25, 24 + (before.length % 12) * Math.round(size * 1.6));
    const after = [
      ...before,
      {
        id: `t${Date.now().toString(36)}${before.length}`,
        x: 24,
        y: Math.max(0, Math.round(y)),
        text: clean,
        size,
        color: this.colour,
      },
    ];
    layer.texts = after;
    this.pushToggle(
      'Text',
      () => (layer.texts = before),
      () => (layer.texts = after),
    );
    this.changed();
    return true;
  }

  /**
   * Delete a layer and what is on it.
   * @param id - Layer id.
   */
  removeLayer(id: string): void {
    if (this.layers.length <= 1) {
      this.hooks.notice('A drawing needs at least one layer.');
      return;
    }
    this.commitSelection();
    const before = this.layers;
    const beforeActive = this.activeId;
    const next = layerAfterDelete(before, id);
    const after = before.filter((l) => l.id !== id);
    this.layers = after;
    this.activeId = next ?? after[0].id;
    const nextActive = this.activeId;
    this.pushToggle(
      'Delete layer',
      () => {
        this.layers = before;
        this.activeId = beforeActive;
      },
      () => {
        this.layers = after;
        this.activeId = nextActive;
      },
      this.width * this.height * 4,
    );
  }

  /**
   * Move a layer one place up or down.
   * @param id - Layer id.
   * @param dir - 1 for up, -1 for down.
   */
  shiftLayer(id: string, dir: 1 | -1): void {
    const before = this.layers;
    const after = moveLayer(before, id, dir) as Layer[];
    if (after === before) return;
    this.layers = after;
    this.pushToggle(
      'Move layer',
      () => (this.layers = before),
      () => (this.layers = after),
    );
  }

  /**
   * Draw a layer onto the one below it and remove it; text on either becomes part of the picture.
   * @param id - The upper layer.
   */
  mergeDown(id: string): void {
    const i = this.layers.findIndex((l) => l.id === id);
    if (i <= 0) {
      this.hooks.notice('There is no layer below to merge into.');
      return;
    }
    const upper = this.layers[i];
    const lower = this.layers[i - 1];
    if (lower.locked) {
      this.hooks.notice(`“${lower.name}” is locked. Unlock it to merge into it.`);
      return;
    }
    this.commitSelection();
    const beforeLayers = this.layers;
    const beforeCanvas = lower.canvas;
    const beforeTexts = lower.texts;
    const beforeBlank = lower.blank;
    const beforeActive = this.activeId;
    const merged = makeCanvas(this.width, this.height);
    const mctx = ctxOf(merged);
    this.drawLayer(mctx, { ...lower, visible: true, opacity: 1 });
    this.drawLayer(mctx, { ...upper, visible: true });
    const afterLayers = beforeLayers.filter((l) => l.id !== id);
    const apply = () => {
      lower.canvas = merged;
      lower.ctx = mctx;
      lower.texts = [];
      lower.blank = false;
      lower.rev++;
      this.layers = afterLayers;
      this.activeId = lower.id;
    };
    apply();
    this.pushToggle(
      'Merge layers',
      () => {
        lower.canvas = beforeCanvas;
        lower.ctx = ctxOf(beforeCanvas);
        lower.texts = beforeTexts;
        lower.blank = beforeBlank;
        this.layers = beforeLayers;
        this.activeId = beforeActive;
      },
      apply,
      this.width * this.height * 4,
    );
  }

  /**
   * Show or hide a layer.
   * @param id - Layer id.
   * @param visible - Whether it shows.
   */
  setVisible(id: string, visible: boolean): void {
    const l = this.layers.find((x) => x.id === id);
    if (!l) return;
    l.visible = visible;
    l.rev++;
    this.changed();
  }

  /**
   * Lock or unlock a layer.
   * @param id - Layer id.
   * @param locked - Whether it is locked.
   */
  setLocked(id: string, locked: boolean): void {
    const l = this.layers.find((x) => x.id === id);
    if (!l) return;
    this.commitSelection();
    l.locked = locked;
    l.rev++;
    this.changed();
  }

  /**
   * Set how see-through a layer is.
   * @param id - Layer id.
   * @param opacity - 0 to 1.
   */
  setLayerOpacity(id: string, opacity: number): void {
    const l = this.layers.find((x) => x.id === id);
    if (!l) return;
    l.opacity = Math.max(0, Math.min(1, opacity));
    l.rev++;
    this.changed();
  }

  /**
   * Rename a layer.
   * @param id - Layer id.
   * @param name - New name.
   */
  renameLayer(id: string, name: string): void {
    const l = this.layers.find((x) => x.id === id);
    const n = name.trim().slice(0, 60);
    if (!l || !n) return;
    l.name = n;
    l.rev++;
    this.changed();
  }

  // --- the canvas: crop, resize, trim ---------------------------------------------

  /**
   * Swap every layer for a new set of canvases of a new size, as one undoable step.
   * @param w - New width.
   * @param h - New height.
   * @param make - Draws each layer into its new canvas and returns its texts.
   */
  private rebuild(
    label: string,
    w: number,
    h: number,
    make: (layer: Layer, to: CanvasRenderingContext2D) => SourceText[],
  ): void {
    this.commitSelection();
    this.endText(true);
    const oldW = this.width;
    const oldH = this.height;
    const olds = this.layers.map((l) => ({ l, canvas: l.canvas, ctx: l.ctx, texts: l.texts }));
    const news = this.layers.map((l) => {
      const canvas = makeCanvas(w, h);
      const ctx = ctxOf(canvas);
      return { l, canvas, ctx, texts: make(l, ctx) };
    });
    const set = (side: 'old' | 'new') => {
      const src = side === 'old' ? olds : news;
      this.width = side === 'old' ? oldW : w;
      this.height = side === 'old' ? oldH : h;
      for (const s of src) {
        s.l.canvas = s.canvas;
        s.l.ctx = s.ctx;
        s.l.texts = s.texts;
        s.l.blank = false;
        s.l.rev++;
      }
      this.strokeCanvas = null;
      this.cropBox = null;
    };
    set('new');
    this.pushToggle(
      label,
      () => set('old'),
      () => set('new'),
      olds.length * oldW * oldH * 4,
    );
    this.fit();
  }

  /**
   * Make the canvas a different size, keeping the drawing as it is (from the top left corner).
   * @param w - New width.
   * @param h - New height.
   */
  resizeCanvas(w: number, h: number): void {
    const nw = clampSide(w, this.width);
    const nh = clampSide(h, this.height);
    if (w > MAX_SIDE || h > MAX_SIDE) this.hooks.notice(`Too large. The limit is ${MAX_SIDE} × ${MAX_SIDE} px.`);
    if (nw === this.width && nh === this.height) return;
    this.rebuild('Canvas size', nw, nh, (l, to) => {
      if (l.kind === 'paper') {
        to.fillStyle = '#ffffff';
        to.fillRect(0, 0, nw, nh);
      }
      to.drawImage(l.canvas, 0, 0);
      return l.texts;
    });
  }

  /**
   * Scale the whole drawing to a new size.
   * @param w - New width.
   * @param h - New height.
   */
  scaleDrawing(w: number, h: number): void {
    const nw = clampSide(w, this.width);
    const nh = clampSide(h, this.height);
    if (w > MAX_SIDE || h > MAX_SIDE) this.hooks.notice(`Too large. The limit is ${MAX_SIDE} × ${MAX_SIDE} px.`);
    if (nw === this.width && nh === this.height) return;
    const kx = nw / this.width;
    const ky = nh / this.height;
    this.rebuild('Scale drawing', nw, nh, (l, to) => {
      to.imageSmoothingQuality = 'high';
      to.drawImage(l.canvas, 0, 0, nw, nh);
      return l.texts.map((t) => ({ ...t, x: t.x * kx, y: t.y * ky, size: Math.max(4, t.size * ky) }));
    });
  }

  /**
   * Cut the canvas down to a box; everything outside it goes.
   * @param box - The box to keep, in drawing pixels.
   */
  cropTo(box: Rect): void {
    const r = clipRect(box, this.width, this.height);
    if (!r) return;
    this.rebuild('Crop', r.w, r.h, (l, to) => {
      to.drawImage(l.canvas, -r.x, -r.y);
      return l.texts.map((t) => ({ ...t, x: t.x - r.x, y: t.y - r.y }));
    });
  }

  /** Crop the canvas to the box drawn with the crop tool. */
  cropToBox(): void {
    if (this.cropBox) this.cropTo(this.cropBox);
  }

  /** Cut the canvas down to what is drawn on it (the white page and a picture do not count). */
  trimToContent(): void {
    let box: Rect | null = null;
    for (const l of this.layers) {
      if (l.kind !== 'layer' || !l.visible) continue;
      const data = l.ctx.getImageData(0, 0, this.width, this.height);
      box = unionRect(box, contentBounds(data as Raster));
      for (const t of l.texts) box = unionRect(box, this.textBounds(t));
    }
    if (!box) {
      this.hooks.notice('There is nothing drawn to trim to.');
      return;
    }
    this.cropTo(growRect(box, 8));
  }

  // --- view: zoom and pan --------------------------------------------------------

  /** Size of the area the drawing is shown in, from the editor's layout. */
  setViewSize(cssW: number, cssH: number): void {
    const first = this.viewW === 0;
    this.viewW = cssW;
    this.viewH = cssH;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.view.width = Math.max(1, Math.round(cssW * this.dpr));
    this.view.height = Math.max(1, Math.round(cssH * this.dpr));
    if ((first || this.autoFit) && this.layers.length) this.fit();
    else this.render();
  }

  /** Zoom to fit the drawing in the view, centred. */
  fit(): void {
    if (!this.viewW) return;
    this.autoFit = true;
    this.zoom = fitZoom(this.width, this.height, this.viewW, this.viewH);
    this.centre();
    this.changedSoon();
  }

  private centre(): void {
    this.panX = (this.viewW - this.width * this.zoom) / 2;
    this.panY = (this.viewH - this.height * this.zoom) / 2;
  }

  /**
   * Zoom around a point of the view (the middle when none is given).
   * @param factor - Multiply the zoom by this.
   * @param cx - Point x in the view, CSS px.
   * @param cy - Point y in the view.
   */
  zoomBy(factor: number, cx = this.viewW / 2, cy = this.viewH / 2): void {
    this.autoFit = false;
    const z = clampZoom(this.zoom * factor);
    const k = z / this.zoom;
    this.panX = cx - (cx - this.panX) * k;
    this.panY = cy - (cy - this.panY) * k;
    this.zoom = z;
    this.changedSoon();
    this.render();
  }

  /**
   * Set the zoom exactly (1 = 100%).
   * @param z - Zoom.
   */
  zoomTo(z: number): void {
    this.zoomBy(clampZoom(z) / this.zoom);
  }

  // --- coordinates ----------------------------------------------------------------

  private toDoc(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.view.getBoundingClientRect();
    return { x: (clientX - r.left - this.panX) / this.zoom, y: (clientY - r.top - this.panY) / this.zoom };
  }

  private toView(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.view.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  // --- drawing the view -------------------------------------------------------------

  /** Redraw on the next frame. */
  render(): void {
    if (this.raf || this.disposed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (!this.disposed) this.paint();
    });
  }

  private drawLayer(ctx: CanvasRenderingContext2D, l: Layer): void {
    if (!l.visible) return;
    // an empty layer costs nothing: with 10 layers of 4096 px most are empty most of the time
    if (l.blank && !l.texts.length && this.stroke?.layer !== l && this.selection?.layer !== l) return;
    ctx.globalAlpha = l.opacity;
    ctx.drawImage(l.canvas, 0, 0);
    if (this.stroke && this.stroke.layer === l) {
      const s = this.strokeCanvas;
      if (s) {
        ctx.globalAlpha = l.opacity * this.stroke.stroke.opacity;
        ctx.drawImage(s, 0, 0);
        ctx.globalAlpha = l.opacity;
      }
    }
    const sel = this.selection;
    if (sel && sel.layer === l && sel.floating) {
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(sel.floating, sel.dest.x, sel.dest.y, sel.dest.w, sel.dest.h);
    }
    for (const t of l.texts) {
      if (this.textEdit && this.textEdit.id === t.id) continue; // the box on top shows it
      ctx.font = fontOf(t);
      ctx.fillStyle = t.color;
      ctx.textBaseline = 'top';
      t.text.split('\n').forEach((line, n) => ctx.fillText(line, t.x, t.y + n * t.size * 1.25));
    }
    ctx.globalAlpha = 1;
  }

  private get stroke(): { layer: Layer; stroke: StrokeState } | null {
    const d = this.drag;
    return d && d.kind === 'stroke' && d.tool !== 'eraser' ? { layer: d.layer, stroke: d.stroke } : null;
  }

  private paint(): void {
    const ctx = this.view.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.view.width, this.view.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const z = this.zoom;
    const px = this.panX;
    const py = this.panY;
    // the page: a shadow, then a chequerboard that shows through clear areas
    ctx.save();
    ctx.shadowColor = 'rgba(37,61,44,0.25)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(px, py, this.width * z, this.height * z);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(px, py, this.width * z, this.height * z);
    ctx.clip();
    ctx.save();
    ctx.translate(px, py);
    ctx.fillStyle = this.checkerboard(ctx);
    ctx.fillRect(0, 0, this.width * z, this.height * z);
    ctx.restore();
    ctx.translate(px, py);
    ctx.scale(z, z);
    ctx.imageSmoothingEnabled = z < 2;
    for (const l of this.layers) this.drawLayer(ctx, l);
    if (this.aiPreview) this.drawLayer(ctx, this.aiPreview.layer);
    ctx.restore();
    // what is being made: shapes, selections, the crop box, the brush ring
    ctx.save();
    ctx.translate(px, py);
    ctx.scale(z, z);
    this.paintOverlay(ctx, z);
    ctx.restore();
  }

  private checkerboard(ctx: CanvasRenderingContext2D): CanvasPattern | string {
    if (!this.checker) {
      const tile = makeCanvas(24, 24);
      const t = ctxOf(tile);
      t.fillStyle = '#f7f9f8';
      t.fillRect(0, 0, 24, 24);
      t.fillStyle = '#e4e9e6';
      t.fillRect(0, 0, 12, 12);
      t.fillRect(12, 12, 12, 12);
      this.checker = ctx.createPattern(tile, 'repeat');
    }
    return this.checker ?? '#f7f9f8';
  }

  private paintOverlay(ctx: CanvasRenderingContext2D, z: number): void {
    const hair = 1 / z;
    const d = this.drag;
    if (d && d.kind === 'shape') {
      const spec = this.shapeSpec(d);
      if (spec) this.paintShape(ctx, spec);
    }
    const dash = (r: Rect, colour = '#2e6f40') => {
      ctx.save();
      ctx.lineWidth = hair * 1.5;
      ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([5 * hair, 4 * hair]);
      ctx.strokeStyle = colour;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.restore();
    };
    if (this.selection) {
      const r = this.selection.dest;
      dash(r);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#2e6f40';
      ctx.lineWidth = hair * 1.5;
      for (const h of HANDLES) {
        const p = this.handlePoint(r, h);
        const s = 5 * hair;
        ctx.fillRect(p.x - s, p.y - s, s * 2, s * 2);
        ctx.strokeRect(p.x - s, p.y - s, s * 2, s * 2);
      }
    }
    if (this.cropBox) {
      const b = this.cropBox;
      ctx.save();
      ctx.fillStyle = 'rgba(30,42,34,0.45)';
      ctx.beginPath();
      ctx.rect(0, 0, this.width, this.height);
      ctx.rect(b.x, b.y, b.w, b.h);
      ctx.fill('evenodd');
      ctx.restore();
      dash(b, '#e8441a');
    }
    if (this.selectedTextId) {
      const l = this.activeLayer();
      const t = l.texts.find((x) => x.id === this.selectedTextId);
      if (t) {
        const b = this.textBounds(t);
        if (b) dash(growRect(b, 3));
      }
    }
    const p = this.pointer;
    if (
      p &&
      p.show &&
      this.drag?.kind !== 'pan' &&
      (this.tool === 'brush' || this.tool === 'eraser' || this.tool === 'pencil')
    ) {
      const size = this.options.sizes[this.tool];
      ctx.save();
      ctx.lineWidth = hair;
      ctx.strokeStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, size / 2 + hair, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = '#1e2a22';
      ctx.beginPath();
      ctx.arc(p.x, p.y, size / 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  private handlePoint(r: Rect, h: string): { x: number; y: number } {
    const x = h.includes('w') ? r.x : h.includes('e') ? r.x + r.w : r.x + r.w / 2;
    const y = h.includes('n') ? r.y : h.includes('s') ? r.y + r.h : r.y + r.h / 2;
    return { x, y };
  }

  private hitHandle(r: Rect, x: number, y: number): string | null {
    const reach = 9 / this.zoom;
    for (const h of HANDLES) {
      const p = this.handlePoint(r, h);
      if (Math.abs(p.x - x) <= reach && Math.abs(p.y - y) <= reach) return h;
    }
    return null;
  }

  // --- shapes ----------------------------------------------------------------------

  private shapeSpec(d: { x0: number; y0: number; x1: number; y1: number; shift: boolean }): ShapeSpec | null {
    let { x1, y1 } = d;
    const t = this.tool;
    if (t === 'line') {
      if (d.shift) ({ x: x1, y: y1 } = snapAngle(d.x0, d.y0, x1, y1, 15));
      return {
        kind: 'line',
        x0: d.x0,
        y0: d.y0,
        x1,
        y1,
        colour: this.colour,
        width: this.options.sizes.line,
        arrow: this.options.arrow,
        filled: false,
        opacity: this.options.opacity / 100,
      };
    }
    if (t === 'shape') {
      if (d.shift) ({ x: x1, y: y1 } = squareCorner(d.x0, d.y0, x1, y1));
      return {
        kind: this.options.shape,
        x0: d.x0,
        y0: d.y0,
        x1,
        y1,
        colour: this.colour,
        width: this.options.sizes.shape,
        arrow: false,
        filled: this.options.filled,
        opacity: this.options.opacity / 100,
      };
    }
    return null;
  }

  private paintShape(ctx: CanvasRenderingContext2D, s: ShapeSpec): void {
    ctx.save();
    ctx.globalAlpha = s.opacity;
    ctx.strokeStyle = s.colour;
    ctx.fillStyle = s.colour;
    ctx.lineWidth = s.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (s.kind === 'line') {
      ctx.beginPath();
      ctx.moveTo(s.x0, s.y0);
      ctx.lineTo(s.x1, s.y1);
      ctx.stroke();
      if (s.arrow) {
        const head = arrowHead(s.x0, s.y0, s.x1, s.y1, Math.max(10, s.width * 4));
        if (head.length) {
          ctx.beginPath();
          ctx.moveTo(head[0].x, head[0].y);
          ctx.lineTo(head[1].x, head[1].y);
          ctx.lineTo(head[2].x, head[2].y);
          ctx.closePath();
          ctx.fill();
        }
      }
    } else {
      const r = rectFromCorners(s.x0, s.y0, s.x1, s.y1);
      ctx.beginPath();
      if (s.kind === 'ellipse') ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      else ctx.rect(r.x, r.y, r.w, r.h);
      if (s.filled) ctx.fill();
      else ctx.stroke();
    }
    ctx.restore();
  }

  private shapeBounds(s: ShapeSpec): Rect {
    const pad = s.width + (s.arrow ? Math.max(10, s.width * 4) : 0) + 2;
    return growRect(rectFromCorners(s.x0, s.y0, s.x1, s.y1), pad);
  }

  // --- brush stamps -----------------------------------------------------------------

  private stampFor(size: number, softness: number, colour: string): HTMLCanvasElement {
    const d = Math.max(1, Math.ceil(size));
    const key = `${d}|${Math.round(softness)}|${colour}`;
    let s = this.stamps.get(key);
    if (s) return s;
    s = makeCanvas(d, d);
    const ctx = ctxOf(s);
    const r = d / 2;
    const hard = 1 - (softness / 100) * 0.97;
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    g.addColorStop(0, rgba(colour, 1));
    g.addColorStop(Math.min(0.999, hard), rgba(colour, 1));
    g.addColorStop(1, rgba(colour, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, d, d);
    if (this.stamps.size > 200) this.stamps.clear();
    this.stamps.set(key, s);
    return s;
  }

  private ensureStrokeCanvas(): HTMLCanvasElement {
    if (!this.strokeCanvas || this.strokeCanvas.width !== this.width || this.strokeCanvas.height !== this.height) {
      this.strokeCanvas = makeCanvas(this.width, this.height);
    }
    return this.strokeCanvas;
  }

  // --- pointer input ------------------------------------------------------------------

  private attach(): void {
    const v = this.view;
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      v.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => v.removeEventListener(type, fn as EventListener));
    };
    on('pointerdown', (e) => this.onDown(e));
    on('pointermove', (e) => this.onMove(e));
    on('pointerup', (e) => this.onUp(e));
    on('pointercancel', (e) => this.onUp(e, true));
    on('pointerleave', (e) => {
      if (e.pointerType === 'mouse') {
        this.pointer = null;
        this.hooks.cursor(null);
        this.render();
      }
    });
    on('wheel', (e) => this.onWheel(e), { passive: false });
    on('contextmenu', (e) => e.preventDefault());
    this.ro = new ResizeObserver(() => {
      const r = v.parentElement?.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) this.setViewSize(r.width, r.height);
    });
    if (v.parentElement) this.ro.observe(v.parentElement);
  }

  /** Space held: dragging pans the drawing. */
  setSpace(down: boolean): void {
    this.spaceDown = down;
    this.updateCursor();
  }

  private updateCursor(): void {
    const t = this.tempTool ?? this.tool;
    this.view.style.cursor =
      this.drag?.kind === 'pan'
        ? 'grabbing'
        : this.spaceDown
          ? 'grab'
          : t === 'text'
            ? 'text'
            : t === 'brush' || t === 'eraser' || t === 'pencil'
              ? 'none'
              : 'crosshair';
  }

  private isPalm(e: PointerEvent): boolean {
    return e.pointerType === 'touch' && Date.now() < this.penUntil;
  }

  private onDown(e: PointerEvent): void {
    if (this.isPalm(e)) return;
    if (e.pointerType === 'pen') this.penUntil = Date.now() + PALM_MS;
    this.view.setPointerCapture(e.pointerId);
    const v = this.toView(e.clientX, e.clientY);
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, v);
      const n = this.touches.size;
      if (n >= 2) {
        this.cancelDrag();
        const [a, b] = [...this.touches.values()];
        this.gesture = {
          dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          zoom: this.zoom,
          mx: (a.x + b.x) / 2,
          my: (a.y + b.y) / 2,
          panX: this.panX,
          panY: this.panY,
          fingers: Math.max(n, this.gesture?.fingers ?? 0),
          t0: this.gesture?.t0 ?? performance.now(),
          moved: this.gesture?.moved ?? false,
        };
        return;
      }
      this.gesture = null;
    }
    if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
      this.cancelDrag();
      this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, px: this.panX, py: this.panY };
      this.updateCursor();
      return;
    }
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    // the pen's eraser end draws with the Eraser while it is held
    this.tempTool = e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) !== 0) ? 'eraser' : null;
    const tool = this.tempTool ?? this.tool;
    const p = this.toDoc(e.clientX, e.clientY);
    // Alt while drawing is a quick colour pick
    if (e.altKey && tool !== 'picker' && tool !== 'text' && tool !== 'select' && tool !== 'crop') {
      this.pickAt(p.x, p.y);
      return;
    }
    this.begin(tool, p, e);
  }

  private begin(tool: ToolId, p: { x: number; y: number }, e: PointerEvent): void {
    this.endText(true);
    const sample: Sample = { x: p.x, y: p.y, p: eventPressure(e.pointerType, e.pressure) };
    switch (tool) {
      case 'pencil':
      case 'brush':
      case 'eraser': {
        const layer = this.activeLayer();
        if (!this.canDraw(layer)) return;
        this.commitSelection();
        const stroke: StrokeState = {
          last: sample,
          smoothed: sample,
          carry: 0,
          bounds: null,
          snap: tool === 'eraser' ? new TileSnapshot(this.width, this.height) : null,
          opacity: tool === 'eraser' ? 1 : this.options.opacity / 100,
        };
        const d: Extract<Drag, { kind: 'stroke' }> = { kind: 'stroke', tool, layer, stroke };
        this.drag = d;
        this.dab(d, sample, sample);
        break;
      }
      case 'line':
      case 'shape':
        if (!this.canDraw(this.activeLayer())) return;
        this.commitSelection();
        this.drag = { kind: 'shape', x0: p.x, y0: p.y, x1: p.x, y1: p.y, shift: e.shiftKey };
        break;
      case 'fill':
      case 'picker':
      case 'text':
        // these act on release, so a second finger landing for a gesture does not trigger them
        this.drag = { kind: 'click', x: p.x, y: p.y, sx: e.clientX, sy: e.clientY };
        break;
      case 'select':
        this.beginSelect(p, e);
        break;
      case 'crop':
        this.cropBox = null;
        this.drag = { kind: 'crop', x0: p.x, y0: p.y };
        break;
    }
    this.render();
  }

  private canDraw(layer: Layer): boolean {
    if (!layer.visible) {
      this.hooks.notice(`“${layer.name}” is hidden. Show it to draw on it.`);
      return false;
    }
    if (layer.locked) {
      this.hooks.notice(`“${layer.name}” is locked. Unlock it to draw on it.`);
      return false;
    }
    return true;
  }

  private onMove(e: PointerEvent): void {
    if (this.isPalm(e)) return;
    if (e.pointerType === 'pen') this.penUntil = Date.now() + PALM_MS;
    const doc = this.toDoc(e.clientX, e.clientY);
    this.pointer = { x: doc.x, y: doc.y, show: e.pointerType !== 'touch' };
    this.hooks.cursor({ x: Math.floor(doc.x), y: Math.floor(doc.y) });
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, this.toView(e.clientX, e.clientY));
      if (this.gesture && this.touches.size >= 2) {
        this.moveGesture();
        return;
      }
    }
    const d = this.drag;
    if (!d) {
      this.render();
      return;
    }
    // a fast pointer reports several positions per event; use them all so a curve stays smooth
    const events = e.getCoalescedEvents?.().length ? e.getCoalescedEvents() : [e];
    switch (d.kind) {
      case 'pan':
        this.autoFit = false;
        this.panX = d.px + (e.clientX - d.sx);
        this.panY = d.py + (e.clientY - d.sy);
        this.changedSoon();
        break;
      case 'stroke':
        for (const ce of events) {
          const p = this.toDoc(ce.clientX, ce.clientY);
          const raw: Sample = { x: p.x, y: p.y, p: eventPressure(e.pointerType, ce.pressure) };
          const next = d.tool === 'pencil' ? raw : smoothStep(d.stroke.smoothed, raw, this.options.smoothing);
          d.stroke.smoothed = next;
          this.dab(d, d.stroke.last, next);
          d.stroke.last = next;
        }
        break;
      case 'shape':
        d.x1 = doc.x;
        d.y1 = doc.y;
        d.shift = e.shiftKey;
        break;
      case 'marquee': {
        const r = rectFromCorners(d.x0, d.y0, doc.x, doc.y);
        const layer = this.activeLayer();
        const clipped = clipRect(r, this.width, this.height);
        this.selection = clipped ? { layer, rect: clipped, dest: { ...clipped }, floating: null, snap: null } : null;
        break;
      }
      case 'crop': {
        const r = clipRect(rectFromCorners(d.x0, d.y0, doc.x, doc.y), this.width, this.height);
        this.cropBox = r;
        break;
      }
      case 'move':
        if (this.selection) {
          this.liftSelection();
          this.selection.dest = { ...this.selection.dest, x: Math.round(doc.x - d.dx), y: Math.round(doc.y - d.dy) };
        }
        break;
      case 'resize':
        if (this.selection) {
          this.liftSelection();
          this.selection.dest = this.resizedRect(d.start, d.handle, doc.x, doc.y, e.shiftKey);
        }
        break;
      case 'textmove': {
        const t = d.layer.texts.find((x) => x.id === d.id);
        if (t) {
          t.x = Math.round(doc.x - d.dx);
          t.y = Math.round(doc.y - d.dy);
          d.layer.rev++;
        }
        break;
      }
      case 'click':
        break;
    }
    this.render();
  }

  private moveGesture(): void {
    const g = this.gesture;
    if (!g) return;
    const [a, b] = [...this.touches.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    if (Math.abs(dist - g.dist) > 12 || Math.hypot(mx - g.mx, my - g.my) > 12) g.moved = true;
    if (!g.moved) return;
    this.autoFit = false;
    const z = clampZoom(g.zoom * (dist / g.dist));
    const k = z / g.zoom;
    // keep the point between the fingers where it was, then follow the fingers
    this.panX = mx - (g.mx - g.panX) * k;
    this.panY = my - (g.my - g.panY) * k;
    this.zoom = z;
    this.changedSoon();
    this.render();
  }

  private onUp(e: PointerEvent, cancelled = false): void {
    if (e.pointerType === 'touch') {
      if (!this.touches.delete(e.pointerId)) return;
      const g = this.gesture;
      if (g) {
        if (this.touches.size === 0) {
          // a quick tap with two fingers undoes, with three redoes
          if (!g.moved && !cancelled && performance.now() - g.t0 < TAP_MS) {
            if (g.fingers === 2) this.undo();
            else if (g.fingers >= 3) this.redo();
          }
          this.gesture = null;
        }
        return;
      }
    }
    const d = this.drag;
    if (!d) return;
    const doc = this.toDoc(e.clientX, e.clientY);
    this.drag = null;
    if (cancelled) {
      this.discard(d);
      this.tempTool = null;
      this.updateCursor();
      this.changed(false);
      return;
    }
    switch (d.kind) {
      case 'stroke':
        if (d.tool !== 'pencil') {
          // smoothing lags behind the pointer: finish the line at the point where it was let go
          this.dab(d, d.stroke.last, { x: doc.x, y: doc.y, p: d.stroke.last.p });
        }
        this.finishStroke(d);
        break;
      case 'shape':
        d.x1 = doc.x;
        d.y1 = doc.y;
        d.shift = e.shiftKey;
        this.finishShape(d);
        break;
      case 'marquee':
        if (this.selection && (this.selection.rect.w < 2 || this.selection.rect.h < 2)) this.selection = null;
        break;
      case 'crop':
        if (this.cropBox && (this.cropBox.w < 2 || this.cropBox.h < 2)) this.cropBox = null;
        break;
      case 'textmove': {
        const after = d.layer.texts.map((t) => ({ ...t }));
        const before = d.before;
        const layer = d.layer;
        if (JSON.stringify(after) !== JSON.stringify(before)) {
          layer.texts = after;
          this.pushToggle(
            'Move text',
            () => (layer.texts = before),
            () => (layer.texts = after),
          );
        }
        break;
      }
      case 'click':
        if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 8) this.clickAt(this.tempTool ?? this.tool, d.x, d.y);
        break;
      case 'move':
      case 'resize':
      case 'pan':
        break;
    }
    this.tempTool = null;
    this.updateCursor();
    this.changed(false);
  }

  /** Abort what the pointer was doing without keeping any of it (a second finger landed). */
  private cancelDrag(): void {
    const d = this.drag;
    this.drag = null;
    if (d) this.discard(d);
  }

  private discard(d: Drag): void {
    if (d.kind === 'stroke') {
      if (d.tool === 'eraser' && d.stroke.snap)
        d.stroke.snap.swap(this.surface(d.layer)); // put the pixels back
      else this.clearStroke(d.stroke.bounds);
    } else if (d.kind === 'textmove') {
      d.layer.texts = d.before;
    }
    this.render();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const v = this.toView(e.clientX, e.clientY);
    if (e.ctrlKey || e.metaKey) {
      this.zoomBy(Math.exp(-e.deltaY * 0.01), v.x, v.y);
    } else {
      this.autoFit = false;
      this.panX -= e.shiftKey ? e.deltaY : e.deltaX;
      this.panY -= e.shiftKey ? 0 : e.deltaY;
      this.changedSoon();
      this.render();
    }
  }

  // --- strokes ---------------------------------------------------------------------

  /** Draw the part of a stroke from `a` to `b`. */
  private dab(d: Extract<Drag, { kind: 'stroke' }>, a: Sample, b: Sample): void {
    const { tool, layer, stroke } = d;
    const size = this.options.sizes[tool];
    if (tool === 'pencil') {
      const ctx = ctxOf(this.ensureStrokeCanvas());
      ctx.strokeStyle = this.colour;
      ctx.fillStyle = this.colour;
      ctx.lineWidth = size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      if (a.x === b.x && a.y === b.y) ctx.arc(a.x, a.y, size / 2, 0, Math.PI * 2);
      else {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.fill();
      ctx.stroke();
      stroke.bounds = unionRect(stroke.bounds, growRect(rectFromCorners(a.x, a.y, b.x, b.y), size + 2));
      return;
    }
    const first = a === b;
    const spacing = stampSpacing(size);
    const { stamps, carry } = first ? { stamps: [b], carry: 0 } : stampsAlong(a, b, spacing, stroke.carry);
    stroke.carry = carry;
    for (const s of stamps) {
      const st = pressureStamp(size, s.p, this.options.pressure, this.options.pressureTarget);
      const stampImg = this.stampFor(size, this.options.softness, tool === 'eraser' ? '#000000' : this.colour);
      const half = st.size / 2;
      const rect = growRect({ x: s.x - half, y: s.y - half, w: st.size, h: st.size }, 2);
      if (tool === 'eraser') {
        stroke.snap?.capture(this.surface(layer), rect);
        const ctx = layer.ctx;
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.globalAlpha = (this.options.opacity / 100) * st.flow;
        ctx.drawImage(stampImg, s.x - half, s.y - half, st.size, st.size);
        ctx.restore();
      } else {
        const ctx = ctxOf(this.ensureStrokeCanvas());
        ctx.globalAlpha = st.flow;
        ctx.drawImage(stampImg, s.x - half, s.y - half, st.size, st.size);
        ctx.globalAlpha = 1;
      }
      stroke.bounds = unionRect(stroke.bounds, rect);
    }
  }

  private clearStroke(bounds: Rect | null): void {
    const c = this.strokeCanvas;
    if (!c) return;
    const r = bounds ? clipRect(bounds, c.width, c.height) : null;
    if (r) ctxOf(c).clearRect(r.x, r.y, r.w, r.h);
  }

  private finishStroke(d: Extract<Drag, { kind: 'stroke' }>): void {
    const { tool, layer, stroke } = d;
    if (tool === 'eraser') {
      if (stroke.snap) this.pushPixels(layer, stroke.snap, 'Erase');
      return;
    }
    const b = stroke.bounds ? clipRect(stroke.bounds, this.width, this.height) : null;
    const sc = this.strokeCanvas;
    if (!b || !sc) return;
    const snap = new TileSnapshot(this.width, this.height);
    snap.capture(this.surface(layer), b);
    layer.ctx.globalAlpha = stroke.opacity;
    layer.ctx.drawImage(sc, b.x, b.y, b.w, b.h, b.x, b.y, b.w, b.h);
    layer.ctx.globalAlpha = 1;
    ctxOf(sc).clearRect(b.x, b.y, b.w, b.h);
    this.pushPixels(layer, snap, tool === 'pencil' ? 'Pencil' : 'Brush');
    this.addRecent();
  }

  private addRecent(): void {
    if (this.recent[0] !== this.colour) this.recent = pushRecent(this.recent, this.colour);
  }

  private finishShape(d: Extract<Drag, { kind: 'shape' }>): void {
    const spec = this.shapeSpec(d);
    const layer = this.activeLayer();
    if (!spec || (spec.x0 === spec.x1 && spec.y0 === spec.y1)) return;
    const b = clipRect(this.shapeBounds(spec), this.width, this.height);
    if (!b) return;
    const snap = new TileSnapshot(this.width, this.height);
    snap.capture(this.surface(layer), b);
    this.paintShape(layer.ctx, spec);
    this.pushPixels(layer, snap, spec.kind === 'line' ? (spec.arrow ? 'Arrow' : 'Line') : 'Shape');
    this.addRecent();
  }

  // --- clicks: fill, pick, text -----------------------------------------------------

  private clickAt(tool: ToolId, x: number, y: number): void {
    if (tool === 'fill') this.fillAt(x, y);
    else if (tool === 'picker') this.pickAt(x, y);
    else if (tool === 'text') this.textAt(x, y);
  }

  private composite(): Raster {
    const flat = this.flatten();
    return ctxOf(flat).getImageData(0, 0, this.width, this.height);
  }

  /** Fill the closed area under a point with the colour, on the selected layer. */
  fillAt(x: number, y: number): void {
    const layer = this.activeLayer();
    if (!this.canDraw(layer)) return;
    this.commitSelection();
    const mask = floodMask(this.composite(), x, y, (this.options.tolerance / 100) * 255);
    if (!mask) return;
    const grown = growMask(mask, 1);
    const [r, g, b] = hexToRgb(this.colour);
    const patch = maskToPatch(grown, [r, g, b, Math.round((this.options.opacity / 100) * 255)]);
    const snap = new TileSnapshot(this.width, this.height);
    snap.capture(this.surface(layer), grown.bounds);
    const tmp = makeCanvas(patch.width, patch.height);
    ctxOf(tmp).putImageData(
      new ImageData(patch.data as Uint8ClampedArray<ArrayBuffer>, patch.width, patch.height),
      0,
      0,
    );
    layer.ctx.drawImage(tmp, grown.bounds.x, grown.bounds.y);
    this.pushPixels(layer, snap, 'Fill');
    this.addRecent();
    this.changed();
  }

  /** Use the colour of the pixel under a point (what is seen, all layers together). */
  pickAt(x: number, y: number): void {
    const px = Math.floor(x);
    const py = Math.floor(y);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) return;
    const d = ctxOf(this.flatten()).getImageData(px, py, 1, 1).data;
    if (d[3] === 0) return;
    this.setColour(rgbToHex(d[0], d[1], d[2]));
  }

  // --- text -------------------------------------------------------------------------

  private textBounds(t: SourceText): Rect | null {
    const ctx = (this.measure ??= ctxOf(makeCanvas(1, 1)));
    ctx.font = fontOf(t);
    const lines = t.text.split('\n');
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width), 1);
    return { x: t.x, y: t.y, w, h: lines.length * t.size * 1.25 };
  }

  private textAt(x: number, y: number): void {
    const layer = this.activeLayer();
    const hit = [...layer.texts].reverse().find((t) => {
      const b = this.textBounds(t);
      return b && rectContains(growRect(b, 4), x, y);
    });
    if (hit) {
      if (!this.canDraw(layer)) return;
      this.beginText(layer, hit.id, hit.x, hit.y, hit.text);
      return;
    }
    if (!this.canDraw(layer)) return;
    this.beginText(layer, null, Math.round(x), Math.round(y), '');
  }

  private beginText(layer: Layer, id: string | null, x: number, y: number, text: string): void {
    this.textEdit = { id, layer, x, y };
    this.textDraft = text;
    this.selectedTextId = null;
    this.changed(false);
  }

  /**
   * The text box content changed.
   * @param text - What is typed.
   */
  setTextDraft(text: string): void {
    this.textDraft = text;
    this.changed(false);
  }

  /**
   * Finish typing text.
   * @param keep - True to keep what was typed; false to drop it.
   */
  endText(keep: boolean): void {
    const e = this.textEdit;
    if (!e) return;
    this.textEdit = null;
    const text = this.textDraft.replace(/\s+$/g, '');
    this.textDraft = '';
    const layer = e.layer;
    const before = layer.texts;
    if (!keep) {
      this.changed(false);
      return;
    }
    let after: SourceText[];
    if (e.id) {
      after = text ? before.map((t) => (t.id === e.id ? { ...t, text } : t)) : before.filter((t) => t.id !== e.id);
      if (after.length === before.length && after.every((t, i) => t.text === before[i].text)) {
        this.changed(false);
        return;
      }
    } else if (text) {
      const id = `t${Date.now().toString(36)}${before.length}`;
      after = [
        ...before,
        {
          id,
          x: e.x,
          y: e.y,
          text,
          size: this.options.sizes.text,
          color: this.colour,
          bold: this.options.bold || undefined,
        },
      ];
      this.addRecent();
    } else {
      this.changed(false);
      return;
    }
    layer.texts = after;
    this.pushToggle(
      'Text',
      () => (layer.texts = before),
      () => (layer.texts = after),
    );
    this.changed();
  }

  private restyleSelectedText(patch: Partial<SourceText>): void {
    const layer = this.activeLayer();
    const id = this.selectedTextId;
    if (!id) return;
    const before = layer.texts;
    const after = before.map((t) => (t.id === id ? { ...t, ...patch } : t));
    layer.texts = after;
    this.pushToggle(
      'Text style',
      () => (layer.texts = before),
      () => (layer.texts = after),
    );
  }

  // --- select and move ----------------------------------------------------------------

  private beginSelect(p: { x: number; y: number }, e: PointerEvent): void {
    const sel = this.selection;
    if (sel) {
      const handle = this.hitHandle(sel.dest, p.x, p.y);
      if (handle) {
        this.drag = { kind: 'resize', handle, start: { ...sel.dest } };
        return;
      }
      if (rectContains(sel.dest, p.x, p.y)) {
        this.drag = { kind: 'move', dx: p.x - sel.dest.x, dy: p.y - sel.dest.y };
        return;
      }
      this.commitSelection();
    }
    const layer = this.activeLayer();
    const text = [...layer.texts].reverse().find((t) => {
      const b = this.textBounds(t);
      return b && rectContains(growRect(b, 4), p.x, p.y);
    });
    if (text && !layer.locked) {
      this.selectedTextId = text.id;
      this.drag = {
        kind: 'textmove',
        layer,
        id: text.id,
        dx: p.x - text.x,
        dy: p.y - text.y,
        before: layer.texts.map((t) => ({ ...t })),
      };
      return;
    }
    this.selectedTextId = null;
    if (!this.canDraw(layer)) return;
    this.drag = { kind: 'marquee', x0: p.x, y0: p.y };
    void e;
  }

  private resizedRect(start: Rect, handle: string, x: number, y: number, keepShape: boolean): Rect {
    let x0 = start.x;
    let y0 = start.y;
    let x1 = start.x + start.w;
    let y1 = start.y + start.h;
    if (handle.includes('w')) x0 = x;
    if (handle.includes('e')) x1 = x;
    if (handle.includes('n')) y0 = y;
    if (handle.includes('s')) y1 = y;
    let r = rectFromCorners(x0, y0, x1, y1);
    if (keepShape && handle.length === 2) {
      const k = Math.max(r.w / start.w, r.h / start.h);
      const w = start.w * k;
      const h = start.h * k;
      r = {
        x: handle.includes('w') ? start.x + start.w - w : start.x,
        y: handle.includes('n') ? start.y + start.h - h : start.y,
        w,
        h,
      };
    }
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.max(1, Math.round(r.w)), h: Math.max(1, Math.round(r.h)) };
  }

  /** Cut the selected pixels off the layer so they can be moved. */
  private liftSelection(): void {
    const sel = this.selection;
    if (!sel || sel.floating) return;
    const layer = sel.layer;
    const snap = new TileSnapshot(this.width, this.height);
    snap.capture(this.surface(layer), sel.rect);
    const floating = makeCanvas(sel.rect.w, sel.rect.h);
    ctxOf(floating).drawImage(
      layer.canvas,
      sel.rect.x,
      sel.rect.y,
      sel.rect.w,
      sel.rect.h,
      0,
      0,
      sel.rect.w,
      sel.rect.h,
    );
    layer.ctx.clearRect(sel.rect.x, sel.rect.y, sel.rect.w, sel.rect.h);
    sel.floating = floating;
    sel.snap = snap;
  }

  /** Put a moved selection down on its layer, as one undoable step. */
  commitSelection(): void {
    const sel = this.selection;
    if (!sel) return;
    this.selection = null;
    if (sel.floating && sel.snap) {
      const dest = clipRect(sel.dest, this.width, this.height);
      if (dest) sel.snap.capture(this.surface(sel.layer), dest);
      sel.layer.ctx.imageSmoothingQuality = 'high';
      sel.layer.ctx.drawImage(sel.floating, sel.dest.x, sel.dest.y, sel.dest.w, sel.dest.h);
      this.pushPixels(sel.layer, sel.snap, 'Move selection');
    }
    this.changed(false); // putting a move down is an edit (the history says so); dropping a plain box is not
  }

  /** Delete what is inside the selection (or the selected text). */
  deleteSelection(): void {
    const sel = this.selection;
    if (sel) {
      this.selection = null;
      if (!sel.floating) {
        const snap = new TileSnapshot(this.width, this.height);
        snap.capture(this.surface(sel.layer), sel.rect);
        sel.layer.ctx.clearRect(sel.rect.x, sel.rect.y, sel.rect.w, sel.rect.h);
        this.pushPixels(sel.layer, snap, 'Delete selection');
      } else if (sel.snap) {
        this.pushPixels(sel.layer, sel.snap, 'Delete selection'); // the lift already cleared it
      }
      this.changed();
      return;
    }
    const id = this.selectedTextId;
    if (id) {
      const layer = this.activeLayer();
      const before = layer.texts;
      const after = before.filter((t) => t.id !== id);
      layer.texts = after;
      this.selectedTextId = null;
      this.pushToggle(
        'Delete text',
        () => (layer.texts = before),
        () => (layer.texts = after),
      );
      this.changed();
    }
  }

  /** Drop the selection, the crop box and an unfinished text. */
  cancel(): void {
    const sel = this.selection;
    if (sel?.floating && sel.snap) {
      sel.snap.swap(this.surface(sel.layer)); // Esc puts a half-made move back where it was
      sel.layer.rev++;
    }
    this.selection = null;
    this.endText(false);
    this.cropBox = null;
    this.selectedTextId = null;
    this.changed(false);
  }

  /** Select the whole layer (Ctrl+A with the Select tool). */
  selectAll(): void {
    const layer = this.activeLayer();
    if (!this.canDraw(layer)) return;
    this.commitSelection();
    const rect = { x: 0, y: 0, w: this.width, h: this.height };
    this.selection = { layer, rect, dest: { ...rect }, floating: null, snap: null };
    this.changed(false);
  }
}
