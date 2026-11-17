/**
 * How the parts of the block editing layer reach each other: a node view (an image's Replace, a table's properties)
 * or the Insert catalog asks for a dialog or panel that the block layer (BlockLayer) draws. One bus per editor, kept
 * in the BlockKit extension's storage.
 */

import type { Editor } from '@tiptap/core';

/** The image properties panel's tabs. */
export type ImageTab = 'layout' | 'style' | 'text';

/** What the layer is asked to open. */
export type BlockUiRequest =
  /** The Insert image dialog; with `replacePos`, it replaces that image's picture and keeps its place and size. */
  | { type: 'insertImage'; replacePos?: number }
  /** The image properties panel for the image at `pos`. */
  | { type: 'imageProps'; pos: number; tab?: ImageTab }
  /** The crop frame for the image at `pos`. */
  | { type: 'crop'; pos: number }
  /** The block menu for the block at `pos`, by `anchor` (a sheet on a phone). */
  | { type: 'blockMenu'; pos: number; anchor: DOMRect | null }
  /** Start choosing several blocks (the phone's checkboxes), with the block at `pos` chosen. */
  | { type: 'selectBlocks'; pos: number }
  /** Shift+click on a handle: choose the blocks from the last chosen one (or the cursor's) to the block at `pos`. */
  | { type: 'chooseBlock'; pos: number };

type Listener = (req: BlockUiRequest) => void;

/** A tiny event bus: the layer listens, node views and menus ask. */
export class BlockBus {
  private listeners = new Set<Listener>();

  /** Listens to requests; returns the function that stops it. */
  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Sends a request to whoever listens (nothing happens when no layer is mounted). */
  emit(req: BlockUiRequest): void {
    this.listeners.forEach((l) => l(req));
  }
}

/** What BlockKit keeps per editor. */
export interface BlockKitStorage {
  bus: BlockBus;
  /** The project's image upload limit in MB (Docs settings `uploads.imageMb`). */
  imageLimitMb: number;
}

/** The block layer's storage of an editor, or null when the editor has no BlockKit (a headless converter). */
export function blockKitOf(editor: Editor | null | undefined): BlockKitStorage | null {
  const s = (editor?.storage as unknown as Record<string, unknown> | undefined)?.blockKit;
  return (s as BlockKitStorage | undefined) ?? null;
}

/** Sends `req` to the editor's block layer. */
export function askBlockUi(editor: Editor | null | undefined, req: BlockUiRequest): void {
  blockKitOf(editor)?.bus.emit(req);
}
