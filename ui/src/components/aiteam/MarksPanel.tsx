import { useState } from 'react';
import { useAiOverview } from '../../api/ai';
import { useEvalMarks, useEvalSuites, useRunEval } from '../../api/aiEvals';
import { extractError } from '../../api/extractError';
import { LoadError, ago } from '../ai/aiUi';
import '../ai/ai.css';
import { SUITE_COPY, Trend, pctOf, scoreColor, trendOf } from './marksParts';

const COLS = '170px minmax(160px, 1fr) minmax(160px, 260px) 110px 100px 130px';
const note = { fontSize: 12.5, lineHeight: 1.6 } as const;
const noteCard = {
  flex: '1 1 300px',
  border: '1px solid #E3E8E5',
  borderRadius: 10,
  background: '#FBFCFB',
  padding: '12px 14px',
} as const;

/** Marking the team against fixed suites (design/screens/ai-board-wave3.md, K). */
export function MarksPanel({ projectId }: { projectId: string }) {
  const suites = useEvalSuites();
  const marks = useEvalMarks();
  const overview = useAiOverview(projectId);
  const run = useRunEval();
  const [memberId, setMemberId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const members = (overview.data?.members ?? []).filter((m) => m.kind === 'ai');
  const chosen = members.find((m) => m.id === memberId) ?? members[0];
  const light = (m: string | null | undefined) => !!m && /haiku|mini|flash|lite/i.test(m);
  const all = marks.data ?? [];

  const start = async (suite: string) => {
    if (!chosen) return;
    setError(null);
    try {
      await run.mutateAsync({ suite, memberId: chosen.id });
    } catch (e) {
      setError(extractError(e));
    }
  };

  return (
    <section
      data-testid="marks-panel"
      data-project={projectId}
      style={{ display: 'flex', flexDirection: 'column', gap: 10, margin: '14px 0' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800 }}>Marking the AI team</h2>
        <span className="ai-chip" style={{ background: '#EFE8FB', color: '#5B3AA6' }}>
          Sandbox project
        </span>
        <span style={{ flex: 1 }} />
        <label className="ai-hint" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          Run with
          <select
            className="ai-select"
            aria-label="Member to mark"
            value={chosen?.id ?? ''}
            onChange={(e) => setMemberId(e.target.value)}
            style={{ width: 'auto' }}
            disabled={!members.length}
          >
            {members.length === 0 && <option value="">No AI member</option>}
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.model ? ` (${m.model})` : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div style={{ ...note, maxWidth: 1000 }}>
        Run against a fixed sandbox project with a sample repository whose bugs are known. Use a light model, which is
        cheap; run the model you actually use now and then, because a light model’s score measures the light model.
        {chosen && !light(chosen.model) && (
          <b data-testid="marks-light-hint">
            {' '}
            {chosen.name} runs on {chosen.model ?? 'its default model'}; a light model such as haiku keeps a mark cheap.
          </b>
        )}
      </div>
      {(suites.error || marks.error) && (
        <LoadError
          what="the marks"
          error={suites.error ?? marks.error}
          onRetry={() => {
            void suites.refetch();
            void marks.refetch();
          }}
        />
      )}
      {error && (
        <div className="ai-notice ai-notice-error" role="alert">
          {error}
        </div>
      )}
      {suites.isLoading || marks.isLoading ? (
        <div className="ai-skel" style={{ height: 120 }} aria-busy="true" aria-label="Loading" />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: 820, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div
              className="ai-muted"
              style={{
                display: 'grid',
                gridTemplateColumns: COLS,
                gap: 14,
                padding: '0 15px 2px',
                textTransform: 'uppercase',
                fontWeight: 700,
                letterSpacing: '0.06em',
                fontSize: 10.5,
              }}
            >
              <div>Suite</div>
              <div>What it checks</div>
              <div>How it is scored</div>
              <div>Last</div>
              <div>8 weeks</div>
              <div />
            </div>
            {(suites.data ?? []).map((s) => {
              const copy = SUITE_COPY[s.key];
              const mine = all.filter((m) => m.suite === s.key).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
              const running = mine.find((m) => m.state === 'running');
              const last = mine.find((m) => m.state === 'done');
              const showing = open === s.key ? (running ?? last) : undefined;
              return (
                <div
                  key={s.key}
                  data-testid="mark-row"
                  data-suite={s.key}
                  style={{ border: '1px solid #E3E8E5', borderRadius: 10, background: '#fff', padding: '11px 15px' }}
                >
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: COLS,
                      gap: 14,
                      alignItems: 'center',
                      fontSize: 12.5,
                    }}
                  >
                    <div style={{ fontWeight: 700, fontSize: 13 }}>
                      {copy?.name ?? s.name}
                      <div className="ai-muted" style={{ fontWeight: 500 }}>
                        {s.tasks} {s.tasks === 1 ? 'task' : 'tasks'}
                      </div>
                    </div>
                    <div style={{ color: '#5B6B60', lineHeight: 1.5 }}>{copy?.checks ?? ''}</div>
                    <div style={{ lineHeight: 1.5 }}>{copy?.scored ?? ''}</div>
                    <div>
                      {running ? (
                        <span className="ai-hint" data-testid="mark-running">
                          Running…
                        </span>
                      ) : last ? (
                        <div>
                          <div style={{ fontSize: 18, fontWeight: 800, color: scoreColor(last.score) }}>
                            {pctOf(last.score)}
                          </div>
                          <div className="ai-muted">{ago(last.endedAt ?? last.createdAt)}</div>
                        </div>
                      ) : (
                        <span className="ai-hint" data-testid="mark-never">
                          Never run
                        </span>
                      )}
                    </div>
                    <div>
                      <Trend marks={trendOf(all, s.key)} />
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      {s.runnable ? (
                        <button
                          type="button"
                          className="ai-btn ai-btn-sm"
                          disabled={!!running || run.isPending || !chosen}
                          aria-label={`Run ${copy?.name ?? s.name}`}
                          onClick={() => void start(s.key)}
                        >
                          {last || running ? 'Run again' : 'Run'}
                        </button>
                      ) : (
                        <span
                          className="ai-muted"
                          title="Needs a sample repository or a fault injector, not runnable from here yet"
                        >
                          Not runnable yet
                        </span>
                      )}
                      {(last || running) && (
                        <button
                          type="button"
                          className="ai-link"
                          aria-expanded={open === s.key}
                          onClick={() => setOpen(open === s.key ? null : s.key)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                        >
                          Details
                        </button>
                      )}
                    </div>
                  </div>
                  {showing && (
                    <div
                      data-testid="mark-details"
                      style={{ marginTop: 8, borderTop: '1px solid #EEF3EF', paddingTop: 8, fontSize: 12 }}
                    >
                      <div className="ai-muted">
                        {showing.model ?? 'model not recorded'} ·{' '}
                        {showing.state === 'running' ? 'running' : `finished ${ago(showing.endedAt)}`}
                      </div>
                      {showing.details.length === 0 ? (
                        <div className="ai-hint">No task has finished yet.</div>
                      ) : (
                        showing.details.map((d) => (
                          <div key={d.task} style={{ display: 'flex', gap: 10, padding: '3px 0' }}>
                            <b style={{ color: scoreColor(d.score), minWidth: 40 }}>{pctOf(d.score)}</b>
                            <span style={{ flex: 1 }}>
                              {d.task}
                              {d.notes ? <span className="ai-muted"> · {d.notes}</span> : null}
                            </span>
                            {d.costUsd != null && <span className="ai-muted">${d.costUsd.toFixed(3)}</span>}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={noteCard}>
          <div style={note}>
            <b>Marks run on a sandbox.</b> A mark is only comparable if the questions do not change. Running these
            against your real project would measure the project, and would also leave litter in it.
          </div>
        </div>
        <div style={noteCard}>
          <div style={note}>
            <b>What a mark is for.</b> Noticing that something got worse — after a plugin update, a persona edit or a
            model change — not for deciding which AI is cleverest. The Health screen already says those numbers measure
            the setup; so do these.
          </div>
        </div>
      </div>
    </section>
  );
}
