declare module 'gifenc' {
  /** Reduce RGBA pixels to a palette of at most `maxColors` colours. */
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, options?: object): number[][];
  /** Map RGBA pixels to indexes into `palette`. */
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: number[][], format?: string): Uint8Array;
  export interface GifEncoder {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      options?: { palette?: number[][]; delay?: number; repeat?: number },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  }
  export function GIFEncoder(): GifEncoder;
}
