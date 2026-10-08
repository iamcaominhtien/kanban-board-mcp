import React, { useState, useEffect, useRef } from 'react';
import { useCreateBranch } from '../api/tickets';
import { useToast } from './Toast';
import { extractError } from '../api/extractError';
import styles from './CreateBranchModal.module.css';

interface BranchOption {
  id?: string;
  name: string;
  status?: string;
}

interface CreateBranchModalProps {
  isOpen: boolean;
  onClose: () => void;
  ticketId: string;
  branches?: BranchOption[];
  initialBranchFrom?: string;
  onSuccess?: (newBranchName: string) => void;
  defaultWorktreeTemplate?: string | null;
  defaultWorktreeEnabled?: boolean;
  projectPrefix?: string;
  hasRepoLinked?: boolean;
}

/** Expand the worktree path template for a project, ticket and branch. */
export function computeDefaultWorktreePath(
  template: string | null | undefined,
  projectPrefix: string = '',
  ticketId: string = '',
  branchName: string = '',
): string {
  const tpl = template && template.trim() ? template.trim() : '../worktrees/{project}/{ticket_id}-{branch}';
  const sanitizedBranch = branchName ? branchName.replace(/\//g, '-').trim() : '{branch}';
  return tpl
    .replace(/\{project\}/g, projectPrefix || 'PROJ')
    .replace(/\{ticket_id\}/g, ticketId || 'TICKET')
    .replace(/\{ticket\}/g, ticketId || 'TICKET')
    .replace(/\{branch\}/g, sanitizedBranch)
    .replace(/\{repo\}/g, 'repo');
}

/** Dialog to create a branch for a ticket, optionally with a worktree. */
export function CreateBranchModal({
  isOpen,
  onClose,
  ticketId,
  branches = [],
  initialBranchFrom = 'main',
  onSuccess,
  defaultWorktreeTemplate,
  defaultWorktreeEnabled = false,
  projectPrefix = '',
  hasRepoLinked = true,
}: CreateBranchModalProps) {
  const [branchName, setBranchName] = useState('');
  const [branchFrom, setBranchFrom] = useState(initialBranchFrom);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [createWorktree, setCreateWorktree] = useState(Boolean(defaultWorktreeEnabled));
  const [customWorktreePath, setCustomWorktreePath] = useState('');
  const [isCustomWorktreePathTouched, setIsCustomWorktreePathTouched] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const createBranchMutation = useCreateBranch();
  const toast = useToast();

  // Reset inputs when opened
  useEffect(() => {
    if (isOpen) {
      setBranchName('');
      setBranchFrom(initialBranchFrom || 'main');
      setIsDropdownOpen(false);
      setCreateWorktree(Boolean(defaultWorktreeEnabled));
      setCustomWorktreePath('');
      setIsCustomWorktreePathTouched(false);
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    }
  }, [isOpen, initialBranchFrom, defaultWorktreeEnabled]);

  // Handle ESC key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isDropdownOpen) {
          setIsDropdownOpen(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isDropdownOpen, onClose]);

  // Handle click outside dropdown
  useEffect(() => {
    if (!isDropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isDropdownOpen]);

  if (!isOpen) return null;

  // Deduplicate and ensure 'main' is listed
  const branchNamesSet = new Set<string>();
  branchNamesSet.add('main');
  branches.forEach((b) => {
    if (b.name) branchNamesSet.add(b.name);
  });
  const branchOptions = Array.from(branchNamesSet);

  const computedWorktreePath = computeDefaultWorktreePath(defaultWorktreeTemplate, projectPrefix, ticketId, branchName);
  const currentWorktreePath = isCustomWorktreePathTouched ? customWorktreePath : computedWorktreePath;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = branchName.trim();
    if (!trimmed) return;

    const effectiveWorktreePath = createWorktree
      ? isCustomWorktreePathTouched
        ? customWorktreePath.trim()
        : computeDefaultWorktreePath(defaultWorktreeTemplate, projectPrefix, ticketId, trimmed)
      : undefined;

    try {
      await createBranchMutation.mutateAsync({
        ticketId,
        data: {
          name: trimmed,
          branch_from: branchFrom || 'main',
          status: 'open',
          create_worktree: createWorktree,
          worktree_path: effectiveWorktreePath || null,
        },
      });
      toast.success(createWorktree ? 'Branch & worktree created' : 'Branch created', trimmed);
      onSuccess?.(trimmed);
      onClose();
    } catch (err) {
      toast.error("Couldn't create branch", extractError(err));
    }
  };

  return (
    <div
      className={styles.modalBackdrop}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <form
        className={styles.modalCard}
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-branch-title"
      >
        <h3 id="new-branch-title" className={styles.title}>
          New branch
        </h3>

        {/* Field 1: Name */}
        <div className={styles.fieldGroup}>
          <label htmlFor="new-branch-name" className={styles.fieldLabel}>
            Name
          </label>
          <input
            id="new-branch-name"
            ref={inputRef}
            type="text"
            className={styles.textInput}
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            placeholder="experiment/drag-inertia"
            autoComplete="off"
            required
          />
        </div>

        {/* Field 2: Branch from */}
        <div className={styles.fieldGroup}>
          <span className={styles.fieldLabel}>Branch from</span>
          <div className={styles.branchSelectContainer} ref={dropdownRef}>
            <button
              type="button"
              className={styles.branchSelectTrigger}
              onClick={() => setIsDropdownOpen(!isDropdownOpen)}
              aria-haspopup="listbox"
              aria-expanded={isDropdownOpen}
            >
              <span className={styles.dot} />
              <span>{branchFrom}</span>
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#9AA8A0"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 9L12 15L18 9" />
              </svg>
            </button>

            {isDropdownOpen && (
              <div className={styles.branchDropdown} role="listbox">
                {branchOptions.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    className={`${styles.dropdownItem} ${opt === branchFrom ? styles.dropdownItemActive : ''}`}
                    onClick={() => {
                      setBranchFrom(opt);
                      setIsDropdownOpen(false);
                    }}
                    role="option"
                    aria-selected={opt === branchFrom}
                  >
                    <span className={styles.dot} />
                    <span>{opt}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className={styles.helperText}>
            Any existing branch works too, not just main — spins up a new ticket that carries the parent&apos;s
            description/AC as a starting point.
          </span>
        </div>

        {/* Field 3: Git Worktree */}
        <div className={styles.worktreeSection}>
          <label className={styles.checkboxLabel}>
            <input
              type="checkbox"
              className={styles.checkbox}
              checked={createWorktree}
              onChange={(e) => setCreateWorktree(e.target.checked)}
            />
            <span className={styles.checkboxText}>Create git worktree for this branch</span>
          </label>

          {createWorktree && (
            <div className={styles.worktreeGroup}>
              <div className={styles.worktreeHeader}>
                <span className={styles.fieldLabel}>Worktree directory path</span>
                {isCustomWorktreePathTouched && (
                  <button
                    type="button"
                    className={styles.resetBtn}
                    onClick={() => {
                      setIsCustomWorktreePathTouched(false);
                      setCustomWorktreePath('');
                    }}
                  >
                    Reset to template
                  </button>
                )}
              </div>
              <input
                type="text"
                className={styles.textInput}
                value={currentWorktreePath}
                onChange={(e) => {
                  setIsCustomWorktreePathTouched(true);
                  setCustomWorktreePath(e.target.value);
                }}
                placeholder="../worktrees/{project}/{ticket_id}-{branch}"
                autoComplete="off"
              />
              {!hasRepoLinked ? (
                <span className={styles.helperText} style={{ color: '#C4432A' }}>
                  Note: Git repository path is not configured on project or ticket. Git worktree creation requires a
                  linked repository path.
                </span>
              ) : (
                <span className={styles.helperText}>
                  Resolved relative to git repo root. Creates an isolated directory for concurrent development.
                </span>
              )}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className={styles.actions}>
          <button
            type="submit"
            className={styles.btnPrimary}
            disabled={createBranchMutation.isPending || !branchName.trim()}
          >
            {createBranchMutation.isPending ? 'Creating...' : 'Create branch'}
          </button>
          <button type="button" className={styles.btnSecondary} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
