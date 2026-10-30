import type { Editor } from '@tiptap/core';
import type { DocsAiSource } from '../../../types/docs';
import { countCitations, findMarkers } from '../../../utils/writeRules';
import { Icon } from '../Icon';
import { AiSpark } from './AiSpark';

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

/** The header chip of a draft an AI wrote: "Draft · Drafted with AI · from KAN-154 · only you see it". */
export function AiDraftChip({ source }: { source: DocsAiSource }) {
  return (
    <div
      data-testid="ai-draft-chip"
      style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5, color: '#5B6B60' }}
    >
      <span className="mc-chip" style={{ background: '#EEF3EF', color: '#5B6B60' }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#9AA8A0', display: 'inline-block' }} />
        Draft
      </span>
      <span
        className="mc-chip"
        style={{ background: '#F1ECFD', border: '1px solid #D9CCF7', color: '#5B3FBF', fontWeight: 600 }}
      >
        <AiSpark size={12} />
        {source.kind === 'accepted' ? 'AI text accepted' : 'Drafted with AI'}
      </span>
      <span>{source.from && source.kind !== 'accepted' ? `from ${source.from} · ` : ''}only you see it</span>
    </div>
  );
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
        width: 260,
        flexShrink: 0,
        borderLeft: '1px solid #E3E8E5',
        background: '#F8F5FE',
        padding: '16px 16px 24px',
        overflowY: 'auto',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: '#5B3FBF' }}>
        GAPS · {markers.length}
      </div>
      {markers.length === 0 ? (
        <div style={{ fontSize: 12.5, color: '#5B6B60', margin: '8px 0 16px', lineHeight: 1.5 }}>
          No gaps left. Read the page once more before you publish it.
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12.5, color: '#1E2A22', margin: '8px 0 6px', lineHeight: 1.5 }}>
            I could not find these in the sources, so I left them empty instead of guessing:
          </div>
          <ul
            style={{
              listStyle: 'none',
              margin: '0 0 16px',
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
                    padding: '2px 0',
                    font: 'inherit',
                    fontSize: 13,
                    color: '#1E2A22',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <span style={{ color: '#B4791E', display: 'flex' }}>
                    <Icon name="i14" size={13} strokeWidth={2} />
                  </span>
                  {m.label.charAt(0).toUpperCase() + m.label.slice(1)}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {sources.length > 0 && (
        <>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: '#5B3FBF' }}>SOURCES</div>
          <ol
            style={{
              listStyle: 'none',
              margin: '8px 0 0',
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            {sources.map((s) => (
              <li key={s.n} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <button
                  type="button"
                  className="mc-chip"
                  aria-label={`Find [${s.n}] in the text`}
                  onClick={() => onGoTo(`[${s.n}]`)}
                  style={{
                    border: '1px solid #D9CCF7',
                    background: '#F1ECFD',
                    color: '#5B3FBF',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  {s.n}
                </button>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#1E2A22' }}>{s.label}</div>
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
          style={{ marginTop: 16 }}
          onClick={onStripCitations}
          title="The [1] marks point at the sources here. Remove them before you publish if you do not want them in the page."
        >
          Remove {cites} [n] mark{cites === 1 ? '' : 's'}
        </button>
      )}
    </aside>
  );
}
