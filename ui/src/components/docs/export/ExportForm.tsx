/**
 * The "New export" tab (frames 1 to 13, 18, 50, 51): four formats on top, the chosen format's few options, include
 * highlights, what to export (this page, this page and its child pages with a tick list, the whole space), the
 * published version or the draft for editors, the file name checked as you type, and one note line.
 */

import type { ReactNode } from 'react';
import type { DocsTreeNode } from '../../../types/docs';
import { Switch } from '../../settings/settingsUi';
import { Icon } from '../Icon';
import { EXPORT_FORMATS } from '../docsExport';
import { FormatBadge } from './ExportFrame';
import {
  checkFileName,
  isPaged,
  optionDisabled,
  type ExportForm as Form,
  type ExportFormat,
  type ExportOptions,
} from './exportModel';

const SHORT_NOTE: Record<ExportFormat, string> = {
  docx: 'Keep editing it',
  pdf: 'Send or print',
  html: 'A web page',
  md: 'Plain text',
};

/**
 * A segmented choice.
 * @param props.label - Accessible name of the group.
 * @param props.disabled - Every choice greyed (Fit to content turns orientation off).
 */
export function Seg<T extends string>({
  label,
  value,
  choices,
  onChange,
  disabled,
  testId,
}: {
  label: string;
  value: T;
  choices: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <div className="dx-seg" role="group" aria-label={label} data-testid={testId}>
      {choices.map(([v, text]) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          disabled={disabled}
          onClick={() => onChange(v)}
          data-testid={testId ? `${testId}-${v}` : undefined}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** One option: its label over its choices (design A 1). */
function OptRow({ label, children, grow }: { label: string; children: ReactNode; grow?: number }) {
  return (
    <div className="dx-opt-row" style={grow ? { flex: grow } : undefined}>
      <span className="dx-field-label">{label}</span>
      {children}
    </div>
  );
}

/**
 * A switch with a name and one line.
 * @param props.on - Whether it is on.
 */
export function SwitchRow({
  title,
  hint,
  on,
  onChange,
  disabled,
  testId,
}: {
  title: string;
  hint: string;
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <div className="dk-rs-switch dx-switch" style={disabled ? { opacity: 0.5 } : undefined}>
      <span>
        <b>{title}</b>
        <span>{hint}</span>
      </span>
      <Switch on={on} label={title} onChange={onChange} disabled={disabled} testId={testId} />
    </div>
  );
}

/**
 * The four format cards.
 * @param props.value - The chosen format.
 */
export function FormatGrid({ value, onChange }: { value: ExportFormat; onChange: (f: ExportFormat) => void }) {
  return (
    <div className="dx-section">
      <span className="dx-label">Format</span>
      <div className="dx-formats" role="group" aria-label="Format">
        {EXPORT_FORMATS.map((f) => (
          <button
            key={f.format}
            type="button"
            className="dx-fmt"
            aria-pressed={value === f.format}
            aria-label={`${f.label} .${f.format}`}
            data-testid={`export-format-${f.format}`}
            onClick={() => onChange(f.format)}
          >
            <FormatBadge format={f.format} />
            <span style={{ minWidth: 0 }}>
              <b>{f.label}</b> <span className="dx-ext">.{f.format}</span>
              <div className="dx-fmt-note">{SHORT_NOTE[f.format]}</div>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The chosen format's options (frames 6 to 9) and Include highlights.
 * @param props.format - The format whose options show.
 * @param props.options - Every option.
 * @param props.onChange - Called with the options changed.
 */
export function FormatOptions({
  format,
  options: o,
  onChange,
}: {
  format: ExportFormat;
  options: ExportOptions;
  onChange: (o: ExportOptions) => void;
}) {
  const set = <K extends keyof ExportOptions>(k: K, v: ExportOptions[K]) => onChange({ ...o, [k]: v });
  const label = { docx: 'Word', pdf: 'PDF', html: 'HTML', md: 'Markdown' }[format];
  return (
    <div className="dx-section" data-testid="export-options">
      <span className="dx-label">{label} options</span>
      <div className="dx-opts">
        {isPaged(format) && (
          <>
            <div className="dx-opt-pair">
              <OptRow label="Page size" grow={1.7}>
                <Seg
                  label="Page size"
                  testId="export-pagesize"
                  value={o.pageSize}
                  onChange={(v) => set('pageSize', v)}
                  choices={[
                    ['a4', 'A4'],
                    ['letter', 'Letter'],
                    ['fit', 'Fit to content'],
                  ]}
                />
              </OptRow>
              <OptRow label="Orientation" grow={1}>
                <Seg
                  label="Orientation"
                  testId="export-orientation"
                  value={optionDisabled(o, 'orientation') ? 'portrait' : o.orientation}
                  disabled={optionDisabled(o, 'orientation')}
                  onChange={(v) => set('orientation', v)}
                  choices={[
                    ['portrait', 'Portrait'],
                    ['landscape', 'Landscape'],
                  ]}
                />
              </OptRow>
            </div>
            <OptRow label="Margins">
              <Seg
                label="Margins"
                testId="export-margins"
                value={o.margins}
                onChange={(v) => set('margins', v)}
                choices={[
                  ['narrow', 'Narrow'],
                  ['normal', 'Normal'],
                  ['wide', 'Wide'],
                ]}
              />
            </OptRow>
            {o.pageSize === 'fit' && (
              <p className="dx-opt-hint">One long page: orientation and page numbers do not apply.</p>
            )}
            {format === 'docx' && (
              <p className="dx-opt-hint">
                The page’s styles stay styles: Title, Heading 1 to 4, Quote and Caption become Word styles you can
                change.
              </p>
            )}
          </>
        )}
        {format === 'html' && (
          <>
            <OptRow label="Files">
              <Seg
                label="Files"
                testId="export-layout"
                value={o.layout}
                onChange={(v) => set('layout', v)}
                choices={[
                  ['single', 'One file'],
                  ['folder', 'A folder with assets'],
                ]}
              />
            </OptRow>
            <p className="dx-opt-hint">
              {o.layout === 'single'
                ? 'Pictures are embedded inside it. Easy to send; larger.'
                : 'The page and an assets folder with pictures and videos, as a zip.'}
            </p>
            <OptRow label="Look">
              <Seg
                label="Look"
                testId="export-look"
                value={o.look}
                onChange={(v) => set('look', v)}
                choices={[
                  ['theme', 'Include the page theme'],
                  ['plain', 'Plain'],
                ]}
              />
            </OptRow>
            <p className="dx-opt-hint">
              The theme keeps the page’s fonts, colours and width. Plain uses the browser’s own style.
            </p>
          </>
        )}
        {format === 'md' && (
          <>
            <OptRow label="Pictures">
              <Seg
                label="Pictures"
                testId="export-images"
                value={o.images}
                onChange={(v) => set('images', v)}
                choices={[
                  ['folder', 'In a folder'],
                  ['inline', 'Inline in the file'],
                  ['link', 'As links'],
                ]}
              />
            </OptRow>
            <p className="dx-opt-hint">
              {o.images === 'folder'
                ? 'In a folder: images/ next to the file, as a zip.'
                : o.images === 'inline'
                  ? 'Inline: base64 text inside the file.'
                  : 'As links: the pictures stay where they are; the file points to them.'}
            </p>
            <OptRow label="Embeds are written as">
              <Seg
                label="Embeds are written as"
                testId="export-embeds"
                value={o.embeds}
                onChange={(v) => set('embeds', v)}
                choices={[
                  ['link', 'A link'],
                  ['placeholder', 'A placeholder'],
                ]}
              />
            </OptRow>
            <p className="dx-opt-hint">
              A link: [draw.io diagram](https://…). A placeholder: [embed: draw.io diagram].
            </p>
          </>
        )}
        <div className="dx-switches">
          {isPaged(format) && (
            <>
              {format === 'pdf' && (
                <SwitchRow
                  title="Cover page"
                  hint="The page cover and title on a first page."
                  on={o.coverPage}
                  onChange={(v) => set('coverPage', v)}
                  testId="export-cover"
                />
              )}
              <SwitchRow
                title="Header and footer"
                hint="Page title on top, page numbers at the bottom."
                on={optionDisabled(o, 'pageNumbers') ? false : o.pageNumbers}
                disabled={optionDisabled(o, 'pageNumbers')}
                onChange={(v) => set('pageNumbers', v)}
                testId="export-pagenumbers"
              />
              <SwitchRow
                title="Table of contents"
                hint={format === 'pdf' ? 'Headings 1 to 3, with page numbers.' : 'A Word contents list you can update.'}
                on={o.contents}
                onChange={(v) => set('contents', v)}
                testId="export-contents"
              />
              {format === 'docx' && (
                <SwitchRow
                  title="Cover page"
                  hint="The page cover and title on a first page."
                  on={o.coverPage}
                  onChange={(v) => set('coverPage', v)}
                  testId="export-cover"
                />
              )}
            </>
          )}
          <SwitchRow
            title="Include highlights"
            hint="Off by default. Adds everyone’s highlights, with their colour and who made them."
            on={o.includeHighlights}
            onChange={(v) => set('includeHighlights', v)}
            testId="export-highlights"
          />
        </div>
      </div>
    </div>
  );
}

interface ScopeCardProps {
  checked: boolean;
  title: string;
  detail?: string;
  count: string;
  disabled?: boolean;
  onPick: () => void;
  testId: string;
}

function ScopeCard({ checked, title, detail, count, disabled, onPick, testId }: ScopeCardProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className="dx-scope"
      disabled={disabled}
      onClick={onPick}
      data-testid={testId}
    >
      <span className="dx-radio" />
      <span className="dx-scope-main">
        {title}
        {detail && <span>{detail}</span>}
      </span>
      <span className="dx-scope-count">{count}</span>
    </button>
  );
}

/** What the form needs to know about the page and the space. */
export interface FormContext {
  pageTitle: string;
  projectName: string;
  /** The page's child pages in tree order (the page itself not included). */
  children: readonly DocsTreeNode[];
  /** Pages in the space. */
  spacePages: number;
  /** The person can edit (the published or draft choice shows). */
  canEdit: boolean;
  /** Some chosen page has changes not yet published. */
  anyDraft: boolean;
  /** The file's extension for the choices. */
  extension: string;
  /** How many embeds become pictures (PDF, Word); 0 for none. */
  embeds: number;
  /** Why Export is off (offline, empty page, a refused request); null when it is on. */
  blocked: { text: string; tone: 'warn' | 'err' } | null;
}

/**
 * The New export tab's content.
 * @param props.form - The choices.
 * @param props.onChange - Called with the choices changed.
 * @param props.ctx - What the form shows about the page and the space.
 */
export function ExportFormBody({ form, onChange, ctx }: { form: Form; onChange: (f: Form) => void; ctx: FormContext }) {
  const name = checkFileName(form.fileName);
  const kids = ctx.children;
  const total = kids.length + 1;
  const ticked = total - form.unticked.length;
  const zip = ctx.extension === 'zip';
  const set = (patch: Partial<Form>) => onChange({ ...form, ...patch });
  return (
    <>
      <FormatGrid value={form.format} onChange={(format) => set({ format })} />
      <FormatOptions format={form.format} options={form.options} onChange={(options) => set({ options })} />
      <div className="dx-section" role="radiogroup" aria-label="What to export">
        <span className="dx-label">What to export</span>
        <ScopeCard
          checked={form.scope === 'page'}
          title="This page"
          detail={ctx.pageTitle}
          count="1 page"
          onPick={() => set({ scope: 'page' })}
          testId="export-scope-page"
        />
        <ScopeCard
          checked={form.scope === 'children'}
          title="This page and its child pages"
          detail={kids.length ? `${ctx.pageTitle} and ${kids.length} below it` : 'This page has no child pages'}
          count={form.scope === 'children' && form.unticked.length ? `${ticked} of ${total} pages` : `${total} pages`}
          disabled={!kids.length}
          onPick={() => set({ scope: 'children' })}
          testId="export-scope-children"
        />
        {form.scope === 'children' && (
          <div className="dx-ticks" data-testid="export-ticks">
            <label className="dx-tick">
              <input type="checkbox" checked disabled />
              {ctx.pageTitle}
            </label>
            {kids.map((k) => (
              <label key={k.id} className="dx-tick">
                <input
                  type="checkbox"
                  checked={!form.unticked.includes(k.id)}
                  onChange={(e) =>
                    set({
                      unticked: e.target.checked ? form.unticked.filter((x) => x !== k.id) : [...form.unticked, k.id],
                    })
                  }
                />
                {k.title}
                {k.hasDraft && <span className="dx-tag">Draft</span>}
              </label>
            ))}
          </div>
        )}
        <ScopeCard
          checked={form.scope === 'space'}
          title="The whole space"
          detail={`${ctx.projectName}, as a zip`}
          count={`${ctx.spacePages} ${ctx.spacePages === 1 ? 'page' : 'pages'}`}
          onPick={() => set({ scope: 'space' })}
          testId="export-scope-space"
        />
      </div>
      {ctx.canEdit && ctx.anyDraft && (
        <div className="dx-section">
          <span className="dx-label">Pages with changes not yet published</span>
          <Seg
            label="Version"
            testId="export-version"
            value={form.draft ? 'draft' : 'published'}
            onChange={(v) => set({ draft: v === 'draft' })}
            choices={[
              ['published', 'Published version'],
              ['draft', 'My draft'],
            ]}
          />
        </div>
      )}
      <div className="dx-section">
        <label className="dx-label" htmlFor="export-file-name">
          File name
        </label>
        <div className="dx-name" data-invalid={!!name.error}>
          <input
            id="export-file-name"
            data-testid="export-file-name"
            value={form.fileName}
            aria-invalid={!!name.error}
            aria-describedby="export-file-name-line"
            onChange={(e) => set({ fileName: checkFileName(e.target.value).name, nameEdited: true })}
          />
          <span>.{ctx.extension}</span>
        </div>
        {name.error ? (
          <p id="export-file-name-line" className="dx-line dx-line-err" role="alert">
            {name.error}
          </p>
        ) : name.note ? (
          <p id="export-file-name-line" className="dx-line">
            {name.note}
          </p>
        ) : zip && form.scope !== 'page' ? (
          <p id="export-file-name-line" className="dx-line">
            Files inside are named after their pages, in folders like the page tree.
          </p>
        ) : null}
      </div>
      {ctx.blocked ? (
        <div className={`dx-note dx-note-${ctx.blocked.tone}`} role="status" data-testid="export-blocked">
          {ctx.blocked.text}
        </div>
      ) : form.scope === 'space' ? (
        <div className="dx-note" data-testid="export-background-note">
          This is a big one, so it runs in the background. You can close this window and keep working. We tell you when
          the zip is ready.
        </div>
      ) : isPaged(form.format) && ctx.embeds > 0 ? (
        <p className="dx-line dx-line-note" data-testid="export-embeds-note">
          <Icon name="i54" size={14} strokeWidth={2} />
          <span>{ctx.embeds === 1 ? '1 embed is' : `${ctx.embeds} embeds are`} exported as pictures.</span>
        </p>
      ) : form.format === 'md' && zip ? (
        <p className="dx-line">Pictures go into an images folder, so this exports as a zip.</p>
      ) : null}
    </>
  );
}
