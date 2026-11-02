import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NoAccess } from './DocsStates';

describe('Docs access request (EM-2)', () => {
  it('names the admin who gets the request, with an avatar, when one is known', () => {
    const html = renderToStaticMarkup(
      <NoAccess projectName="Kanban Board" admins={['Hoa Mai']} onRequest={async () => true} />,
    );
    expect(html).toContain('HM');
    expect(html.replace(/<[^>]+>/g, '')).toContain('Admin: Hoa Mai gets the request');
  });

  it('keeps the board owner line when the project has no admin', () => {
    const html = renderToStaticMarkup(<NoAccess projectName="Kanban Board" admins={[]} onRequest={async () => true} />);
    expect(html).toContain('The board owner gets the request');
  });
});
