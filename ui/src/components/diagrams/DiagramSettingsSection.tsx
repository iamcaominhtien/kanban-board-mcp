import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  diagramFailure,
  diagramKeys,
  saveDiagramSettings,
  useDiagramSettings,
  type DiagramEditorMode,
} from '../../api/diagrams';
import { Field, SettingsCard } from '../settings/settingsUi';
import ss from '../settings/SettingsPage.module.css';

/** Settings → Diagrams: where the draw.io editor runs (admin setting; the one built into the app by default). */
export function DiagramSettingsSection() {
  const q = useDiagramSettings();
  const qc = useQueryClient();
  const [mode, setMode] = useState<DiagramEditorMode>('self-hosted');
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
      setStatus({ ok: true, text: 'Saved' });
    } catch (err) {
      setStatus({ ok: false, text: diagramFailure(err).message });
    }
  }

  const radio = (value: DiagramEditorMode, title: string, text: string) => {
    const on = mode === value;
    return (
      <label className={`${ss.choice} ${on ? ss.choiceOn : ''}`}>
        <input type="radio" name="drawio-mode" checked={on} onChange={() => setMode(value)} />
        <span className={ss.choiceText}>
          <span className={ss.settingName}>{title}</span>
          <span className={ss.hint}>{text}</span>
        </span>
      </label>
    );
  };

  // Nothing loaded (an error): saving stays possible, as before
  const dirty = !q.data || mode !== q.data.mode || url !== q.data.url;

  return (
    <SettingsCard
      title="Diagrams (draw.io)"
      hint="The editor used to draw diagrams in tickets, comments and Docs."
      setting="drawio"
      status={status}
      testId="diagram-settings"
    >
      <div className={ss.choices} role="radiogroup" aria-label="Where the draw.io editor runs">
        {q.data?.builtInAvailable &&
          radio(
            'built-in',
            'Built into the app (default)',
            `The draw.io editor${q.data.builtInVersion ? ` ${q.data.builtInVersion}` : ''} that comes with the app. Nothing to run, works offline, drawings stay on this computer.`,
          )}
        {radio(
          'self-hosted',
          q.data?.builtInAvailable ? 'Self-hosted' : 'Self-hosted (default)',
          'Drawings stay on your servers. You run the draw.io service (for example the jgraph/drawio image).',
        )}
        {radio(
          'public',
          'Public diagrams.net',
          `Simpler, but the drawing is sent to ${q.data?.publicUrl ?? 'embed.diagrams.net'} while the editor is open.`,
        )}
      </div>
      {mode === 'self-hosted' && (
        <Field label="Editor address" htmlFor="drawio-url" hint="Self-hosted keeps drawings on your servers.">
          <input
            id="drawio-url"
            className={`${ss.input} ${ss.mono}`}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={q.data?.defaultSelfHostedUrl ?? 'http://localhost:8080'}
            aria-label="Editor address"
          />
        </Field>
      )}
      <div className={ss.row}>
        <button type="button" className={`${ss.btn} ${ss.btnPrimary}`} disabled={!dirty} onClick={() => void save()}>
          Save
        </button>
      </div>
    </SettingsCard>
  );
}
