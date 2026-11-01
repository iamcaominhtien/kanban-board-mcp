import { createContext, useContext } from 'react';
import type { Canvas, CanvasOwnerKind } from '../../api/canvases';

/** What to open the editor with. Everything but the owner is optional. */
export interface OpenCanvasRequest {
  ownerKind: CanvasOwnerKind;
  ownerId: string;
  /** Edit this saved canvas; leave empty to make a new one (the "New canvas" dialog). */
  canvasId?: string;
  /** Select this board when the editor opens. */
  boardId?: string;
  /** Project, when the owner does not say (a comment still being written). */
  projectId?: string;
  /** Shown in the header: "in ticket KAN-142". */
  ownerLabel?: string;
  /** Name for a new canvas. */
  title?: string;
  /** Skip the dialog: make a blank canvas straight away. */
  blank?: boolean;
  /** Open with the "Ask AI" panel (selected boards) already shown. */
  openAi?: boolean;
}

/** What `openCanvas` resolves to once the editor closes after a save. */
export interface CanvasResult {
  id: string;
  title: string;
  /** The line that places the canvas in a text: `![title](canvas:id)`. */
  markdown: string;
  canvas: Canvas;
}

/** What the large view opens with. */
export interface ViewCanvasRequest {
  id: string;
  boardId?: string;
  pageId?: string;
  /** Start with the comments panel open. */
  comments?: boolean;
}

/** The canvas tool, for any part of the app. */
export interface CanvasApi {
  /** Open the full-window editor and wait for the person to finish; null when closed without a canvas. */
  openCanvas: (req: OpenCanvasRequest) => Promise<CanvasResult | null>;
  /** Show a canvas large, read only (everyone can do this). */
  openViewer: (req: ViewCanvasRequest) => void;
  /** Present a canvas: dark full screen, board by board. */
  present: (req: ViewCanvasRequest) => void;
  /** False outside a `CanvasProvider`. */
  available: boolean;
}

const NONE: CanvasApi = {
  openCanvas: () => Promise.resolve(null),
  openViewer: () => undefined,
  present: () => undefined,
  available: false,
};

/** Carries the canvas actions from `CanvasProvider` down to every markdown field. */
export const CanvasContext = createContext<CanvasApi>(NONE);

/** The canvas tool: `const { openCanvas } = useCanvas()`. */
export function useCanvas(): CanvasApi {
  return useContext(CanvasContext);
}

/** Where a picture or page opened from the file viewer can be put on a canvas: set by the page that shows files. */
export interface CanvasOwner {
  ownerKind: CanvasOwnerKind;
  ownerId: string;
  projectId?: string;
  ownerLabel?: string;
  /** Called with the markdown of a canvas made from a file, so the page can add it to its text. */
  onCreated?: (markdown: string, title: string) => void;
}

/** The owner "Open on a canvas" saves to; null where no page has said (the button is then hidden). */
export const CanvasOwnerContext = createContext<CanvasOwner | null>(null);
