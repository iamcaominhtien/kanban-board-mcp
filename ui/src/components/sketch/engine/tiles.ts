import { clipRect, copyRegion, type Raster, type Rect } from './raster.ts';

/** Edge of a tile in px. A change keeps only the tiles it touches, not the whole layer. */
export const TILE = 128;

/** Something pixels can be read from and written to: a layer canvas in the editor, a raster in tests. */
export interface Surface {
  width: number;
  height: number;
  /** Read a region that lies inside the surface. */
  read(r: Rect): Raster;
  /** Overwrite the pixels at (x, y) with the patch, without blending. */
  write(x: number, y: number, patch: Raster): void;
}

/**
 * The "before" pixels of the tiles one change touched; the undo record of that change.
 * `capture` before changing pixels (a tile already held is not copied again), then `swap` to undo and
 * `swap` again to redo: each call puts the held pixels back and keeps what was there.
 */
export class TileSnapshot {
  private tiles = new Map<number, { x: number; y: number; px: Raster }>();
  private cols: number;
  private width: number;
  private height: number;

  /**
   * @param width - Width of the surface the snapshot is for.
   * @param height - Height of the surface.
   */
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.cols = Math.ceil(width / TILE);
  }

  /**
   * Keep the pixels of every tile the rectangle touches that is not held yet.
   * @param surface - Surface to read from, before the change is made.
   * @param rect - The area about to change.
   */
  capture(surface: Surface, rect: Rect): void {
    const r = clipRect(rect, this.width, this.height);
    if (!r) return;
    const tx0 = Math.floor(r.x / TILE);
    const tx1 = Math.floor((r.x + r.w - 1) / TILE);
    const ty0 = Math.floor(r.y / TILE);
    const ty1 = Math.floor((r.y + r.h - 1) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const key = ty * this.cols + tx;
        if (this.tiles.has(key)) continue;
        const x = tx * TILE;
        const y = ty * TILE;
        const tile = { x, y, w: Math.min(TILE, this.width - x), h: Math.min(TILE, this.height - y) };
        this.tiles.set(key, { x, y, px: surface.read(tile) });
      }
    }
  }

  /**
   * Exchange the held tiles with what the surface shows now: undoes a change, or redoes it when called again.
   * @param surface - The surface to write to.
   */
  swap(surface: Surface): void {
    for (const t of this.tiles.values()) {
      const now = surface.read({ x: t.x, y: t.y, w: t.px.width, h: t.px.height });
      surface.write(t.x, t.y, t.px);
      t.px = now;
    }
  }

  /** Whether nothing was captured (the change touched no pixels). */
  get empty(): boolean {
    return this.tiles.size === 0;
  }

  /** Memory held, in bytes. */
  get bytes(): number {
    let n = 0;
    for (const t of this.tiles.values()) n += t.px.data.length;
    return n;
  }
}

/**
 * A surface over a raster in memory.
 * @param raster - The raster to wrap; changes show in it.
 */
export function rasterSurface(raster: Raster): Surface {
  return {
    width: raster.width,
    height: raster.height,
    read: (r) => copyRegion(raster, r),
    write: (x, y, patch) => {
      for (let row = 0; row < patch.height; row++) {
        const to = ((y + row) * raster.width + x) * 4;
        raster.data.set(patch.data.subarray(row * patch.width * 4, (row + 1) * patch.width * 4), to);
      }
    },
  };
}
