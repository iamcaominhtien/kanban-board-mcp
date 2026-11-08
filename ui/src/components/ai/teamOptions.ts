/** What a team's lead and roles may run on (server/services/ai/teams.py). */
export const MODELS = [
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
  { id: 'opus', label: 'Opus' },
] as const;

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export const PERMISSION_MODES = [
  { id: 'bypass', label: 'Bypass', hint: 'Nothing asks first. A short deny list still applies.' },
  { id: 'auto', label: 'Auto', hint: "Claude Code's own classifier decides what needs a person." },
] as const;

export const MAX_PERSONA = 4000;
