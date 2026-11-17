/**
 * Settings › Docs beyond "on" and "who can edit" (design "Rich Docs — organising pages", F 49-60 and G 65): how new
 * pages look (with a live preview), which templates the New page gallery shows, public links, highlights, upload
 * limits and scripts in HTML embeds, and the pages kept from AI teams (how each team changes pages is in the
 * AI in Docs card). Every change saves as it is made; a refused
 * change goes back and its card says why. People who are not admins read it but cannot change it; while Docs is off
 * everything is dimmed.
 */

import { useState, type ReactNode } from 'react';
import { docsErrorDetail, useDocsTree } from '../../../api/docs';
import { useDocsAccess } from '../../../api/docsAccess';
import { useDocsGallery } from '../../../api/docsGallery';
import {
  MAX_UPLOAD_MB,
  useDocsSpaceSettings,
  useUpdateDocsSpaceSettings,
  type DocsSpacePatch,
  type DocsSpaceSettings as Settings,
  type NewPageStyle,
} from '../../../api/docsSpace';
import { extractError } from '../../../api/extractError';
import type { Project } from '../../../types/ticket';
import { Pills, SettingRow, SettingsCard, Switch } from '../../settings/settingsUi';
import ss from '../../settings/SettingsPage.module.css';
import { ModalShell } from '../docsShared';
import {
  BACKGROUNDS,
  BACKGROUND_LABEL,
  FONTS,
  FONT_FAMILY,
  FONT_LABEL,
  PALETTE,
  TEXT_SIZE_PX,
  WIDTH_LABEL,
  WIDTHS,
  type PageBackground,
  type PageFont,
} from '../pageSettings';
import './docsSpaceSettings.css';

/** The settings every project starts with (the server's defaults), shown while they load or while Docs is off. */
export const SPACE_DEFAULTS: Settings = {
  newPage: {
    width: 'normal',
    bodyFont: 'jakarta',
    textSize: 'm',
    background: 'white',
    titleAlign: 'left',
    childCopiesParent: true,
  },
  defaultTemplate: 'blank',
  hiddenTemplates: [],
  allowPublicLinks: true,
  publicLinkExpiry: 'never',
  highlights: 'on',
  uploads: { imageMb: 10, videoMb: 200, fileMb: 100 },
  scriptsInEmbeds: 'ask',
  embedSites: [],
  aiApply: {},
};

const EXPIRY: readonly (readonly [Settings['publicLinkExpiry'], string])[] = [
  ['never', 'Never'],
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['90d', '90 days'],
];

/** A card's failed save: what was tried, why it failed, what it still is, and the change to try again. */
interface Failure {
  card: string;
  what: string;
  why: string;
  still: string;
  retry: DocsSpacePatch;
}

/**
 * The Docs settings cards for a project.
 * @param props.project - The project (its `docsEnabled` dims everything while off).
 */
export function DocsSpaceSettings({ project }: { project: Project }) {
  const enabled = project.docsEnabled !== false;
  const access = useDocsAccess(project.id, enabled);
  const query = useDocsSpaceSettings(project.id, enabled);
  const update = useUpdateDocsSpaceSettings(project.id);
  const [saved, setSaved] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const s: Settings = { ...SPACE_DEFAULTS, ...(query.data ?? {}) };
  const isAdmin = access.data?.role === 'admin';
  // only admins change these; while Docs is off nothing here applies
  const locked = !enabled || !isAdmin;
  const why = !enabled
    ? 'Docs is off for this project. Turn it on to change these settings.'
    : access.data && !isAdmin
      ? 'Only project admins can change these settings.'
      : null;

  function save(card: string, patch: DocsSpacePatch, what: string, still: string) {
    if (locked) return;
    setFailure(null);
    setSaved(null);
    update.mutate(patch, {
      onSuccess: () => setSaved(card),
      onError: (e) => {
        const d = docsErrorDetail(e);
        const reason =
          d?.code === 'admins_only'
            ? 'Only project admins can change Docs settings.'
            : (d?.message ?? (extractError(e) || 'The server didn’t answer.'));
        setFailure({ card, what, why: reason, still, retry: patch });
      },
    });
  }

  const status = (card: string) => (saved === card ? { ok: true, text: 'Saved' } : null);
  const failed = (card: string): ReactNode =>
    failure?.card === card ? (
      <div className={ss.notice} role="alert" data-testid="docs-settings-error" style={{ color: '#A5321E' }}>
        <span style={{ flex: 1 }}>
          Couldn’t save “{failure.what}”. {failure.why} The setting is still “{failure.still}”.
        </span>
        <button
          type="button"
          className="st-btn st-btn-sm"
          onClick={() => save(card, failure.retry, failure.what, failure.still)}
        >
          Try again
        </button>
      </div>
    ) : null;

  return (
    <div
      className={`ds-root${!enabled ? ' ds-off' : ''}`}
      data-testid="docs-space-settings"
      aria-disabled={locked || undefined}
    >
      {why && (
        <div className={ss.notice} role="note" data-testid="docs-settings-why">
          {why}
        </div>
      )}
      <NewPagesCard s={s.newPage} locked={locked} status={status('new')} error={failed('new')} save={save} />
      <TemplatesCard
        projectId={project.id}
        s={s}
        locked={locked}
        enabled={enabled}
        status={status('tpl')}
        error={failed('tpl')}
        save={save}
      />
      <SharingCard s={s} locked={locked} status={status('share')} error={failed('share')} save={save} />
      <UploadsCard s={s} locked={locked} status={status('up')} error={failed('up')} save={save} />
      <AiPagesCard projectId={project.id} enabled={enabled} />
    </div>
  );
}

type Save = (card: string, patch: DocsSpacePatch, what: string, still: string) => void;

interface CardProps {
  locked: boolean;
  status: { ok: boolean; text: string } | null;
  error: ReactNode;
  save: Save;
}

const ALIGN_LABEL = { left: 'Left', center: 'Centred' } as const;
const SIZE_LABEL = { s: 'Small', m: 'Medium', l: 'Large' } as const;

/** "New pages": how a page looks before anyone styles it, with a live preview. */
function NewPagesCard({ s, locked, status, error, save }: CardProps & { s: NewPageStyle }) {
  const set = <K extends keyof NewPageStyle>(k: K, v: NewPageStyle[K], label: string, old: string) =>
    save('new', { newPage: { [k]: v } as Partial<NewPageStyle> }, label, old);
  const bg = (BACKGROUNDS as readonly string[]).includes(s.background) ? (s.background as PageBackground) : 'white';
  const font = (FONTS as readonly string[]).includes(s.bodyFont) ? (s.bodyFont as PageFont) : 'jakarta';
  return (
    <SettingsCard
      title="New pages"
      hint="How a page looks before anyone styles it. Pages that already exist keep their own style."
      setting="docs-new-pages"
      status={status}
    >
      {error}
      <div className="ds-split">
        <fieldset disabled={locked} className="ds-fields">
          <Labelled label="Page width">
            <Pills
              label="Page width"
              options={WIDTHS.map((w) => [w, WIDTH_LABEL[w]] as const)}
              value={s.width}
              onChange={(v) => set('width', v, `Page width: ${WIDTH_LABEL[v]}`, WIDTH_LABEL[s.width])}
            />
          </Labelled>
          <Labelled label="Font">
            <select
              className="st-input"
              aria-label="Font"
              value={font}
              style={{ fontFamily: FONT_FAMILY[font] }}
              onChange={(e) =>
                set('bodyFont', e.target.value, `Font: ${FONT_LABEL[e.target.value as PageFont]}`, FONT_LABEL[font])
              }
            >
              {FONTS.map((f) => (
                <option key={f} value={f}>
                  {FONT_LABEL[f]}
                </option>
              ))}
            </select>
          </Labelled>
          <Labelled label="Text size">
            <Pills
              label="Text size"
              options={(['s', 'm', 'l'] as const).map((k) => [k, SIZE_LABEL[k]] as const)}
              value={s.textSize}
              onChange={(v) => set('textSize', v, `Text size: ${SIZE_LABEL[v]}`, SIZE_LABEL[s.textSize])}
            />
          </Labelled>
          <Labelled label="Page colour">
            <Pills
              label="Page colour"
              options={BACKGROUNDS.map((b) => [b, BACKGROUND_LABEL[b]] as const)}
              value={bg}
              onChange={(v) => set('background', v, `Page colour: ${BACKGROUND_LABEL[v]}`, BACKGROUND_LABEL[bg])}
            />
          </Labelled>
          <Labelled label="Title">
            <Pills
              label="Title alignment"
              options={(['left', 'center'] as const).map((k) => [k, ALIGN_LABEL[k]] as const)}
              value={s.titleAlign}
              onChange={(v) => set('titleAlign', v, `Title: ${ALIGN_LABEL[v]}`, ALIGN_LABEL[s.titleAlign])}
            />
          </Labelled>
          <SettingRow title="Child pages copy the parent’s style" hint="A chapter starts like its book.">
            <Switch
              on={s.childCopiesParent}
              label="Child pages copy the parent’s style"
              disabled={locked}
              testId="ds-child-copies"
              onChange={(v) =>
                set('childCopiesParent', v, 'Child pages copy the parent’s style', s.childCopiesParent ? 'On' : 'Off')
              }
            />
          </SettingRow>
        </fieldset>
        <NewPagePreview s={s} bg={bg} font={font} />
      </div>
    </SettingsCard>
  );
}

/** The live preview of a new page in the chosen style. */
function NewPagePreview({ s, bg, font }: { s: NewPageStyle; bg: PageBackground; font: PageFont }) {
  const p = PALETTE[bg];
  const width = { narrow: '72%', normal: '84%', wide: '94%', full: '100%' }[s.width] ?? '84%';
  return (
    <div className="ds-preview" aria-label="Preview of a new page" role="img" data-testid="ds-preview" data-bg={bg}>
      <div
        className="ds-preview-page"
        style={{
          background: p.page,
          color: p.ink,
          fontFamily: FONT_FAMILY[font],
          fontSize: TEXT_SIZE_PX[s.textSize] - 2,
        }}
      >
        <div style={{ width, margin: '0 auto', textAlign: s.titleAlign === 'center' ? 'center' : 'left' }}>
          <div className="ds-preview-title">Untitled page</div>
          <div className="ds-preview-by" style={{ color: p.text.slate }}>
            An Nguyen · today
          </div>
        </div>
        <div style={{ width, margin: '0 auto' }}>
          <p>Start typing, or press / to add a heading, a table, an image or a diagram.</p>
          <div className="ds-preview-h">A heading</div>
          <p>
            Second paragraph with a <u style={{ color: p.text.green }}>link</u> and some more words to show the line
            length.
          </p>
        </div>
      </div>
    </div>
  );
}

/** "Templates": the default for new pages, which built-in templates the gallery shows, and the saved ones. */
function TemplatesCard({
  projectId,
  s,
  locked,
  enabled,
  status,
  error,
  save,
}: CardProps & { projectId: string; s: Settings; enabled: boolean }) {
  const gallery = useDocsGallery(enabled ? projectId : '');
  const [manage, setManage] = useState(false);
  const builtin = gallery.data?.builtin ?? [];
  const saved = [...(gallery.data?.yours ?? []), ...(gallery.data?.project ?? [])];
  const shared = saved.filter((t) => t.scope === 'project');
  const name = (id: string) =>
    id === 'blank' ? 'Blank' : (builtin.find((b) => b.id === id)?.name ?? saved.find((t) => t.id === id)?.name ?? id);
  const hidden = new Set(s.hiddenTemplates);
  return (
    <SettingsCard
      title="Templates"
      hint="What people see in the New page gallery. Your own templates are shared with the project."
      setting="docs-templates"
      status={status}
    >
      {error}
      <fieldset disabled={locked} className="ds-fields">
        <Labelled label="Default for new pages" hint="Used by the + button in the tree, which skips the gallery.">
          <select
            className="st-input"
            aria-label="Default for new pages"
            value={s.defaultTemplate}
            onChange={(e) =>
              save(
                'tpl',
                { defaultTemplate: e.target.value },
                `Default: ${name(e.target.value)}`,
                name(s.defaultTemplate),
              )
            }
          >
            <option value="blank">Blank</option>
            {builtin
              .filter((b) => b.id !== 'blank')
              .map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            {shared.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} (saved)
              </option>
            ))}
          </select>
        </Labelled>
        <div className={ss.field}>
          <span className={ss.fieldLab}>Shown in the gallery</span>
          <div className="ds-checks" role="group" aria-label="Shown in the gallery">
            <label className="ds-check">
              <input type="checkbox" checked disabled />
              <span>
                Blank <small>Always available</small>
              </span>
            </label>
            {builtin
              .filter((b) => b.id !== 'blank')
              .map((b) => (
                <label key={b.id} className="ds-check">
                  <input
                    type="checkbox"
                    checked={!hidden.has(b.id)}
                    data-testid={`ds-tpl-${b.id}`}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? s.hiddenTemplates.filter((x) => x !== b.id)
                        : [...s.hiddenTemplates, b.id];
                      save(
                        'tpl',
                        { hiddenTemplates: next },
                        `${b.name}: ${e.target.checked ? 'shown' : 'hidden'}`,
                        e.target.checked ? 'hidden' : 'shown',
                      );
                    }}
                  />
                  <span>
                    {b.name} {b.description && <small>{b.description}</small>}
                  </span>
                </label>
              ))}
          </div>
        </div>
      </fieldset>
      <div className={ss.settingRow}>
        <div className={ss.settingRowText}>
          <div className={ss.settingName}>Your templates · {shared.length} shared with this project</div>
        </div>
        <button type="button" className="st-btn st-btn-sm" disabled={!enabled} onClick={() => setManage(true)}>
          Manage
        </button>
      </div>
      {manage && <SavedTemplates templates={saved} onClose={() => setManage(false)} />}
    </SettingsCard>
  );
}

const KEEPS = { content: 'keeps content', structure: 'keeps style and structure', style: 'keeps style only' } as const;

/** "Your templates": who saved each one, what it keeps and how often it is used. */
function SavedTemplates({
  templates,
  onClose,
}: {
  templates: { id: string; name: string; owner: string; keeps: keyof typeof KEEPS; usedCount: number; scope: string }[];
  onClose: () => void;
}) {
  return (
    <ModalShell
      width={460}
      ariaLabel="Your templates"
      title="Your templates"
      subtitle={`Shared with this project · ${templates.filter((t) => t.scope === 'project').length}`}
      onClose={onClose}
      bodyStyle={{ padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: 8 }}
      footer={
        <button type="button" className="st-btn st-btn-primary" style={{ marginLeft: 'auto' }} onClick={onClose}>
          Done
        </button>
      }
    >
      {templates.length === 0 && (
        <p className="st-hint">Nobody saved a template yet. Use “Save as template…” in a page’s menu.</p>
      )}
      {templates.map((t) => (
        <div key={t.id} className="ds-tpl">
          <b>{t.name}</b>
          <small>
            {t.owner} · {KEEPS[t.keeps] ?? t.keeps}
          </small>
          <span>Used {t.usedCount === 1 ? 'once' : `${t.usedCount} times`}</span>
        </div>
      ))}
      <p className="st-hint" style={{ margin: 0 }}>
        Anyone who can edit pages can save a template. Only the person who saved it, and admins, can change or delete
        it.
      </p>
    </ModalShell>
  );
}

/** "Sharing" and "Highlights on pages". */
function SharingCard({ s, locked, status, error, save }: CardProps & { s: Settings }) {
  const expiry = (v: Settings['publicLinkExpiry']) => EXPIRY.find(([k]) => k === v)?.[1] ?? v;
  return (
    <SettingsCard
      title="Sharing and highlights"
      hint="A page owner turns a public link on for one page. An admin can switch public links off for the whole project."
      setting="docs-sharing"
      status={status}
    >
      {error}
      <SettingRow
        title="Allow public links"
        hint="Off: every public link in this project stops working, and owners can no longer make one."
      >
        <Switch
          on={s.allowPublicLinks}
          label="Allow public links"
          disabled={locked}
          testId="ds-public-links"
          onChange={(v) =>
            save('share', { allowPublicLinks: v }, 'Allow public links', s.allowPublicLinks ? 'On' : 'Off')
          }
        />
      </SettingRow>
      <fieldset disabled={locked || !s.allowPublicLinks} className="ds-fields">
        <Labelled label="New public links expire" hint="The default for new links. Owners can choose a shorter time.">
          <Pills
            label="New public links expire"
            options={EXPIRY}
            value={s.publicLinkExpiry}
            onChange={(v) => save('share', { publicLinkExpiry: v }, `Expire: ${expiry(v)}`, expiry(s.publicLinkExpiry))}
          />
        </Labelled>
      </fieldset>
      <div className={ss.divider} />
      <fieldset disabled={locked} className="ds-fields">
        <Labelled
          label="Highlights on pages"
          hint="Readers can highlight a passage while reading; only people who can comment can. A page can turn them off in its Access settings. Highlights are not shown on public pages."
        >
          <Pills
            label="Highlights on pages"
            options={[
              ['on', 'On'],
              ['off', 'Off'],
            ]}
            value={s.highlights}
            onChange={(v) =>
              save(
                'share',
                { highlights: v },
                `Highlights: ${v === 'on' ? 'On' : 'Off'}`,
                s.highlights === 'on' ? 'On' : 'Off',
              )
            }
          />
        </Labelled>
      </fieldset>
    </SettingsCard>
  );
}

/** One upload limit in MB, saved when the field is left or Enter is pressed. */
function LimitField({
  label,
  hint,
  value,
  max,
  onSave,
}: {
  label: string;
  hint?: string;
  value: number;
  max: number;
  onSave: (mb: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value);
  const n = Number(shown);
  const bad = !Number.isInteger(n) || n < 1 || n > max;
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    if (!bad && n !== value) onSave(n);
  };
  return (
    <Labelled label={label} hint={bad ? `A whole number from 1 to ${max}.` : hint}>
      <span className="ds-mb">
        <input
          className="st-input"
          inputMode="numeric"
          aria-label={`${label} in MB`}
          aria-invalid={bad || undefined}
          value={shown}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
        />
        MB
      </span>
    </Labelled>
  );
}

/** "Uploads": the size limits, the fixed HTML embed limit, scripts in HTML embeds, and the virus check. */
function UploadsCard({ s, locked, status, error, save }: CardProps & { s: Settings }) {
  const limit = (key: keyof Settings['uploads'], label: string) => (mb: number) =>
    save('up', { uploads: { [key]: mb } }, `${label}: ${mb} MB`, `${s.uploads[key]} MB`);
  return (
    <SettingsCard
      title="Uploads"
      hint="Limits for files that people add to pages."
      setting="docs-uploads"
      status={status}
    >
      {error}
      <fieldset disabled={locked} className="ds-fields ds-grid">
        <LimitField
          label="Image size"
          hint="Larger images are refused with a message."
          value={s.uploads.imageMb}
          max={MAX_UPLOAD_MB.imageMb}
          onSave={limit('imageMb', 'Image size')}
        />
        <LimitField
          label="Video size"
          value={s.uploads.videoMb}
          max={MAX_UPLOAD_MB.videoMb}
          onSave={limit('videoMb', 'Video size')}
        />
        <LimitField
          label="File size"
          hint="PDF, Word, Excel, PowerPoint, text, archives."
          value={s.uploads.fileMb}
          max={MAX_UPLOAD_MB.fileMb}
          onSave={limit('fileMb', 'File size')}
        />
        <Labelled label="HTML embed size" hint="Fixed. Embeds run in a sandbox.">
          <span className="ds-fixed">512 KB</span>
        </Labelled>
      </fieldset>
      <fieldset disabled={locked} className="ds-fields">
        <Labelled
          label="Scripts in HTML embeds"
          hint="An embed that needs scripts runs only after someone presses “Run it”."
        >
          <Pills
            label="Scripts in HTML embeds"
            options={[
              ['ask', 'Ask before running'],
              ['off', 'Off'],
            ]}
            value={s.scriptsInEmbeds}
            onChange={(v) =>
              save(
                'up',
                { scriptsInEmbeds: v },
                `Scripts: ${v === 'ask' ? 'Ask before running' : 'Off'}`,
                s.scriptsInEmbeds === 'ask' ? 'Ask before running' : 'Off',
              )
            }
          />
        </Labelled>
      </fieldset>
      <SettingRow title="Check files for viruses" hint="Always on. Programs and scripts can’t be uploaded.">
        <span className="ds-fixed">On</span>
      </SettingRow>
    </SettingsCard>
  );
}

/**
 * "Pages kept from AI teams": how many pages are marked "Not for AI teams" and what teams read. How each team changes
 * pages (Suggest first / Apply directly) is set in the "AI in Docs" card above (DocsAiSettings), not here.
 */
function AiPagesCard({ projectId, enabled }: { projectId: string; enabled: boolean }) {
  const tree = useDocsTree(enabled ? projectId : '');
  const nodes = tree.data ?? [];
  // the tree says which pages are kept from teams once the server sends it; until then no number is shown
  const known = nodes.some((n) => n.notForAi !== undefined);
  const kept = nodes.filter((n) => n.notForAi === true).length;
  return (
    <SettingsCard
      title="Pages kept from AI teams"
      hint="Teams of this project read and write Docs through the board’s tools, not through a browser."
      setting="docs-ai-teams"
    >
      <SettingRow
        title="Pages marked “Not for AI teams”"
        hint={
          known
            ? `${kept} ${kept === 1 ? 'page' : 'pages'}. Teams can’t read or change them; set in the page’s Access settings.`
            : 'Teams can’t read or change them; set in each page’s Access settings.'
        }
      >
        <span />
      </SettingRow>
      <span className={ss.hint}>
        Teams read text, tables and captions. Images, video, diagrams and files show up as placeholders, and teams never
        edit inside a diagram or an HTML embed.
      </span>
    </SettingsCard>
  );
}

function Labelled({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className={ss.field}>
      <span className={ss.fieldLab}>{label}</span>
      {children}
      {hint && <span className={ss.hint}>{hint}</span>}
    </div>
  );
}
