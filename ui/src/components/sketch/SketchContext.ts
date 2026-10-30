import { createContext, useContext } from 'react';
import type { Sketch, SketchOwnerKind } from '../../api/sketches';

/** What to open the editor with. Everything but the owner is optional. */
export interface OpenSketchRequest {
  ownerKind: SketchOwnerKind;
  ownerId: string;
  /** Edit this saved sketch; leave empty to make a new one. */
  sketchId?: string;
  /** Draw on this picture (an address from the uploads folder): it goes on its own locked layer and is never changed. */
  baseImageUrl?: string;
  /** Name of the drawing. */
  title?: string;
  /** Start a blank page of this size straight away, without the "New sketch" dialog. */
  size?: { w: number; h: number; background: 'white' | 'clear' };
  /** Project, when the owner does not say (a comment still being written). */
  projectId?: string;
  /** Shown under the title: "in idea “…”". */
  ownerLabel?: string;
  /** Open the unsaved draft kept on this computer instead of asking. */
  restoreDraft?: boolean;
  /** Open with the AI panel shown (the "Ask AI" button of an embedded sketch); ignored when AI is not available. */
  openAi?: boolean;
}

/** What `openSketch` resolves to once the person pressed Done. */
export interface SketchResult {
  id: string;
  /** Shows the picture when used as an image source; changes with each save. */
  pngUrl: string;
  title: string;
  version: number;
  /** The line that places the drawing in a text: `![title](sketch:id)`. */
  markdown: string;
  sketch: Sketch;
}

/** The sketch tool, for any part of the app. */
export interface SketchApi {
  /**
   * Open the full-screen editor and wait for the person to finish.
   * @returns The saved drawing when they pressed Done (or saved a copy); null when they closed it without saving.
   */
  openSketch: (req: OpenSketchRequest) => Promise<SketchResult | null>;
  /** Show a drawing large (viewers can do this too). */
  openViewer: (s: { id: string; title: string; version?: number }) => void;
  /** False outside a `SketchProvider`: `openSketch` then resolves null at once. */
  available: boolean;
}

const NONE: SketchApi = {
  openSketch: () => Promise.resolve(null),
  openViewer: () => undefined,
  available: false,
};

/** Carries the sketch actions from `SketchProvider` down to every markdown field. */
export const SketchContext = createContext<SketchApi>(NONE);

/**
 * The sketch tool: `const { openSketch } = useSketch()`.
 */
export function useSketch(): SketchApi {
  return useContext(SketchContext);
}

/** Where a drawing made from a picture in the file viewer belongs: set by the page that shows the attachments. */
export interface SketchOwner {
  ownerKind: SketchOwnerKind;
  ownerId: string;
  projectId?: string;
  ownerLabel?: string;
  /** Called with the saved drawing, so the page can add it to its text (as the file viewer has no text of its own). */
  onSaved?: (r: SketchResult) => void;
}

/** The owner "Draw on it" saves to; null where no page has said (the button is then hidden). */
export const SketchOwnerContext = createContext<SketchOwner | null>(null);
