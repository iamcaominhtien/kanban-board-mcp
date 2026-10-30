import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePageJob, type ExplainResult } from '../../../api/docsAiPage';
import { moneyLabel, problemLine } from '../../../utils/pageAiRules';
import { Icon } from '../Icon';
import type { PageAiView } from './usePageAiView';
import './pageAi.css';

/** "Explain": a small card by the selection with the answer, where it is from and what it cost (docs-ai E2). */
export function ExplainCard({ view }: { view: PageAiView }) {
  const e = view.explain;
  const { running, result, error } = usePageJob<ExplainResult>(e?.jobId);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 8, top: 8 });
  useLayoutEffect(() => {
    if (!e) return;
    const h = ref.current?.offsetHeight ?? 160;
    const left = Math.max(8, Math.min(window.innerWidth - 388, e.rect.left));
    let top = e.rect.bottom + 10;
    if (top + h > window.innerHeight - 8) top = Math.max(8, e.rect.top - h - 10);
    setPos({ left, top });
  }, [e, result, running]);
  const close = view.closeExplain;
  useEffect(() => {
    if (!e) return;
    const onKey = (ev: KeyboardEvent) => ev.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [e, close]);
  if (!e) return null;
  const fail = e.problem ?? error;
  const waiting = !fail && (!e.jobId || running);
  return (
    <div
      ref={ref}
      className="pai-explain"
      style={pos}
      role="dialog"
      aria-label="Explanation by AI"
      data-testid="explain-card"
      data-nocomment
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 }}>
        <span style={{ color: '#6b5bd2' }}>✦</span>Explain
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="dk-icobtn"
          aria-label="Close"
          onClick={close}
          style={{ width: 24, height: 24 }}
        >
          <Icon name="close" size={13} strokeWidth={2} />
        </button>
      </div>
      {waiting && (
        <div aria-live="polite" style={{ display: 'grid', gap: 8 }}>
          <div className="pai-skel" style={{ width: '95%' }} />
          <div className="pai-skel" style={{ width: '80%' }} />
          <div className="pai-skel" style={{ width: '45%' }} />
        </div>
      )}
      {fail && (
        <div className="pai-err" role="alert">
          {problemLine(fail.code, fail.detail)}
        </div>
      )}
      {result && (
        <>
          <div data-testid="explain-text">{result.text}</div>
          <div className="pai-foot">
            From this page · {result.from}
            {result.section ? ` › ${result.section}` : ''} · {moneyLabel(result.cost, result.metered)}
          </div>
        </>
      )}
    </div>
  );
}
