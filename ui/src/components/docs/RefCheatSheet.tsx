import { useEffect, useState } from 'react';
import { ModalShell } from './docsShared';

const OPEN_EVENT = 'docs:ref-cheat-sheet';

/** Open the reference cheat sheet (mounted once by `RefCheatSheetHost`). */
export function openRefCheatSheet() {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

const mono: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 12,
  color: '#2E6F40',
  background: '#F6FAF7',
  borderRadius: 4,
  padding: '2px 6px',
  whiteSpace: 'nowrap',
};
const label: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: '#5B6B60',
};
const cell: React.CSSProperties = { padding: '8px 12px', borderBottom: '1px solid #EEF3EF', verticalAlign: 'top' };
const head: React.CSSProperties = { ...label, ...cell, textAlign: 'left', background: '#FBFCFB' };

/** [Write, You see, Notes] */
const SYNTAX: [string, string, string][] = [
  ['[[Page]]', 'Page chip', 'Matches the page title, case-insensitive. Shown title follows renames.'],
  ['[[Page#Section]]', 'Page › Section chip', 'Section is a heading text; resolved to its slug anchor.'],
  ['[[Page#Section|text]]', 'Your text as the chip', 'Your own text replaces the title; it is never rewritten.'],
  ['[[Parent/Page]]', 'Parent / Page chip', 'Needed only when two pages share a title.'],
  ['KAN-12', 'Ticket chip', 'Project key + number; any project you can read.'],
  ['[text](https://…)', 'Link', 'Standard markdown link. External links open in a new tab.'],
];

const ANCHORS: [string, string][] = [
  ['Example request', '#example-request'],
  ['Auth & tokens (v2)', '#auth-tokens-v2'],
  ['Overview (first)', '#overview'],
  ['Overview (second)', '#overview-2'],
  ['Résumé', '#resume'],
];

/** The "Markdown reference cheat sheet" (DocsRefs board H): syntax, how anchors are made, what a rename does. */
export function RefCheatSheet({ onClose }: { onClose: () => void }) {
  return (
    <ModalShell
      width={760}
      ariaLabel="Reference syntax"
      icon="i59"
      title="Reference syntax"
      subtitle="Link pages, sections and tickets from any page or ticket"
      onClose={onClose}
      bodyStyle={{ padding: '16px 22px 20px', display: 'flex', flexDirection: 'column', gap: 18 }}
    >
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, color: '#1E2A22' }}>
        <thead>
          <tr>
            <th style={head}>Write</th>
            <th style={head}>You see</th>
            <th style={head}>Notes</th>
          </tr>
        </thead>
        <tbody>
          {SYNTAX.map(([w, s, n]) => (
            <tr key={w}>
              <td style={cell}>
                <span style={mono}>{w}</span>
              </td>
              <td style={{ ...cell, fontWeight: 600 }}>{s}</td>
              <td style={{ ...cell, color: '#5B6B60', lineHeight: 1.45 }}>{n}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 12.5, lineHeight: 1.5, color: '#5B6B60' }}>
        Type <span style={mono}>[[</span> in the editor and everything above is a pick-list, so nobody has to remember
        it. Pasting a docs URL into a paragraph turns it into the same chip.
      </div>
      <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={label}>How anchors are generated</div>
          <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6, color: '#3A4A3E' }}>
            <li>Lower-case.</li>
            <li>Strip accents.</li>
            <li>Drop punctuation and inline code marks.</li>
            <li>Spaces and runs of dashes become one dash.</li>
            <li>
              A repeated slug on the same page gets <span style={mono}>-2</span>, <span style={mono}>-3</span> in
              document order.
            </li>
          </ol>
          <table style={{ borderCollapse: 'collapse', fontSize: 12.5 }}>
            <tbody>
              {ANCHORS.map(([h, a]) => (
                <tr key={a}>
                  <td style={{ ...cell, padding: '5px 12px 5px 0', color: '#1E2A22' }}>{h}</td>
                  <td style={{ ...cell, padding: '5px 0' }}>
                    <span style={mono}>{a}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={label}>When something is renamed</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6, color: '#3A4A3E' }}>
            <li>
              <b>Page title:</b> stored links are rewritten to the new title, after a confirm that lists the pages.
              Display text is kept. Tickets link by page id and show the new title.
            </li>
            <li>
              <b>Heading:</b> nothing is rewritten; the old anchor redirects to the new one.
            </li>
            <li>
              <b>Page moved:</b> no change, links use the page id.
            </li>
            <li>
              <b>Page deleted:</b> links turn into “In Recycle Bin” chips; restore fixes them.
            </li>
          </ul>
        </div>
      </div>
    </ModalShell>
  );
}

/** Mount once in the Docs space: shows the cheat sheet whenever `openRefCheatSheet()` is called. */
export function RefCheatSheetHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, on);
    return () => window.removeEventListener(OPEN_EVENT, on);
  }, []);
  return open ? <RefCheatSheet onClose={() => setOpen(false)} /> : null;
}
