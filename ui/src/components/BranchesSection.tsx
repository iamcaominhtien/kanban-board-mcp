import { useState } from 'react';
import type { TicketBranch, BranchStatus } from '../types';
import { useTicketBranches, useUpdateBranch, useDeleteBranch, useCheckoutBranch, useTicket } from '../api/tickets';
import { useProject } from '../api/projects';
import { useToast } from './Toast';
import { extractError } from '../api/extractError';
import { CreateBranchModal } from './CreateBranchModal';
import { BranchGraph } from './BranchGraph';
import styles from './BranchesSection.module.css';

interface BranchesSectionProps {
  ticketId: string;
  readOnly?: boolean;
}

const STATUS_CONFIG: Record<BranchStatus, { label: string; dot: string; color: string; bg: string }> = {
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
  const { data: ticket } = useTicket(ticketId);
  const { data: project } = useProject(ticket?.projectId ?? '');
  const updateBranchMutation = useUpdateBranch();
  const deleteBranchMutation = useDeleteBranch();
  const checkoutMutation = useCheckoutBranch();
  const [renameTarget, setRenameTarget] = useState<TicketBranch | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const toast = useToast();

  const [confirmDialog, setConfirmDialog] = useState<{
    action: 'delete' | 'merge' | 'archive';
    branch: TicketBranch;
  } | null>(null);
  const [removeWorktreeChecked, setRemoveWorktreeChecked] = useState(true);
  const [deleteGitBranchChecked, setDeleteGitBranchChecked] = useState(false);
  const [forceDeleteChecked, setForceDeleteChecked] = useState(false);
  const hasRepo = Boolean(ticket?.repoPath || project?.repoPath);

  function handleStatusChange(branch: TicketBranch, nextStatus: BranchStatus) {
    if (branch.worktreePath) {
      setConfirmDialog({
        action: nextStatus === 'merged' ? 'merge' : 'archive',
        branch,
      });
      setRemoveWorktreeChecked(true);
      return;
    }
    updateBranchMutation.mutate(
      {
        ticketId,
        branchId: branch.id,
        data: { status: nextStatus },
      },
      {
        onSuccess: () => {
          toast.success(`Branch marked as ${nextStatus}`);
        },
        onError: (err) => {
          toast.error("Couldn't update branch", extractError(err));
        },
      },
    );
  }

  function handleCheckout(branch: TicketBranch) {
    checkoutMutation.mutate(
      { ticketId, branchId: branch.id },
      {
        onSuccess: () => toast.success(`Checked out ${branch.name}`),
        onError: (err) => toast.error("Couldn't check out branch", extractError(err)),
      },
    );
  }

  async function submitRename() {
    if (!renameTarget) return;
    const next = renameDraft.trim();
    if (!next || next === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    try {
      await updateBranchMutation.mutateAsync({
        ticketId,
        branchId: renameTarget.id,
        data: { name: next },
      });
      toast.success(`Renamed to ${next}`);
      setRenameTarget(null);
    } catch (err) {
      toast.error("Couldn't rename branch", extractError(err));
    }
  }

  function handleDeleteClick(branch: TicketBranch) {
    // With a linked repo the dialog also offers to delete the real git branch
    if (branch.worktreePath || (hasRepo && branch.inRepo !== false && branch.status !== 'baseline')) {
      setConfirmDialog({
        action: 'delete',
        branch,
      });
      setRemoveWorktreeChecked(true);
      setDeleteGitBranchChecked(false);
      setForceDeleteChecked(false);
      return;
    }
    if (window.confirm(`Delete branch "${branch.name}"?`)) {
      deleteBranchMutation.mutate(
        {
          ticketId,
          branchId: branch.id,
        },
        {
          onSuccess: () => {
            toast.success(`Deleted branch ${branch.name}`);
          },
          onError: (err) => {
            toast.error("Couldn't delete branch", extractError(err));
          },
        },
      );
    }
  }

  if (isLoading) {
    return <div className={styles.emptyState}>Loading branches...</div>;
  }

  // Ensure default main/baseline is present in list if empty
  const allBranches: TicketBranch[] =
    branches.length > 0
      ? branches
      : [
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
          <button type="button" className={styles.brAddBtn} onClick={() => setIsCreateModalOpen(true)}>
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
            >
              <path d="M12 5V19" />
              <path d="M5 12H19" />
            </svg>
            Create branch
          </button>
        )}
      </div>

      {/* Graph Tab */}
      {activeTab === 'graph' && <BranchGraph ticketId={ticketId} />}

      {/* List Tab */}
      {activeTab === 'list' && (
        <div className={styles.tableCard}>
          <div className={styles.tableHeader}>
            <span style={{ width: 8, flexShrink: 0 }} />
            <span style={{ width: 170, flexShrink: 0 }}>Branch</span>
            <span style={{ flexGrow: 1 }}>Origin / Ahead-Behind / Worktree</span>
            <span style={{ width: 70, flexShrink: 0 }}>Created</span>
            <span style={{ width: 80, flexShrink: 0 }}>Status</span>
            <span style={{ width: 215, flexShrink: 0 }} />
          </div>

          {allBranches.map((br) => {
            const cfg = STATUS_CONFIG[br.status] || STATUS_CONFIG.open;
            return (
              <div key={br.id} className={styles.brRow}>
                <span className={styles.statusDot} style={{ background: cfg.dot }} />
                <span className={styles.branchName} title={br.name}>
                  {br.name}
                  {br.isCurrent && (
                    <span className={styles.worktreeBadge} style={{ marginLeft: 6 }}>
                      HEAD
                    </span>
                  )}
                </span>

                <div className={styles.branchMeta}>
                  <div>
                    {br.status === 'baseline' ? (
                      'baseline'
                    ) : (
                      <>
                        from <span className={styles.metaMono}>{br.branchFrom || 'main'}</span>
                        {br.aheadCount !== undefined && ` · ${br.aheadCount} ahead, ${br.behindCount ?? 0} behind`}
                      </>
                    )}
                  </div>
                  {br.worktreePath && (
                    <div className={styles.worktreeInfo} title={`Worktree: ${br.worktreePath}`}>
                      <span className={styles.worktreeBadge}>🌳 worktree</span>
                      <span className={styles.worktreePathMono}>{br.worktreePath}</span>
                    </div>
                  )}
                </div>

                <span className={styles.dateCol}>{formatDate(br.createdAt)}</span>

                <span className={styles.statusCol}>
                  <span className={styles.brStatus} style={{ background: cfg.bg, color: cfg.color }}>
                    {cfg.label}
                  </span>
                </span>

                <span className={styles.actionCol}>
                  {!readOnly && hasRepo && br.inRepo && !br.isCurrent && br.status !== 'baseline' && (
                    <button
                      type="button"
                      className={styles.actionBtn}
                      onClick={() => handleCheckout(br)}
                      disabled={checkoutMutation.isPending}
                      title="Check out this branch in the repository"
                    >
                      Checkout
                    </button>
                  )}
                  {!readOnly && br.status !== 'baseline' && (
                    <button
                      type="button"
                      className={styles.actionBtn}
                      onClick={() => {
                        setRenameTarget(br);
                        setRenameDraft(br.name);
                      }}
                      title="Rename branch"
                    >
                      Rename
                    </button>
                  )}
                  {!readOnly && br.status === 'open' && (
                    <button
                      type="button"
                      className={styles.actionBtn}
                      onClick={() => handleStatusChange(br, 'merged')}
                      title={hasRepo ? 'Mark as merged (verified in git)' : 'Mark as merged'}
                    >
                      Merge
                    </button>
                  )}
                  {!readOnly && br.status === 'stale' && (
                    <button
                      type="button"
                      className={styles.actionBtn}
                      onClick={() => handleStatusChange(br, 'archived')}
                      title="Archive branch"
                    >
                      Archive
                    </button>
                  )}
                  {!readOnly && br.status !== 'baseline' && (
                    <button
                      type="button"
                      className={`${styles.actionBtn} ${styles.actionBtnDanger}`}
                      onClick={() => handleDeleteClick(br)}
                      title="Delete branch"
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
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
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M12 5V19" />
            <path d="M5 12H19" />
          </svg>
          Create branch
        </button>
      )}

      {/* Confirmation Dialog for branch actions with worktree */}
      {confirmDialog && (
        <div className={styles.dialogBackdrop} onClick={() => setConfirmDialog(null)}>
          <div className={styles.dialogCard} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h4 className={styles.dialogTitle}>
              {confirmDialog.action === 'delete'
                ? 'Delete branch'
                : confirmDialog.action === 'merge'
                  ? 'Merge branch'
                  : 'Archive branch'}
            </h4>
            <p className={styles.dialogPrompt}>
              {confirmDialog.action === 'delete' ? (
                <>
                  Are you sure you want to delete branch <strong>{confirmDialog.branch.name}</strong>?
                </>
              ) : confirmDialog.action === 'merge' ? (
                <>
                  Mark branch <strong>{confirmDialog.branch.name}</strong> as merged?
                  {hasRepo &&
                    confirmDialog.branch.inRepo !== false &&
                    ' Git must already contain all its commits in the origin branch.'}
                </>
              ) : (
                <>
                  Archive branch <strong>{confirmDialog.branch.name}</strong>?
                </>
              )}
            </p>

            {confirmDialog.branch.worktreePath && (
              <label className={styles.dialogCheckboxLabel}>
                <input
                  type="checkbox"
                  className={styles.dialogCheckbox}
                  checked={removeWorktreeChecked}
                  onChange={(e) => setRemoveWorktreeChecked(e.target.checked)}
                />
                <div className={styles.dialogCheckboxContent}>
                  <span className={styles.dialogCheckboxTitle}>Clean up worktree directory</span>
                  <code className={styles.dialogWorktreePath}>{confirmDialog.branch.worktreePath}</code>
                </div>
              </label>
            )}

            {confirmDialog.action === 'delete' &&
              hasRepo &&
              confirmDialog.branch.inRepo !== false &&
              confirmDialog.branch.status !== 'baseline' && (
                <>
                  <label className={styles.dialogCheckboxLabel}>
                    <input
                      type="checkbox"
                      className={styles.dialogCheckbox}
                      checked={deleteGitBranchChecked}
                      onChange={(e) => setDeleteGitBranchChecked(e.target.checked)}
                    />
                    <div className={styles.dialogCheckboxContent}>
                      <span className={styles.dialogCheckboxTitle}>Also delete the git branch</span>
                      <code className={styles.dialogWorktreePath}>{confirmDialog.branch.name}</code>
                    </div>
                  </label>
                  {deleteGitBranchChecked && (
                    <label className={styles.dialogCheckboxLabel}>
                      <input
                        type="checkbox"
                        className={styles.dialogCheckbox}
                        checked={forceDeleteChecked}
                        onChange={(e) => setForceDeleteChecked(e.target.checked)}
                      />
                      <div className={styles.dialogCheckboxContent}>
                        <span className={styles.dialogCheckboxTitle}>Force delete (discard unmerged commits)</span>
                        <span className={styles.dialogWorktreePath}>
                          Without this, git refuses to delete a branch that is not fully merged.
                        </span>
                      </div>
                    </label>
                  )}
                </>
              )}

            <div className={styles.dialogActions}>
              <button
                type="button"
                className={confirmDialog.action === 'delete' ? styles.dialogBtnDanger : styles.dialogBtnPrimary}
                disabled={deleteBranchMutation.isPending || updateBranchMutation.isPending}
                onClick={async () => {
                  try {
                    if (confirmDialog.action === 'delete') {
                      await deleteBranchMutation.mutateAsync({
                        ticketId,
                        branchId: confirmDialog.branch.id,
                        removeWorktree: Boolean(confirmDialog.branch.worktreePath) && removeWorktreeChecked,
                        deleteGitBranch: deleteGitBranchChecked,
                        force: deleteGitBranchChecked && forceDeleteChecked,
                      });
                      toast.success(
                        deleteGitBranchChecked
                          ? `Deleted branch ${confirmDialog.branch.name} and its git branch`
                          : `Deleted branch ${confirmDialog.branch.name}`,
                      );
                    } else {
                      const nextStatus = confirmDialog.action === 'merge' ? 'merged' : 'archived';
                      await updateBranchMutation.mutateAsync({
                        ticketId,
                        branchId: confirmDialog.branch.id,
                        data: {
                          status: nextStatus,
                          remove_worktree: removeWorktreeChecked,
                        },
                      });
                      toast.success(`Branch marked as ${nextStatus}`);
                    }
                    setConfirmDialog(null);
                  } catch (err) {
                    toast.error(
                      confirmDialog.action === 'delete' ? "Couldn't delete branch" : "Couldn't update branch",
                      extractError(err),
                    );
                  }
                }}
              >
                {deleteBranchMutation.isPending || updateBranchMutation.isPending
                  ? 'Processing...'
                  : confirmDialog.action === 'delete'
                    ? 'Delete branch'
                    : 'Confirm'}
              </button>
              <button type="button" className={styles.dialogBtnCancel} onClick={() => setConfirmDialog(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {renameTarget && (
        <div className={styles.dialogBackdrop} onClick={() => setRenameTarget(null)}>
          <div className={styles.dialogCard} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h4 className={styles.dialogTitle}>Rename branch</h4>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitRename();
              }}
            >
              <input
                type="text"
                className={styles.dialogInput}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  margin: '8px 0 12px',
                  padding: '6px 10px',
                  fontFamily: 'monospace',
                }}
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                autoFocus
                aria-label="New branch name"
              />
              <div className={styles.dialogActions}>
                <button
                  type="submit"
                  className={styles.dialogBtnPrimary}
                  disabled={updateBranchMutation.isPending || !renameDraft.trim()}
                >
                  {updateBranchMutation.isPending ? 'Renaming...' : 'Rename'}
                </button>
                <button type="button" className={styles.dialogBtnCancel} onClick={() => setRenameTarget(null)}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <CreateBranchModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        ticketId={ticketId}
        branches={allBranches}
        initialBranchFrom="main"
        defaultWorktreeTemplate={project?.worktreeTemplate}
        defaultWorktreeEnabled={project?.worktreeByDefault}
        projectPrefix={project?.prefix}
        hasRepoLinked={Boolean(ticket?.repoPath || project?.repoPath)}
      />
    </div>
  );
}
