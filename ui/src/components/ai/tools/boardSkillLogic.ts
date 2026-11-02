import type { BoardSkillSwitch } from '../../../api/aiProjectOps';

/** Whether a board skill is on: for the project (no member), or for a member (its own switch, else the project's). */
export function boardSkillOn(list: BoardSkillSwitch[] | undefined, skill: string, memberId?: string): boolean {
  const r = (list ?? []).find((x) => x.skill === skill);
  if (!r) return true;
  if (memberId && (r.membersOn ?? []).includes(memberId)) return true;
  if (memberId && (r.membersOff ?? []).includes(memberId)) return false;
  return r.on !== false;
}

/** Whether the member has its own switch for the skill (not following the project). */
export function boardSkillOwn(list: BoardSkillSwitch[] | undefined, skill: string, memberId: string): boolean {
  const r = (list ?? []).find((x) => x.skill === skill);
  return !!r && ((r.membersOn ?? []).includes(memberId) || (r.membersOff ?? []).includes(memberId));
}

/**
 * The list after one switch: the project's (`memberId` absent) or a member's (`on` null: follow the project again).
 * A skill back on for the project with no member switches leaves the list.
 */
export function withBoardSkill(
  list: BoardSkillSwitch[] | undefined,
  skill: string,
  on: boolean | null,
  memberId?: string,
): BoardSkillSwitch[] {
  const rest = (list ?? []).filter((x) => x.skill !== skill);
  const cur = (list ?? []).find((x) => x.skill === skill) ?? { skill };
  let membersOn = (cur.membersOn ?? []).filter((m) => m !== memberId);
  let membersOff = (cur.membersOff ?? []).filter((m) => m !== memberId);
  let projectOn = cur.on !== false;
  if (memberId) {
    if (on === true) membersOn = [...membersOn, memberId];
    if (on === false) membersOff = [...membersOff, memberId];
  } else {
    projectOn = on !== false;
    membersOn = cur.membersOn ?? [];
    membersOff = cur.membersOff ?? [];
  }
  if (projectOn && !membersOn.length && !membersOff.length) return rest;
  return [...rest, { skill, on: projectOn, membersOn, membersOff }];
}
