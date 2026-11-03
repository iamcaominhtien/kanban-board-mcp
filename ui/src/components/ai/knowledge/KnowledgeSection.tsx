import { useState } from 'react';
import { useKnowledge } from '../../../api/aiKnowledge';
import type { Knowledge } from '../../../types/aiKnowledge';
import { LoadError } from '../aiUi';
import { InstructionsPanel } from './InstructionsPanel';
import { KnowledgeBasePanel } from './KnowledgeBasePanel';
import { MemoryPanel } from './MemoryPanel';
import { TokenMeter } from './TokenMeter';

type Tab = 'instructions' | 'memory' | 'kb';

/** What in the memory waits for a person: lessons proposed, and lessons or notes flagged as maybe out of date. */
export function memoryWaiting(data: Knowledge): number {
  const proposals = data.lessons.filter((l) => l.state === 'proposed').length;
  return proposals + new Set((data.flags ?? []).map((f) => f.id)).size;
}

/** Project knowledge (design/screens/ai-operations.md, H): instructions for every AI and the lessons they learned. */
export function KnowledgeSection({ projectId, initialTab }: { projectId: string; initialTab?: Tab }) {
  const q = useKnowledge(projectId);
  const [picked, setTab] = useState<Tab | null>(initialTab ?? null);

  if (q.isLoading)
    return (
      <div
        className="ai-skel"
        style={{ height: 120 }}
        aria-busy="true"
        aria-label="Loading"
        data-testid="knowledge-section"
      />
    );
  if (q.error || !q.data)
    return <LoadError what="the project knowledge" error={q.error} onRetry={() => void q.refetch()} />;
  const data = q.data;
  const proposals = data.lessons.filter((l) => l.state === 'proposed').length;
  const waiting = memoryWaiting(data);
  // proposals wait in Memory: open on it while any do, so they are not missed behind the Instructions tab
  const tab: Tab = picked ?? (waiting > 0 ? 'memory' : 'instructions');

  return (
    <div data-testid="knowledge-section" data-project={projectId} style={{ display: 'grid', gap: 10 }}>
      <TokenMeter total={data.totalTokens} budget={data.budget} />
      <div className="ai-tabs" role="tablist" style={{ marginTop: 0 }}>
        <button
          role="tab"
          aria-selected={tab === 'instructions'}
          className={`ai-tab${tab === 'instructions' ? ' ai-tab-active' : ''}`}
          onClick={() => setTab('instructions')}
        >
          Instructions
        </button>
        <button
          role="tab"
          aria-selected={tab === 'memory'}
          className={`ai-tab${tab === 'memory' ? ' ai-tab-active' : ''}`}
          onClick={() => setTab('memory')}
        >
          Memory{' '}
          <span className="ai-tab-count" data-testid="memory-count">
            {data.lessons.filter((l) => l.state === 'kept').length + data.notes.length}
          </span>
          {waiting > 0 && (
            <span
              data-testid="memory-waiting"
              title={`${proposals} proposed lesson${proposals === 1 ? '' : 's'} and ${waiting - proposals} flagged`}
              style={{
                marginLeft: 6,
                background: '#E8821A',
                color: '#fff',
                borderRadius: 999,
                padding: '0 7px',
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {waiting} waiting for you
            </span>
          )}
        </button>
        <button
          role="tab"
          aria-selected={tab === 'kb'}
          className={`ai-tab${tab === 'kb' ? ' ai-tab-active' : ''}`}
          onClick={() => setTab('kb')}
        >
          Knowledge base
        </button>
      </div>
      {tab === 'instructions' ? (
        <InstructionsPanel key={data.updatedAt ?? 'new'} projectId={projectId} data={data} />
      ) : tab === 'kb' ? (
        <KnowledgeBasePanel projectId={projectId} />
      ) : (
        <MemoryPanel projectId={projectId} data={data} />
      )}
    </div>
  );
}
