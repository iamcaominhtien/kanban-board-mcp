import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { assistApi, assistError, useAssistState, useDocDrafts } from '../../api/assist';
import { useDocsAiState } from '../../api/docsAi';
import { markAiAccepted } from '../../api/docsAiWrite';
import { extractError } from '../../api/extractError';
import type { AssistDraft } from '../../types/assist';
import { useAssist } from './AssistContext';
import { CostChip, DraftTag, featureBlock } from './assistUi';
import { cleanEditorMarkdown } from '../../utils/docsMarkdown';
import { aiGate } from '../../utils/docsAiRules';
import type { AiSlashId } from '../docs/editor/slashItems';
import { CheckThisPage } from '../docs/ai/CheckThisPage';
import { DrawDiagram } from '../docs/ai/DrawDiagram';
import './assist.css';

export interface DocsAiEditor {
  getEditor: () => Editor | null;
  /** Current Markdown of the page being edited. */
  getMarkdown: () => string;
  /** Replace the whole page (used for link suggestions). */
  setMarkdown: (md: string) => void;
}

function insertAt(ed: Editor | null, where: 'top' | 'cursor' | 'selection', md: string): boolean {
  if (!ed) return false;
  const opts = { contentType: 'markdown' } as never;
  if (where === 'top') return ed.chain().focus().insertContentAt(0, md, opts).run();
  const { from, to, $to } = ed.state.selection;
  if (where === 'selection' && from !== to) return ed.chain().focus().insertContentAt({ from, to }, md, opts).run();
  const pos = $to.depth ? $to.after(1) : $to.pos;
  return ed.chain().focus().insertContentAt(pos, md, opts).run();
}

/** Replace the first plain occurrence of `phrase` (outside an existing [[ ]] reference) with `ref`. */
export function linkPhrase(md: string, phrase: string, ref: string): string {
  let i = md.indexOf(phrase);
  while (i >= 0) {
    const open = md.lastIndexOf('[[', i);
    const close = md.lastIndexOf(']]', i);
    if (open === -1 || close > open) return md.slice(0, i) + ref + md.slice(i + phrase.length);
    i = md.indexOf(phrase, i + phrase.length);
  }
  return md;
}

const LIST_TYPES = ['bulletList', 'orderedList', 'taskList'];

/** The list the cursor is in as Markdown, else the selected text, else null ("Table from this list"). */
export function listAtCursor(ed: Editor | null): string | null {
  if (!ed) return null;
  const { $from, from, to } = ed.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (LIST_TYPES.includes(n.type.name)) {
      const lines: string[] = [];
      n.forEach((item) => lines.push(`- ${item.textContent.trim()}`));
      return lines.join('\n');
    }
  }
  return from !== to ? ed.state.doc.textBetween(from, to, '\n') : null;
}

/** The code block the cursor is in (its text), else null ("Explain this code block"). */
export function codeAtCursor(ed: Editor | null): string | null {
  if (!ed) return null;
  const { $from } = ed.state.selection;
  return $from.parent.type.name === 'codeBlock' ? $from.parent.textContent : null;
}

const SELECTION_TAG: Record<string, string> = {
  rewrite: 'Rewrite of the selection',
  ask: 'Answer about the selection',
  table: 'Table from the list',
  explain_code: 'Explanation of the code',
};

function DraftBlock({ d, ed, onDone }: { d: AssistDraft; ed: DocsAiEditor; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(d.payload.text ?? '');
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  const [copied, setCopied] = useState(false);
  const run = async (fn: () => Promise<unknown> | unknown) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      setError(assistError(e)?.detail ?? extractError(e));
    } finally {
      setBusy(false);
    }
  };
  const used = (detail: Record<string, unknown>) => {
    // accepting AI text marks the draft, so History shows the version "with AI" once it is published
    if (d.docId) void markAiAccepted(d.docId);
    return assistApi.apply(d.id, { detail });
  };
  const discard = () => run(() => assistApi.discard(d.id));
  const copy = () => {
    void navigator.clipboard?.writeText(d.kind === 'doc_section' ? `## ${d.payload.heading}\n\n${text}` : text);
    setCopied(true);
  };

  if (d.status === 'pending')
    return (
      <div className="as-draft" data-testid="docs-draft-pending">
        <DraftTag>Drafting…</DraftTag>
        <div className="as-skel" style={{ height: 14, width: '80%' }} />
        <div className="as-skel" style={{ height: 14, width: '55%' }} />
        <button
          type="button"
          className="ai-link"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => void run(() => assistApi.cancel(d.id))}
        >
          Cancel
        </button>
      </div>
    );
  if (d.status === 'failed')
    return (
      <div className="as-tile as-tile-error">
        <div className="as-tile-title">Draft didn’t come back</div>
        <div className="ai-hint">{d.result.error?.message}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="ai-btn ai-btn-sm" onClick={() => void run(() => assistApi.regenerate(d.id))}>
            Try again
          </button>
          <button type="button" className="ai-btn ai-btn-sm" onClick={() => void discard()}>
            Dismiss
          </button>
        </div>
      </div>
    );

  if (d.kind === 'doc_links') {
    const links = (d.payload.links ?? []).filter((l) => !skipped.has(l.n));
    const accept = (ls: typeof links) =>
      run(async () => {
        let md = cleanEditorMarkdown(ed.getMarkdown());
        for (const l of ls) md = linkPhrase(md, l.phrase, l.ref);
        ed.setMarkdown(md);
        await used({ links: ls.map((l) => l.n) });
      });
    return (
      <div className="as-draft" data-testid="docs-links">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <b style={{ fontSize: 13 }}>Suggested links · {links.length} found</b>
          <span style={{ flex: 1 }} />
          <CostChip cost={d.cost} metered={d.cost > 0} />
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            disabled={!links.length || busy}
            onClick={() => void accept(links)}
          >
            Accept all
          </button>
        </div>
        {!links.length && <div className="ai-muted">No link suggestions for this page.</div>}
        {links.map((l) => (
          <div key={l.n} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <span style={{ textDecoration: 'underline dotted #2E6F40', textUnderlineOffset: 3 }}>“{l.phrase}”</span>→
            <span className="as-ctx-chip">
              <span>
                {l.kind === 'ticket' ? `🗋 ${l.target}` : `📄 ${l.target}${l.anchor ? ` › # ${l.anchor}` : ''}`}
              </span>
            </span>
            <span style={{ flex: 1 }} />
            <button type="button" className="ai-btn ai-btn-sm" disabled={busy} onClick={() => void accept([l])}>
              Accept
            </button>
            <button type="button" className="ai-link" onClick={() => setSkipped(new Set([...skipped, l.n]))}>
              Skip
            </button>
          </div>
        ))}
        <button type="button" className="ai-link" style={{ alignSelf: 'flex-start' }} onClick={() => void discard()}>
          Discard
        </button>
        {error && <div className="ai-error-text">{error}</div>}
      </div>
    );
  }

  const isSection = d.kind === 'doc_section';
  const isSelection = d.kind === 'doc_text';
  return (
    <div className="as-draft" data-testid={`docs-${d.kind}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <DraftTag>
          {isSection
            ? 'Section draft'
            : isSelection
              ? (SELECTION_TAG[String(d.payload.action)] ?? 'Summary of the selection')
              : 'Summary draft'}
        </DraftTag>
        <span className="ai-muted">
          {isSection
            ? `generated from ${d.payload.ticket?.id} ${d.payload.ticket?.title ?? ''}`
            : isSelection
              ? `from ${String(d.payload.selected ?? '').slice(0, 40)}…`
              : `from this page · ${d.payload.sections ?? 0} sections`}
        </span>
        <span style={{ flex: 1 }} />
        <CostChip cost={d.cost} metered={d.cost > 0} />
      </div>
      {isSection && <div style={{ fontWeight: 700, fontSize: 15 }}>{d.payload.heading}</div>}
      {editing ? (
        <textarea className="ai-textarea" rows={5} value={text} onChange={(e) => setText(e.target.value)} />
      ) : (
        <div style={{ fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{text}</div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {d.kind === 'doc_summary' && (
          <button
            type="button"
            className="ai-btn ai-btn-primary ai-btn-sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                insertAt(ed.getEditor(), 'top', text.trim());
                await used({ where: 'top' });
              })
            }
          >
            Insert at top
          </button>
        )}
        {isSection && (
          <button
            type="button"
            className="ai-btn ai-btn-primary ai-btn-sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                insertAt(ed.getEditor(), 'cursor', `## ${d.payload.heading}\n\n${text.trim()}`);
                await used({ where: 'cursor' });
              })
            }
          >
            Insert below the cursor
          </button>
        )}
        {isSelection && d.payload.action === 'rewrite' && (
          <button
            type="button"
            className="ai-btn ai-btn-primary ai-btn-sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                insertAt(ed.getEditor(), 'selection', text);
                await used({ where: 'selection' });
              })
            }
          >
            Replace selection
          </button>
        )}
        {isSelection && d.payload.action !== 'rewrite' && (
          <button
            type="button"
            className="ai-btn ai-btn-primary ai-btn-sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                insertAt(ed.getEditor(), 'cursor', text.trim());
                await used({ where: 'cursor' });
              })
            }
          >
            Insert below
          </button>
        )}
        {(isSection || isSelection) && (
          <button type="button" className="ai-btn ai-btn-sm" onClick={() => setEditing((v) => !v)}>
            {editing ? 'Done' : 'Edit'}
          </button>
        )}
        <button type="button" className="ai-btn ai-btn-sm" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="ai-link" onClick={() => void discard()}>
          Discard
        </button>
      </div>
      {error && <div className="ai-error-text">{error}</div>}
    </div>
  );
}

/** Docs AI (G): the Ask AI menu and the dashed drafts that stay outside the page until inserted. */
export function DocsAi({
  projectId,
  pageId,
  pageTitle,
  menuOpen,
  setMenuOpen,
  ed,
  hidden,
  command,
  onCreateTickets,
}: {
  projectId: string;
  pageId: string;
  pageTitle: string;
  menuOpen: boolean;
  setMenuOpen: (v: boolean) => void;
  ed: DocsAiEditor;
  /** The page is hidden from AI: the Docs-only rows are not offered. */
  hidden?: boolean;
  /** A row of the `/ai` slash menu that was picked (run once per `n`). */
  command?: { id: AiSlashId; n: number } | null;
  /** Create tickets from a list or the page (the editor screen opens the dialog). */
  onCreateTickets?: (text: string) => void;
}) {
  const ctx = useAssist();
  const st = useAssistState(projectId);
  const docsAi = useDocsAiState(projectId);
  const gate = aiGate(docsAi.data, { hidden: !!hidden });
  const docsOn = gate.show && gate.reason === null;
  const drafts = useDocDrafts(projectId, pageId);
  const [ticketPick, setTicketPick] = useState(false);
  const [ticketId, setTicketId] = useState('');
  const [checking, setChecking] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const block = featureBlock(st.data, 'docs');
  const start = async (kind: 'doc_summary' | 'doc_section' | 'doc_links', data: Record<string, unknown> = {}) => {
    setMenuOpen(false);
    setError(null);
    try {
      await assistApi.startDraft(projectId, {
        kind,
        docId: pageId,
        data: { markdown: cleanEditorMarkdown(ed.getMarkdown()), ...data },
      });
      await drafts.refetch();
    } catch (e) {
      setError(assistError(e)?.detail ?? extractError(e));
    }
  };
  const fromCursor = async (action: 'table' | 'explain_code', text: string | null, missing: string) => {
    setMenuOpen(false);
    setError(null);
    if (!text?.trim()) return setError(missing);
    try {
      await startSelectionDraft(projectId, pageId, action, text);
      await drafts.refetch();
    } catch (e) {
      setError(assistError(e)?.detail ?? extractError(e));
    }
  };
  /** Run a row of the AI menu or of `/ai`. */
  const runRow = (id: AiSlashId) => {
    const editor = ed.getEditor();
    switch (id) {
      case 'ask':
        setMenuOpen(true);
        break;
      case 'section':
        setMenuOpen(false);
        setTicketPick(true);
        break;
      case 'links':
        void start('doc_links');
        break;
      case 'summary':
        void start('doc_summary');
        break;
      case 'table':
        void fromCursor('table', listAtCursor(editor), 'Put the cursor in a list (or select it) first.');
        break;
      case 'explain_code':
        void fromCursor('explain_code', codeAtCursor(editor), 'Put the cursor in a code block first.');
        break;
      case 'diagram':
        setMenuOpen(false);
        setError(null);
        setDrawing(true);
        break;
      case 'tickets':
        setMenuOpen(false);
        onCreateTickets?.(listAtCursor(editor) ?? '');
        break;
      case 'check':
        setMenuOpen(false);
        setChecking(true);
        break;
    }
  };
  const runRowRef = useRef(runRow);
  runRowRef.current = runRow;
  useEffect(() => {
    if (command) runRowRef.current(command.id);
  }, [command]);
  const open = (drafts.data ?? []).filter((d) => ['pending', 'open', 'failed'].includes(d.status));
  return (
    <div
      className="ai-root"
      style={{ display: 'flex', flexDirection: 'column', gap: 10, position: 'relative' }}
      data-testid="docs-ai"
    >
      {menuOpen && (
        <div
          className="as-menu"
          style={{ position: 'relative', alignSelf: 'flex-end', width: 300 }}
          role="menu"
          data-testid="docs-ai-menu"
        >
          {block && (
            <div className="ai-hint" style={{ padding: 8 }}>
              {block.reason}
            </div>
          )}
          {!docsOn && (
            <button type="button" disabled={!!block} onClick={() => void start('doc_summary')}>
              Summarise this page
            </button>
          )}
          <button type="button" disabled={!!block} onClick={() => setTicketPick(true)}>
            Draft a section from a ticket…
          </button>
          <button type="button" disabled={!!block} onClick={() => void start('doc_links')}>
            Suggest [[ ]] links
          </button>
          <button
            type="button"
            disabled={!!featureBlock(st.data, 'chat') && !!block}
            onClick={() => {
              setMenuOpen(false);
              ctx?.ask({ scope: 'doc', docId: pageId });
            }}
          >
            Ask this page
          </button>
          {docsOn && (
            <>
              <div
                style={{
                  padding: '8px 10px 2px',
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  color: '#6B5BD2',
                }}
              >
                DOCS ONLY
              </div>
              {(
                [
                  ['summary', 'Summary at the top', 'A short summary block, as a draft'],
                  ['table', 'Table from this list', 'Turns the list above into a table'],
                  ['explain_code', 'Explain this code block', 'Plain-language notes under the code'],
                  ['diagram', 'Draw a diagram', 'From this section, as an editable draw.io diagram'],
                  ['tickets', 'Create tickets from this list', 'Drafts to review first'],
                  ['check', 'Check this page', 'Unclear text, gaps, broken or unknown references'],
                ] as [AiSlashId, string, string][]
              ).map(([id, title, hint]) => (
                <button
                  key={id}
                  type="button"
                  data-testid={`docs-only-${id}`}
                  disabled={id !== 'check' && id !== 'diagram' && !!block}
                  onClick={() => runRow(id)}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}
                >
                  <span>{title}</span>
                  <span className="ai-hint" style={{ fontWeight: 400 }}>
                    {hint}
                  </span>
                </button>
              ))}
            </>
          )}
          <button type="button" onClick={() => setMenuOpen(false)} style={{ color: '#9AA8A0' }}>
            Close
          </button>
        </div>
      )}
      {ticketPick && (
        <div className="as-tile" style={{ flexDirection: 'row', alignItems: 'center' }}>
          <span className="ai-hint">Ticket</span>
          <input
            className="ai-input"
            placeholder="KAN-154"
            value={ticketId}
            autoFocus
            onChange={(e) => setTicketId(e.target.value.toUpperCase())}
            style={{ width: 140 }}
          />
          <button
            type="button"
            className="ai-btn ai-btn-primary ai-btn-sm"
            disabled={!ticketId.trim()}
            onClick={() => {
              setTicketPick(false);
              void start('doc_section', { ticketId: ticketId.trim() });
            }}
          >
            Draft section
          </button>
          <button type="button" className="ai-link" onClick={() => setTicketPick(false)}>
            Cancel
          </button>
        </div>
      )}
      {error && <div className="ai-notice ai-notice-error">{error}</div>}
      {drawing && docsOn && (
        <DrawDiagram
          pageId={pageId}
          getEditor={ed.getEditor}
          getMarkdown={ed.getMarkdown}
          onClose={() => setDrawing(false)}
        />
      )}
      {checking && docsOn && (
        <CheckThisPage
          pageId={pageId}
          getMarkdown={ed.getMarkdown}
          setMarkdown={ed.setMarkdown}
          onClose={() => setChecking(false)}
        />
      )}
      {open.map((d) => (
        <DraftBlock key={`${d.id}-${d.status}`} d={d} ed={ed} onDone={() => void drafts.refetch()} />
      ))}
      {open.length > 0 && (
        <div className="ai-muted">Dashed blocks stay outside “{pageTitle}” until you insert them.</div>
      )}
    </div>
  );
}

/** Start a selection action (Summarise / Rewrite / Ask AI…) as a doc draft. */
export async function startSelectionDraft(
  projectId: string,
  pageId: string,
  action: 'summarise' | 'rewrite' | 'ask' | 'table' | 'explain_code',
  text: string,
  question?: string,
) {
  return assistApi.startDraft(projectId, { kind: 'doc_text', docId: pageId, data: { action, text, question } });
}
