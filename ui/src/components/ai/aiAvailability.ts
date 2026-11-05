import type { AiTeam } from '../../types/ai';

/** What the pickers say about an AI team: its status in words, and whether it can be mentioned or assigned now. */
export interface AiAvailability {
  /** Status in one or two words: "Running KAN-142", "Idle", "Signed out". */
  label: string;
  /** The rest of the line: "· Claude Code", "· can’t be mentioned". */
  note: string;
  /** Green: working or ready. Amber: offline or rate-limited, still reachable later. Grey: cannot be used now. */
  tone: 'ok' | 'warn' | 'off';
  /** False greys the team out and stops a mention or an assignment. */
  usable: boolean;
}

/** Status of an AI team for the mention list, the hover card and the pill. */
export function aiAvailability(m: AiTeam): AiAvailability {
  switch (m.status.code) {
    case 'running':
      return { label: `Running ${m.status.ticketId ?? ''}`.trim(), note: '· Claude Code', tone: 'ok', usable: true };
    case 'idle':
      return { label: 'Idle', note: '· Claude Code', tone: 'ok', usable: true };
    case 'runner_missing':
      return { label: 'Offline', note: '· can still be asked later', tone: 'warn', usable: true };
    case 'rate_limited':
      return { label: 'Rate-limited', note: '· will queue', tone: 'warn', usable: true };
    case 'not_logged_in':
      return { label: 'Signed out', note: '· can’t be mentioned', tone: 'off', usable: false };
    case 'over_budget':
      return { label: 'Over budget', note: '· can’t be mentioned', tone: 'off', usable: false };
    case 'paused':
      return { label: 'Paused', note: '· can’t be mentioned', tone: 'off', usable: false };
    case 'paused_all':
      return { label: 'AI paused', note: '· can’t be mentioned', tone: 'off', usable: false };
    default:
      return { label: m.status.label, note: '', tone: 'off', usable: false };
  }
}

/** Colour of the status dot of a tone. */
export const TONE_COLOR: Record<AiAvailability['tone'], string> = { ok: '#2E6F40', warn: '#B4791E', off: '#9AA8A0' };

/** What a team can do, in the words of the @ list: "its roles: Dev, Reviewer, QA". */
export function aiCan(m: AiTeam): string {
  const names = m.roles.map((r) => r.name ?? r.key);
  return names.length ? `roles: ${names.join(', ')}` : 'no roles';
}

/** The sub line of a team row in the @ list; a team that cannot be used says why. */
export function aiPickerLine(m: AiTeam): { line: string; chip?: string } {
  const av = aiAvailability(m);
  if (!av.usable) {
    const chip = m.status.code === 'paused' || m.status.code === 'paused_all' ? 'Paused' : av.label;
    return {
      line: m.status.code === 'paused' && m.status.detail ? m.status.detail : `${av.label} ${av.note}`.trim(),
      chip,
    };
  }
  const word = m.status.code === 'running' ? `running ${m.status.ticketId ?? ''}`.trim() : 'ready';
  return { line: `Team · ${word} · ${aiCan(m)}` };
}
