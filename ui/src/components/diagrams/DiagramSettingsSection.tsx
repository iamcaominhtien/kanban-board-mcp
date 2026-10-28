import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { diagramFailure, diagramKeys, saveDiagramSettings, useDiagramSettings } from '../../api/diagrams';

/** Settings → Diagrams: where the draw.io editor runs (admin setting, default self-hosted). */
export function DiagramSettingsSection() {
  const q = useDiagramSettings();
  const qc = useQueryClient();
  const [mode, setMode] = useState<'self-hosted' | 'public'>('self-hosted');
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (q.data) {
      setMode(q.data.mode);
      setUrl(q.data.url);
    }
  }, [q.data]);

  async function save() {
    setStatus(null);
    try {
      const saved = await saveDiagramSettings({ mode, url });
      qc.setQueryData(diagramKeys.settings, saved);
      setStatus({ ok: true, text: '✓ Saved' });
    } catch (err) {
      setStatus({ ok: false, text: `✗ ${diagramFailure(err).message}` });
    }
  }

  const radio = (value: 'self-hosted' | 'public', title: string, text: string) => (
    <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
      <input
        type="radio"
        name="drawio-mode"
        checked={mode === value}
        onChange={() => setMode(value)}
        style={{ marginTop: 3 }}
      />
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#1E2A22' }}>{title}</span>
        <span style={{ fontSize: 12, color: '#5B6B60', lineHeight: 1.45 }}>{text}</span>
      </span>
    </label>
  );

  return (
    <div
      data-testid="diagram-settings"
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
      <span style={{ fontSize: 12.5, color: '#5B6B60', lineHeight: 1.5 }}>
        Where the draw.io editor runs for diagrams in tickets, comments and Docs.
      </span>
      {radio(
        'self-hosted',
        'Self-hosted (default)',
        'Drawings stay on your servers. You run the draw.io service (for example the jgraph/drawio image).',
      )}
      {mode === 'self-hosted' && (
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={q.data?.defaultSelfHostedUrl ?? 'http://localhost:8080'}
          aria-label="Editor address"
          style={{
            height: 34,
            border: '1px solid #DCE6DF',
            borderRadius: 8,
            padding: '0 10px',
            font: 'inherit',
            fontSize: 13,
          }}
        />
      )}
      {radio(
        'public',
        'Public diagrams.net',
        `Simpler, but the drawing is sent to ${q.data?.publicUrl ?? 'embed.diagrams.net'} while the editor is open.`,
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button type="button" className="st-btn st-btn-primary" onClick={() => void save()}>
          Save
        </button>
        {status && <span style={{ fontSize: 12.5, color: status.ok ? '#2E6F40' : '#C4432A' }}>{status.text}</span>}
      </div>
    </div>
  );
}
