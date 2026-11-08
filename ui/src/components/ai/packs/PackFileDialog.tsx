import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { aiPacksApi, usePackMutation } from '../../../api/aiPacks';
import { extractError } from '../../../api/extractError';
import type { PackImportResult, RolePack } from '../../../types/aiPacks';
import { LineIcon } from '../../ui/LineIcon';
import { PackModal } from './PackDialogs';
import { fileNameOf, kb, PACK_FORMAT } from './packLogic';

const NOT_A_PACK = 'This is not a role pack file.';

/** Hand the text to the browser as a file. */
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** The pack as one file: its name, format, version and size, and Download. */
function ExportCard({ projectId, pack }: { projectId: string; pack: RolePack }) {
  const file = useQuery({
    queryKey: ['ai', 'role-pack-export', projectId, pack.key, pack.version, pack.builtin],
    queryFn: () => aiPacksApi.exportFile(projectId, pack.key),
    retry: false,
  });
  const text = file.data ? JSON.stringify(file.data, null, 2) : '';
  const name = fileNameOf(pack);
  return (
    <div className="rp-field" data-testid="pack-export-card">
      <span className="ai-label">Export</span>
      <div className="rp-file">
        <LineIcon name="page" size={18} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="rp-file-name">{name}</div>
          <div className="ai-hint">
            {file.isError
              ? `Could not make the file: ${extractError(file.error)}`
              : file.data
                ? `${file.data.format} · version ${file.data.version} · ${kb(new Blob([text]).size)}`
                : 'Making the file…'}
          </div>
        </div>
        <button
          type="button"
          className="ai-btn ai-btn-sm"
          disabled={!file.data}
          onClick={() => download(name, text)}
          data-testid="pack-download"
        >
          <LineIcon name="download" size={13} />
          Download
        </button>
      </div>
    </div>
  );
}

/** Import a pack file: drop it or choose it; says what the file names that this project does not have yet. */
function ImportCard({ projectId }: { projectId: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PackImportResult | null>(null);
  const imp = usePackMutation(projectId, (data: unknown) => aiPacksApi.importFile(projectId, data));

  const read = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setResult(null);
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      setError(NOT_A_PACK);
      return;
    }
    if (!data || typeof data !== 'object' || (data as { format?: unknown }).format !== PACK_FORMAT) {
      setError(NOT_A_PACK);
      return;
    }
    try {
      setResult(await imp.mutateAsync(data));
    } catch (e) {
      setError(extractError(e));
    }
  };

  return (
    <div className="rp-field" data-testid="pack-import-card">
      <span className="ai-label">Import</span>
      <button
        type="button"
        className={`rp-drop ${over ? 'rp-drop-over' : ''}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void read(e.dataTransfer.files[0]);
        }}
        disabled={imp.isPending}
      >
        {imp.isPending ? 'Importing…' : 'Drop a role pack file here, or choose one'}
      </button>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        hidden
        data-testid="pack-import-file"
        onChange={(e) => {
          void read(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {result && (
        <div className="rp-result" role="status" data-testid="pack-import-result">
          <b>
            <LineIcon name="check" size={13} /> Imported {result.pack.name} as version {result.pack.version}.
          </b>
          {result.missing.length > 0 && (
            <span data-testid="pack-import-missing">
              Not on this project yet: <span className="rp-mono">{result.missing.join(', ')}</span>. Add them under
              Skills &amp; plugins
            </span>
          )}
        </div>
      )}
      {error && (
        <div className="ai-notice ai-notice-error" role="alert" data-testid="pack-import-error">
          {error}
        </div>
      )}
    </div>
  );
}

/** Export one pack as a file (when `pack` is given) and import one. */
export function PackFileDialog({
  projectId,
  pack,
  onClose,
}: {
  projectId: string;
  pack: RolePack | null;
  onClose: () => void;
}) {
  return (
    <PackModal
      title={pack ? `Export ${pack.name}, or import a pack` : 'Import a pack'}
      width={520}
      onClose={onClose}
      testId="pack-file-dialog"
      foot={
        <button type="button" className="ai-btn" onClick={onClose}>
          Close
        </button>
      }
    >
      <p className="ai-hint" style={{ margin: 0 }}>
        One file carries the whole pack.
      </p>
      {pack && <ExportCard projectId={projectId} pack={pack} />}
      <ImportCard projectId={projectId} />
    </PackModal>
  );
}
