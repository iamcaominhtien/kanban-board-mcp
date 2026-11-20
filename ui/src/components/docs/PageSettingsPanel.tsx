/**
 * Page settings (design boards "Rich Docs — app frame" 5 and 17, "new page, templates & page settings" 11-20): how a
 * page looks as a whole, in five tabs (Layout, Text, Colour, Cover, Header) and the Book and Access tabs. Beside the
 * page on a desktop, a drawer over the right side on a tablet, a bottom sheet on a phone. The page changes as you
 * choose; the changes are saved after a short pause (usePageSettings).
 */

import { useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
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
  BASE_SIZE_MAX,
  BASE_SIZE_MIN,
  COVER_LABEL,
  COVER_PX,
  FONTS,
  FONT_FAMILY,
  FONT_LABEL,
  FONT_PAIRINGS,
  HIGHLIGHT_NAMES,
  LINE_HEIGHTS,
  LOOK_KEYS,
  PALETTE,
  ROOMS,
  TEXT_COLOR_NAMES,
  TITLE_SIZES,
  TITLE_STYLES,
  WIDTHS,
  WIDTH_LABEL,
  WIDTH_PX,
  contrastRatio,
  coverStyle,
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
import './pageSettings.css';

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

/** The 15 px icons over the tab names (Start 11-15; Book and Access, which the board does not draw, use the app's
 * book and lock). */
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

/** The four lines of each alignment button (16 px, Start 12 and 15). */
const ALIGN_ICON: Record<'left' | 'center' | 'right' | 'justify', string> = {
  left: '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>',
  center: '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>',
  right: '<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>',
  justify: '<path d="M4 6h16M4 10h16M4 14h16M4 18h16"/>',
};
const ALIGN_LABEL = { left: 'Left', center: 'Centre', right: 'Right', justify: 'Justify' } as const;

function Svg({ d, size = 15, sw = 1.9 }: { d: string; size?: number; sw?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      dangerouslySetInnerHTML={{ __html: d }}
    />
  );
}

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

/** A row of choices, one of them on (a radio group drawn as the board's pill segments). */
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
    <div role="radiogroup" aria-label={label} className="dk-seg dk-ps-seg">
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

/** Alignment as a row of 30 px icon buttons (Start 12 and 15). */
function AlignButtons<T extends keyof typeof ALIGN_ICON>({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
  testId: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="dk-ps-aligns">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          role="radio"
          aria-checked={o === value}
          aria-label={ALIGN_LABEL[o]}
          title={ALIGN_LABEL[o]}
          className={`dk-ps-align${o === value ? ' dk-ps-align-on' : ''}`}
          data-testid={`${testId}-${o}`}
          onClick={() => onChange(o)}
        >
          <Svg d={ALIGN_ICON[o]} size={16} />
        </button>
      ))}
    </div>
  );
}

/** A slider drawn as the board's: a 4 px track filled in green and a 16 px round thumb. */
function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  testId,
  ends,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  testId: string;
  /** Small marks at each end (the "A" and the big "A" of Base size). */
  ends?: [ReactNode, ReactNode];
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="dk-ps-slider">
      {ends?.[0]}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        data-testid={testId}
        className="dk-ps-range"
        style={{ '--pct': `${pct}%` } as CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {ends?.[1]}
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

function Field({
  label,
  children,
  hint,
  value,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
  /** A value shown at the right of the label ("17 px"). */
  value?: ReactNode;
}) {
  return (
    <div className="dk-ps-field">
      <span className="dk-ps-label">
        <span className="st-field-label">{label}</span>
        {value != null && <span className="dk-ps-value">{value}</span>}
      </span>
      {children}
      {hint && <span className="dk-ps-hint">{hint}</span>}
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

/** Every picture of the page (published, else its draft): the "This page" cover choices. */
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

/** The thumbnail text column of each width (Start 11): 22, 31, 41 and 50 px wide in a 58 × 38 page. */
const WIDTH_THUMB: Record<(typeof WIDTHS)[number], number> = { narrow: 22, normal: 31, wide: 41, full: 50 };

/**
 * The four page widths as cards with a small page drawn in each (Start 11): Narrow 560, Normal 680, Wide 880,
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

interface TabProps {
  look: PageLook;
  set: (patch: SettingsPatch) => void;
}

/** Layout (Start 11): width, margins, spacing between blocks, continuous or paged, the editor's side outline. */
function LayoutTab({ look, set, layout }: TabProps & { layout: DocsLayout }) {
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
      <Field label="Margins">
        <Segmented
          label="Margins"
          testId="ps-margins"
          value={look.margins}
          onChange={(v) => set({ margins: v === 'normal' ? null : v })}
          options={ROOMS}
        />
      </Field>
      <Field label="Spacing between blocks">
        <Segmented
          label="Spacing between blocks"
          testId="ps-spacing"
          value={look.blockSpacing}
          onChange={(v) => set({ blockSpacing: v === 'normal' ? null : v })}
          options={ROOMS}
        />
      </Field>
      <Field label="View" hint="Paged adds page breaks for print and PDF. Reading stays continuous.">
        <Segmented
          label="View"
          testId="ps-view"
          value={look.view}
          onChange={(v) => set({ view: v === 'continuous' ? null : v })}
          options={[
            { value: 'continuous', label: 'Continuous' },
            { value: 'paged', label: 'Paged' },
          ]}
        />
      </Field>
      <Switch
        label="Side outline in the editor"
        hint="Shows headings next to the page while you write."
        on={look.editorOutline}
        testId="ps-editor-outline"
        onChange={(v) => set({ editorOutline: v ? null : false })}
      />
    </>
  );
}

/** Text (Start 12): font pairing, heading and text fonts, base size, line height, paragraphs, alignment, drop cap. */
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
                <span className="dk-ps-card-note">{p.note}</span>
              </button>
            );
          })}
        </div>
      </Field>
      <div className="dk-ps-pair-row">
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
      </div>
      <Field label="Base size" value={`${look.sizePx} px`}>
        <Slider
          label="Base size"
          testId="ps-base-size"
          min={BASE_SIZE_MIN}
          max={BASE_SIZE_MAX}
          step={0.5}
          value={look.sizePx}
          // the base size replaces the S / M / L step it was drawn from
          onChange={(v) => set({ baseSize: v, textSize: null })}
          ends={[
            <span key="s" className="dk-ps-a-small" aria-hidden="true">
              A
            </span>,
            <span key="l" className="dk-ps-a-big" aria-hidden="true">
              A
            </span>,
          ]}
        />
      </Field>
      <Field label="Line height" hint={`${lh.label} is ${lh.value.toFixed(1)} times the text size.`}>
        <Segmented
          label="Line height"
          testId="ps-lh"
          value={lh.value}
          onChange={(v) => set({ lineHeight: v })}
          options={LINE_HEIGHTS.map((l) => ({ value: l.value, label: l.label }))}
        />
      </Field>
      <Field label="Paragraphs">
        <Segmented
          label="Paragraphs"
          testId="ps-paragraphs"
          value={look.paragraphs}
          onChange={(v) => set({ paragraphs: v === 'space' ? null : v })}
          options={[
            { value: 'space', label: 'Space between' },
            { value: 'indent', label: 'First-line indent' },
          ]}
        />
      </Field>
      <Field label="Alignment">
        <AlignButtons
          label="Text alignment"
          testId="ps-text-align"
          value={look.textAlign}
          options={['left', 'center', 'right', 'justify'] as const}
          onChange={(v) => set({ textAlign: v === 'left' ? null : v })}
        />
      </Field>
      <Switch
        label="Drop cap on the first paragraph"
        on={look.dropCap}
        testId="ps-drop-cap"
        onChange={(v) => set({ dropCap: v ? true : null })}
      />
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

type CoverSource = 'upload' | 'page' | 'colour';
/** The 3 × 3 position grid: each cell's `positionX`, `positionY`. */
const GRID = [0, 50, 100].flatMap((y) => [0, 50, 100].map((x) => [x, y] as const));
const POS_NAME = ['top', 'middle', 'bottom'];
const POS_X_NAME = ['left', 'centre', 'right'];

/** The stored form of a cover: no empty `src`, no `color` on a picture. */
function coverValue(c: PageCover): Record<string, unknown> {
  const out: Record<string, unknown> = c.color && !c.src ? { color: c.color } : { src: c.src };
  return {
    ...out,
    positionX: c.positionX,
    positionY: c.positionY,
    height: c.height,
    fit: c.fit,
    dim: c.dim,
    titleOnCover: c.titleOnCover,
  };
}

/** Cover (Start 14): the picture with a drag to reposition, its source, height, position, fit, dim and the title. */
function CoverTab({ look, set, page }: TabProps & { page: DocsPage }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [link, setLink] = useState('');
  const [uploading, setUploading] = useState(false);
  const images = useMemo(() => pageImages(page), [page]);
  const cover = look.cover;
  const [source, setSource] = useState<CoverSource>(cover?.color && !cover.src ? 'colour' : 'upload');
  const base: PageCover = cover ?? {
    src: '',
    color: null,
    positionX: 50,
    positionY: 50,
    height: 'm',
    fit: 'fill',
    dim: 0,
    titleOnCover: false,
  };
  const setCover = (c: Partial<PageCover>) => set({ cover: coverValue({ ...base, ...c }) });
  const choose = (src: string) => setCover({ src, color: null });
  const dragging = useRef(false);
  const moveTo = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.round(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)));
    const y = Math.round(Math.min(100, Math.max(0, ((e.clientY - r.top) / r.height) * 100)));
    setCover({ positionX: x, positionY: y });
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
  const picture = !!cover?.src;
  const coverColours = TEXT_COLOR_NAMES.map((n) => PALETTE.white.text[n]);
  return (
    <>
      {cover ? (
        <div
          className="dk-ps-cover"
          style={coverStyle(cover, resolveOrigin())}
          data-testid="ps-cover-preview"
          onPointerDown={(e) => {
            if (!picture) return;
            dragging.current = true;
            e.currentTarget.setPointerCapture?.(e.pointerId);
            moveTo(e);
          }}
          onPointerMove={(e) => dragging.current && moveTo(e)}
          onPointerUp={() => (dragging.current = false)}
        >
          {picture && (
            <>
              <span
                className="dk-ps-cover-dot"
                // the ring stays inside the frame at the edges
                style={{
                  left: `clamp(11px, ${cover.positionX}%, calc(100% - 11px))`,
                  top: `clamp(11px, ${cover.positionY}%, calc(100% - 11px))`,
                }}
                aria-hidden="true"
              />
              <span className="dk-ps-cover-tip">Drag to reposition</span>
            </>
          )}
        </div>
      ) : (
        <div className="dk-ps-cover dk-ps-cover-none" data-testid="ps-cover-preview">
          <Svg d={TAB_ICON.cover} size={20} />
          <span>A picture across the top of the page, above the title.</span>
        </div>
      )}
      {cover && (
        <div className="dk-ps-row">
          <button type="button" className="st-btn" onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? <span className="mc-spin" /> : <Svg d={TAB_ICON.cover} size={14} sw={2} />}
            Change image
          </button>
          <button type="button" className="st-btn" onClick={() => set({ cover: null })} data-testid="ps-cover-remove">
            Remove
          </button>
        </div>
      )}
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
      <Field label="Source">
        <Segmented
          label="Cover source"
          testId="ps-cover-source"
          value={source}
          onChange={setSource}
          options={[
            { value: 'upload', label: 'Upload' },
            { value: 'page', label: 'This page' },
            { value: 'colour', label: 'Colour' },
          ]}
        />
        <div className="dk-ps-source" data-testid="ps-cover-sources">
          {source === 'upload' && (
            <>
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
                  placeholder="Or paste a link: https://…"
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                />
                <button type="submit" className="st-btn" disabled={!link.trim()}>
                  Use
                </button>
              </form>
            </>
          )}
          {source === 'page' &&
            (images.length > 0 ? (
              <div className="dk-ps-thumbs">
                {images.map((src) => (
                  <button
                    key={src}
                    type="button"
                    className={`dk-ps-thumb${cover?.src === src ? ' dk-ps-thumb-on' : ''}`}
                    aria-label={`Use ${src.split('/').pop()} as the cover`}
                    onClick={() => choose(src)}
                  >
                    <img src={coverUrl(src, resolveOrigin())} alt="" loading="lazy" />
                  </button>
                ))}
              </div>
            ) : (
              <span className="dk-ps-hint">This page has no pictures yet.</span>
            ))}
          {source === 'colour' && (
            <div className="dk-ps-cover-colours" role="radiogroup" aria-label="Cover colour">
              {coverColours.map((hex, i) => (
                <button
                  key={hex}
                  type="button"
                  role="radio"
                  aria-checked={!picture && cover?.color === hex}
                  aria-label={cap(TEXT_COLOR_NAMES[i])}
                  title={cap(TEXT_COLOR_NAMES[i])}
                  className={`dk-ps-cover-colour${!picture && cover?.color === hex ? ' dk-ps-cover-colour-on' : ''}`}
                  style={{ background: hex }}
                  data-testid={`ps-cover-colour-${TEXT_COLOR_NAMES[i]}`}
                  onClick={() => setCover({ src: '', color: hex })}
                />
              ))}
            </div>
          )}
        </div>
      </Field>
      <fieldset disabled={!cover} className="dk-ps-sub">
        <Field label="Height" value={`${COVER_PX[base.height]} px`}>
          <Segmented
            label="Cover height"
            testId="ps-cover-height"
            value={base.height}
            onChange={(v: CoverHeight) => setCover({ height: v })}
            options={(['s', 'm', 'l', 'full'] as const).map((h) => ({ value: h, label: COVER_LABEL[h] }))}
          />
        </Field>
        <div className="dk-ps-cover-grid-row">
          <Field label="Position">
            <div role="radiogroup" aria-label="Cover position" className="dk-ps-grid">
              {GRID.map(([x, y]) => {
                const on = !!picture && base.positionX === x && base.positionY === y;
                return (
                  <button
                    key={`${x}-${y}`}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={`${POS_NAME[y / 50]} ${POS_X_NAME[x / 50]}`}
                    className={`dk-ps-grid-cell${on ? ' dk-ps-grid-on' : ''}`}
                    data-testid={`ps-cover-pos-${x}-${y}`}
                    disabled={!picture}
                    onClick={() => setCover({ positionX: x, positionY: y })}
                  />
                );
              })}
            </div>
          </Field>
          <div className="dk-ps-cover-fit">
            <Field label="Fit">
              <Segmented
                label="Cover fit"
                testId="ps-cover-fit"
                value={base.fit}
                onChange={(v) => setCover({ fit: v })}
                options={[
                  { value: 'fill', label: 'Fill' },
                  { value: 'fit', label: 'Fit' },
                ]}
              />
            </Field>
            <Field label="Dim the image">
              <Slider
                label="Dim the image"
                testId="ps-cover-dim"
                min={0}
                max={80}
                step={5}
                value={base.dim}
                onChange={(v) => setCover({ dim: v })}
              />
            </Field>
          </div>
        </div>
        <Switch
          label="Title over the cover"
          hint="The title sits on the picture."
          on={base.titleOnCover}
          testId="ps-cover-title"
          onChange={(v) => setCover({ titleOnCover: v })}
        />
      </fieldset>
    </>
  );
}

/** Header (Start 15): title size and alignment, then what readers see around the title. */
function HeaderTab({ look, set }: TabProps) {
  const [eyebrow, setEyebrow] = useState(look.eyebrow ?? '');
  return (
    <>
      <Field label="Title size">
        <Segmented
          label="Title size"
          testId="ps-title-size"
          value={look.titleSize}
          onChange={(v) => set({ titleSize: v === 'standard' ? null : v })}
          options={TITLE_SIZES}
        />
      </Field>
      <Field label="Title alignment">
        <AlignButtons
          label="Title alignment"
          testId="ps-title-align"
          value={look.titleAlign}
          options={['left', 'center', 'right'] as const}
          onChange={(v) => set({ titleAlign: v === 'left' ? null : v })}
        />
      </Field>
      <div className="dk-ps-rule" />
      <Switch
        label="Show the title"
        on={look.showTitle}
        testId="ps-show-title"
        onChange={(v) => set({ showTitle: v ? null : false })}
      />
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
      <Switch
        label="Edited by, and when"
        hint="“Edited by Hoa Mai · 2h ago”."
        on={look.showEditedBy}
        testId="ps-edited-by"
        onChange={(v) => set({ showEditedBy: v ? null : false })}
      />
      <Switch
        label="Outline"
        hint="The “On this page” list for readers."
        on={look.showOutline}
        testId="ps-outline"
        onChange={(v) => set({ showOutline: v ? null : false })}
      />
      {look.showOutline && (
        <Field label="Outline depth">
          <Segmented
            label="Outline depth"
            testId="ps-outline-depth"
            value={look.outlineDepth}
            onChange={(v) => set({ outlineDepth: v === 3 ? null : v })}
            options={[
              { value: 2, label: 'Headings 2' },
              { value: 3, label: 'Headings 2 and 3' },
            ]}
          />
        </Field>
      )}
      <div className="dk-ps-rule" />
      <Field label="Title style">
        <Segmented
          label="Title style"
          testId="ps-title-style"
          value={look.titleStyle}
          onChange={(v) => set({ titleStyle: v === 'plain' ? null : v })}
          options={TITLE_STYLES}
        />
      </Field>
      <Field label="Eyebrow" hint="The small line above the title, for example ENGINEERING NOTES.">
        <input
          className="st-input dk-ps-input"
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
    </>
  );
}

/** The template icon of "Save as template…" (14 px, Start 11). */
const TEMPLATE_ICON = '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M3.5 9h17M9 9v11.5"/>';

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
          className="dk-ps-reset-link"
          disabled={!!readOnly || !anySet}
          data-testid="ps-reset"
          onClick={() => set(Object.fromEntries(LOOK_KEYS.map((k) => [k, null])))}
        >
          Reset
        </button>
        <button type="button" className="dk-icobtn dk-ps-close" aria-label="Close page settings" onClick={onClose}>
          <Icon name="close" size={16} strokeWidth={1.9} />
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
            <Svg d={TAB_ICON[t.id]} size={15} sw={layout === 'phone' ? 1.8 : 1.9} />
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="ps-panel" aria-labelledby={`ps-tab-${tab}`} className="dk-ps-panel">
        <fieldset disabled={!!readOnly} className={`dk-ps-fields dk-ps-fields-${tab}`}>
          {tab === 'layout' && <LayoutTab look={look} set={set} layout={layout} />}
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
          <button type="button" className="dk-ps-template" onClick={onSaveTemplate} data-testid="ps-save-template">
            <Svg d={TEMPLATE_ICON} size={14} />
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
