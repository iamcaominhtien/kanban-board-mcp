/**
 * The frame of the export dialog: a centred panel on a desktop, the same panel 640 wide from the top on a tablet,
 * and a sheet that fills most of the screen on a phone (frames 1 to 4). Also the few icons the export screens use.
 */

import type { ReactNode } from 'react';
import type { DocsLayout } from '../../../hooks/useDocsLayout';
import { BottomSheet } from '../DocsSheets';
import { CloseButton, DOCS_SCRIM, useEscape } from '../docsShared';
import type { ExportFormat } from './exportModel';
import './export.css';
import '../reader.css';

/**
 * A stroked 24-unit icon.
 * @param props.d - The path data, one string per path.
 * @param props.size - Width and height in px.
 */
export function Svg({ d, size = 16, width = 1.9 }: { d: readonly string[]; size?: number; width?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {d.map((p) => (
        <path key={p} d={p} />
      ))}
    </svg>
  );
}

export const ICONS = {
  download: ['M12 4v11', 'M7 11l5 5 5-5', 'M5 20h14'],
  check: ['M5 12.5L10 17.5L19 7'],
  alert: ['M12 3l9.5 17h-19z', 'M12 10v4', 'M12 17.5v.01'],
  stop: ['M7 7h10v10H7z'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  grip: ['M9 6h.01', 'M15 6h.01', 'M9 12h.01', 'M15 12h.01', 'M9 18h.01', 'M15 18h.01'],
  book: ['M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z', 'M4 21V5', 'M8 7h7'],
  close: ['M6 6L18 18', 'M18 6L6 18'],
} as const;

/** Each format's badge: colours and paths (from the design board). */
export const FORMAT_ICON: Record<ExportFormat, { bg: string; fg: string; d: readonly string[] }> = {
  docx: {
    bg: '#E1EEFB',
    fg: '#1F5A8E',
    d: ['M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z', 'M7 8l2 8 3-6 3 6 2-8'],
  },
  pdf: { bg: '#FDF1EE', fg: '#C4432A', d: ['M6 3h8l4 4v14H6z', 'M14 3v5h5'] },
  html: { bg: '#FDF3E3', fg: '#8A5A00', d: ['M8 7l-5 5 5 5M16 7l5 5-5 5M14 5l-4 14'] },
  md: {
    bg: '#EEF3EF',
    fg: '#3A4A3E',
    d: [
      'M4.5 6h15a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z',
      'M6 15V9l3 3 3-3v6M17 9v6M15 13l2 2 2-2',
    ],
  },
};

/** A format's badge. */
export function FormatBadge({ format, size = 34 }: { format: ExportFormat; size?: number }) {
  const ic = FORMAT_ICON[format];
  return (
    <span className="dx-fmt-ico" style={{ background: ic.bg, color: ic.fg, width: size, height: size }}>
      <Svg d={ic.d} size={Math.round(size / 2)} width={1.8} />
    </span>
  );
}

interface FrameProps {
  layout: DocsLayout;
  /** Accessible name. */
  label: string;
  title: ReactNode;
  subtitle?: ReactNode;
  /** The round badge's tone. */
  tone?: 'green' | 'red' | 'amber';
  icon?: readonly string[];
  /** Tabs under the header (New export / History). */
  tabs?: ReactNode;
  footer?: ReactNode;
  /** Desktop width (px); a tablet uses 640. */
  width?: number;
  onClose: () => void;
  children: ReactNode;
  /** The body scrolls itself (book mode's columns). */
  rawBody?: boolean;
  /**
   * A running export or its ending (board D 14–17): 520 wide, a plain head with a rule under it, and, when set to
   * `hero`, the round badge large and centred at the top of the body instead of in the head.
   */
  job?: 'plain' | 'hero';
  className?: string;
}

/**
 * The dialog's frame for the layout.
 * @param props.layout - Desktop, tablet (640 wide, from the top) or phone (a sheet).
 * @param props.onClose - Called by the close button, Esc or a tap outside.
 */
export function ExportFrame({
  layout,
  label,
  title,
  subtitle,
  tone = 'green',
  icon = ICONS.download,
  tabs,
  footer,
  width = 680,
  onClose,
  children,
  rawBody,
  className = '',
  job,
}: FrameProps) {
  if (job) {
    className = `dx-job ${className}`.trim();
    if (width === 680) width = 520;
    if (job === 'hero') {
      children = (
        <>
          <div className="dx-hero">
            <span className={`dx-hero-ico${tone === 'green' ? '' : ` dx-hero-ico-${tone}`}`}>
              <Svg d={icon} size={tone === 'green' ? 26 : 24} width={tone === 'green' ? 2.6 : 2.2} />
            </span>
          </div>
          {children}
        </>
      );
    }
  }
  const head = (
    <div className="dx-head">
      {!job && (
        <span className={`dx-head-ico${tone === 'green' ? '' : ` dx-head-ico-${tone}`}`}>
          <Svg d={icon} size={17} />
        </span>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="dx-title">{title}</div>
        {subtitle && <div className="dx-sub">{subtitle}</div>}
      </div>
      <CloseButton onClick={onClose} />
    </div>
  );
  if (layout === 'phone') {
    return (
      <BottomSheet label={label} hideTitle onClose={onClose} testId="export-dialog">
        <div
          className={`dx-phone ${className}`}
          style={{ display: 'flex', flexDirection: 'column', minHeight: '78vh' }}
        >
          {head}
          {tabs}
          <div className="dx-body" style={{ flex: 1 }}>
            {children}
          </div>
          {footer && <div className="dx-foot">{footer}</div>}
        </div>
      </BottomSheet>
    );
  }
  return (
    <FramePanel
      layout={layout}
      label={label}
      width={layout === 'tablet' ? 640 : width}
      onClose={onClose}
      className={className}
    >
      {head}
      {tabs}
      {rawBody ? children : <div className="dx-body">{children}</div>}
      {footer && <div className="dx-foot">{footer}</div>}
    </FramePanel>
  );
}

function FramePanel({
  layout,
  label,
  width,
  onClose,
  children,
  className,
}: {
  layout: DocsLayout;
  label: string;
  width: number;
  onClose: () => void;
  children: ReactNode;
  className: string;
}) {
  useEscape(onClose);
  return (
    <div
      className={`docs-root dx-scrim dx-${layout}`}
      style={{ background: DOCS_SCRIM }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-testid="export-dialog"
        className={`dx-panel ${className}`}
        style={{ width }}
      >
        {children}
      </div>
    </div>
  );
}
