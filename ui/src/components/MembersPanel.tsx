import { useState } from 'react';
import type { AxiosError } from 'axios';
import type { Member } from '../types/ticket';
import { useAddMember, useRemoveMember } from '../api/members';
import styles from './MembersPanel.module.css';

const PRESET_MEMBER_COLORS = [
  '#2E6F40', // forest green
  '#5B5FA8', // muted indigo
  '#B4791E', // warm amber
  '#B0446E', // soft berry
  '#2F6FB0', // classic blue
  '#6D5DD3', // purple
  '#C4432A', // brick red
];

function memberInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

interface MembersPanelProps {
  projectId: string;
  members: Member[];
  onClose: () => void;
}

export function MembersPanel({ projectId, members, onClose }: MembersPanelProps) {
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(PRESET_MEMBER_COLORS[0]);
  const [addError, setAddError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const addMemberMutation = useAddMember(projectId);
  const removeMemberMutation = useRemoveMember(projectId);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setAddError(null);
    try {
      await addMemberMutation.mutateAsync({ name, color: newColor });
      setNewName('');
    } catch {
      setAddError('Failed to add member. Please try again.');
    }
  }

  async function handleRemove(memberId: string) {
    setRemoveError(null);
    try {
      await removeMemberMutation.mutateAsync(memberId);
    } catch (err: unknown) {
      const detail = (err as AxiosError<{ detail: string }>)?.response?.data?.detail;
      setRemoveError(detail ?? 'Failed to remove member. If assigned to open tickets, reassign first.');
    }
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className={styles.header}>
          <h2 className={styles.title}>
            Project Members
            <span className={styles.countBadge}>{members.length}</span>
          </h2>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Close"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M6 6L18 18M18 6L6 18" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className={styles.content}>
          <div className={styles.memberList}>
            {members.map((m, idx) => (
              <div key={m.id}>
                <div className={styles.memberRow}>
                  <div className={styles.avatar} style={{ background: m.color || '#2E6F40' }}>
                    {memberInitials(m.name)}
                  </div>
                  <span className={styles.memberName}>{m.name}</span>
                  <button
                    type="button"
                    className={styles.removeBtn}
                    onClick={() => handleRemove(m.id)}
                    aria-label={`Remove ${m.name}`}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                      <path d="M6 6L18 18M18 6L6 18" />
                    </svg>
                  </button>
                </div>
                {idx < members.length - 1 && <div className={styles.rowDivider} />}
              </div>
            ))}

            {members.length === 0 && (
              <div className={styles.emptyState}>No members yet.</div>
            )}
          </div>

          {removeError && <div className={styles.errorText}>{removeError}</div>}

          <div className={styles.sectionDivider} />

          {/* Add member section */}
          <form className={styles.addSection} onSubmit={handleAdd}>
            <span className={styles.fieldLabel}>Add member</span>
            <input
              className={styles.input}
              type="text"
              placeholder="Member name…"
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value);
                setAddError(null);
              }}
            />
            <div className={styles.swatchesAndBtn}>
              <div className={styles.swatchesRow}>
                {PRESET_MEMBER_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`${styles.swatch} ${newColor === color ? styles.swatchActive : ''}`}
                    style={{ backgroundColor: color }}
                    onClick={() => setNewColor(color)}
                    aria-label={`Color ${color}`}
                  />
                ))}
              </div>
              <button
                type="submit"
                className={styles.addBtn}
                disabled={!newName.trim() || addMemberMutation.isPending}
              >
                {addMemberMutation.isPending ? '…' : 'Add'}
              </button>
            </div>
            {addError && <div className={styles.errorText}>{addError}</div>}
          </form>
        </div>
      </div>
    </div>
  );
}
