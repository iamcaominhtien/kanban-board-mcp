import { useEffect, useRef, useState } from 'react';
import './docs.css';
import { Icon } from './Icon';
import { useUpdateProject } from '../../api/projects';
import { readCachedPageCount, useDocsPageCount } from '../../api/docsFx';
import { extractError } from '../../api/extractError';
import { useDocsAccess } from '../../api/docsAccess';
import type { DocsEditPolicy, Project } from '../../types/ticket';
import { SettingRow, SettingsCard, Switch } from '../settings/settingsUi';
import ss from '../settings/SettingsPage.module.css';

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
    <SettingsCard
      title="Docs"
      hint="A page tree per project for requirements, designs and decisions. Turning it off hides the Docs tab for everyone; pages are kept and come back when you turn it on again."
      setting="docs-enabled"
      status={status ? { ok: status.kind === 'ok', text: status.text } : null}
    >
      <SettingRow title="Enable Docs" hint={enabled ? 'On for this project.' : 'Off for this project.'}>
        <Switch
          on={enabled}
          label={`Docs enabled for ${project.name}`}
          disabled={update.isPending || readOnly}
          onChange={(v) => void save({ docs_enabled: v })}
        />
      </SettingRow>
      {!enabled && (
        <div className={ss.notice}>
          <Icon name="i28" size={15} strokeWidth={1.9} style={{ color: '#5B6B60', flexShrink: 0 }} />
          <span>
            {hiddenCount === null
              ? 'Pages are hidden while Docs is off.'
              : `${hiddenCount} ${hiddenCount === 1 ? 'page is' : 'pages are'} hidden while Docs is off.`}{' '}
            Links to them from tickets show as unavailable.
          </span>
        </div>
      )}
      <div className={ss.divider} />
      <div data-setting="docs-edit-policy" className={ss.field}>
        <span className={ss.fieldLab} id={`docs-policy-${project.id}`}>
          Who can edit pages
        </span>
        <div
          role="radiogroup"
          aria-labelledby={`docs-policy-${project.id}`}
          className={ss.grid3}
          style={{ opacity: enabled ? 1 : 0.5 }}
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
                className={`${ss.choice} ${on && enabled ? ss.choiceOn : ''}`}
                style={{ font: 'inherit', textAlign: 'left', cursor: off ? 'default' : 'pointer' }}
              >
                <span className={`${ss.radioDot} ${on && enabled ? ss.radioDotOn : ''}`} aria-hidden />
                <span className={ss.choiceText}>
                  <span className={ss.settingName}>{o.label}</span>
                  <span className={ss.hint}>{o.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
        <span className={ss.hint}>
          Everyone with project access can always <b>read</b> published pages. Drafts stay visible to their author only.
          {readOnly && ' Only project admins can change these settings.'}
        </span>
      </div>
    </SettingsCard>
  );
}
