import { extractError } from '../api/extractError';
import { useState } from 'react';
import type { AxiosError } from 'axios';
import type { Member } from '../types/ticket';
import { useAddMember, useRemoveMember, useSetMemberRole } from '../api/members';
import styles from './MembersPanel.module.css';
import { useAiOverview } from '../api/ai';
import { AiAvatar, ConnectionChip, StatusLabel } from './ai/aiUi';
import { BoardAiPicker } from './ai/AiDialogs';

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
  /** Open the full AI members page (optionally straight into “Add AI member”). */
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
  const ai = useAiOverview(projectId);
  const aiMembers = ai.data?.members ?? [];
  const boardAi = aiMembers.find((m) => m.id === ai.data?.settings.boardAiId);
  // “Change” on the Board AI card opens the picker right here
  const [picker, setPicker] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(PRESET_MEMBER_COLORS[0]);
  const [addError, setAddError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

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
      // 409: names are unique across people and AI in a project, so @mentions never point at two members
      setAddError(extractError(err) || 'Failed to add member. Please try again.');
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
              <span className="ai-tab-count">{t === 'humans' ? members.length : aiMembers.length}</span>
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
                  <b>Could not load AI members</b>
                  <div>
                    <button type="button" className="ai-link" onClick={() => void ai.refetch()}>
                      Try again
                    </button>
                  </div>
                </div>
              </div>
            )}
            {boardAi && (
              <div
                className="ai-card"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: 10,
                  background: '#F1F8F3',
                  borderColor: '#BFDCC7',
                }}
              >
                <AiAvatar provider={boardAi.provider} color={boardAi.color} glyph={boardAi.glyph} size={30} />
                <div style={{ flex: 1 }}>
                  <div className="ai-label" style={{ color: '#2E6F40' }}>
                    Board AI
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{boardAi.name}</div>
                </div>
                <button
                  type="button"
                  className="ai-btn ai-btn-sm"
                  onClick={() => setPicker(true)}
                  data-testid="members-board-ai-change"
                >
                  Change
                </button>
              </div>
            )}
            {!ai.isLoading && !ai.isError && aiMembers.length === 0 && (
              <div className={styles.emptyState}>No AI members yet.</div>
            )}
            {aiMembers.slice(0, 4).map((m) => (
              <button
                key={m.id}
                type="button"
                className="ai-mi"
                style={{ padding: '8px 4px' }}
                onClick={() => onOpenAiPage?.({ memberId: m.id })}
              >
                <AiAvatar provider={m.provider} color={m.color} glyph={m.glyph} size={30} dim={m.paused} />
                <span style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                  <span>{m.name}</span>
                  <StatusLabel status={m.status} sub={null} />
                </span>
                <ConnectionChip connection={m.connection} />
              </button>
            ))}
            {aiMembers.length > 4 && (
              <button
                type="button"
                className="ai-link"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => onOpenAiPage?.()}
                data-testid="members-more"
              >
                +{aiMembers.length - 4} more
              </button>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <button
                type="button"
                className="ai-btn ai-btn-sm"
                onClick={() => onOpenAiPage?.()}
                data-testid="open-ai-page"
              >
                Open AI members page →
              </button>
              <button
                type="button"
                className="ai-btn ai-btn-sm ai-btn-primary"
                onClick={() => onOpenAiPage?.({ add: true })}
              >
                + Add AI member
              </button>
            </div>
          </div>
        )}

        {picker && ai.data && (
          <BoardAiPicker
            projectId={projectId}
            members={aiMembers}
            currentId={ai.data.settings.boardAiId}
            onClose={() => setPicker(false)}
          />
        )}

        {/* Content */}
        <div className={styles.content} style={tab === 'ai' ? { display: 'none' } : undefined}>
          <div className={styles.memberList}>
            {members.map((m, idx) => (
              <div key={m.id}>
                <div className={styles.memberRow}>
                  <div className={styles.avatar} style={{ background: m.color || '#2E6F40' }}>
                    {memberInitials(m.name)}
                  </div>
                  <span className={styles.memberName}>{m.name}</span>
                  <select
                    aria-label={`Docs role of ${m.name}`}
                    title="Docs comments: viewers read, members comment and resolve, admins can delete any comment"
                    data-testid={`member-role-${m.name}`}
                    value={m.role ?? 'member'}
                    onChange={(e) =>
                      setRole.mutate({ memberId: m.id, role: e.target.value as 'viewer' | 'member' | 'admin' })
                    }
                    style={{
                      font: 'inherit',
                      fontSize: 12,
                      border: '1px solid #dce6df',
                      borderRadius: 6,
                      padding: '2px 4px',
                      background: '#fff',
                      color: '#3a4a3e',
                    }}
                  >
                    <option value="viewer">Viewer</option>
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                  <button
                    type="button"
                    className={styles.removeBtn}
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
                {idx < members.length - 1 && <div className={styles.rowDivider} />}
              </div>
            ))}

            {members.length === 0 && <div className={styles.emptyState}>No members yet.</div>}
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
