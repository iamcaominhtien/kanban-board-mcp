import { describe, expect, it } from 'vitest';
import { steppedParams } from './aiTeam';

describe('steppedParams', () => {
  it('sends the AI filter as member_id, the name the server reads', () => {
    const params = steppedParams('today', { memberId: 'm1', mark: 'needed' });
    expect(params).toMatchObject({ range: 'today', member_id: 'm1', mark: 'needed' });
    expect(params).not.toHaveProperty('memberId');
  });
});
