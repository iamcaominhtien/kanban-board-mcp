/** Callout kinds of format 1 (schema.json); `custom` takes its colour and icon from the block's own attributes. */
export type CalloutKind = 'info' | 'warning' | 'success' | 'danger' | 'note' | 'custom';

/** Colours and icons of the Blocks board (frame 41, callout kinds). */
export const CALLOUT_STYLE: Record<
  CalloutKind,
  { label: string; bg: string; border: string; fg: string; icon: string; marker: string }
> = {
  info: { label: 'Info', bg: '#E8F1FB', border: '#B9D3EE', fg: '#2F6FB0', icon: 'i28', marker: 'INFO' },
  warning: { label: 'Warning', bg: '#FEF6E7', border: '#F0DBA8', fg: '#8A6508', icon: 'i14', marker: 'WARNING' },
  success: { label: 'Success', bg: '#EAF5EE', border: '#B7D9C0', fg: '#2E6F40', icon: 'i10', marker: 'SUCCESS' },
  danger: { label: 'Danger', bg: '#FDF1EE', border: '#F0C4B8', fg: '#C4432A', icon: 'i08', marker: 'DANGER' },
  note: { label: 'Note', bg: '#F1F3F1', border: '#DCE3DE', fg: '#3A4A3E', icon: 'i00', marker: 'NOTE' },
  // plain Markdown has no custom kind: it is written as an info callout
  custom: { label: 'Custom', bg: '#F1F3F2', border: '#D3DBD6', fg: '#5B6B60', icon: 'i28', marker: 'INFO' },
};

/** GitHub-alert markers accepted on input, mapped to a kind (`[!DANGER]` and `[!NOTE]` keep their own, format 1). */
export const CALLOUT_ALIASES: Record<string, CalloutKind> = {
  INFO: 'info',
  NOTE: 'note',
  IMPORTANT: 'info',
  WARNING: 'warning',
  WARN: 'warning',
  CAUTION: 'warning',
  DANGER: 'danger',
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
