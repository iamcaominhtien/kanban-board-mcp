import { useCallback } from 'react';
import { canvasMarkdown, type CanvasOwnerKind } from '../../api/canvases';
import { useCanvas } from './CanvasContext';

interface Options {
  /** What the canvas belongs to; without it nothing can be started. */
  ownerKind: CanvasOwnerKind;
  /** Id of that page, ticket or idea. A comment that is still being written has none yet: the project stands in. */
  ownerId?: string;
  projectId?: string;
  /** Shown in the editor header: "in ticket KAN-142". */
  ownerLabel?: string;
  /** Receives the markdown line to insert once the canvas is saved. */
  onInsert: (markdown: string) => void;
}

interface Starter {
  /** False when there is no provider or nothing to attach the canvas to: hide the Canvas action. */
  available: boolean;
  /** Open the "New canvas" dialog, then the editor; inserts the canvas on Done. */
  start: () => Promise<void>;
}

/**
 * The "Canvas" action of a markdown field: start a canvas, then insert its line.
 * @param opts - Owner, project and what to do with the markdown line.
 */
export function useCanvasStarter(opts: Options): Starter {
  const api = useCanvas();
  const { ownerKind, ownerId, projectId, ownerLabel, onInsert } = opts;
  const owner = ownerId || projectId || '';
  const start = useCallback(async () => {
    const r = await api.openCanvas({ ownerKind, ownerId: owner, projectId, ownerLabel });
    if (r) onInsert(canvasMarkdown({ id: r.id, title: r.title }));
  }, [api, ownerKind, owner, projectId, ownerLabel, onInsert]);
  return { available: api.available && !!owner, start };
}
