export type CalloutKind = 'info' | 'warning' | 'success';

/** Colours copied from DocsEditor.dc.html (G: callout close-up). */
export const CALLOUT_STYLE: Record<
  CalloutKind,
  { label: string; bg: string; border: string; fg: string; icon: string; marker: string }
> = {
  info: { label: 'Info', bg: '#E8F1FB', border: '#B9D3EE', fg: '#2F6FB0', icon: 'i28', marker: 'INFO' },
  warning: { label: 'Warning', bg: '#FEF6E7', border: '#F0DBA8', fg: '#B8860B', icon: 'i14', marker: 'WARNING' },
  success: { label: 'Success', bg: '#EAF5EE', border: '#B7D9C0', fg: '#2E6F40', icon: 'i17', marker: 'SUCCESS' },
};

/** GitHub-alert markers accepted on input, mapped to the three kinds the editor offers. */
export const CALLOUT_ALIASES: Record<string, CalloutKind> = {
  INFO: 'info',
  NOTE: 'info',
  IMPORTANT: 'info',
  WARNING: 'warning',
  WARN: 'warning',
  CAUTION: 'warning',
  DANGER: 'warning',
  SUCCESS: 'success',
  OK: 'success',
  TIP: 'success',
};

/** Ticket status dot colours from the board. */
export const TICKET_DOT: Record<string, string> = {
  backlog: '#9AA8A0',
  todo: '#9AA8A0',
  'in-progress': '#2F6FB0',
  review: '#6D5DD3',
  testing: '#B4571F',
  done: '#2E6F40',
  wont_do: '#C4432A',
};

export const TICKET_STATUS_LABEL: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  'in-progress': 'In Progress',
  review: 'Review',
  testing: 'Testing',
  done: 'Done',
  wont_do: "Won't do",
};

export const TICKET_KEY_SRC = '[A-Z][A-Z0-9]{1,5}-\\d+';
