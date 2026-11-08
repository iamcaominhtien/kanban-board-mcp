import { displayStatus } from '../utils/memberAccount';
import { MenuSelect } from './ui/MenuSelect';
import { extractError } from '../api/extractError';
import { useState } from 'react';
import type { AxiosError } from 'axios';
import type { Member } from '../types/ticket';
import { useAddMember, useRemoveMember, useSetMemberRole } from '../api/members';
import styles from './MembersPanel.module.css';
import { useAiTeams } from '../api/ai';
import { AiAvatar, StatusLabel } from './ai/aiUi';

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
  /** Open the full AI teams page (optionally straight into “Add AI team”). */
  onOpenAiPage?: (opts?: { add?: boolean; memberId?: string }) => void;
}

/**
 * Panel to add and remove a project's members.
 * @param props.projectId - Project whose members are managed.
 * @param props.members - Current members.
 * @param props.onClose - Called to dismiss the panel.
 */
export function MembersPanel({ projectId, members: allMembers, onClose, onOpenAiPage }: MembersPanelProps) {
  // AI members live under the AI tab; the people list stays as it was
  const members = allMembers.filter((m) => (m.kind ?? 'human') === 'human');
  const [tab, setTab] = useState<'humans' | 'ai'>('humans');
  const ai = useAiTeams(projectId);
  const aiMembers = ai.data ?? [];
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(PRESET_MEMBER_COLORS[0]);
  const [addError, setAddError] = useState<string | null>(null);
  // the blocked remove message sits under the row it belongs to (design: members-view 4)
  const [removeError, setRemoveError] = useState<{ id: string; message: string } | null>(null);

  const addMemberMutation = useAddMember(projectId);
  const removeMemberMutation = useRemoveMember(projectId);
  const setRole = useSetMemberRole(projectId);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setAddError(null);
    try {
      await addMemberMutation.mutateAsync({ name, color: newColor });
      setNewName('');
    } catch (err) {
      // Any 4xx carries the server's sentence (409: names are unique across people and AI in a project; 422: "Enter a
      // name."). Network errors and 5xx get the generic text.
      const status = (err as AxiosError)?.response?.status;
      const fromServer = status !== undefined && status >= 400 && status < 500 ? extractError(err) : '';
      setAddError(fromServer || 'Failed to add member. Please try again.');
    }
  }

  async function handleRemove(memberId: string) {
    setRemoveError(null);
    try {
      await removeMemberMutation.mutateAsync(memberId);
    } catch (err: unknown) {
      const detail = (err as AxiosError<{ detail: string }>)?.response?.data?.detail;
      setRemoveError({
        id: memberId,
        message: detail ?? 'Failed to remove member. If assigned to open tickets, reassign first.',
      });
    }
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className={styles.header}>
          <h2 className={styles.title}>Project Members</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            >
              <path d="M6 6L18 18M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div
          className="ai-root"
          style={{ display: 'flex', gap: 18, padding: '0 20px', borderBottom: '1px solid #EEF3EF' }}
        >
          {(['humans', 'ai'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`ai-tab ${tab === t ? 'ai-tab-active' : ''}`}
              onClick={() => setTab(t)}
              data-testid={`members-tab-${t}`}
            >
              {t === 'humans' ? 'Humans' : 'AI'}
              <span className="ai-tab-count">
                {t === 'humans' ? members.length : ai.isLoading ? '…' : aiMembers.length}
              </span>
            </button>
          ))}
        </div>

        {tab === 'ai' && (
          <div className={`${styles.content} ai-root`} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {ai.isLoading && (
              <div
                style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
                aria-busy="true"
                data-testid="members-ai-loading"
              >
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <span className="ai-skel" style={{ width: 30, height: 30, borderRadius: 8 }} />
                    <span className="ai-skel" style={{ width: 170, height: 11 }} />
                    <span className="ai-skel" style={{ width: 70, height: 11, marginLeft: 'auto' }} />
                  </div>
                ))}
              </div>
            )}
            {ai.isError && (
              <div className="ai-notice ai-notice-error" role="alert">
                <div>
                  <b>Could not load AI teams</b>
                  <div>
                    <button type="button" className="ai-link" onClick={() => void ai.refetch()}>
                      Try again
                    </button>
                  </div>
                </div>
              </div>
            )}
            {!ai.isLoading && !ai.isError && aiMembers.length === 0 && (
              <div className={styles.emptyState}>No AI teams yet.</div>
            )}
            {aiMembers.slice(0, 4).map((m) => (
              <button
                key={m.id}
                type="button"
                className="ai-mi"
                style={{ padding: '8px 4px' }}
                onClick={() => onOpenAiPage?.({ memberId: m.id })}
              >
                <AiAvatar color={m.color} size={30} dim={m.paused} />
                <span style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                  <span>{m.name}</span>
                  {m.accountRef && (
                    <span
                      className="ai-muted"
                      style={{ fontSize: 11, color: m.accountRef.status === 'needs_sign_in' ? '#A5321E' : undefined }}
                      data-testid="member-account-line"
                    >
                      Claude Code · {m.accountRef.name}
                      {m.accountRef.status === 'needs_sign_in' ? ' signed out' : ''}
                    </span>
                  )}
                  <StatusLabel status={displayStatus(m)} sub={null} />
                </span>
              </button>
            ))}
            {!ai.isLoading && !ai.isError && aiMembers.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
                {aiMembers.length > 4 && (
                  <button type="button" className="ai-link" onClick={() => onOpenAiPage?.()} data-testid="members-more">
                    +{aiMembers.length - 4} more
                  </button>
                )}
                <span style={{ flex: 1 }} />
                <button type="button" className="ai-link" onClick={() => onOpenAiPage?.()} data-testid="open-ai-page">
                  Open AI teams page →
                </button>
              </div>
            )}
            {!ai.isLoading && !ai.isError && (
              <button
                type="button"
                className="ai-btn ai-btn-primary"
                style={{ width: '100%', justifyContent: 'center' }}
                onClick={() => onOpenAiPage?.({ add: true })}
              >
                + Add AI team
              </button>
            )}
          </div>
        )}

        {/* Content */}
        <div className={styles.content} style={tab === 'ai' ? { display: 'none' } : undefined}>
          <div className={styles.memberList}>
            {members.map((m, idx) => (
              <div key={m.id}>
                <div className={styles.memberRow}>
                  <div
                    className={styles.avatar}
                    style={{
                      background: `${m.color || '#2E6F40'}22`,
                      color: m.color || '#2E6F40',
                      border: `1.5px solid ${m.color || '#2E6F40'}`,
                    }}
                  >
                    {memberInitials(m.name)}
                  </div>
                  <span className={styles.memberName}>{m.name}</span>
                  <MenuSelect<'viewer' | 'member' | 'admin'>
                    label={`Docs role of ${m.name}`}
                    testId={`member-role-${m.name}`}
                    variant="chip"
                    value={m.role ?? 'member'}
                    menuWidth={230}
                    onChange={(role) => setRole.mutate({ memberId: m.id, role })}
                    options={[
                      { value: 'viewer', label: 'Viewer', hint: 'Reads docs comments' },
                      { value: 'member', label: 'Member', hint: 'Comments and resolves' },
                      { value: 'admin', label: 'Admin', hint: 'Can delete any comment' },
                    ]}
                  />
                  <button
                    type="button"
                    className={`${styles.removeBtn} ${removeError?.id === m.id ? styles.removeBtnBlocked : ''}`}
                    onClick={() => handleRemove(m.id)}
                    aria-label={`Remove ${m.name}`}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    >
                      <path d="M6 6L18 18M18 6L6 18" />
                    </svg>
                  </button>
                </div>
                {removeError?.id === m.id && (
                  <div className={styles.rowError} role="alert" data-testid="member-remove-error">
                    {removeError.message}
                  </div>
                )}
                {idx < members.length - 1 && <div className={styles.rowDivider} />}
              </div>
            ))}

            {members.length === 0 && <div className={styles.emptyState}>No members yet.</div>}
          </div>

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
              <button type="submit" className={styles.addBtn} disabled={!newName.trim() || addMemberMutation.isPending}>
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
