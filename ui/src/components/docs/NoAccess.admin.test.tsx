// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { NoAccess } from './DocsStates';

afterEach(cleanup);

describe('Docs access request (EM-2)', () => {
  it('names the admin who gets the request, with an avatar, when one is known', () => {
    const { container } = render(
      <NoAccess projectName="Kanban Board" admins={['Hoa Mai']} onRequest={async () => true} />,
    );
    // the rendered text, read from the DOM (no markup stripping)
    const text = container.textContent ?? '';
    expect(text).toContain('HM');
    expect(text).toContain('Admin: Hoa Mai gets the request');
  });

  it('keeps the board owner line when the project has no admin', () => {
    const { container } = render(<NoAccess projectName="Kanban Board" admins={[]} onRequest={async () => true} />);
    expect(container.textContent ?? '').toContain('The board owner gets the request');
  });
});
