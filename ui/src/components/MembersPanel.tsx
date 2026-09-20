import { useState } from 'react';
import type { AxiosError } from 'axios';
import type { Member } from '../types/ticket';
import { useAddMember, useRemoveMember } from '../api/members';
import styles from './MembersPanel.module.css';

const MEMBER_COLOR_OPTIONS: { hex: string; label: string }[] = [
  { hex: '#2E6F40', label: 'Forest Green' },
  { hex: '#5B5FA8', label: 'Indigo' },
  { hex: '#B4791E', label: 'Amber' },
  { hex: '#B0446E', label: 'Rose' },
  { hex: '#3B82F6', label: 'Blue' },
  { hex: '#DC6803', label: 'Orange' },
  { hex: '#7C3AED', label: 'Purple' },
];

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
  const [newColor, setNewColor] = useState(MEMBER_COLOR_OPTIONS[0].hex);
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

  // TODO(backend): the API does not currently reject DELETE /projects/:id/members/:memberId
  // for a member who is still assigned to open tickets -- it just deletes them and silently
  // orphans the `assignee` field on those tickets. Once the backend adds that validation and
  // returns a matching `detail` message (e.g. "Cannot remove: assigned to N open tickets."),
  // the generic error handling below will surface it correctly with no client changes needed.
  async function handleRemove(memberId: string) {
    setRemoveError(null);
    try {
      await removeMemberMutation.mutateAsync(memberId);
    } catch (err: unknown) {
      const detail = (err as AxiosError<{ detail: string }>)?.response?.data?.detail;
      setRemoveError(detail ?? 'Failed to remove member');
    }
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2 className={styles.title}>
            Project Members <span className={styles.countBadge}>{members.length}</span>
          </h2>
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
        {removeError && <p className={styles.errorText}>{removeError}</p>}

        <form className={styles.addForm} onSubmit={handleAdd}>
          <span className={styles.fieldLabel}>Add member</span>
          <input
            className={styles.nameInput}
            type="text"
            placeholder="Member name…"
            value={newName}
            onChange={(e) => { setNewName(e.target.value); setAddError(null); }}
          />
          <div className={styles.addFormRow}>
            <div className={styles.colorSwatchRow}>
              {MEMBER_COLOR_OPTIONS.map((c) => (
                <button
                  key={c.hex}
                  type="button"
                  className={`${styles.swatch} ${newColor === c.hex ? styles.swatchActive : ''}`}
                  style={{ background: c.hex }}
                  onClick={() => setNewColor(c.hex)}
                  title={c.label}
                  aria-label={c.label}
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
        </form>
        {addError && <p className={styles.errorText}>{addError}</p>}
      </div>
    </div>
  );
}
