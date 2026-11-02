import { useWorkflowMetrics, useWorkflowNames } from '../../api/aiWorkflowBoard';
import { buildMetricRows, MIN_TICKETS_FOR_VERDICT, type MetricVerdict } from './workflowMetricsRows';

const VERDICT_COLOR: Record<NonNullable<MetricVerdict>, string> = { good: '#1F5A31', watch: '#7A5A06', fix: '#C4432A' };
const VERDICT_LABEL: Record<NonNullable<MetricVerdict>, string> = { good: 'good', watch: 'watch', fix: 'fix' };

/** Measuring the process, not the AI (design/screens/ai-team-process.md, L): the measures per workflow template. */
export function WorkflowMetrics({ projectId }: { projectId: string }) {
  const metrics = useWorkflowMetrics(projectId, 30);
  const names = useWorkflowNames(projectId);
  const rows = buildMetricRows(metrics.data ?? [], names.data ?? []);

  if (metrics.isLoading)
    return (
      <div data-testid="workflow-metrics" className="at-hint-sm">
        Loading the workflow measures…
      </div>
    );
  if (metrics.isError) {
    return (
      <div data-testid="workflow-metrics" className="at-hint-sm">
        The workflow measures could not be read.
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div data-testid="workflow-metrics" className="at-hint-sm">
        No ticket has run on a workflow in the last 30 days, so there is nothing to compare yet. A ticket done by hand
        is not in these numbers.
      </div>
    );
  }

  return (
    <section
      data-testid="workflow-metrics"
      style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}
    >
      <div className="at-label">Each workflow, over 30 days</div>
      <div className="at-measures">
        {rows.map((r) => (
          <div className="at-measure" key={r.key} data-testid={`workflow-metric-${r.key}`}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="at-label" style={{ flex: 1, fontSize: 11 }}>
                {r.name}
              </span>
              {r.verdict && (
                <span style={{ fontSize: 11, fontWeight: 700, color: VERDICT_COLOR[r.verdict] }}>
                  {VERDICT_LABEL[r.verdict]}
                </span>
              )}
            </div>
            <span className="at-measure-n" style={{ color: r.verdict ? VERDICT_COLOR[r.verdict] : '#5B6B60' }}>
              {r.tickets} {r.tickets === 1 ? 'ticket' : 'tickets'}
            </span>
            <div className="at-hint-sm">
              median {r.median} · {r.passedFirst === 'no review' ? 'no review' : `${r.passedFirst} first time`}
              {r.costVsStandard != null && (
                <>
                  {' '}
                  · <b>{r.costVsStandard.toFixed(1)}&times;</b> the quota of a Standard
                </>
              )}
              {r.tickets < MIN_TICKETS_FOR_VERDICT && <> · too few tickets to judge</>}
            </div>
          </div>
        ))}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: '#5B6B60', borderBottom: '1px solid #E3E8E5' }}>
            <th style={{ padding: '6px 8px' }}>Per template</th>
            <th style={{ padding: '6px 8px' }}>Tickets</th>
            <th style={{ padding: '6px 8px' }}>Median time</th>
            <th style={{ padding: '6px 8px' }}>Passed first</th>
            <th style={{ padding: '6px 8px' }}>Rounds of rework</th>
            <th style={{ padding: '6px 8px' }}>Quota per ticket</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} style={{ borderBottom: '1px solid #EEF2EF' }}>
              <td style={{ padding: '6px 8px', fontWeight: 700 }}>{r.name}</td>
              <td style={{ padding: '6px 8px' }}>{r.tickets}</td>
              <td style={{ padding: '6px 8px' }}>{r.median}</td>
              <td style={{ padding: '6px 8px' }}>{r.passedFirst}</td>
              <td style={{ padding: '6px 8px' }}>{r.rounds}</td>
              <td style={{ padding: '6px 8px' }}>{r.cost}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="at-hint-sm">
        These numbers measure the setup, not whether the work was good. No verdict under {MIN_TICKETS_FOR_VERDICT}{' '}
        tickets on a template.
      </div>
    </section>
  );
}
