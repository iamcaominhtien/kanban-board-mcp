import { useCallback, useEffect, useState } from 'react';
import { usePageAiStart, pageAiProblem } from '../../../api/docsAiPage';

export interface ExplainAsk {
  jobId: string | null;
  selection: string;
  rect: { left: number; right: number; top: number; bottom: number };
  /** The request itself failed (the job never started). */
  problem: { code: string; detail: string } | null;
}

export interface TranslateAsk {
  jobId: string | null;
  language: string;
  section?: string;
  problem: { code: string; detail: string } | null;
}

/**
 * What the reader helpers show for one page: a summary block above it, an explanation card by the selection and a
 * translated view. All of it is view state: the page is never changed, and it resets when another page opens.
 */
export function usePageAiView(pageId: string) {
  const start = usePageAiStart(pageId);
  const [summary, setSummary] = useState<{
    jobId: string | null;
    of: 'page' | 'selection';
    problem: { code: string; detail: string } | null;
  } | null>(null);
  const [explain, setExplain] = useState<ExplainAsk | null>(null);
  const [translate, setTranslate] = useState<TranslateAsk | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);

  useEffect(() => {
    setSummary(null);
    setExplain(null);
    setTranslate(null);
    setShowOriginal(false);
  }, [pageId]);

  const summarise = useCallback(
    (selection?: string) => {
      const of = selection ? 'selection' : 'page';
      setSummary({ jobId: null, of, problem: null });
      start.summary.mutate(selection, {
        onSuccess: (job) => setSummary({ jobId: job.id, of, problem: null }),
        onError: (e) => setSummary({ jobId: null, of, problem: pageAiProblem(e) }),
      });
    },
    [start.summary],
  );

  const explainSelection = useCallback(
    (selection: string, rect: ExplainAsk['rect'], section?: string | null) => {
      setExplain({ jobId: null, selection, rect, problem: null });
      start.explain.mutate(
        { selection, section: section ?? undefined },
        {
          onSuccess: (job) => setExplain({ jobId: job.id, selection, rect, problem: null }),
          onError: (e) => setExplain({ jobId: null, selection, rect, problem: pageAiProblem(e) }),
        },
      );
    },
    [start.explain],
  );

  const translateTo = useCallback(
    (language: string, section?: string) => {
      setShowOriginal(false);
      setTranslate({ jobId: null, language, section, problem: null });
      start.translate.mutate(
        { language, section },
        {
          onSuccess: (job) => setTranslate({ jobId: job.id, language, section, problem: null }),
          onError: (e) => setTranslate({ jobId: null, language, section, problem: pageAiProblem(e) }),
        },
      );
    },
    [start.translate],
  );

  return {
    summary,
    hideSummary: () => setSummary(null),
    summarise,
    explain,
    closeExplain: () => setExplain(null),
    explainSelection,
    translate,
    translateTo,
    showOriginal,
    setShowOriginal,
    stopTranslate: () => setTranslate(null),
  };
}

export type PageAiView = ReturnType<typeof usePageAiView>;
