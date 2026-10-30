import { useEffect, useRef, useState } from 'react';
import { docsAiError } from '../../../api/docsAi';
import { useTidyPreview, type TidyOptionsBody, type TidyResult } from '../../../api/docsAiWrite';
import { tidyHints } from '../../../utils/writeRules';

const OPTIONS: { key: keyof TidyOptionsBody; label: string }[] = [
  { key: 'splitByHeading', label: 'Split into one page per top-level section' },
  { key: 'ticketChips', label: 'Turn ticket keys into chips' },
  { key: 'seeLinks', label: 'Turn “see Auth” into [[links]]' },
  { key: 'headingLevels', label: 'Fix heading levels' },
];

interface Props {
  projectId: string;
  file: File;
  /** The tidied pages to import instead of the file, or null while no option is on. Nothing is imported here. */
  onResult: (r: TidyResult | null) => void;
}

/**
 * "TIDY WHILE IMPORTING (OPTIONAL)" (docs-ai D4): options with their counts. Every option is off until ticked; "see X"
 * links are only added for the ones the person ticks in the review list. Nothing is imported until Import.
 */
export function TidyOptions({ projectId, file, onResult }: Props) {
  const tidy = useTidyPreview(projectId);
  const [opts, setOpts] = useState<TidyOptionsBody>({
    splitByHeading: false,
    ticketChips: false,
    seeLinks: false,
    headingLevels: false,
  });
  const [accept, setAccept] = useState<string[]>([]);
  const [result, setResult] = useState<TidyResult | null>(null);
  const seq = useRef(0);
  const anyOn = Object.values(opts).some(Boolean);

  useEffect(() => {
    const id = ++seq.current;
    void file
      .text()
      .then((markdown) =>
        tidy.mutateAsync({
          markdown,
          filename: file.name,
          options: opts,
          acceptSeeLinks: opts.seeLinks ? accept : [],
        }),
      )
      .then((r) => {
        if (id !== seq.current) return;
        setResult(r);
        onResult(anyOn ? r : null);
      })
      .catch(() => {
        if (id === seq.current) onResult(null);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, opts, accept]);

  const hints = tidyHints(result?.counts ?? null, result?.source.sections ?? null);
  const hintOf: Record<keyof TidyOptionsBody, string> = {
    splitByHeading: hints.splitByHeading,
    ticketChips: hints.ticketChips,
    seeLinks: hints.seeLinks,
    headingLevels: hints.headingLevels,
  };
  const problem = tidy.error ? docsAiError(tidy.error)?.detail : null;
  const candidates = opts.seeLinks ? (result?.seeLinks ?? []) : [];

  return (
    <div data-testid="tidy-options" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: '#5B3FBF' }}>
        TIDY WHILE IMPORTING (OPTIONAL)
      </div>
      {file && result && (
        <div style={{ fontSize: 12, color: '#5B6B60' }}>
          {file.name} · {Math.max(1, Math.round(result.source.bytes / 1024))} KB · {result.source.sections} top-level
          section{result.source.sections === 1 ? '' : 's'}
        </div>
      )}
      {OPTIONS.map((o) => (
        <label key={o.key} style={{ display: 'flex', gap: 9, alignItems: 'flex-start', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={opts[o.key]}
            onChange={(e) => {
              setOpts((cur) => ({ ...cur, [o.key]: e.target.checked }));
              if (o.key === 'seeLinks' && !e.target.checked) setAccept([]);
            }}
            style={{ accentColor: '#2E6F40', marginTop: 3 }}
          />
          <span style={{ fontSize: 13, color: '#1E2A22' }}>
            {o.label}
            <span style={{ display: 'block', fontSize: 11.5, color: '#5B6B60' }}>{hintOf[o.key]}</span>
          </span>
        </label>
      ))}
      {candidates.length > 0 && (
        <div
          data-testid="see-links-review"
          style={{ border: '1px solid #D9CCF7', borderRadius: 9, background: '#F8F5FE', padding: '8px 10px' }}
        >
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#5B3FBF', fontWeight: 700 }}
          >
            Review links
            <button
              type="button"
              className="st-btn st-btn-sm"
              style={{ marginLeft: 'auto' }}
              onClick={() => setAccept(accept.length === candidates.length ? [] : candidates.map((c) => c.id))}
            >
              {accept.length === candidates.length ? 'Add none' : 'Add all'}
            </button>
          </div>
          {candidates.map((c) => (
            <label
              key={c.id}
              style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, padding: '3px 0' }}
            >
              <input
                type="checkbox"
                checked={accept.includes(c.id)}
                onChange={(e) =>
                  setAccept((cur) => (e.target.checked ? [...cur, c.id] : cur.filter((x) => x !== c.id)))
                }
                style={{ accentColor: '#2E6F40' }}
              />
              <span>
                “{c.phrase}” → <b>[[{c.title}]]</b>
                <span style={{ color: '#9AA8A0' }}>
                  {' '}
                  · {c.pageTitle}, line {c.line}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
      <div style={{ fontSize: 12, color: '#5B6B60' }}>
        Nothing is imported until you press Import. The result list shows what changed in each page.
      </div>
      {problem && (
        <div role="alert" style={{ fontSize: 12.5, color: '#C4432A' }}>
          {problem}
        </div>
      )}
    </div>
  );
}
