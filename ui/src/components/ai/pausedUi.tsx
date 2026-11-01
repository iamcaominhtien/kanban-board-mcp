import type { AiSettings } from '../../types/ai';

/** Shared pieces of the "AI paused" state (design/screens/ai-paused.md): one colour, one glyph, the same words. */

export const PAUSE_COLOR = '#B4571F';

/** The pause glyph of the banner, the top bar and the ticket strips. */
export function PauseGlyph({ size = 13, color = '#fff' }: { size?: number; color?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
      aria-hidden="true"
    >
      <rect x="7" y="5" width="3.5" height="14" />
      <rect x="13.5" y="5" width="3.5" height="14" />
    </svg>
  );
}

/** "10:41" in the person's time zone. */
export function clockTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** "23 min ago", "1 h 52 min ago". */
export function agoText(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const min = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h >= 24) return `${Math.floor(h / 24)} d ${h % 24} h ago`;
  return m ? `${h} h ${m} min ago` : `${h} h ago`;
}

/** "23 min", "1 h 06": a length of time. */
export function spanText(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h} h ${String(m).padStart(2, '0')}`;
}

/** Only owners and admins resume. */
export function canResume(settings: AiSettings | null | undefined): boolean {
  const role = settings?.myRole;
  // An old server does not send the role: let the server decide
  return !role || role === 'owner' || role === 'admin';
}

/** "Paused by An Nguyen at 10:41" */
export function pausedByLine(settings: AiSettings): string {
  const by = settings.pausedBy ?? 'someone';
  const at = clockTime(settings.pausedAt);
  return `Paused by ${by}${at ? ` at ${at}` : ''}`;
}

/** What the pause did, for the hover text of the top-bar label. */
export function pausedSummary(settings: AiSettings): string {
  const bits: string[] = [];
  const c = settings.pausedCancelled ?? 0;
  const h = settings.pausedHeld ?? 0;
  if (c) bits.push(`${c} run${c === 1 ? '' : 's'} cancelled`);
  if (h) bits.push(`${h} queued run${h === 1 ? '' : 's'} held`);
  const sentence = bits.length ? `${bits.join(', ')}. ` : '';
  return `${pausedByLine(settings)}. ${sentence}Nothing new starts until an owner or admin resumes.`;
}

/** The ticket-level strip: "AI is paused for this project · by An Nguyen at 10:41". */
export function PausedStrip({
  settings,
  onResume,
  children,
}: {
  settings: AiSettings;
  onResume?: () => void;
  children?: React.ReactNode;
}) {
  const at = clockTime(settings.pausedAt);
  return (
    <div className="ai-paused-strip" role="status" data-testid="ai-paused-strip">
      <span className="ai-paused-ico">
        <PauseGlyph size={12} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <b>AI is paused for this project</b>
        {' · '}by {settings.pausedBy ?? 'someone'}
        {at ? ` at ${at}` : ''}. {children ?? 'Nothing new starts on this ticket.'}
      </span>
      {onResume && canResume(settings) && (
        <button type="button" className="ai-btn ai-btn-sm" onClick={onResume}>
          Resume…
        </button>
      )}
    </div>
  );
}
