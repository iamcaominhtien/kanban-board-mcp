/** Chip colours and two-letter glyphs of the roles (design/source/AiTeamProcess.dc.html, F). */
const ROLE_LOOK: Record<string, { glyph: string; bg: string; fg: string; border: string }> = {
  triage: { glyph: 'TR', bg: '#F1F3F1', fg: '#4A5A50', border: '#C7D2CB' },
  pm: { glyph: 'PM', bg: '#E8F1FA', fg: '#244E78', border: '#2F6FB0' },
  ba: { glyph: 'BA', bg: '#DFF3F3', fg: '#0B5F61', border: '#0F8B8D' },
  designer: { glyph: 'DS', bg: '#FCE8F1', fg: '#8A2655', border: '#B0446E' },
  dev: { glyph: 'DV', bg: '#E6F2EA', fg: '#1F5A31', border: '#2E6F40' },
  qa: { glyph: 'QA', bg: '#FEF3D9', fg: '#7A5A06', border: '#B4791E' },
  user_tester: { glyph: 'UT', bg: '#EFE8FB', fg: '#5B3AA6', border: '#6D5DD3' },
  reviewer: { glyph: 'RV', bg: '#E9EAF7', fg: '#3F4390', border: '#6A6FD0' },
  // the four roles of issue #273
  tech_writer: { glyph: 'TW', bg: '#F3EEE6', fg: '#6B4A1F', border: '#A87B3D' },
  devops: { glyph: 'DO', bg: '#E7EEF3', fg: '#2C4A5E', border: '#4F7A96' },
  security: { glyph: 'SR', bg: '#FBEAEA', fg: '#8E2A2A', border: '#C24B4B' },
  data_analyst: { glyph: 'DA', bg: '#EAF4EE', fg: '#2D5B46', border: '#4C8C6E' },
};
const PLAIN = { bg: '#F1F3F1', fg: '#4A5A50', border: '#C7D2CB' };

/** The look of a role chip. */
export function roleLook(role: string | null) {
  if (role && ROLE_LOOK[role]) return ROLE_LOOK[role];
  return {
    glyph:
      (role ?? '??')
        .replace(/[^a-z0-9]/gi, '')
        .slice(0, 2)
        .toUpperCase() || '??',
    ...PLAIN,
  };
}

/** The two-letter code of a ready-made role ("reviewer" → "RV"), or null for any other role (AT-4). */
export function roleCode(role: string | null | undefined): string | null {
  return (role && ROLE_LOOK[role]?.glyph) || null;
}
