import type { PackBody, PackLimits, RolePack } from '../../../types/aiPacks';

/** The keys of the ready-made packs (server/services/ai/packs.py BUILTIN): a project's pack with one of them is an edited copy. */
export const READY_MADE_KEYS = [
  'triage',
  'pm',
  'ba',
  'designer',
  'dev',
  'reviewer',
  'qa',
  'user_tester',
  'tech_writer',
  'devops',
  'security',
  'data_analyst',
];

export const PACK_FORMAT = 'kanban-role-pack/1';

export const MODELS = ['sonnet', 'haiku', 'opus'] as const;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const WRITES: { id: string; label: string }[] = [
  { id: 'nothing', label: 'Nothing' },
  { id: 'ticket', label: 'Ticket' },
  { id: 'canvas', label: 'Canvas' },
  { id: 'tests', label: 'Tests' },
  { id: 'worktree', label: 'Worktree' },
];

export type PackStateKind = 'ready' | 'edited' | 'own';

/** What a pack is for this project: ready-made, an edited copy of a ready-made one, or the project's own role. */
export function packState(p: RolePack): { kind: PackStateKind; label: string } {
  if (p.builtin) return { kind: 'ready', label: 'Ready-made' };
  if (READY_MADE_KEYS.includes(p.key)) return { kind: 'edited', label: `Edited · v${p.version}` };
  return { kind: 'own', label: `This project’s own · v${p.version}` };
}

/** "sonnet" -> "Sonnet"; a full model id as it is. */
export function modelLabel(model: string | null | undefined): string {
  if (!model) return '—';
  return (MODELS as readonly string[]).includes(model) ? model[0].toUpperCase() + model.slice(1) : model;
}

/** "Haiku · low" */
export function modelEffort(p: RolePack): string {
  return [modelLabel(p.model), p.effort].filter((x) => x && x !== '—').join(' · ') || '—';
}

/** What a pack writes, in words ("worktree" -> "Worktree"). */
export function writesLabel(writes: string | undefined): string {
  if (!writes) return '—';
  return WRITES.find((w) => w.id === writes)?.label ?? writes[0].toUpperCase() + writes.slice(1);
}

/** The plugins and MCP servers of a pack as one list (the design's PLUGINS column). */
export function toolsOf(p: RolePack): string[] {
  return Array.from(new Set([...(p.plugins ?? []), ...(p.mcp ?? [])]));
}

/** Two letters for a role named so ("Release manager" -> "RM"). */
export function glyphOf(name: string): string {
  const words = name
    .replace(/\(.*?\)/g, ' ')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '').slice(0, 2);
  return letters.toUpperCase();
}

/** "Release manager" -> "release_manager" (the key a new role starts with). */
export function keyOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** The file name of an exported pack: "Dev (TDD)" -> "dev-tdd.role-pack.json". */
export function fileNameOf(p: { name?: string; key: string }): string {
  const slug = (p.name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || p.key}.role-pack.json`;
}

/** A size in KB ("4 KB"). */
export function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** "6 Nov" */
export function dayOf(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** Who and when a pack was last saved: "An Nguyen · 6 Nov". */
export function savedBy(p: RolePack): string {
  return [p.updatedBy, dayOf(p.updatedAt)].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------------------------- the editor's form

export interface Draft {
  name: string;
  glyph: string;
  tagline: string;
  persona: string;
  handsIn: string;
  model: string;
  retryModel: string;
  effort: string;
  writes: string;
  plugins: string[];
  mcp: string[];
  maxParallel: string;
  maxRunsPerDay: string;
}

/** The editor's form, filled from a pack. */
export function draftOf(p: RolePack): Draft {
  return {
    name: p.name ?? '',
    glyph: p.glyph ?? '',
    tagline: p.tagline ?? '',
    persona: p.persona ?? '',
    handsIn: p.handsIn ?? '',
    model: p.model ?? '',
    retryModel: p.retryModel ?? '',
    effort: p.effort ?? '',
    writes: p.writes ?? 'nothing',
    plugins: [...(p.plugins ?? [])],
    mcp: [...(p.mcp ?? [])],
    maxParallel: p.limits?.maxParallel != null ? String(p.limits.maxParallel) : '',
    maxRunsPerDay: p.limits?.maxRunsPerDay != null ? String(p.limits.maxRunsPerDay) : '',
  };
}

/** Whether two forms are the same (nothing to save). */
export function sameDraft(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export type DraftErrors = Partial<Record<'name' | 'model' | 'effort' | 'maxParallel' | 'maxRunsPerDay', string>>;

/** The server's own checks (server/services/ai/packs.py clean), in its words, so the person sees them before the call. */
export function validate(d: Draft): DraftErrors {
  const e: DraftErrors = {};
  if (!d.name.trim()) e.name = 'A pack needs a name.';
  const model = d.model.trim();
  if (model && !(MODELS as readonly string[]).includes(model) && !model.includes('-')) {
    e.model = 'The model is haiku, sonnet, opus or a full model id.';
  }
  const effort = d.effort.trim();
  if (effort && !(EFFORTS as readonly string[]).includes(effort)) {
    e.effort = 'The effort is low, medium, high, xhigh or max.';
  }
  for (const k of ['maxParallel', 'maxRunsPerDay'] as const) {
    const v = d[k].trim();
    if (v && !/^[1-9]\d*$/.test(v)) e[k] = 'A whole number, 1 or more.';
  }
  return e;
}

/** The body of a save: the editor's fields; what the editor does not show stays as the server has it. */
export function bodyOf(d: Draft, p: Pick<RolePack, 'limits'>): PackBody {
  const limits: PackLimits = { ...(p.limits ?? {}) };
  for (const [k, v] of [
    ['maxParallel', d.maxParallel],
    ['maxRunsPerDay', d.maxRunsPerDay],
  ] as const) {
    if (v.trim()) limits[k] = Number(v);
    else delete limits[k];
  }
  return {
    name: d.name.trim(),
    glyph: d.glyph.trim(),
    tagline: d.tagline.trim(),
    persona: d.persona,
    handsIn: d.handsIn.trim(),
    model: d.model.trim(),
    retryModel: d.retryModel.trim() || null,
    effort: d.effort.trim(),
    writes: d.writes,
    plugins: d.plugins,
    mcp: d.mcp,
    limits,
  };
}

/** The body of a new role that starts from a copy of `p`: everything but the name. */
export function copyBodyOf(p: RolePack, name: string): PackBody {
  return {
    name,
    glyph: glyphOf(name),
    tagline: p.tagline,
    model: p.model,
    retryModel: p.retryModel ?? null,
    effort: p.effort,
    writes: p.writes,
    handsIn: p.handsIn,
    plugins: p.plugins ?? [],
    mcp: p.mcp ?? [],
    persona: p.persona,
    limits: p.limits,
    depthModels: p.depthModels,
    personas: p.personas,
    template: p.template,
    ceiling: p.ceiling,
    permissions: p.permissions,
    permissionMode: p.permissionMode,
    allow: p.allow,
  };
}

/** The body of a blank role. */
export function blankBodyOf(name: string): PackBody {
  return {
    name,
    glyph: glyphOf(name),
    tagline: '',
    model: 'sonnet',
    effort: 'medium',
    writes: 'nothing',
    handsIn: '',
    plugins: [],
    mcp: [],
    persona: '',
    limits: { maxParallel: 1, maxRunsPerDay: 10 },
  };
}

/** Whether `key` is fit for a new role: letters, digits and underscores. */
export const KEY_RE = /^[a-z0-9_]+$/;
