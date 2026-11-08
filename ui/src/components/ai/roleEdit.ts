import type { AiTeamRole, RoleOverride } from '../../types/ai';

/** What a role's editor holds before Save. */
export interface RoleDraft {
  model: string;
  effort: string;
  prompt: string;
}

/** The draft a role starts from: what it runs on now. */
export function draftOf(role: AiTeamRole): RoleDraft {
  return { model: role.model ?? '', effort: role.effort ?? '', prompt: role.prompt ?? '' };
}

/** The fields of the draft that differ from the role: only these go into the override. */
export function changedFields(role: AiTeamRole, draft: RoleDraft): Partial<RoleDraft> {
  const d = draftOf(role);
  const out: Partial<RoleDraft> = {};
  if (d.model !== draft.model) out.model = draft.model;
  if (d.effort !== draft.effort) out.effort = draft.effort;
  if (d.prompt !== draft.prompt) out.prompt = draft.prompt;
  return out;
}

/** Whether the draft differs from the role. */
export function isChanged(role: AiTeamRole, draft: RoleDraft): boolean {
  const d = draftOf(role);
  return d.model !== draft.model || d.effort !== draft.effort || d.prompt !== draft.prompt;
}

/**
 * The `config.roles` list after one role changed: the other overrides stay, this role's override takes the fields
 * that changed (`off` is kept as it was unless given). An empty model or effort sets the role to inherit.
 */
export function withRoleOverride(
  current: readonly RoleOverride[] | undefined,
  key: string,
  patch: Partial<Omit<RoleOverride, 'key'>>,
): RoleOverride[] {
  const rest = (current ?? []).filter((o) => o.key !== key);
  const mine = (current ?? []).find((o) => o.key === key);
  const next: RoleOverride = { ...mine, ...patch, key };
  if ('model' in patch) next.model = patch.model || null;
  if ('effort' in patch) next.effort = patch.effort || null;
  return [...rest, next];
}

/** The overrides that turn a role off (the roles the team's pack has but the team dropped). */
export function offKeys(overrides: readonly RoleOverride[] | undefined): string[] {
  return (overrides ?? []).filter((o) => o.off).map((o) => o.key);
}

/** The list after a role is turned on again (its other overrides stay). */
export function withRoleOn(current: readonly RoleOverride[] | undefined, key: string): RoleOverride[] {
  return (current ?? []).map((o) => (o.key === key ? { ...o, off: false } : o));
}

/** The list after a role is turned off. */
export function withRoleOff(current: readonly RoleOverride[] | undefined, key: string): RoleOverride[] {
  return withRoleOverride(current, key, { off: true });
}
