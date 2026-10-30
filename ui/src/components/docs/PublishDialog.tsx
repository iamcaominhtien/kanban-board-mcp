import { useEffect, useState } from 'react';
import { useDocsFollowers } from '../../api/docs';
import { docsAiError, useDocsAiJob, useDocsAiState } from '../../api/docsAi';
import { useStartPublishNote } from '../../api/docsAiWrite';
import { aiGate, costLabel } from '../../utils/docsAiRules';
import { findMarkers, publishLabel, publishWarning } from '../../utils/writeRules';
import { AiSpark } from './ai/AiSpark';
import { countPageRefs, lineDiffCounts } from '../../utils/lineDiff';
import { avatarColors } from './docsUi';
import { CloseButton, DOCS_SCRIM, useEscape } from './docsShared';
import { Icon } from './Icon';
import './docs.css';

const MAX_NOTE = 200;
const NOTE_PLACEHOLDER = 'What changed? e.g. Added the rate limiting section and linked KAN-12.';
const NOTE_FONT = {
  fontFamily: "'Plus Jakarta Sans', sans-serif",
  fontSize: 12.5,
  lineHeight: 1.5,
  padding: '8px 10px',
} as const;

/** Ticket keys (KAN-12) in a note are drawn as references, like the chips on the page. */
function withKeys(text: string, tone: 'text' | 'hint') {
  return text.split(/(\b[A-Z][A-Z0-9]{1,9}-\d+\b)/).map((part, i) =>
    i % 2 ? (
      <span
        key={i}
        style={{ background: '#EFE9FB', color: '#5B3FA0', borderRadius: 4, boxShadow: '0 0 0 1px #EFE9FB' }}
      >
        {part}
      </span>
    ) : (
      <span key={i} style={tone === 'hint' ? { color: '#9AA8A0' } : undefined}>
        {part}
      </span>
    ),
  );
}

interface Props {
  projectId: string;
  /** The page being published (the AI suggests its change note). */
  pageId?: string;
  /** Close the dialog and select the first Needs input marker in the editor. */
  onGoToMarker?: (text: string) => void;
  pageTitle: string;
  fromVersion: number;
  baseMarkdown: string;
  draftMarkdown: string;
  publishing: boolean;
  error?: string | null;
  onClose: () => void;
  onReview: () => void;
  onPublish: (note: string, notify: boolean) => void;
}

/**
 * "Publish changes" dialog (DocsEditor board E): diff summary, version note and Notify members.
 * @param props.projectId - Project whose followers are notified.
 * @param props.fromVersion - Version the draft is based on.
 * @param props.baseMarkdown - Markdown of that version.
 * @param props.draftMarkdown - Unpublished draft, diffed against the base.
 * @param props.publishing - A publish is running; disables the buttons.
 * @param props.error - Error from the last publish attempt.
 * @param props.onClose - Called to dismiss the dialog.
 * @param props.onReview - Called to review the diff before publishing.
 * @param props.onPublish - Called with the version note and whether to notify followers.
 */
export function PublishDialog({
  projectId,
  pageId,
  onGoToMarker,
  pageTitle,
  fromVersion,
  baseMarkdown,
  draftMarkdown,
  publishing,
  error,
  onClose,
  onReview,
  onPublish,
}: Props) {
  const [note, setNote] = useState('');
  const [notify, setNotify] = useState(true);
  const [suggested, setSuggested] = useState(false);
  const aiState = useDocsAiState(projectId);
  const aiOn = aiGate(aiState.data).show && aiState.data?.state === 'ready' && !!pageId;
  const startNote = useStartPublishNote(pageId ?? '');
  const [noteJob, setNoteJob] = useState<string | null>(null);
  const noteQ = useDocsAiJob(noteJob);
  const noteBusy =
    startNote.isPending ||
    (!!noteJob && (!noteQ.data || noteQ.data.state === 'queued' || noteQ.data.state === 'running'));
  const noteProblem = startNote.error
    ? docsAiError(startNote.error)?.detail
    : noteQ.data?.state === 'failed'
      ? noteQ.data.error.message
      : null;
  const markers = findMarkers(draftMarkdown);
  const warning = publishWarning(markers);
  useEscape(onClose);
  const { added, removed } = lineDiffCounts(baseMarkdown, draftMarkdown);
  const refsAdded = Math.max(0, countPageRefs(draftMarkdown) - countPageRefs(baseMarkdown));
  const next = fromVersion + 1;
  const followersQ = useDocsFollowers(projectId);
  const followers = followersQ.data?.count ?? 0;
  const followerNames = followersQ.data?.names ?? [];

  // the suggested note fills an empty note box; a note the person already typed is never replaced
  useEffect(() => {
    const j = noteQ.data;
    if (j?.state !== 'finished') return;
    const text = typeof j.result.note === 'string' ? j.result.note : '';
    if (text) {
      setNote((cur) => (cur.trim() ? cur : text.slice(0, MAX_NOTE)));
      setSuggested(true);
    }
  }, [noteQ.data]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !publishing) {
        e.preventDefault();
        onPublish(note, notify);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [note, notify, publishing, onPublish]);

  return (
    <div
      className="docs-root"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1100,
        background: DOCS_SCRIM,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Publish page"
        style={{
          width: 520,
          maxWidth: '100%',
          borderRadius: 12,
          border: '1px solid #E3E8E5',
          boxShadow: '0 24px 64px rgba(30,42,34,0.28)',
          background: '#FFFFFF',
          overflow: 'hidden',
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            padding: '18px 24px',
            borderBottom: '1px solid #E3E8E5',
          }}
        >
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#1E2A22' }}>Publish changes</div>
            <div style={{ fontSize: 12, color: '#5B6B60', marginTop: 2 }}>
              {pageTitle} · v{fromVersion} → v{next}
            </div>
          </div>
          <CloseButton onClick={onClose} />
        </div>
        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 12px',
              borderRadius: 8,
              background: '#F6FAF7',
              border: '1px solid #E3E8E5',
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                gap: 8,
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              <span style={{ color: '#2E6F40' }}>+{added}</span>
              <span style={{ color: '#C4432A' }}>−{removed}</span>
            </span>
            <span style={{ fontSize: 12.5, color: '#5B6B60', flex: 1 }}>
              lines changed
              {refsAdded > 0 && (
                <>
                  {' '}
                  · {refsAdded} reference{refsAdded === 1 ? '' : 's'} added
                </>
              )}
            </span>
            {fromVersion > 0 && (
              <button
                type="button"
                onClick={onReview}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#2E6F40',
                  textDecoration: 'underline',
                  textUnderlineOffset: 2,
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Review changes
              </button>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <label htmlFor="docs-version-note" className="st-field-label">
                Version note
              </label>
              <span style={{ fontSize: 11, color: '#9AA8A0', fontFamily: "'JetBrains Mono', monospace" }}>
                {note.length} / {MAX_NOTE}
              </span>
            </div>
            <div style={{ position: 'relative' }}>
              <div
                aria-hidden
                style={{
                  position: 'absolute',
                  inset: 0,
                  ...NOTE_FONT,
                  border: '1px solid transparent',
                  boxSizing: 'border-box',
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  overflow: 'hidden',
                  pointerEvents: 'none',
                  color: 'transparent',
                }}
              >
                {note ? (
                  withKeys(note, 'text')
                ) : (
                  <span style={{ color: '#9AA8A0' }}>{withKeys(NOTE_PLACEHOLDER, 'hint')}</span>
                )}
              </div>
              <textarea
                id="docs-version-note"
                aria-label="Version note"
                autoFocus
                className="st-input dk-note"
                value={note}
                maxLength={MAX_NOTE}
                onChange={(e) => {
                  setNote(e.target.value);
                  setSuggested(false);
                }}
                style={{
                  minHeight: 72,
                  width: '100%',
                  boxSizing: 'border-box',
                  resize: 'none',
                  background: 'transparent',
                  position: 'relative',
                  ...NOTE_FONT,
                }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {suggested ? (
                <>
                  <span
                    className="mc-chip"
                    style={{ background: '#F1ECFD', color: '#5B3FBF', fontWeight: 600 }}
                    data-testid="suggested-note"
                  >
                    Suggested from your changes
                  </span>
                  <span className="st-hint">Edit it or write your own.</span>
                </>
              ) : (
                <div className="st-hint">Shown in version history next to v{next}. Optional.</div>
              )}
              {aiOn && !suggested && (
                <button
                  type="button"
                  className="st-btn st-btn-sm"
                  disabled={noteBusy}
                  data-testid="suggest-note"
                  onClick={() => startNote.mutate({ markdown: draftMarkdown }, { onSuccess: (j) => setNoteJob(j.id) })}
                >
                  <AiSpark size={12} />
                  {noteBusy ? 'Reading your changes…' : 'Suggest a note'}
                </button>
              )}
              {noteQ.data?.state === 'finished' && !noteQ.data.result.note && (
                <span className="st-hint">Nothing changed yet, so there is nothing to suggest.</span>
              )}
              {noteQ.data?.state === 'finished' && noteQ.data.cost > 0 && (
                <span className="st-hint">
                  AI · {costLabel(noteQ.data.cost, noteQ.data.metered).replace('About ', '')}
                </span>
              )}
              {noteProblem && (
                <span role="alert" style={{ fontSize: 12, color: '#C4432A' }}>
                  {noteProblem}
                </span>
              )}
            </div>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '12px 14px',
              border: '1px solid #E3E8E5',
              borderRadius: 8,
            }}
          >
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#1E2A22' }}>Notify members</span>
              <span className="st-hint">
                {followers === 0
                  ? 'No one else follows this space yet.'
                  : `${followers} ${followers === 1 ? 'person who follows' : 'people who follow'} this space ${followers === 1 ? 'gets a notification' : 'get a notification'}.`}
              </span>
            </div>
            <div style={{ display: 'flex', marginRight: 6 }}>
              {followerNames.map((n) => (
                <span
                  key={n}
                  style={{ marginLeft: -6, border: '2px solid #FFFFFF', borderRadius: '50%', display: 'flex' }}
                >
                  <span
                    title={n}
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: '50%',
                      ...avatarColors(n),
                      fontSize: 11,
                      fontWeight: 700,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    {n
                      .split(' ')
                      .map((p) => p[0])
                      .join('')}
                  </span>
                </span>
              ))}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={notify}
              aria-label="Notify members"
              className="st-toggle-track"
              onClick={() => setNotify((v) => !v)}
              style={{ background: notify ? '#2E6F40' : '#C7D2CB', border: 'none', padding: 0 }}
            >
              <span className="st-toggle-dot" style={{ left: notify ? 17 : 2 }} />
            </button>
          </div>
          {warning.show && (
            <div
              role="alert"
              data-testid="markers-warning"
              style={{
                display: 'flex',
                gap: 10,
                padding: '12px 14px',
                borderRadius: 9,
                background: '#FEF6E7',
                border: '1px solid #F0DBA8',
              }}
            >
              <span style={{ color: '#B4791E', display: 'flex', marginTop: 1 }}>
                <Icon name="i14" size={17} strokeWidth={2} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#7A4F08' }}>{warning.title}</div>
                <div style={{ fontSize: 12.5, color: '#5B4A1E', marginTop: 2, lineHeight: 1.45 }}>{warning.detail}</div>
                {onGoToMarker && (
                  <button
                    type="button"
                    className="st-btn st-btn-sm"
                    style={{ marginTop: 8 }}
                    onClick={() => onGoToMarker(markers[0].text)}
                  >
                    Go to marker
                  </button>
                )}
              </div>
            </div>
          )}
          {error && (
            <div
              role="alert"
              style={{ padding: '8px 12px', borderRadius: 8, background: '#FBE7E4', color: '#A5321E', fontSize: 12.5 }}
            >
              {error}
            </div>
          )}
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            padding: '14px 24px',
            borderTop: '1px solid #E3E8E5',
            background: '#FBFCFB',
          }}
        >
          <button type="button" className="st-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="st-btn st-btn-primary"
            disabled={publishing}
            onClick={() => onPublish(note, notify)}
            data-testid="confirm-publish"
          >
            {publishing ? <span className="mc-spin mc-spin-w" /> : <Icon name="i46" size={14} />}
            {publishLabel(markers, next)}
          </button>
        </div>
      </div>
    </div>
  );
}
