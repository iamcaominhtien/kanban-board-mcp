import { describe, expect, it } from 'vitest';
import { boardSkillOn, boardSkillOwn, withBoardSkill } from './boardSkillLogic';

describe("the board's skill switches (issue #277)", () => {
  it('is on unless the project or the member switched it off; the member wins', () => {
    expect(boardSkillOn([], 'canvas-design')).toBe(true);
    const list = [{ skill: 'canvas-design', on: false, membersOn: ['dev'], membersOff: [] }];
    expect(boardSkillOn(list, 'canvas-design')).toBe(false);
    expect(boardSkillOn(list, 'canvas-design', 'pm')).toBe(false);
    expect(boardSkillOn(list, 'canvas-design', 'dev')).toBe(true);
    expect(boardSkillOwn(list, 'canvas-design', 'dev')).toBe(true);
    expect(boardSkillOwn(list, 'canvas-design', 'pm')).toBe(false);
  });

  it('keeps the members when the project switch changes, and drops a skill back to its default', () => {
    const off = withBoardSkill([], 'repo-and-machine', false);
    expect(off).toEqual([{ skill: 'repo-and-machine', on: false, membersOn: [], membersOff: [] }]);
    const mine = withBoardSkill(off, 'repo-and-machine', true, 'dev');
    expect(mine[0].membersOn).toEqual(['dev']);
    expect(withBoardSkill(mine, 'repo-and-machine', true)[0]).toMatchObject({ on: true, membersOn: ['dev'] });
    expect(withBoardSkill(withBoardSkill(mine, 'repo-and-machine', null, 'dev'), 'repo-and-machine', true)).toEqual([]);
  });
});
