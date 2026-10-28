import { useMemo, useState, type ReactNode } from 'react';
import type { Diagram } from '../../api/diagrams';
import { DiagramEditor } from './DiagramEditor';
import { DiagramViewer } from './DiagramViewer';
import { DiagramsContext, type DiagramsApi, type EditorRequest } from './DiagramsContext';
import { readDiagramFile } from './diagramFile';

interface Viewing {
  diagram: Pick<Diagram, 'id' | 'label' | 'version'>;
  version?: number;
}

/**
 * Hosts the diagram editor layer and the full-size viewer for the whole app.
 * @param props.children - The app.
 */
export function DiagramsProvider({ children }: { children: ReactNode }) {
  const [editor, setEditor] = useState<EditorRequest | null>(null);
  const [viewer, setViewer] = useState<Viewing | null>(null);

  const api = useMemo<DiagramsApi>(
    () => ({
      openEditor: (req) => setEditor(req),
      importFile: async (req, file) => {
        const initialXml = await readDiagramFile(file);
        setEditor({ ...req, initialXml, label: req.label ?? file.name.replace(/\.[^.]+$/, '') });
      },
      openViewer: (diagram, version) => setViewer({ diagram, version }),
    }),
    [],
  );

  return (
    <DiagramsContext.Provider value={api}>
      {children}
      {editor && <DiagramEditor request={editor} onClose={() => setEditor(null)} />}
      {viewer && <DiagramViewer diagram={viewer.diagram} version={viewer.version} onClose={() => setViewer(null)} />}
    </DiagramsContext.Provider>
  );
}
