import { DiagramIcon } from './DiagramIcon';
import { firstDiagramFile } from './diagramFile';

/**
 * True when a drag carries a file that could be a draw.io diagram (.drawio has no MIME type; .xml and .svg do).
 * Plain images keep the editor's own image drop.
 * @param dt - The drag's data transfer.
 */
export function isDiagramDrag(dt: DataTransfer | null): boolean {
  return Array.from(dt?.items ?? []).some((i) => i.kind === 'file' && (i.type === '' || /xml|svg/.test(i.type)));
}

/**
 * "Drop a diagram file here" card shown over an editor while a diagram file is dragged onto it (Diagrams board E).
 * @param props.onFile - Called with the dropped diagram file.
 * @param props.onChoose - Opens the file picker.
 * @param props.onDone - Called when the drop ends, whatever was dropped.
 */
export function DiagramDropZone({
  onFile,
  onChoose,
  onDone,
}: {
  onFile: (file: File) => void;
  onChoose: () => void;
  onDone: () => void;
}) {
  return (
    <div
      data-testid="diagram-drop-zone"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const file = firstDiagramFile(e.dataTransfer.files);
        onDone();
        if (file) onFile(file);
      }}
      style={{
        position: 'sticky',
        top: 12,
        zIndex: 5,
        height: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 8,
          padding: '28px 24px',
          borderRadius: 12,
          border: '2px dashed #4E9A62',
          background: 'rgba(237, 246, 239, 0.97)',
          textAlign: 'center',
          boxShadow: '0 8px 24px rgba(30, 42, 34, 0.12)',
        }}
      >
        <span
          style={{
            width: 48,
            height: 48,
            borderRadius: '50%',
            background: '#D5EAD9',
            color: '#2E6F40',
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <DiagramIcon name="upload" size={22} />
        </span>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#1E2A22' }}>Drop a diagram file here</div>
        <div style={{ fontSize: 12.5, color: '#5B6B60', lineHeight: 1.5, maxWidth: 380 }}>
          .drawio, .xml or .svg exported from draw.io. It opens in the editor so you can check it before saving.
        </div>
        <button type="button" className="st-btn" onClick={onChoose}>
          <DiagramIcon name="file" size={14} /> Choose file
        </button>
      </div>
    </div>
  );
}
