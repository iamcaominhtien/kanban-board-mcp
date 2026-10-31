import { useCallback } from 'react';
import { sketchMarkdown, type SketchOwnerKind } from '../../api/sketches';
import { useSketch } from './SketchContext';

interface Options {
  /** What the drawing belongs to; without it nothing can be started. */
  ownerKind: SketchOwnerKind;
  /** Id of that page, ticket or idea. A comment that is still being written has none yet: the project stands in. */
  ownerId?: string;
  projectId?: string;
  /** Shown in the editor header: "in page “Release notes”". */
  ownerLabel?: string;
  /** Receives the markdown line to insert once the drawing is saved. */
  onInsert: (markdown: string) => void;
}

interface Starter {
  /** False when there is no provider or nothing to attach the drawing to: hide the Sketch action. */
  available: boolean;
  /** Open the "New sketch" dialog, then the editor; inserts the drawing on Done. */
  start: () => Promise<void>;
}

/**
 * The "Sketch" action of a markdown field: start a drawing, then insert its line.
 * @param opts - Owner, project and what to do with the markdown line.
 */
export function useSketchStarter(opts: Options): Starter {
  const api = useSketch();
  const { ownerKind, ownerId, projectId, ownerLabel, onInsert } = opts;
  const owner = ownerId || projectId || '';
  const start = useCallback(async () => {
    const r = await api.openSketch({ ownerKind, ownerId: owner, projectId, ownerLabel });
    if (r) onInsert(sketchMarkdown({ id: r.id, title: r.title }));
  }, [api, ownerKind, owner, projectId, ownerLabel, onInsert]);
  return { available: api.available && !!owner, start };
}
