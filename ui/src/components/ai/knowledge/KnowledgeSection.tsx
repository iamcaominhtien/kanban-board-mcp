import { useState } from 'react';
import { useKnowledge } from '../../../api/aiKnowledge';
import { LoadError } from '../aiUi';
import { InstructionsPanel } from './InstructionsPanel';
import { KnowledgeBasePanel } from './KnowledgeBasePanel';
import { MemoryPanel } from './MemoryPanel';
import { TokenMeter } from './TokenMeter';

type Tab = 'instructions' | 'memory' | 'kb';

/** Project knowledge (design/screens/ai-operations.md, H): instructions for every AI and the lessons they learned. */
export function KnowledgeSection({ projectId }: { projectId: string }) {
  const q = useKnowledge(projectId);
  const [tab, setTab] = useState<Tab>('instructions');

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
          Memory
          <span className="ai-tab-count" data-testid="memory-count">
            {data.lessons.length}
          </span>
          {proposals > 0 && <span className="sr-only">{proposals} waiting for you</span>}
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
