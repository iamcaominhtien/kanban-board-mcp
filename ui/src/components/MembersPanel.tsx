import { useState } from 'react';
import type { Member } from '../types/ticket';
import { useAddMember, useRemoveMember } from '../api/members';
import styles from './MembersPanel.module.css';

function memberInitials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

interface MembersPanelProps {
  projectId: string;
  members: Member[];
  onClose: () => void;
}

export function MembersPanel({ projectId, members, onClose }: MembersPanelProps) {
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState('#3B82F6');
  const [addError, setAddError] = useState<string | null>(null);

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
    try {
      await removeMemberMutation.mutateAsync(memberId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to remove member';
      setAddError(msg);
    }
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2 className={styles.title}>Project Members</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose}>×</button>
        </div>

        <ul className={styles.memberList}>
          {members.map((m) => (
            <li key={m.id} className={styles.memberRow}>
              <span className={styles.avatar} style={{ background: m.color }}>
                {memberInitials(m.name)}
              </span>
              <span className={styles.memberName}>{m.name}</span>
              <button
                type="button"
                className={styles.removeBtn}
                onClick={() => handleRemove(m.id)}
                aria-label={`Remove ${m.name}`}
              >
                ×
              </button>
            </li>
          ))}
          {members.length === 0 && (
            <li className={styles.empty}>No members yet.</li>
          )}
        </ul>

        <form className={styles.addForm} onSubmit={handleAdd}>
          <input
            className={styles.nameInput}
            type="text"
            placeholder="Member name…"
            value={newName}
            onChange={(e) => { setNewName(e.target.value); setAddError(null); }}
          />
          <input
            className={styles.colorInput}
            type="color"
            value={newColor}
            onChange={(e) => setNewColor(e.target.value)}
            title="Avatar color"
          />
          <button
            type="submit"
            className={styles.addBtn}
            disabled={!newName.trim() || addMemberMutation.isPending}
          >
            {addMemberMutation.isPending ? '…' : 'Add'}
          </button>
        </form>
        {addError && <p className={styles.errorText}>{addError}</p>}
      </div>
    </div>
  );
}
