import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { roleCode } from '../ai/workflow/wfFormat';
import { Badge } from './teamUi';

describe('Badge role code (AT-4)', () => {
  it('uses the role code of a member made from a role pack', () => {
    expect(renderToStaticMarkup(<Badge name="Reviewer" color="#6A6FD0" role="reviewer" />)).toContain('>RV<');
    expect(renderToStaticMarkup(<Badge name="Designer Dao" role="designer" />)).toContain('>DS<');
  });

  it('keeps the initials without a role, or for a role of its own', () => {
    expect(renderToStaticMarkup(<Badge name="Reviewer" />)).toContain('>RE<');
    expect(renderToStaticMarkup(<Badge name="Data Wrangler" role="data_wrangler" />)).toContain('>DW<');
    expect(roleCode('pm')).toBe('PM');
    expect(roleCode(null)).toBeNull();
  });
});
