import { useEffect, useRef, useState } from 'react';
import './docs.css';
import { Icon } from './Icon';
import { useUpdateProject } from '../../api/projects';
import { readCachedPageCount, useDocsPageCount } from '../../api/docsFx';
import { extractError } from '../../api/extractError';
import type { Project } from '../../types/ticket';

/** "Docs" on/off row for one project (Settings). Design: DocsEmpty.dc.html artboard F (no permission options). */
export function DocsSettingsRow({ project }: { project: Project }) {
  const update = useUpdateProject();
  const enabled = project.docsEnabled !== false;
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const count = useDocsPageCount(project.id, enabled);
  const hiddenCount = enabled ? (count.data ?? null) : readCachedPageCount(project.id);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function toggle() {
    setStatus(null);
    try {
      await update.mutateAsync({ id: project.id, docs_enabled: !enabled });
      setStatus({ kind: 'ok', text: 'Saved' });
    } catch (err) {
      setStatus({ kind: 'err', text: extractError(err) });
    }
  }

  return (
    <div
      className="docs-root"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: '12px 14px',
        background: '#F8FAF8',
        borderRadius: 8,
        border: '1px solid #E3E8E5',
      }}
    >
      <span style={{ fontSize: 11.5, fontWeight: 600, color: '#5B6B60' }}>
        {project.name} ({project.prefix})
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#1E2A22', flexGrow: 1 }}>Docs</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: enabled ? '#2E6F40' : '#5B6B60' }}>
            {enabled ? 'Enabled for this project' : 'Disabled for this project'}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={`Docs enabled for ${project.name}`}
            className="st-toggle-track"
            disabled={update.isPending}
            onClick={toggle}
            style={{ background: enabled ? '#2E6F40' : '#C7D2CB', border: 'none', padding: 0 }}
          >
            <span className="st-toggle-dot" style={{ left: enabled ? 17 : 2 }} />
          </button>
        </div>
      </div>
      <div className="st-hint">
        A page tree per project for requirements, designs and decisions. Turning it off hides the Docs tab for everyone;
        pages are kept and come back when you turn it on again.
      </div>
      {status && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: status.kind === 'ok' ? '#2E6F40' : '#C4432A' }}>
            {status.text}
          </span>
        </div>
      )}
      {!enabled && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 12px',
            borderRadius: 8,
            background: '#F1F3F1',
            border: '1px solid #E3E8E5',
            fontSize: 12.5,
            color: '#3A4A3E',
            lineHeight: 1.45,
          }}
        >
          <Icon name="i28" size={15} strokeWidth={1.9} style={{ color: '#5B6B60' }} />
          {hiddenCount === null
            ? 'Pages are hidden while Docs is off.'
            : `${hiddenCount} ${hiddenCount === 1 ? 'page is' : 'pages are'} hidden while Docs is off.`}{' '}
          Links to them from tickets show as unavailable.
        </div>
      )}
    </div>
  );
}
