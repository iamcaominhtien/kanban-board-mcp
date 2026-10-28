import { useCallback, useRef, type ReactElement } from 'react';
import { diagramMarkdown } from '../../api/diagrams';
import { useToast } from '../Toast';
import { useDiagrams } from './DiagramsContext';
import { DiagramFileError } from './diagramFile';

interface Options {
  /** Project the diagram belongs to; without it nothing can be started. */
  projectId?: string;
  /** Shown in the editor header as "Saves to: …". */
  saveTo?: string;
  itemKind?: 'ticket' | 'comment' | 'doc';
  itemId?: string;
  /** Receives the markdown line to insert once the diagram is saved. */
  onInsert: (markdown: string) => void;
}

interface Starter {
  /** False when there is no project or no provider: hide the Diagram action. */
  available: boolean;
  /** Open the editor on a blank drawing. */
  startNew: () => void;
  /** Open the file chooser; the chosen file opens in the editor. */
  pickFile: () => void;
  /** Open a dropped or chosen file in the editor. */
  startImport: (file: File) => Promise<void>;
  /** The hidden file input; render it once next to the action. */
  fileInput: ReactElement;
}

/**
 * The "Diagram" action of a markdown field: start a drawing or import a file, then insert its line.
 * @param opts - Project, destination and what to do with the markdown line.
 */
export function useDiagramStarter(opts: Options): Starter {
  const api = useDiagrams();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const { projectId, saveTo, itemKind, itemId, onInsert } = opts;

  const request = useCallback(
    () => ({
      projectId: projectId ?? '',
      saveTo,
      itemKind,
      itemId,
      onSaved: (d: { id: string; label: string }) => onInsert(diagramMarkdown(d)),
    }),
    [projectId, saveTo, itemKind, itemId, onInsert],
  );

  const startImport = useCallback(
    async (file: File) => {
      if (!api || !projectId) return;
      try {
        await api.importFile(request(), file);
      } catch (err) {
        toast.error(
          "Couldn't import the file",
          err instanceof DiagramFileError ? err.message : 'It could not be read.',
        );
      }
    },
    [api, projectId, request, toast],
  );

  return {
    available: !!api && !!projectId,
    startNew: () => api?.openEditor({ ...request(), label: 'Untitled diagram' }),
    pickFile: () => input.current?.click(),
    startImport,
    fileInput: (
      <input
        ref={input}
        type="file"
        accept=".drawio,.xml,.svg"
        data-testid="diagram-file-input"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void startImport(f);
        }}
      />
    ),
  };
}
