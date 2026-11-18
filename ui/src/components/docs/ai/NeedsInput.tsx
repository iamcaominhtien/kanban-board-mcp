import type { Editor } from '@tiptap/core';
import type { DocsAiSource } from '../../../types/docs';
import { countCitations, findMarkers } from '../../../utils/writeRules';
import type { CSSProperties } from 'react';
import { SgIcon, Spark, type SgIconName } from '../suggestions/sgIcons';

/** Select the first occurrence of `text` in the visual editor and scroll to it; false when it is not found. */
export function goToText(editor: Editor | null, text: string): boolean {
  if (!editor) return false;
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (at >= 0 || !node.isText || !node.text) return;
    const i = node.text.indexOf(text);
    if (i >= 0) at = pos + i;
  });
  if (at < 0) return false;
  editor
    .chain()
    .focus()
    .setTextSelection({ from: at, to: at + text.length })
    .scrollIntoView()
    .run();
  return true;
}

// the board's chips (RichDocsAi2 frame 25)
const DRAFT_CHIP: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 22,
  padding: '0 9px',
  borderRadius: 999,
  background: '#EEF3EF',
  color: '#5B6B60',
  fontWeight: 600,
  boxSizing: 'border-box',
};
const AI_CHIP: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  height: 22,
  padding: '0 8px',
  borderRadius: 999,
  background: '#EFE8FB',
  border: '1px solid #D9CCF7',
  color: '#5B3AA6',
  fontSize: 11.5,
  fontWeight: 700,
  whiteSpace: 'nowrap',
  flex: 'none',
  boxSizing: 'border-box',
};
const HEAD: CSSProperties = { fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: '#5B3AA6' };

/** The header chip of a draft an AI wrote: "Draft · Drafted with AI · from KAN-154 · only you see it". */
export function AiDraftChip({ source }: { source: DocsAiSource }) {
  return (
    <div
      data-testid="ai-draft-chip"
      style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5, color: '#5B6B60' }}
    >
      <span style={DRAFT_CHIP}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#9AA8A0', flexShrink: 0 }} />
        Draft
      </span>
      <span style={AI_CHIP}>
        <Spark size={11.5} color="#5B3AA6" />
        {source.kind === 'accepted' ? 'AI text accepted' : 'Drafted with AI'}
      </span>
      <span>{source.from && source.kind !== 'accepted' ? `from ${source.from} · ` : ''}only you see it</span>
    </div>
  );
}

/** The icon of a line of "Formatting the team used". */
export function formattingIcon(line: string): SgIconName {
  const l = line.toLowerCase();
  if (l.includes('centred') || l.includes('aligned')) return 'align';
  if (l.includes('floated')) return 'float';
  if (l.includes('quote')) return 'quote';
  if (l.includes('image') || l.includes('video')) return 'image';
  if (l.includes('callout')) return 'callout';
  if (l.includes('table')) return 'table';
  if (l.includes('column')) return 'columns';
  if (l.includes('colour')) return 'colour';
  if (l.includes('highlight')) return 'highlight';
  if (l.includes('task')) return 'tasks';
  return 'text';
}

interface PanelProps {
  source: DocsAiSource;
  /** The text in the editor now: the gaps shown are the markers still in it. */
  markdown: string;
  onGoTo: (text: string) => void;
  onStripCitations: () => void;
}

/**
 * GAPS and SOURCES of an AI draft, beside the page. The gaps are the Needs input markers still in the text; a source
 * jumps to its [n] mark in the text and shows the quote the AI relied on.
 */
export function AiDraftPanel({ source, markdown, onGoTo, onStripCitations }: PanelProps) {
  const markers = findMarkers(markdown);
  const cites = countCitations(markdown);
  const sources = source.sources ?? [];
  return (
    <aside
      className="dk-ai-draft-panel"
      aria-label="Gaps and sources"
      style={{
        width: 250,
        flexShrink: 0,
        borderLeft: '1px solid #E3E8E5',
        background: '#FBFAFE',
        padding: '18px 16px',
        overflowY: 'auto',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={HEAD}>GAPS · {markers.length}</div>
      {markers.length === 0 ? (
        <div style={{ fontSize: 12.5, color: '#5B6B60', lineHeight: 1.5 }}>
          No gaps left. Read the page once more before you publish it.
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12.5, color: '#5B6B60', lineHeight: 1.5 }}>
            I could not find these in the sources, so I left them empty instead of guessing:
          </div>
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            {markers.map((m, i) => (
              <li key={`${m.line}-${i}`}>
                <button
                  type="button"
                  onClick={() => onGoTo(m.text)}
                  title="Go to marker"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    border: 'none',
                    background: 'none',
                    padding: 0,
                    font: 'inherit',
                    fontSize: 12.5,
                    color: '#1E2A22',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <span aria-hidden="true">•</span>
                  {m.label.charAt(0).toUpperCase() + m.label.slice(1)}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {(source.formatting ?? []).length > 0 && (
        <>
          <div style={{ ...HEAD, borderTop: '1px solid #E3E8E5', paddingTop: 10 }}>FORMATTING THE TEAM USED</div>
          {(source.formatting ?? []).map((f) => (
            <div
              key={f}
              data-testid="ai-draft-formatting"
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', fontSize: 12.5 }}
            >
              <SgIcon name={formattingIcon(f)} size={14} color="#5B3AA6" />
              <span>{f}</span>
            </div>
          ))}
          <div style={{ fontSize: 12, color: '#5B6B60', lineHeight: 1.5 }}>
            All of it is ordinary formatting. Change or remove any of it in the editor.
          </div>
        </>
      )}
      {sources.length > 0 && (
        <>
          <div style={{ ...HEAD, borderTop: '1px solid #E3E8E5', paddingTop: 10 }}>SOURCES</div>
          <ol
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            {sources.map((s) => (
              <li key={s.n} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5 }}>
                <button
                  type="button"
                  aria-label={`Find [${s.n}] in the text`}
                  onClick={() => onGoTo(`[${s.n}]`)}
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    border: 'none',
                    padding: 0,
                    background: '#EFE8FB',
                    color: '#5B3AA6',
                    fontSize: 10.5,
                    fontWeight: 700,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flex: 'none',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  {s.n}
                </button>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: '#1E2A22' }}>{s.label}</div>
                  {s.quote && (
                    <div style={{ fontSize: 12, color: '#5B6B60', lineHeight: 1.45, marginTop: 2 }}>“{s.quote}”</div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
      {cites > 0 && (
        <button
          type="button"
          className="st-btn st-btn-sm"
          style={{ alignSelf: 'flex-start' }}
          onClick={onStripCitations}
          title="The [1] marks point at the sources here. Remove them before you publish if you do not want them in the page."
        >
          Remove {cites} [n] mark{cites === 1 ? '' : 's'}
        </button>
      )}
    </aside>
  );
}
