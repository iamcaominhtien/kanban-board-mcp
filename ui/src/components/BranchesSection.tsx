import { useState } from 'react';
import type { TicketBranch, BranchStatus } from '../types';
import { useTicketBranches, useUpdateBranch } from '../api/tickets';
import { CreateBranchModal } from './CreateBranchModal';
import styles from './BranchesSection.module.css';

interface BranchesSectionProps {
  ticketId: string;
  readOnly?: boolean;
}

const STATUS_CONFIG: Record<
  BranchStatus,
  { label: string; dot: string; color: string; bg: string }
> = {
  baseline: {
    label: 'Baseline',
    dot: '#2E6F40',
    color: '#2E6F40',
    bg: 'rgba(46,111,64,0.12)',
  },
  open: {
    label: 'Open',
    dot: '#6D5DD3',
    color: '#6D5DD3',
    bg: 'rgba(109,93,211,0.14)',
  },
  merged: {
    label: 'Merged',
    dot: '#2F6FB0',
    color: '#2E6F40',
    bg: 'rgba(46,111,64,0.12)',
  },
  stale: {
    label: 'Stale',
    dot: '#C4432A',
    color: '#C4432A',
    bg: 'rgba(196,67,42,0.1)',
  },
  archived: {
    label: 'Archived',
    dot: '#9AA8A0',
    color: '#9AA8A0',
    bg: '#F6FAF7',
  },
};

function formatDate(iso?: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function BranchesSection({ ticketId, readOnly = false }: BranchesSectionProps) {
  const [activeTab, setActiveTab] = useState<'graph' | 'list'>('graph');
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

  const { data: branches = [], isLoading } = useTicketBranches(ticketId);
  const updateBranchMutation = useUpdateBranch();

  function handleStatusChange(branch: TicketBranch, nextStatus: BranchStatus) {
    updateBranchMutation.mutate({
      ticketId,
      branchId: branch.id,
      data: { status: nextStatus },
    });
  }

  if (isLoading) {
    return <div className={styles.emptyState}>Loading branches...</div>;
  }

  // Ensure default main/baseline is present in list if empty
  const allBranches: TicketBranch[] = branches.length > 0 ? branches : [
    {
      id: 'baseline-main',
      name: 'main',
      status: 'baseline',
      branchFrom: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      aheadCount: 0,
      behindCount: 0,
    },
  ];

  return (
    <div className={styles.container}>
      {/* Top Bar: Tabs & Create Button */}
      <div className={styles.topBar}>
        <div className={styles.tabs}>
          <button
            type="button"
            className={`${styles.tab} ${activeTab === 'graph' ? styles.tabActive : ''}`}
            onClick={() => setActiveTab('graph')}
          >
            Graph
          </button>
          <button
            type="button"
            className={`${styles.tab} ${activeTab === 'list' ? styles.tabActive : ''}`}
            onClick={() => setActiveTab('list')}
          >
            List
          </button>
        </div>

        {!readOnly && (
          <button
            type="button"
            className={styles.brAddBtn}
            onClick={() => setIsCreateModalOpen(true)}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M12 5V19" /><path d="M5 12H19" />
            </svg>
            Create branch
          </button>
        )}
      </div>

      {/* Graph Tab */}
      {activeTab === 'graph' && (
        <div className={styles.graphCard}>
          <svg width="100%" height="240" viewBox="0 0 920 240" style={{ overflow: 'visible' }}>
            {/* Lane Labels */}
            <text x="10" y="84" fontFamily="JetBrains Mono, monospace" fontSize="11" fill="#2E6F40" fontWeight="600">
              main (baseline)
            </text>
            <text x="10" y="164" fontFamily="JetBrains Mono, monospace" fontSize="11" fill="#6D5DD3" fontWeight="600">
              feature branches
            </text>

            {/* Main Baseline Track */}
            <path d="M160 80 L840 80" stroke="#2E6F40" strokeWidth="3" fill="none" strokeLinecap="round" />

            {/* Fork to Feature branch */}
            <path
              d="M300 80 C340 80 340 160 380 160 L680 160"
              stroke="#6D5DD3"
              strokeWidth="2.5"
              fill="none"
              strokeLinecap="round"
            />

            {/* Merge back line */}
            <path
              d="M680 160 C720 160 720 80 760 80"
              stroke="#2F6FB0"
              strokeWidth="2.5"
              fill="none"
              strokeLinecap="round"
              strokeDasharray="4 4"
            />

            {/* Main Baseline Nodes */}
            <circle cx="200" cy="80" r="7" fill="#2E6F40" />
            <text x="200" y="106" fontFamily="JetBrains Mono, monospace" fontSize="10.5" fill="#5B6B60" textAnchor="middle">
              {ticketId}
            </text>

            <circle cx="760" cy="80" r="8" fill="#2E6F40" />
            <path d="M756 80 L759 83 L765 76" stroke="#FFFFFF" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            <text x="760" y="106" fontFamily="JetBrains Mono, monospace" fontSize="10.5" fill="#5B6B60" textAnchor="middle">
              merge
            </text>

            <circle cx="840" cy="80" r="7" fill="#2E6F40" />
            <text x="840" y="106" fontFamily="JetBrains Mono, monospace" fontSize="10.5" fill="#1E2A22" fontWeight="600" textAnchor="middle">
              HEAD
            </text>

            {/* Feature Branch Nodes */}
            <circle cx="480" cy="160" r="6" fill="#6D5DD3" stroke="#1E2A22" strokeWidth="1.5" />
            <text x="480" y="186" fontFamily="JetBrains Mono, monospace" fontSize="10.5" fill="#1E2A22" fontWeight="600" textAnchor="middle">
              {ticketId} work
            </text>

            <circle cx="680" cy="160" r="7" fill="none" stroke="#6D5DD3" strokeWidth="2" />
            <text x="680" y="186" fontFamily="JetBrains Mono, monospace" fontSize="10.5" fill="#6D5DD3" fontWeight="600" textAnchor="middle">
              open branch
            </text>
          </svg>
        </div>
      )}

      {/* List Tab */}
      {activeTab === 'list' && (
        <div className={styles.tableCard}>
          <div className={styles.tableHeader}>
            <span style={{ width: 8, flexShrink: 0 }} />
            <span style={{ width: 190, flexShrink: 0 }}>Branch</span>
            <span style={{ flexGrow: 1 }}>Origin / Ahead-Behind</span>
            <span style={{ width: 70, flexShrink: 0 }}>Created</span>
            <span style={{ width: 80, flexShrink: 0 }}>Status</span>
            <span style={{ width: 65, flexShrink: 0 }} />
          </div>

          {allBranches.map((br) => {
            const cfg = STATUS_CONFIG[br.status] || STATUS_CONFIG.open;
            return (
              <div key={br.id} className={styles.brRow}>
                <span className={styles.statusDot} style={{ background: cfg.dot }} />
                <span className={styles.branchName} title={br.name}>
                  {br.name}
                </span>

                <span className={styles.branchMeta}>
                  {br.status === 'baseline' ? (
                    'baseline'
                  ) : (
                    <>
                      from <span className={styles.metaMono}>{br.branchFrom || 'main'}</span>
                      {br.aheadCount !== undefined && ` · ${br.aheadCount} ahead, ${br.behindCount ?? 0} behind`}
                    </>
                  )}
                </span>

                <span className={styles.dateCol}>{formatDate(br.createdAt)}</span>

                <span className={styles.statusCol}>
                  <span className={styles.brStatus} style={{ background: cfg.bg, color: cfg.color }}>
                    {cfg.label}
                  </span>
                </span>

                <span className={styles.actionCol}>
                  {!readOnly && br.status === 'open' && (
                    <button
                      type="button"
                      className={styles.actionBtn}
                      onClick={() => handleStatusChange(br, 'merged')}
                    >
                      Merge
                    </button>
                  )}
                  {!readOnly && br.status === 'stale' && (
                    <button
                      type="button"
                      className={styles.actionBtn}
                      onClick={() => handleStatusChange(br, 'archived')}
                    >
                      Archive
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {activeTab === 'list' && !readOnly && (
        <button
          type="button"
          className={styles.brAddBtn}
          onClick={() => setIsCreateModalOpen(true)}
          style={{ alignSelf: 'flex-start' }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5V19" /><path d="M5 12H19" />
          </svg>
          Create branch
        </button>
      )}

      <CreateBranchModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        ticketId={ticketId}
        branches={allBranches}
        initialBranchFrom="main"
      />
    </div>
  );
}
