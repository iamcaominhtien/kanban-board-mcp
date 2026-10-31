import { createContext, useContext, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { AiMember, AiProvider, AiRun, AiSettings, AiStatus, RunState } from '../../types/ai';
import './ai.css';
import { extractError } from '../../api/extractError';

/** Adapters an AI member can use (mirrors server/services/ai/providers.py). */
export const PROVIDERS: Record<
  AiProvider,
  {
    label: string;
    connection: 'local' | 'api_key' | 'inbox';
    sub: string;
    models: string[];
    defaultModel: string | null;
    baseUrl?: string;
    install?: string;
    binary?: string;
  }
> = {
  'claude-code': {
    label: 'Claude Code',
    connection: 'local',
    sub: 'Uses an AI account · subscription',
    models: ['sonnet', 'haiku'],
    defaultModel: 'sonnet',
    install: 'npm install -g @anthropic-ai/claude-code',
    binary: 'claude',
  },
  codex: {
    label: 'Codex',
    connection: 'local',
    sub: 'Uses an AI account',
    models: [],
    defaultModel: null,
    install: 'npm install -g @openai/codex',
    binary: 'codex',
  },
  opencode: {
    label: 'opencode',
    connection: 'local',
    sub: 'Free models need no account; paid ones use an account',
    models: [],
    defaultModel: null,
    install: 'npm install -g opencode-ai',
    binary: 'opencode',
  },
  antigravity: {
    label: 'Antigravity',
    connection: 'local',
    sub: 'Uses your signed-in CLI, or an AI account',
    models: [],
    defaultModel: null,
    binary: 'agy',
  },
  anthropic: {
    label: 'Anthropic',
    connection: 'api_key',
    sub: 'Claude models',
    models: ['claude-sonnet-5-5', 'claude-haiku-5-5'],
    defaultModel: 'claude-sonnet-5-5',
    baseUrl: 'https://api.anthropic.com',
  },
  openai: {
    label: 'OpenAI',
    connection: 'api_key',
    sub: 'GPT models',
    models: ['gpt-4.1-mini', 'gpt-4.1'],
    defaultModel: 'gpt-4.1-mini',
    baseUrl: 'https://api.openai.com/v1',
  },
  gemini: {
    label: 'Gemini',
    connection: 'api_key',
    sub: 'Gemini models',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    defaultModel: 'gemini-2.5-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  custom: {
    label: 'Custom endpoint',
    connection: 'api_key',
    sub: 'Any OpenAI-compatible URL',
    models: [],
    defaultModel: null,
  },
  'mcp-client': {
    label: 'Other MCP client',
    connection: 'inbox',
    sub: 'Cursor, Cline… connect through MCP like today',
    models: [],
    defaultModel: null,
  },
};

const GLYPHS: Record<AiProvider, { path: string; bg: string; color: string; fill?: boolean }> = {
  'claude-code': { path: 'M12 3V21M3 12H21M5.6 5.6L18.4 18.4M18.4 5.6L5.6 18.4', bg: '#DCEEE1', color: '#2E6F40' },
  anthropic: { path: 'M12 3V21M3 12H21M5.6 5.6L18.4 18.4M18.4 5.6L5.6 18.4', bg: '#F3E7DC', color: '#B4571F' },
  antigravity: { path: 'M5 18.5L12 5.5L19 18.5M8.8 14.5H15.2', bg: '#DDEBF7', color: '#2F6FB0' },
  codex: { path: 'M12 3L20 7.5V16.5L12 21L4 16.5V7.5Z', bg: '#E8F1FA', color: '#244E78' },
  opencode: {
    path: 'M9 4C7 4 7 6 7 8S7 11 5 12C7 13 7 14 7 16S7 20 9 20M15 4C17 4 17 6 17 8S17 11 19 12C17 13 17 14 17 16S17 20 15 20',
    bg: '#EFE8FB',
    color: '#5B3AA6',
  },
  openai: { path: 'M12 3L20 7.5V16.5L12 21L4 16.5V7.5Z', bg: '#E6E9F5', color: '#5B5FA8' },
  gemini: {
    path: 'M12 2.5C12 8 16 12 21.5 12C16 12 12 16 12 21.5C12 16 8 12 2.5 12C8 12 12 8 12 2.5Z',
    bg: '#FBE4E9',
    color: '#B0446E',
    fill: true,
  },
  custom: {
    path: 'M9 4C7 4 7 6 7 8S7 11 5 12C7 13 7 14 7 16S7 20 9 20M15 4C17 4 17 6 17 8S17 11 19 12C17 13 17 14 17 16S17 20 15 20',
    bg: '#E8EFEA',
    color: '#5B6B60',
  },
  'mcp-client': { path: 'M9 3V8M15 3V8M6 8H18V12A6 6 0 0 1 6 12ZM12 18V21', bg: '#EEF1EE', color: '#5B6B60' },
};

const SPARKLE = 'M12 3C12 8 14 10 19 12C14 14 12 16 12 21C12 16 10 14 5 12C10 10 12 8 12 3Z';

/** Glyph of a provider (vendor-neutral drawings, never logos). */
export function ProviderGlyph({ provider, size = 12 }: { provider: AiProvider; size?: number }) {
  const g = GLYPHS[provider] ?? GLYPHS.custom;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0 }} aria-hidden="true">
      <path
        d={g.path}
        fill={g.fill ? 'currentColor' : 'none'}
        stroke={g.fill ? 'none' : 'currentColor'}
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Glyphs an AI member can pick for its avatar (neutral drawings, never vendor logos). */
export const AI_GLYPHS: Record<string, { path: string; fill?: boolean }> = {
  asterisk: { path: 'M12 3V21M3 12H21M5.6 5.6L18.4 18.4M18.4 5.6L5.6 18.4' },
  spark: {
    path: 'M12 2.5C12 8 16 12 21.5 12C16 12 12 16 12 21.5C12 16 8 12 2.5 12C8 12 12 8 12 2.5Z',
    fill: true,
  },
  braces: {
    path: 'M9 4C7 4 7 6 7 8S7 11 5 12C7 13 7 14 7 16S7 20 9 20M15 4C17 4 17 6 17 8S17 11 19 12C17 13 17 14 17 16S17 20 15 20',
  },
  peak: { path: 'M5 18.5L12 5.5L19 18.5M8.8 14.5H15.2' },
  hex: { path: 'M12 3L20 7.5V16.5L12 21L4 16.5V7.5Z' },
  plug: { path: 'M9 3V8M15 3V8M6 8H18V12A6 6 0 0 1 6 12ZM12 18V21' },
  terminal: { path: 'M4 6L10 12L4 18M12 19H20' },
  eye: { path: 'M2 12C5 6 9 4 12 4S19 6 22 12C19 18 15 20 12 20S5 18 2 12ZM12 9A3 3 0 1 1 11.99 9' },
  tag: { path: 'M3 12V4H11L21 14L14 21L3 12ZM7.5 8.5H7.6' },
  doc: { path: 'M6 3H14L19 8V21H6ZM14 3V8H19M9 13H16M9 17H16' },
  phone: { path: 'M8 3H16V21H8ZM11 18H13' },
  chip: { path: 'M7 7H17V17H7ZM10 3V7M14 3V7M10 17V21M14 17V21M3 10H7M3 14H7M17 10H21M17 14H21' },
};

/** Avatar colours of an AI member (the same palette the people use). */
export const AI_COLORS = ['#2E6F40', '#2F6FB0', '#6D5DD3', '#B4791E', '#B0446E', '#C4432A', '#5B6B60'];

/** What the avatar shows until someone picks: a glyph and a colour per provider (mirrors providers.py). */
export const DEFAULT_LOOK: Record<AiProvider, { glyph: string; color: string }> = {
  'claude-code': { glyph: 'asterisk', color: '#2E6F40' },
  anthropic: { glyph: 'asterisk', color: '#B4791E' },
  antigravity: { glyph: 'peak', color: '#2F6FB0' },
  codex: { glyph: 'hex', color: '#244E78' },
  opencode: { glyph: 'braces', color: '#5B3AA6' },
  openai: { glyph: 'hex', color: '#6D5DD3' },
  gemini: { glyph: 'spark', color: '#B0446E' },
  custom: { glyph: 'braces', color: '#5B6B60' },
  'mcp-client': { glyph: 'plug', color: '#5B6B60' },
};

/** One avatar glyph, drawn in the current text colour. */
export function GlyphIcon({ glyph, size = 12 }: { glyph: string; size?: number }) {
  const g = AI_GLYPHS[glyph] ?? AI_GLYPHS.spark;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0 }} aria-hidden="true">
      <path
        d={g.path}
        fill={g.fill ? 'currentColor' : 'none'}
        stroke={g.fill ? 'none' : 'currentColor'}
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Square AI avatar with the dark sparkle badge (people stay round). It shows the glyph and colour the member
 * picked; without them it falls back to its provider's look.
 */
export function AiAvatar({
  provider,
  color,
  glyph,
  size = 36,
  title,
  dim,
}: {
  provider: AiProvider;
  color?: string | null;
  glyph?: string | null;
  size?: number;
  title?: string;
  dim?: boolean;
}) {
  const look = DEFAULT_LOOK[provider] ?? DEFAULT_LOOK.custom;
  const tint = color || look.color;
  const badge = Math.max(10, Math.round(size * 0.39));
  return (
    <span
      title={title}
      aria-label={title}
      style={{
        position: 'relative',
        display: 'inline-flex',
        width: size,
        height: size,
        borderRadius: Math.round(size / 4),
        background: `${tint}24`,
        color: tint,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        opacity: dim ? 0.55 : 1,
      }}
    >
      <GlyphIcon glyph={glyph || look.glyph} size={Math.round(size / 2)} />
      <span
        style={{
          position: 'absolute',
          right: -Math.round(size / 9),
          bottom: -Math.round(size / 9),
          width: badge,
          height: badge,
          borderRadius: '50%',
          background: '#1E2A22',
          border: '1.5px solid #FFFFFF',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#FFFFFF',
        }}
      >
        <svg width={Math.round(badge * 0.58)} height={Math.round(badge * 0.58)} viewBox="0 0 24 24">
          <path d={SPARKLE} fill="currentColor" />
        </svg>
      </span>
    </span>
  );
}

/** Colour and glyph pickers of the Add AI member stepper and Configuration, with a live avatar preview. */
export function AvatarPicker({
  provider,
  color,
  glyph,
  onChange,
  preview = true,
}: {
  provider: AiProvider;
  color: string;
  glyph: string;
  onChange: (next: { color: string; glyph: string }) => void;
  /** Draw the avatar next to the pickers (the stepper already shows it beside the name). */
  preview?: boolean;
}) {
  return (
    <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-start' }} data-testid="avatar-picker">
      <div className="ai-field">
        <span className="ai-label ai-label-dark">Avatar color</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 34 }}>
          {AI_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Color ${c}`}
              aria-pressed={color.toUpperCase() === c}
              data-testid={`avatar-color-${c.slice(1)}`}
              onClick={() => onChange({ color: c, glyph })}
              style={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                background: c,
                cursor: 'pointer',
                border: '2px solid #fff',
                boxShadow: color.toUpperCase() === c ? `0 0 0 2px ${c}, 0 0 0 4px #1E2A22` : '0 0 0 1px #C7D2CB',
                padding: 0,
              }}
            />
          ))}
        </div>
      </div>
      <div className="ai-field">
        <span className="ai-label ai-label-dark">Glyph</span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', maxWidth: 330 }}>
          {Object.keys(AI_GLYPHS).map((g) => (
            <button
              key={g}
              type="button"
              aria-label={`Glyph ${g}`}
              aria-pressed={glyph === g}
              data-testid={`avatar-glyph-${g}`}
              onClick={() => onChange({ color, glyph: g })}
              style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                color: glyph === g ? color : '#5B6B60',
                background: glyph === g ? `${color}1F` : '#fff',
                border: `1.5px solid ${glyph === g ? color : '#E3E8E5'}`,
              }}
            >
              <GlyphIcon glyph={g} size={17} />
            </button>
          ))}
        </div>
      </div>
      {preview && (
        <span aria-hidden="true" style={{ marginTop: 18 }}>
          <AiAvatar provider={provider} color={color} glyph={glyph} size={40} />
        </span>
      )}
    </div>
  );
}

/** Sparkle icon (Run button, AI badges). */
export function SparkleIcon({ size = 13, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0 }} aria-hidden="true">
      <path d={SPARKLE} fill={color} />
    </svg>
  );
}

/** Chip naming the provider (glyph + label). */
export function ProviderChip({ provider, label }: { provider: AiProvider; label?: string }) {
  return (
    <span className="ai-chip" style={{ background: '#F6FAF7', color: '#5B6B60', border: '1px solid #E3E8E5' }}>
      <ProviderGlyph provider={provider} />
      {label ?? PROVIDERS[provider]?.label.replace(' endpoint', '') ?? provider}
    </span>
  );
}

/** Local runner / API key / Inbox chip. */
export function ConnectionChip({ connection }: { connection: 'local' | 'api_key' | 'inbox' }) {
  if (connection === 'local')
    return (
      <span className="ai-chip" style={{ background: '#E8F1FA', color: '#2F6FB0' }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="4" width="18" height="12" rx="2" />
          <path d="M8 20H16M12 16V20" />
        </svg>
        Local runner
      </span>
    );
  if (connection === 'api_key')
    return (
      <span className="ai-chip" style={{ background: '#EFEAFB', color: '#6D5DD3' }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="8" cy="15" r="4" />
          <path d="M11 12L20 3M17 6L20 9" />
        </svg>
        API key
      </span>
    );
  return (
    <span className="ai-chip" style={{ background: '#EEF1EE', color: '#5B6B60' }}>
      Inbox only
    </span>
  );
}

export const STATUS_NAMES: Record<string, string> = {
  none: 'None',
  backlog: 'Backlog',
  todo: 'To Do',
  'in-progress': 'In Progress',
  review: 'Review',
  testing: 'Testing',
  done: 'Done',
  wont_do: "Won't Do",
};

/** “Up to Review” permission chip (orange below Review, red above). */
export function CeilingChip({ ceiling }: { ceiling: string }) {
  const rank = ['none', 'backlog', 'todo', 'in-progress', 'review', 'testing', 'done'].indexOf(ceiling);
  const style =
    rank === 4
      ? { background: '#F1F8F3', color: '#2E6F40' }
      : rank > 4
        ? { background: '#FBEEEA', color: '#C4432A' }
        : { background: '#FDF0E6', color: '#B4571F' };
  return (
    <span className="ai-chip" style={style}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 3L20 6V12C20 16.5 16.5 20 12 21C7.5 20 4 16.5 4 12V6Z" />
      </svg>
      {ceiling === 'none' ? 'No status moves' : `Up to ${STATUS_NAMES[ceiling] ?? ceiling}`}
    </span>
  );
}

const STATUS_STYLE: Record<string, { dot: string; text: string; hollow?: boolean; square?: boolean }> = {
  running: { dot: '#2E6F40', text: '#2E6F40' },
  online: { dot: '#2E6F40', text: '#2E6F40' },
  idle: { dot: '#9AA8A0', text: '#1E2A22', hollow: true },
  inbox: { dot: '#9AA8A0', text: '#5B6B60', hollow: true },
  key_invalid: { dot: '#C4432A', text: '#C4432A' },
  not_logged_in: { dot: '#C4432A', text: '#C4432A' },
  runner_missing: { dot: '#B4791E', text: '#B4571F' },
  model_retired: { dot: '#B4571F', text: '#B4571F' },
  over_budget: { dot: '#B4571F', text: '#B4571F' },
  rate_limited: { dot: '#B4791E', text: '#B4571F' },
  paused: { dot: '#9AA8A0', text: '#5B6B60', square: true },
  paused_all: { dot: '#B4571F', text: '#B4571F', square: true },
  not_ready: { dot: '#B4791E', text: '#7A5A06' },
  removing: { dot: '#9AA8A0', text: '#5B6B60' },
  removed: { dot: '#9AA8A0', text: '#9AA8A0' },
};

/** Status dot + label (+ ticket id while running). */
export function StatusLabel({ status, sub }: { status: AiStatus; sub?: ReactNode }) {
  const s = STATUS_STYLE[status.code] ?? STATUS_STYLE.idle;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span
          className={status.code === 'running' ? 'ai-pulse' : undefined}
          style={{
            width: 8,
            height: 8,
            borderRadius: s.square ? 2 : '50%',
            background: s.hollow ? 'transparent' : s.dot,
            border: s.hollow ? `1.5px solid ${s.dot}` : undefined,
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: s.text, whiteSpace: 'nowrap' }}>{status.label}</span>
        {status.code === 'running' && status.ticketId && (
          <span className="ai-mono" style={{ fontSize: 11.5, fontWeight: 500, color: '#2E6F40' }}>
            {status.ticketId}
          </span>
        )}
      </div>
      {sub !== undefined ? (
        <div className="ai-muted" style={{ marginTop: 1 }}>
          {sub}
        </div>
      ) : status.detail && status.code !== 'running' ? (
        <div className="ai-muted" style={{ marginTop: 1 }}>
          {status.detail}
        </div>
      ) : null}
    </div>
  );
}

const RUN_CHIPS: Record<RunState | 'in_ai_review' | 'paused', { label: string; bg: string; color: string }> = {
  queued: { label: 'Queued', bg: '#EEF1EE', color: '#5B6B60' },
  starting: { label: 'Starting', bg: '#F1F8F3', color: '#2E6F40' },
  running: { label: 'Running', bg: '#F1F8F3', color: '#2E6F40' },
  needs_input: { label: 'Needs input', bg: '#EEF2F6', color: '#34455A' },
  finished: { label: 'Finished', bg: '#E5F2E9', color: '#2E6F40' },
  failed: { label: 'Failed', bg: '#FBEEEA', color: '#C4432A' },
  cancelled: { label: 'Cancelled', bg: '#F1F3F2', color: '#5B6B60' },
  timed_out: { label: 'Timed out', bg: '#FDF0E6', color: '#B4571F' },
  in_ai_review: { label: 'In AI review', bg: '#F5F3FD', color: '#6D5DD3' },
  paused: { label: 'Paused', bg: '#EEF1EE', color: '#5B6B60' },
};

/** Run state chip (legend of AI work on tickets). */
export function RunStateChip({
  state,
  suffix,
  label,
}: {
  state: RunState | 'in_ai_review' | 'paused';
  suffix?: ReactNode;
  label?: string;
}) {
  const c = RUN_CHIPS[state];
  return (
    <span className="ai-chip" style={{ background: c.bg, color: c.color, border: `1px solid ${c.bg}` }}>
      {state === 'running' && (
        <span className="ai-pulse" style={{ width: 7, height: 7, borderRadius: '50%', background: c.color }} />
      )}
      {state === 'starting' && <span className="ai-spin" style={{ width: 10, height: 10 }} />}
      {state === 'queued' && (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7V12L15 14" />
        </svg>
      )}
      {state === 'needs_input' && (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
          <path d="M8.5 5.5V18.5M15.5 5.5V18.5" />
        </svg>
      )}
      {state === 'finished' && (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6">
          <path d="M5 12.5L10 17.5L19 7" />
        </svg>
      )}
      {(state === 'failed' || state === 'timed_out') && (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
          <path d="M12 3.5L22 20H2Z" />
          <path d="M12 10V14M12 17.2V17.3" />
        </svg>
      )}
      {state === 'cancelled' && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6">
          <path d="M6 6L18 18M18 6L6 18" />
        </svg>
      )}
      {label ?? c.label}
      {suffix}
    </span>
  );
}

/** "3m 12s". */
export function fmtElapsed(s: number | null | undefined): string {
  if (s == null) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

/** Seconds since an ISO time. */
export function secondsSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
}

/** "$1.84". */
export function money(v: number | null | undefined): string {
  return `$${(v ?? 0).toFixed(2)}`;
}

/** "12:41". */
export function hhmm(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** "18 min ago". */
export function ago(iso: string | null | undefined): string {
  const s = secondsSince(iso);
  if (s == null) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso as string).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Re-renders the caller every `intervalMs` (default every second), so elapsed times tick while `enabled`. */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, enabled]);
  return now;
}

/** "Oct 20". */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** When a run happened in words: "12:30 today", "Yesterday", "Oct 20". */
export function whenWords(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days <= 0) return `${hhmm(iso)} today`;
  if (days === 1) return 'Yesterday';
  return shortDate(iso);
}

/** "in 40 seconds", "in about 3 minutes" (a wait that is still to come, from `retryAt`). */
export function inWords(iso: string | null | undefined): string {
  if (!iso) return 'a moment';
  const s = Math.max(1, Math.round((new Date(iso).getTime() - Date.now()) / 1000));
  if (s < 90) return `${s} second${s === 1 ? '' : 's'}`;
  if (s < 5400) return `${Math.round(s / 60)} minutes`;
  return `${Math.round(s / 3600)} hours`;
}

/**
 * The second line under a status: “Last call 2 min ago” for an online API member, “Paused Oct 20” for a paused
 * one, “401 from provider” for a rejected key, “3m 12s elapsed” while it runs, “Resets at 00:00” over budget.
 */
export function statusSub(m: AiMember): string | undefined {
  switch (m.status.code) {
    case 'running': {
      const run = m.running.find((r) => r.state === 'running' || r.state === 'starting');
      return run?.startedAt ? `${fmtElapsed(secondsSince(run.startedAt))} elapsed` : undefined;
    }
    case 'online':
      return m.lastCallAt ? `Last call ${ago(m.lastCallAt)}` : 'No calls yet';
    case 'idle':
      return m.lastRunAt ? `Last run ${ago(m.lastRunAt)}` : 'No runs yet';
    case 'paused':
      return m.pausedAt ? `Paused ${shortDate(m.pausedAt)}` : (m.status.detail ?? undefined);
    case 'over_budget':
      return /1st/.test(m.status.detail ?? '') ? 'Resets on the 1st' : 'Resets at 00:00';
    case 'rate_limited':
      return `Retries in about ${inWords(m.retryAt)}`;
    case 'runner_missing':
      return 'CLI not found on this computer';
    default:
      return m.status.detail ?? undefined;
  }
}

export const ACTIVE_RUN_STATES: RunState[] = ['queued', 'starting', 'running', 'needs_input'];

// ---------------------------------------------------------------------------
// Shared AI state for the board: members by id, runs by ticket, the kill switch
// ---------------------------------------------------------------------------

export interface AiBoardState {
  projectId: string;
  members: Map<string, AiMember>;
  runsByTicket: Map<string, AiRun>;
  settings: AiSettings | null;
  /** Open the AI members page (optionally a member's profile). */
  openAiPage?: (memberId?: string) => void;
  /** Open a ticket. */
  openTicket?: (ticketId: string) => void;
  /** Open the AI page on one of its tabs (Inbox, Audit log, Usage, Safety). */
  openAiTab?: (tab: 'accounts' | 'approvals' | 'audit' | 'usage' | 'safety', opts?: { memberId?: string }) => void;
}

/** AI state of the open project, provided by App. */
export const AiBoardContext = createContext<AiBoardState>({
  projectId: '',
  members: new Map(),
  runsByTicket: new Map(),
  settings: null,
});

/** The AI state of the current project. */
export function useAiBoardState(): AiBoardState {
  return useContext(AiBoardContext);
}

/** AI avatar for an AI member (dimmed while paused). */
export function Avatar({ member, size = 20, style }: { member: AiMember; size?: number; style?: CSSProperties }) {
  return (
    <span style={style}>
      <AiAvatar
        provider={member.provider}
        color={member.color}
        glyph={member.glyph}
        size={size}
        title={member.name}
        dim={member.paused}
      />
    </span>
  );
}

/** On / off switch in the AI screens' style. */
export function Toggle({
  on,
  onChange,
  label,
  disabled,
  testId,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-testid={testId}
      className={`ai-toggle ${on ? 'ai-toggle-on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!on)}
    />
  );
}

/** A query that failed: what could not load, why, and Try again (instead of a spinner that never stops). */
export function LoadError({ what, error, onRetry }: { what: string; error: unknown; onRetry: () => void }) {
  return (
    <div className="ai-notice ai-notice-error" role="alert" data-testid="load-error">
      Couldn't load {what}: {extractError(error)}.{' '}
      <button type="button" className="ai-link" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
