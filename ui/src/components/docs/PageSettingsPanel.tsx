/**
 * Page settings (design boards "Rich Docs — app frame" 5 and 17, "new page, templates & page settings" 11-20): how a
 * page looks as a whole, in five tabs (Layout, Text, Colour, Cover, Header). Beside the page on a desktop, a drawer
 * over the right side on a tablet, a bottom sheet on a phone. The page changes as you choose; the changes are saved
 * after a short pause (usePageSettings).
 */

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { uploadDescriptionImage } from '../../api/tickets';
import { resolveOrigin } from '../../api/resolveOrigin';
import type { DocsLayout } from '../../hooks/useDocsLayout';
import type { DocsPage, DocsTreeNode, RichDoc } from '../../types/docs';
import { AccessTab, BookTab, type AnyPatch } from './tree/PageSettingsTabs';
import { useToast } from '../Toast';
import { BottomSheet, DocsDrawer } from './DocsSheets';
import { Icon } from './Icon';
import {
  BACKGROUNDS,
  BACKGROUND_LABEL,
  COVER_LABEL,
  FONTS,
  FONT_FAMILY,
  FONT_LABEL,
  FONT_PAIRINGS,
  HIGHLIGHT_NAMES,
  LINE_HEIGHTS,
  LOOK_KEYS,
  PALETTE,
  TEXT_COLOR_NAMES,
  TEXT_SIZES,
  TITLE_STYLES,
  WIDTHS,
  WIDTH_LABEL,
  WIDTH_PX,
  contrastRatio,
  coverUrl,
  readPageLook,
  type CoverHeight,
  type PageCover,
  type PageFont,
  type PageLook,
  type SettingsPatch,
} from './pageSettings';
import { draftDoc, publishedDoc } from './richPage';
import { usePageSettingsSaver } from './usePageSettings';

export type SettingsTab = 'layout' | 'text' | 'colour' | 'cover' | 'header' | 'book' | 'access';
const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'layout', label: 'Layout' },
  { id: 'text', label: 'Text' },
  { id: 'colour', label: 'Colour' },
  { id: 'cover', label: 'Cover' },
  { id: 'header', label: 'Header' },
  { id: 'book', label: 'Book' },
  { id: 'access', label: 'Access' },
];

/** The 15 px icons over the tab names on a phone (Shell 17; Book and Access, which the board does not draw, use the
 * app's book and lock). */
const TAB_ICON: Record<SettingsTab, string> = {
  layout: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.5 4.5v15"/>',
  text: '<path d="M5 7V5h14v2M12 5v14M9 19h6"/>',
  colour: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  cover:
    '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-5 4 4 3-3 4 4"/>',
  header: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  book: '<path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h10"/>',
  access: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8A4 4 0 0 1 16 8V11"/>',
};

interface Props {
  page: DocsPage;
  layout: DocsLayout;
  /** Why the settings can't be changed here (no edit rights, offline); null: they can. */
  readOnly?: string | null;
  initialTab?: SettingsTab;
  onClose: () => void;
  /** The space's tree (the Book tab counts the chapters). */
  nodes?: DocsTreeNode[];
  /** "Save as template…" at the foot of the panel (editors); left out when not given. */
  onSaveTemplate?: () => void;
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** A row of choices, one of them on (a radio group drawn as segments). */
function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: ReactNode; sub?: string }[];
  onChange: (v: T) => void;
  testId: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="dk-seg">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={`dk-seg-btn${o.value === value ? ' dk-seg-on' : ''}`}
          data-testid={`${testId}-${o.value}`}
          onClick={() => onChange(o.value)}
        >
          <span>{o.label}</span>
          {o.sub && <span className="dk-seg-sub">{o.sub}</span>}
        </button>
      ))}
    </div>
  );
}

/** An on/off switch with its label and a line under it. */
function Switch({
  label,
  hint,
  on,
  onChange,
  testId,
}: {
  label: string;
  hint?: string;
  on: boolean;
  onChange: (v: boolean) => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className="dk-switch-row"
      data-testid={testId}
      onClick={() => onChange(!on)}
    >
      <span className="dk-switch-text">
        <span>{label}</span>
        {hint && <span className="st-hint">{hint}</span>}
      </span>
      <span className="st-toggle-track" style={{ background: on ? '#2E6F40' : '#C7D2CB' }} aria-hidden="true">
        <span className="st-toggle-dot" style={{ left: on ? 17 : 2 }} />
      </span>
    </button>
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="dk-ps-field">
      <span className="st-field-label">{label}</span>
      {children}
      {hint && <span className="st-hint">{hint}</span>}
    </div>
  );
}

function FontSelect({
  label,
  value,
  onChange,
  allowSame,
  testId,
}: {
  label: string;
  value: PageFont | null;
  onChange: (v: PageFont | null) => void;
  allowSame?: boolean;
  testId: string;
}) {
  return (
    <select
      aria-label={label}
      className="st-input dk-ps-select"
      data-testid={testId}
      value={value ?? ''}
      style={{ fontFamily: value ? FONT_FAMILY[value] : undefined }}
      onChange={(e) => onChange((e.target.value || null) as PageFont | null)}
    >
      {allowSame && <option value="">Same as the text</option>}
      {FONTS.map((f) => (
        <option key={f} value={f}>
          {FONT_LABEL[f]}
        </option>
      ))}
    </select>
  );
}

/** Every picture of the page (published, else its draft): the "From this page" cover choices. */
function pageImages(page: DocsPage): string[] {
  const doc = publishedDoc(page) ?? draftDoc(page.draft);
  const out: string[] = [];
  const walk = (n: RichDoc) => {
    const src = n.type === 'image' ? n.attrs?.src : undefined;
    if (typeof src === 'string' && src && !out.includes(src)) out.push(src);
    n.content?.forEach(walk);
  };
  if (doc) walk(doc);
  return out.slice(0, 12);
}

/** The thumbnail text column of each width (app frame, B 5): 16, 22, 29 and 36 px wide in a 46 × 30 page. */
const WIDTH_THUMB: Record<(typeof WIDTHS)[number], number> = { narrow: 16, normal: 22, wide: 29, full: 36 };

/**
 * The four page widths as cards with a small page drawn in each (app frame, B 5): Narrow 560, Normal 680, Wide 880,
 * Full 100 %.
 * @param props.value - The width in use.
 * @param props.onChange - Called with the width picked.
 */
function WidthCards({
  value,
  onChange,
}: {
  value: (typeof WIDTHS)[number];
  onChange: (v: (typeof WIDTHS)[number]) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Page width" className="dk-ps-widths">
      {WIDTHS.map((w) => {
        const on = w === value;
        return (
          <button
            key={w}
            type="button"
            role="radio"
            aria-checked={on}
            className={`dk-ps-width${on ? ' dk-ps-width-on' : ''}`}
            data-testid={`ps-width-${w}`}
            onClick={() => onChange(w)}
          >
            <span className="dk-ps-width-page" aria-hidden="true">
              <span style={{ width: WIDTH_THUMB[w] }}>
                <span />
                <span style={{ width: '70%' }} />
              </span>
            </span>
            <span className="dk-ps-width-name">{WIDTH_LABEL[w]}</span>
            <span className="dk-ps-width-px">{WIDTH_PX[w] ? String(WIDTH_PX[w]) : '100%'}</span>
          </button>
        );
      })}
    </div>
  );
}

function LayoutTab({ look, set, layout, onMore }: TabProps & { layout: DocsLayout; onMore: () => void }) {
  return (
    <>
      <Field
        label="Page width"
        hint={
          layout === 'phone'
            ? 'On a phone the page is always the screen width.'
            : 'Sets the text column. Wide pictures, tables and code can still break out of it.'
        }
      >
        <WidthCards value={look.width} onChange={(v) => set({ width: v === 'normal' ? null : v })} />
      </Field>
      <Field label="Body font">
        <FontSelect
          label="Body font"
          testId="ps-body-font"
          value={look.bodyFont}
          onChange={(v) => set({ bodyFont: v && v !== 'jakarta' ? v : null })}
        />
      </Field>
      <TextSizeField look={look} set={set} />
      <Switch
        label="Show “On this page”"
        hint="The list of headings beside the page."
        on={look.showOutline}
        testId="ps-outline"
        onChange={(v) => set({ showOutline: v ? null : false })}
      />
      <button type="button" className="st-btn dk-ps-more" onClick={onMore} data-testid="ps-more">
        More settings…
      </button>
    </>
  );
}

interface TabProps {
  look: PageLook;
  set: (patch: SettingsPatch) => void;
}

function TextSizeField({ look, set }: TabProps) {
  return (
    <Field label="Text size">
      <Segmented
        label="Text size"
        testId="ps-size"
        value={look.textSize}
        onChange={(v) => set({ textSize: v === 'm' ? null : v })}
        options={TEXT_SIZES.map((s) => ({ value: s, label: s.toUpperCase() }))}
      />
    </Field>
  );
}

function TextTab({ look, set }: TabProps) {
  const pairing = FONT_PAIRINGS.find((p) => p.bodyFont === look.bodyFont && p.headingFont === look.headingFont);
  const lh = LINE_HEIGHTS.find((l) => l.value === look.lineHeight) ?? LINE_HEIGHTS[1];
  return (
    <>
      <Field label="Font pairing">
        <div role="radiogroup" aria-label="Font pairing" className="dk-ps-pairs">
          {FONT_PAIRINGS.map((p) => {
            const on = pairing?.id === p.id;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={on}
                className={`dk-ps-card${on ? ' dk-ps-card-on' : ''}`}
                data-testid={`ps-pair-${p.id}`}
                onClick={() =>
                  set({
                    bodyFont: p.bodyFont === 'jakarta' ? null : p.bodyFont,
                    headingFont: p.headingFont,
                  })
                }
              >
                <span className="dk-ps-aa" style={{ fontFamily: FONT_FAMILY[p.headingFont ?? p.bodyFont] }}>
                  Aa
                  <span style={{ fontFamily: FONT_FAMILY[p.bodyFont] }}>Body text</span>
                </span>
                <b>{p.label}</b>
                <span className="st-hint">{p.note}</span>
              </button>
            );
          })}
        </div>
      </Field>
      <Field label="Headings">
        <FontSelect
          label="Heading font"
          testId="ps-heading-font"
          allowSame
          value={look.headingFont}
          onChange={(v) => set({ headingFont: v })}
        />
      </Field>
      <Field label="Text">
        <FontSelect
          label="Text font"
          testId="ps-text-font"
          value={look.bodyFont}
          onChange={(v) => set({ bodyFont: v && v !== 'jakarta' ? v : null })}
        />
      </Field>
      <TextSizeField look={look} set={set} />
      <Field label="Line height" hint={`${lh.label} is ${lh.value.toFixed(1)} times the text size.`}>
        <Segmented
          label="Line height"
          testId="ps-lh"
          value={lh.value}
          onChange={(v) => set({ lineHeight: v })}
          options={LINE_HEIGHTS.map((l) => ({ value: l.value, label: l.label }))}
        />
      </Field>
    </>
  );
}

function ColourTab({ look, set }: TabProps) {
  const pal = PALETTE[look.background];
  const ratio = contrastRatio(pal.ink, pal.page);
  const rows: [string, string, string][] = [
    ['Page background', BACKGROUND_LABEL[look.background], pal.page],
    ['Text', 'Ink', pal.ink],
    ['Links', 'Green', pal.text.green],
    ['Accent', 'Teal', pal.text.teal],
  ];
  return (
    <>
      <Field label="Page theme">
        <div role="radiogroup" aria-label="Page theme" className="dk-ps-themes">
          {BACKGROUNDS.map((b) => {
            const on = look.background === b;
            return (
              <button
                key={b}
                type="button"
                role="radio"
                aria-checked={on}
                className={`dk-ps-theme${on ? ' dk-ps-card-on' : ''}`}
                data-testid={`ps-bg-${b}`}
                onClick={() => set({ background: b === 'white' ? null : b })}
              >
                <span className="dk-ps-swatch" style={{ background: PALETTE[b].page, color: PALETTE[b].ink }}>
                  Aa
                </span>
                <span>
                  <b>{BACKGROUND_LABEL[b]}</b>
                  {on && <span className="dk-ps-inuse">In use</span>}
                </span>
                <span className="dk-ps-hex">{PALETTE[b].page}</span>
              </button>
            );
          })}
        </div>
      </Field>
      <Field
        label="Page colours"
        hint={`Text on page: ${ratio.toFixed(1)} : 1. ${ratio >= 7 ? 'Easy to read.' : ratio >= 4.5 ? 'Readable.' : 'Hard to read.'}`}
      >
        <div className="dk-ps-colours">
          {rows.map(([what, name, hex]) => (
            <div key={what} className="dk-ps-colour">
              <span>{what}</span>
              <span className="dk-ps-dot" style={{ background: hex }} />
              <span>{name}</span>
              <span className="dk-ps-hex">{hex}</span>
            </div>
          ))}
        </div>
      </Field>
      <Field
        label={`Text colours · ${BACKGROUND_LABEL[look.background]} page`}
        hint="The 12 text and 12 highlight colours keep their names on every theme; only their values shift so text stays readable."
      >
        <div className="dk-ps-palette" data-testid="ps-palette-text">
          {TEXT_COLOR_NAMES.map((n) => (
            <span key={n} className="dk-ps-chip" title={pal.text[n]}>
              <span className="dk-ps-dot" style={{ background: pal.text[n] }} />
              {cap(n)}
            </span>
          ))}
        </div>
        <span className="st-field-label" style={{ marginTop: 8 }}>
          Highlights
        </span>
        <div className="dk-ps-palette" data-testid="ps-palette-highlight">
          {HIGHLIGHT_NAMES.map((n) => (
            <span key={n} className="dk-ps-chip" title={pal.highlight[n]}>
              <span className="dk-ps-dot" style={{ background: pal.highlight[n] }} />
              {cap(n)}
            </span>
          ))}
        </div>
      </Field>
    </>
  );
}

function CoverTab({ look, set, page }: TabProps & { page: DocsPage }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [link, setLink] = useState('');
  const [picking, setPicking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const images = useMemo(() => pageImages(page), [page]);
  const cover = look.cover;
  const setCover = (c: Partial<PageCover>) =>
    set({ cover: { ...(cover ?? { positionY: 50, height: 'm', titleOnCover: false }), ...c } });
  const choose = (src: string) => {
    setPicking(false);
    setCover({ src });
  };
  async function upload(file: File) {
    setUploading(true);
    try {
      const res = await uploadDescriptionImage(file);
      choose(res.url);
    } catch {
      toast.error('Could not upload the image', 'Check the file type (png, jpeg, gif, webp) and size (max 5 MB).');
    } finally {
      setUploading(false);
    }
  }
  const sources = (
    <div className="dk-ps-field" data-testid="ps-cover-sources">
      <span className="st-field-label">Source</span>
      <button
        type="button"
        className="st-btn"
        disabled={uploading}
        onClick={() => fileRef.current?.click()}
        data-testid="ps-cover-upload"
      >
        {uploading ? <span className="mc-spin" /> : <Icon name="i26" size={14} />}
        Upload an image
      </button>
      <input
        ref={fileRef}
        type="file"
        hidden
        aria-label="Upload a cover image"
        accept="image/png,image/jpeg,image/gif,image/webp"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void upload(f);
        }}
      />
      {images.length > 0 && (
        <>
          <span className="st-hint">From this page</span>
          <div className="dk-ps-thumbs">
            {images.map((src) => (
              <button
                key={src}
                type="button"
                className="dk-ps-thumb"
                aria-label={`Use ${src.split('/').pop()} as the cover`}
                onClick={() => choose(src)}
              >
                <img src={coverUrl(src, resolveOrigin())} alt="" loading="lazy" />
              </button>
            ))}
          </div>
        </>
      )}
      <span className="st-hint">From a link</span>
      <form
        className="dk-ps-link"
        onSubmit={(e) => {
          e.preventDefault();
          const v = link.trim();
          if (!/^(https?:\/\/|\/uploads\/)/.test(v)) {
            toast.error('Not a picture link', 'Paste a link that starts with https://.');
            return;
          }
          setLink('');
          choose(v);
        }}
      >
        <input
          className="st-input"
          aria-label="Image link"
          placeholder="https://…"
          value={link}
          onChange={(e) => setLink(e.target.value)}
        />
        <button type="submit" className="st-btn" disabled={!link.trim()}>
          Use
        </button>
      </form>
    </div>
  );
  if (!cover || picking) {
    return (
      <>
        {!cover && <p className="st-hint">A picture across the top of the page, above the title.</p>}
        {sources}
        {picking && (
          <button type="button" className="st-btn" onClick={() => setPicking(false)}>
            Keep the current cover
          </button>
        )}
      </>
    );
  }
  return (
    <>
      <div
        className="dk-ps-cover"
        style={{
          backgroundImage: `url("${coverUrl(cover.src, resolveOrigin())}")`,
          backgroundPosition: `center ${cover.positionY}%`,
        }}
        data-testid="ps-cover-preview"
      />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="st-btn" onClick={() => setPicking(true)}>
          Change image
        </button>
        <button
          type="button"
          className="st-btn st-btn-danger-outline"
          onClick={() => set({ cover: null })}
          data-testid="ps-cover-remove"
        >
          Remove
        </button>
      </div>
      <Field label="Position" hint="Which part of the picture shows: 0 is the top, 100 the bottom.">
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          aria-label="Vertical position"
          className="dk-ps-range"
          value={cover.positionY}
          onChange={(e) => setCover({ positionY: Number(e.target.value) })}
        />
      </Field>
      <Field label="Height">
        <Segmented
          label="Cover height"
          testId="ps-cover-height"
          value={cover.height}
          onChange={(v: CoverHeight) => setCover({ height: v })}
          options={(['s', 'm', 'l'] as const).map((h) => ({ value: h, label: COVER_LABEL[h] }))}
        />
      </Field>
      <Switch
        label="Title over the cover"
        hint="The title sits on the picture."
        on={cover.titleOnCover}
        testId="ps-cover-title"
        onChange={(v) => setCover({ titleOnCover: v })}
      />
    </>
  );
}

function HeaderTab({ look, set }: TabProps) {
  const [eyebrow, setEyebrow] = useState(look.eyebrow ?? '');
  return (
    <>
      <Field label="Title style">
        <Segmented
          label="Title style"
          testId="ps-title-style"
          value={look.titleStyle}
          onChange={(v) => set({ titleStyle: v === 'plain' ? null : v })}
          options={TITLE_STYLES}
        />
      </Field>
      <Field label="Title alignment">
        <Segmented
          label="Title alignment"
          testId="ps-title-align"
          value={look.titleAlign}
          onChange={(v) => set({ titleAlign: v === 'left' ? null : v })}
          options={[
            { value: 'left', label: 'Left' },
            { value: 'center', label: 'Centre' },
          ]}
        />
      </Field>
      <Field label="Eyebrow" hint="The small line above the title, for example ENGINEERING NOTES.">
        <input
          className="st-input"
          aria-label="Eyebrow"
          data-testid="ps-eyebrow"
          placeholder="None"
          maxLength={80}
          value={eyebrow}
          onChange={(e) => {
            setEyebrow(e.target.value);
            set({ eyebrow: e.target.value.trim() ? e.target.value : null });
          }}
        />
      </Field>
      <Switch
        label="Author line"
        hint="Name and date under the title."
        on={look.showByline}
        testId="ps-byline"
        onChange={(v) => set({ showByline: v ? null : false })}
      />
      <Switch
        label="Reading time"
        hint="For example 6 min read."
        on={look.showReadingTime}
        testId="ps-reading-time"
        onChange={(v) => set({ showReadingTime: v ? null : false })}
      />
    </>
  );
}

/**
 * The Page settings panel.
 * @param props.page - The page (its `settings` are what the panel shows; they update as you choose).
 * @param props.layout - Beside the page (desktop), a drawer (tablet) or a bottom sheet (phone).
 * @param props.readOnly - Why the settings can't be changed (shown at the top, every control disabled); null: they
 *   can.
 * @param props.initialTab - The tab it opens on.
 * @param props.onClose - Called by Done, the close button, Esc or a tap outside.
 * @param props.onSaveTemplate - Opens "Save as a template" for the page.
 * @param props.nodes - The space's tree (the Book tab counts the chapters).
 */
export function PageSettingsPanel({
  page,
  layout,
  readOnly,
  initialTab = 'layout',
  onClose,
  onSaveTemplate,
  nodes,
}: Props) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const save = usePageSettingsSaver(page.id);
  const look = readPageLook(page.settings);
  const set = (patch: SettingsPatch) => {
    if (!readOnly) save(patch);
  };
  // the Book and Access tabs change keys beyond the look (book, notForAi, highlights); the saver sends any key
  const setAny = (patch: AnyPatch) => set(patch as SettingsPatch);
  const anySet = LOOK_KEYS.some((k) => page.settings?.[k] !== undefined);

  const body = (
    <div className="dk-ps docs-root" data-testid="page-settings">
      <div className="dk-ps-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 className="dk-ps-title">Page settings</h2>
          <span className="st-hint">Applies to this page only.</span>
        </div>
        <button
          type="button"
          className={layout === 'phone' ? 'dk-ps-reset-link' : 'st-btn st-btn-sm'}
          disabled={!!readOnly || !anySet}
          data-testid="ps-reset"
          onClick={() => set(Object.fromEntries(LOOK_KEYS.map((k) => [k, null])))}
        >
          Reset
        </button>
        <button type="button" className="dk-icobtn" aria-label="Close page settings" onClick={onClose}>
          <Icon name="close" size={16} strokeWidth={layout === 'phone' ? 1.8 : 2} />
        </button>
      </div>
      {readOnly && (
        <div className="dk-ps-readonly" role="note">
          <Icon name="lock" size={14} />
          {readOnly}
        </div>
      )}
      <div role="tablist" aria-label="Page settings" className="dk-ps-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`ps-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="ps-panel"
            className={`dk-ps-tab${tab === t.id ? ' dk-ps-tab-on' : ''}`}
            data-testid={`ps-tab-${t.id}`}
            onClick={() => setTab(t.id)}
          >
            {layout === 'phone' && (
              <svg
                aria-hidden="true"
                width={15}
                height={15}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                dangerouslySetInnerHTML={{ __html: TAB_ICON[t.id] }}
              />
            )}
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="ps-panel" aria-labelledby={`ps-tab-${tab}`} className="dk-ps-panel">
        <fieldset disabled={!!readOnly} className="dk-ps-fields">
          {tab === 'layout' && <LayoutTab look={look} set={set} layout={layout} onMore={() => setTab('text')} />}
          {tab === 'text' && <TextTab look={look} set={set} />}
          {tab === 'colour' && <ColourTab look={look} set={set} />}
          {tab === 'cover' && <CoverTab look={look} set={set} page={page} />}
          {tab === 'header' && <HeaderTab key={page.id} look={look} set={set} />}
          {tab === 'book' && <BookTab page={page} nodes={nodes ?? []} set={setAny} />}
          {tab === 'access' && <AccessTab page={page} set={setAny} />}
        </fieldset>
      </div>
      <div className="dk-ps-foot">
        {onSaveTemplate && !readOnly && (
          <button
            type="button"
            className="st-btn"
            style={{ marginRight: 'auto' }}
            onClick={onSaveTemplate}
            data-testid="ps-save-template"
          >
            Save as template…
          </button>
        )}
        <button type="button" className="st-btn st-btn-primary" onClick={onClose} data-testid="ps-done">
          Done
        </button>
      </div>
    </div>
  );

  if (layout === 'phone') {
    return (
      <BottomSheet label="Page settings" onClose={onClose} testId="page-settings-sheet" hideTitle>
        {body}
      </BottomSheet>
    );
  }
  if (layout === 'tablet') {
    return (
      <DocsDrawer side="right" width={380} label="Page settings" onClose={onClose} testId="page-settings-drawer">
        {body}
      </DocsDrawer>
    );
  }
  return (
    <aside aria-label="Page settings" className="dk-ps-aside">
      {body}
    </aside>
  );
}
