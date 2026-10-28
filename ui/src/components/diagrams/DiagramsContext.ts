import { createContext, useContext } from 'react';
import type { Diagram } from '../../api/diagrams';

/** What opens the editor: a new drawing, an imported one, or an existing diagram. */
export interface EditorRequest {
  projectId: string;
  /** Edit this diagram; leave empty for a new one. */
  diagramId?: string;
  /** Start a new drawing from this draw.io XML (an imported file). */
  initialXml?: string;
  label?: string;
  /** Where it will live, shown as "Saves to: …". */
  saveTo?: string;
  itemKind?: 'ticket' | 'comment' | 'doc';
  itemId?: string;
  /** The text can be pointed at a copy (`onSaved` with `asCopy`); otherwise the copy's markdown goes to the clipboard. */
  replaces?: boolean;
  /** Called after a save. `asCopy` means the saved diagram has a new id the text should point to. */
  onSaved: (d: Diagram, info: { created: boolean; asCopy: boolean }) => void;
}

export interface DiagramsApi {
  /** Open the editor layer. */
  openEditor: (req: EditorRequest) => void;
  /** Open an imported file in the editor so it can be checked before saving. */
  importFile: (req: Omit<EditorRequest, 'initialXml'>, file: File) => Promise<void>;
  /** Open the full-size viewer. */
  openViewer: (d: Pick<Diagram, 'id' | 'label' | 'version'>, version?: number) => void;
}

/** Carries the diagram actions from `DiagramsProvider` down to every markdown field. */
export const DiagramsContext = createContext<DiagramsApi | null>(null);

/**
 * The diagram actions (editor and viewer), or null outside a provider.
 */
export function useDiagrams(): DiagramsApi | null {
  return useContext(DiagramsContext);
}
