import type { Plugin, SkillUsage } from '../../../types/aiPlugins';

export const ROLES: Record<string, string> = {
  triage: 'Triage',
  pm: 'PM',
  ba: 'BA',
  designer: 'Designer',
  dev: 'Dev',
  reviewer: 'Reviewer',
  qa: 'QA',
  user_tester: 'User tester',
};

/** The display name of a role pack key. */
export const roleName = (key: string) => ROLES[key] ?? key;

/** A member's own switch, or undefined when it follows the project default. */
export function ownSwitch(members: Plugin['members'] | null | undefined, id: string): boolean | undefined {
  return (members ?? []).find((m) => m.memberId === id)?.on;
}

export type Why = 'own' | 'default' | 'role' | 'off';

/** Whether a member gets the plugin: its own switch, else the project default, else whether its role is suggested. */
export function effective(p: Pick<Plugin, 'members' | 'defaultOn' | 'roles'>, memberId: string, role?: string | null) {
  const own = ownSwitch(p.members, memberId);
  if (own !== undefined) return { on: own, why: 'own' as Why };
  if (p.defaultOn) return { on: true, why: 'default' as Why };
  if (role && p.roles.includes(role)) return { on: true, why: 'role' as Why };
  return { on: false, why: 'off' as Why };
}

/** What a member gets when it follows the project (no switch of its own). */
export function followed(p: Pick<Plugin, 'defaultOn' | 'roles'>, role?: string | null): boolean {
  return p.defaultOn || (!!role && p.roles.includes(role));
}

export type Filter = 'all' | 'plugins' | 'skills' | 'mcp' | 'never';

export interface Row {
  id: string;
  name: string;
  kind: 'plugin' | 'skill' | 'mcp';
  uses: number;
  plugin?: Plugin;
  usage?: SkillUsage;
}

/** The installed plugins plus the loose skills and MCP servers the run streams have seen. */
export function buildRows(plugins: Plugin[], usage: SkillUsage[]): Row[] {
  const rows: Row[] = plugins.map((p) => ({
    id: p.id,
    name: p.name,
    kind: 'plugin',
    uses: p.used?.uses ?? 0,
    plugin: p,
  }));
  const names = new Set(plugins.map((p) => p.name));
  for (const u of usage) {
    if (u.plugin || names.has(u.name)) continue;
    rows.push({
      id: `${u.kind}:${u.name}`,
      name: u.name,
      kind: u.kind === 'mcp' ? 'mcp' : 'skill',
      uses: u.uses,
      usage: u,
    });
  }
  return rows;
}

/** The rows a filter keeps. */
export function applyFilter(rows: Row[], f: Filter): Row[] {
  if (f === 'plugins') return rows.filter((r) => r.kind === 'plugin');
  if (f === 'skills') return rows.filter((r) => r.kind === 'skill');
  if (f === 'mcp') return rows.filter((r) => r.kind === 'mcp');
  if (f === 'never') return rows.filter((r) => r.uses === 0);
  return rows;
}

/** How many items a hooks/mcp field holds (a list or a count). */
export function countOf(v: unknown[] | number | null | undefined): number {
  return Array.isArray(v) ? v.length : (v ?? 0);
}

/** A size in KB or MB. */
export function mb(bytes: number | null | undefined): string {
  if (bytes == null) return '';
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
