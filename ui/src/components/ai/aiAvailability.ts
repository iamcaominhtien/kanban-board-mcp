import type { AiMember } from '../../types/ai';

/** What the pickers say about an AI member: its status in words, and whether it can be mentioned or asked now. */
export interface AiAvailability {
  /** Status in one or two words: "Running KAN-142", "Idle", "Key invalid". */
  label: string;
  /** The rest of the line: "· Local runner", "· can’t be mentioned". */
  note: string;
  /** Green: working or ready. Amber: offline or rate-limited, still reachable later. Grey: cannot be used now. */
  tone: 'ok' | 'warn' | 'off';
  /** False greys the member out and stops a mention or an assignment. */
  usable: boolean;
}

/** Status of an AI member for the mention list, the hover card and the pill. */
export function aiAvailability(m: AiMember): AiAvailability {
  const how = m.connection === 'local' ? 'Local runner' : m.connection === 'api_key' ? 'API key' : 'Inbox only';
  switch (m.status.code) {
    case 'running':
      return { label: `Running ${m.status.ticketId ?? ''}`.trim(), note: `· ${how}`, tone: 'ok', usable: true };
    case 'idle':
      return { label: 'Idle', note: `· ${how}`, tone: 'ok', usable: true };
    case 'online':
      return { label: 'Online', note: `· ${how}`, tone: 'ok', usable: true };
    case 'inbox':
      return { label: 'Inbox only', note: '· picks tickets up through MCP', tone: 'warn', usable: true };
    case 'runner_missing':
      return { label: 'Offline', note: '· can still be asked later', tone: 'warn', usable: true };
    case 'rate_limited':
      return { label: 'Rate-limited', note: '· will queue', tone: 'warn', usable: true };
    case 'key_invalid':
      return { label: 'Key invalid', note: '· can’t be mentioned', tone: 'off', usable: false };
    case 'not_logged_in':
      return { label: 'Signed out', note: '· can’t be mentioned', tone: 'off', usable: false };
    case 'model_retired':
      return { label: 'Model retired', note: '· can’t be mentioned', tone: 'off', usable: false };
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
