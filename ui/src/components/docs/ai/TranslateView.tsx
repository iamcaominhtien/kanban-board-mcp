import { usePageJob, type TranslateResult } from '../../../api/docsAiPage';
import { moneyLabel, problemLine, readsOf } from '../../../utils/pageAiRules';
import { Icon } from '../Icon';
import type { PageAiView } from './usePageAiView';
import './pageAi.css';

/** The translated Markdown to show instead of the page, or null while there is none (or the original is shown). */
export function useTranslatedMarkdown(view: PageAiView): string | null {
  const { result } = usePageJob<TranslateResult>(view.translate?.jobId);
  return view.translate && result && !view.showOriginal ? result.markdown : null;
}

/**
 * "Translate view": the banner above the page while a translation is shown (docs-ai E3). The page itself is not
 * changed; Show original switches the view off. A long page is read by section, and the banner offers the rest.
 */
export function TranslateBanner({ view, markdown }: { view: PageAiView; markdown: string }) {
  const t = view.translate;
  const { running, result, error } = usePageJob<TranslateResult>(t?.jobId);
  if (!t) return null;
  const fail = t.problem ?? error;
  const waiting = !fail && (!t.jobId || running);
  const key = readsOf(markdown).tickets[0];
  return (
    <div data-testid="translate-banner" style={{ margin: '0 0 14px' }}>
      <div className="pai-banner" role="status">
        <Icon name="i47" size={16} strokeWidth={1.9} style={{ color: '#6b5bd2', flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {waiting && <span>Translating into {t.language}…</span>}
          {fail && (
            <span className="pai-err" role="alert">
              {problemLine(fail.code, fail.detail)}
            </span>
          )}
          {result && !view.showOriginal && (
            <span>
              Showing a <b>{result.language}</b> translation by AI. The page is not changed.
              <span className="pai-foot" style={{ display: 'block' }}>
                Code, links and ticket keys{key ? ` such as ${key}` : ''} stay as they are.{' '}
                {moneyLabel(result.cost, result.metered)}
                {result.keptOriginalBlocks > 0
                  ? ` · ${result.keptOriginalBlocks} ${result.keptOriginalBlocks === 1 ? 'paragraph was' : 'paragraphs were'} left as written so nothing in them changed.`
                  : ''}
              </span>
            </span>
          )}
          {result && view.showOriginal && <span>Showing the original page.</span>}
        </div>
        {result && (
          <button
            type="button"
            className="pai-link"
            data-testid="translate-toggle"
            onClick={() => view.setShowOriginal(!view.showOriginal)}
          >
            {view.showOriginal ? 'Show translation' : 'Show original'}
          </button>
        )}
        {(waiting || fail) && (
          <button type="button" className="pai-link" onClick={view.stopTranslate}>
            {waiting ? 'Cancel' : 'Close'}
          </button>
        )}
      </div>
      {result?.tooLong && result.sections && (
        <div className="pai-banner" style={{ marginTop: -6, background: '#faf9ff' }} data-testid="translate-too-long">
          <div style={{ flex: 1 }}>
            <b>
              I read the first {result.tooLong.readSections} of {result.tooLong.totalSections} sections
            </b>
            <div className="pai-foot">
              The page is longer than one request can hold. Pick a section to translate it.
            </div>
          </div>
          <select
            aria-label="Choose a section"
            defaultValue=""
            onChange={(e) => e.target.value && view.translateTo(t.language, e.target.value)}
            style={{ maxWidth: 200, padding: '6px 8px', borderRadius: 8, border: '1px solid #d9d2f6' }}
          >
            <option value="" disabled>
              Choose a section
            </option>
            {result.sections.map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.title}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
