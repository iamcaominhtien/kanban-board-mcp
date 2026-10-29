import { useEffect, useRef, useState } from 'react';
import './docs.css';
import { Icon } from './Icon';
import { useUpdateProject } from '../../api/projects';
import { readCachedPageCount, useDocsPageCount } from '../../api/docsFx';
import { extractError } from '../../api/extractError';
import { useDocsAccess } from '../../api/docsAccess';
import type { DocsEditPolicy, Project } from '../../types/ticket';

const POLICIES: { value: DocsEditPolicy; label: string; hint: string }[] = [
  { value: 'everyone', label: 'Everyone', hint: 'Anyone with project access, including viewers' },
  { value: 'members', label: 'Members', hint: 'Project members only. The default.' },
  { value: 'admins', label: 'Admins', hint: 'Only project admins' },
];

/** "Docs" on/off row and who can edit pages, for one project (Settings). Design: DocsEmpty.dc.html artboard F. */
export function DocsSettingsRow({ project }: { project: Project }) {
  const update = useUpdateProject();
  const enabled = project.docsEnabled !== false;
  const policy = project.docsEditPolicy ?? 'members';
  const access = useDocsAccess(project.id, enabled);
  // only admins change Docs settings; while Docs is off the space can't be asked, so the server decides
  const readOnly = enabled && access.data != null && access.data.role !== 'admin';
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const count = useDocsPageCount(project.id, enabled);
  const hiddenCount = enabled ? (count.data ?? null) : readCachedPageCount(project.id);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function save(data: { docs_enabled?: boolean; docs_edit_policy?: DocsEditPolicy }) {
    setStatus(null);
    try {
      await update.mutateAsync({ id: project.id, ...data });
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
            disabled={update.isPending || readOnly}
            onClick={() => void save({ docs_enabled: !enabled })}
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span
          id={`docs-policy-${project.id}`}
          style={{
            fontSize: 11,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: '#5B6B60',
          }}
        >
          Who can edit pages
        </span>
        <div
          role="radiogroup"
          aria-labelledby={`docs-policy-${project.id}`}
          style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}
        >
          {POLICIES.map((o) => {
            const on = policy === o.value;
            const off = !enabled || readOnly || update.isPending;
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={off}
                onClick={() => !on && void save({ docs_edit_policy: o.value })}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '10px 11px',
                  textAlign: 'left',
                  borderRadius: 8,
                  border: `1px solid ${on && enabled ? '#2E6F40' : '#E3E8E5'}`,
                  background: on && enabled ? '#F1F7F2' : '#FFFFFF',
                  cursor: off ? 'default' : 'pointer',
                  opacity: enabled ? 1 : 0.5,
                  font: 'inherit',
                }}
              >
                <span
                  aria-hidden
                  style={{
                    flexShrink: 0,
                    width: 14,
                    height: 14,
                    marginTop: 1,
                    borderRadius: '50%',
                    border: `1.5px solid ${on && enabled ? '#2E6F40' : '#C7D2CB'}`,
                    display: 'grid',
                    placeItems: 'center',
                  }}
                >
                  {on && enabled && (
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#2E6F40' }} />
                  )}
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: '#1E2A22' }}>{o.label}</span>
                  <span style={{ fontSize: 11.5, color: '#5B6B60', lineHeight: 1.4 }}>{o.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="st-hint">
          Everyone with project access can always <b>read</b> published pages. Drafts stay visible to their author only.
          {readOnly && ' Only project admins can change these settings.'}
        </div>
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
