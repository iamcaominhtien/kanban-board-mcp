import { useEffect, useRef, useState } from 'react';
import { NotificationBellButton } from '../notifications/NotificationsHost';
import { aiApi, useAiMutation, useAiOverview, useAiTeams } from '../../api/ai';
import { useAiAccounts } from '../../api/aiAccounts';
import { extractError } from '../../api/extractError';
import { useToast } from '../Toast';
import type { AiTeam } from '../../types/ai';
import type { Member } from '../../types';
import { MemberAvatar } from '../MemberAvatar';
import { AddTeamModal } from './AddTeamModal';
import { AiProfile } from './AiProfile';
import { PauseAllButton, RemoveAiDialog } from './AiDialogs';
import { AccountsTab } from './accounts/AccountsTab';
import { SignedOutBanners } from './accounts/SignedOutBanners';
import { accountCell, displayStatus } from '../../utils/memberAccount';
import './accounts/accountsMember.css';
import { AiAvatar, StatusLabel, money, statusSub, useAiBoardState, useNow } from './aiUi';
import { roleLook } from './roleLook';
import { LineIcon } from '../ui/LineIcon';

type Tab = 'humans' | 'ai' | 'accounts';

interface Props {
  projectId: string;
  projectName: string;
  humans: Member[];
  initialMemberId?: string | null;
  initialTab?: Tab;
  /** Open “Add AI team” right away. */
  initialAdd?: boolean;
  onBack: () => void;
  onOpenTicket: (ticketId: string) => void;
  onOpenMembersModal: () => void;
  /** Open Settings (its AI section holds the project's run settings). */
  onOpenSettings?: () => void;
  /** Show the board filtered to what this team is assigned. */
  onViewOnBoard?: (memberId: string) => void;
}

/** Members page: people, AI teams (list, add, one team's page) and the AI accounts. */
export function AiMembersPage({
  projectId,
  projectName,
  humans,
  initialMemberId,
  initialTab,
  initialAdd,
  onBack,
  onOpenTicket,
  onOpenMembersModal,
  onOpenSettings,
  onViewOnBoard,
}: Props) {
  const [tab, setTab] = useState<Tab>(initialTab ?? 'ai');
  const [profileId, setProfileId] = useState<string | null>(initialMemberId ?? null);
  const [adding, setAdding] = useState(!!initialAdd);
  const [removing, setRemoving] = useState<AiTeam | null>(null);
  const accounts = useAiAccounts(projectId);
  const teamsQuery = useAiTeams(projectId);
  const overview = useAiOverview(projectId);
  const { settings } = useAiBoardState();
  const members = teamsQuery.data ?? [];

  useEffect(() => {
    if (initialMemberId) setProfileId(initialMemberId);
  }, [initialMemberId]);

  const profile = profileId ? members.find((m) => m.id === profileId) : null;
  const running = overview.data?.active.filter((a) => a.state === 'running' || a.state === 'starting').length ?? 0;
  const waiting = overview.data?.runs.needsInput ?? 0;

  return (
    <div className="ai-page ai-root" data-testid="ai-members-page">
      <div className="ai-crumbs">
        <button type="button" onClick={onBack}>
          {projectName}
        </button>
        <span>/</span>
        {profile ? (
          <>
            <button type="button" onClick={() => setProfileId(null)}>
              Members
            </button>
            <span>/</span>
            <b>{profile.name}</b>
          </>
        ) : (
          <b>Members</b>
        )}
        <span style={{ flex: 1 }} />
        {settings && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <PauseAllButton projectId={projectId} settings={settings} members={members} />
          </span>
        )}
        <NotificationBellButton />
      </div>
      <div className="ai-page-inner">
        {profile ? (
          <AiProfile
            key={profile.id}
            onViewOnBoard={onViewOnBoard}
            member={profile}
            projectId={projectId}
            humans={humans}
            onOpenTicket={onOpenTicket}
            onRemoved={() => setProfileId(null)}
          />
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
              <div style={{ flex: 1 }}>
                <h1 className="ai-h1">Members</h1>
                <div className="ai-hint" style={{ fontSize: 13, marginTop: 4 }}>
                  People and AI teams who can be assigned tickets and @mentioned in {projectName}.
                </div>
              </div>
              <button
                type="button"
                className="ai-btn ai-btn-primary"
                style={{ padding: '10px 16px', fontSize: 13 }}
                onClick={() => setAdding(true)}
                data-testid="ai-add-member"
              >
                <span style={{ fontSize: 16, lineHeight: 1 }}>+</span> Add AI team
              </button>
            </div>
            <div className="ai-tabs ai-tabs-seg" role="tablist">
              <TabBtn id="humans" tab={tab} setTab={setTab} label="Humans" count={humans.length} />
              <TabBtn id="ai" tab={tab} setTab={setTab} label="AI teams" count={members.length} />
              <TabBtn
                id="accounts"
                tab={tab}
                setTab={setTab}
                label="AI accounts"
                count={accounts.data?.accounts.length ?? 0}
              />
            </div>
            <div style={{ marginTop: 18 }}>
              {tab === 'humans' && (
                <div className="ai-card">
                  {humans.map((h, i) => (
                    <div
                      key={h.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '11px 16px',
                        borderTop: i ? '1px solid #EEF3EF' : undefined,
                      }}
                    >
                      <MemberAvatar member={h} size={30} />
                      <span style={{ fontSize: 13.5, fontWeight: 600, flex: 1 }}>{h.name}</span>
                      <span className="ai-muted">{h.role ?? 'member'}</span>
                    </div>
                  ))}
                  <div style={{ padding: '10px 16px', borderTop: '1px solid #EEF3EF' }}>
                    <button type="button" className="ai-link" onClick={onOpenMembersModal}>
                      Add or remove people
                    </button>
                  </div>
                </div>
              )}
              {tab === 'ai' &&
                (teamsQuery.isLoading ? (
                  <ListSkeleton />
                ) : teamsQuery.isError ? (
                  <ListError onRetry={() => void teamsQuery.refetch()} />
                ) : members.length === 0 ? (
                  <EmptyState onSetUp={() => setAdding(true)} />
                ) : (
                  <>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 22,
                        fontSize: 12,
                        color: '#5B6B60',
                        margin: '0 0 12px',
                      }}
                    >
                      <span>
                        <b style={{ color: '#1E2A22' }}>{running}</b> running now
                      </span>
                      <span>
                        <b style={{ color: '#1E2A22' }}>{members.reduce((n, m) => n + m.usage.runsToday, 0)}</b> runs
                        today
                      </span>
                      {waiting > 0 && (
                        <span style={{ color: '#34455A', fontWeight: 600 }}>
                          <LineIcon name="pause" size={13} /> {waiting} waiting for an answer
                        </span>
                      )}
                      {onOpenSettings && (
                        <button
                          type="button"
                          className="ai-link"
                          onClick={onOpenSettings}
                          data-testid="ai-settings-link"
                        >
                          AI settings
                        </button>
                      )}
                    </div>
                    <SignedOutBanners projectId={projectId} members={members} />
                    <TeamTable
                      members={members}
                      onOpen={setProfileId}
                      onRemove={setRemoving}
                      onOpenTicket={onOpenTicket}
                    />
                  </>
                ))}
              {tab === 'accounts' && <AccountsTab projectId={projectId} />}
            </div>
          </>
        )}
      </div>
      {adding && (
        <AddTeamModal
          projectId={projectId}
          projectName={projectName}
          onClose={() => setAdding(false)}
          onOpenProfile={(id) => {
            setAdding(false);
            setProfileId(id);
          }}
        />
      )}
      {removing && <RemoveAiDialog member={removing} humans={humans} onClose={() => setRemoving(null)} />}
    </div>
  );
}

function TabBtn({
  id,
  tab,
  setTab,
  label,
  count,
}: {
  id: Tab;
  tab: Tab;
  setTab: (t: Tab) => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={tab === id}
      className={`ai-tab ${tab === id ? 'ai-tab-active' : ''}`}
      onClick={() => setTab(id)}
      data-testid={`ai-tab-${id}`}
    >
      {label}
      {count !== undefined && <span className="ai-tab-count">{count}</span>}
    </button>
  );
}

/** The role chips of a team ("DV", "RV", "QA"), each titled with the role's name. */
export function RoleChips({ team }: { team: AiTeam }) {
  if (!team.roles.length) return <span className="ai-muted">No roles</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }} data-testid="role-chips">
      {team.roles.map((r) => {
        const look = roleLook(r.key);
        return (
          <span
            key={r.key}
            className="ai-chip"
            title={`${r.name ?? r.key}${r.model ? ` · ${r.model}` : ''}`}
            style={{ background: look.bg, color: look.fg, border: `1px solid ${look.border}`, height: 20 }}
          >
            {r.name ?? look.glyph}
          </span>
        );
      })}
    </span>
  );
}

function TeamTable({
  members,
  onOpen,
  onRemove,
  onOpenTicket,
}: {
  members: AiTeam[];
  onOpen: (id: string) => void;
  onRemove: (m: AiTeam) => void;
  onOpenTicket: (id: string) => void;
}) {
  const [menu, setMenu] = useState<string | null>(null);
  // Elapsed times of running teams tick every second
  useNow(
    1000,
    members.some((m) => m.status.code === 'running'),
  );
  const toast = useToast();
  const pause = useAiMutation((m: AiTeam) => (m.paused ? aiApi.resumeTeam(m.id) : aiApi.pauseTeam(m.id)));
  const test = useAiMutation((id: string) => aiApi.testTeam(id));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenu(null);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, []);

  return (
    <div className="ai-card" style={{ overflow: 'visible' }} ref={ref}>
      <div className="ai-grid acm-grid" style={{ padding: '8px 16px', borderBottom: '1px solid #E3E8E5' }}>
        <div className="ai-label">Team</div>
        <div className="ai-label">Roles</div>
        <div className="ai-label">Model</div>
        <div className="ai-label">Account</div>
        <div className="ai-label">Status</div>
        <div className="ai-label">Today</div>
        <div className="ai-label">Permissions</div>
        <span />
      </div>
      {members.map((m, i) => (
        <div key={m.id}>
          {i > 0 && <div className="ai-divider" />}
          <div className="ai-grid acm-grid ai-row" onClick={() => onOpen(m.id)} data-testid={`ai-row-${m.name}`}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
              <AiAvatar color={m.color} size={36} dim={m.paused} />
              <div style={{ minWidth: 0 }}>
                <span style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap' }}>{m.name}</span>
                <div
                  className="ai-hint"
                  style={{ marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {m.packName ?? m.packKey}
                  {m.workingDir ? ` · ${m.workingDir}` : ''}
                </div>
              </div>
            </div>
            <div>
              <RoleChips team={m} />
            </div>
            <div style={{ fontSize: 13 }}>
              {m.model ?? 'sonnet'}
              {m.effort ? ` · ${m.effort}` : ''}
            </div>
            <AccountCell member={m} />
            <div
              onClick={(e) => {
                if (m.status.ticketId) {
                  e.stopPropagation();
                  onOpenTicket(m.status.ticketId);
                }
              }}
            >
              <StatusLabel
                status={displayStatus(m)}
                sub={displayStatus(m) !== m.status ? displayStatus(m).detail : (statusSub(m) ?? null)}
              />
            </div>
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                {m.usage.runsToday} run{m.usage.runsToday === 1 ? '' : 's'}
              </div>
              <div className="ai-muted">{money(m.usage.costToday)}</div>
            </div>
            <div style={{ fontSize: 13 }}>{m.permissionMode}</div>
            <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="ai-icobtn"
                aria-label={`More actions for ${m.name}`}
                onClick={() => setMenu(menu === m.id ? null : m.id)}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="5" cy="12" r="1.6" />
                  <circle cx="12" cy="12" r="1.6" />
                  <circle cx="19" cy="12" r="1.6" />
                </svg>
              </button>
              {menu === m.id && (
                <div className="ai-menu" style={{ right: 0, top: 30 }}>
                  <button
                    type="button"
                    className="ai-mi"
                    onClick={() => {
                      setMenu(null);
                      onOpen(m.id);
                    }}
                    data-testid={`ai-edit-${m.name}`}
                  >
                    <LineIcon name="edit" size={14} />
                    Edit
                  </button>
                  <button
                    type="button"
                    className="ai-mi"
                    data-testid={`ai-pause-${m.name}`}
                    onClick={() => {
                      setMenu(null);
                      pause.mutate(m);
                    }}
                  >
                    <LineIcon name={m.paused ? 'play' : 'pause'} size={14} />
                    {m.paused ? 'Resume' : 'Pause'}
                  </button>
                  <button
                    type="button"
                    className="ai-mi"
                    onClick={async () => {
                      setMenu(null);
                      try {
                        const r = await test.mutateAsync(m.id);
                        if (r.ok) toast.success(`${m.name}: Claude Code works`, r.message);
                        else toast.error(`${m.name}: check failed`, r.message);
                      } catch (err) {
                        toast.error('Test failed', extractError(err));
                      }
                    }}
                  >
                    <LineIcon name="bolt" size={14} />
                    Test
                  </button>
                  <div className="ai-divider" style={{ margin: '4px 0' }} />
                  <button
                    type="button"
                    className="ai-mi ai-mi-danger"
                    data-testid={`ai-remove-${m.name}`}
                    onClick={() => {
                      setMenu(null);
                      onRemove(m);
                    }}
                  >
                    <LineIcon name="trash" size={14} />
                    Remove…
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** The Account column: the account the team runs as, or the login on this computer. */
function AccountCell({ member }: { member: AiTeam }) {
  const cell = accountCell(member);
  if (!cell) return <div className="ai-muted">—</div>;
  return (
    <div style={{ minWidth: 0 }} data-testid="account-cell">
      <div style={{ fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {cell.name}
      </div>
      <div className={cell.warn ? 'ai-muted acm-warn-text' : 'ai-muted'}>{cell.sub}</div>
    </div>
  );
}

function EmptyState({ onSetUp }: { onSetUp: () => void }) {
  return (
    <div className="ai-card" style={{ padding: '36px 24px', textAlign: 'center' }} data-testid="ai-empty">
      <div style={{ fontSize: 16, fontWeight: 800 }}>No AI teams yet</div>
      <div className="ai-hint" style={{ maxWidth: 520, margin: '6px auto 18px' }}>
        Add a team to assign tickets to it. Its lead runs Claude Code on the ticket and calls the team's roles (Dev,
        Reviewer, QA…) as helpers.
      </div>
      <button type="button" className="ai-btn ai-btn-primary" onClick={onSetUp} data-testid="ai-empty-add">
        Set up a team
      </button>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div
      className="ai-card"
      style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}
      aria-busy="true"
    >
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span className="ai-skel" style={{ width: 36, height: 36, borderRadius: 9 }} />
          <span className="ai-skel" style={{ width: 220, height: 12 }} />
          <span className="ai-skel" style={{ width: 90, height: 12, marginLeft: 'auto' }} />
        </div>
      ))}
    </div>
  );
}

/** The list could not be loaded: say so and offer to try again. */
function ListError({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      className="ai-card"
      style={{ padding: '28px 24px', textAlign: 'center' }}
      role="alert"
      data-testid="ai-list-error"
    >
      <div style={{ fontSize: 15, fontWeight: 800 }}>Could not load AI teams</div>
      <div className="ai-hint" style={{ margin: '6px auto 14px', maxWidth: 420 }}>
        The board could not be reached. Nothing was changed; teams that are running keep running.
      </div>
      <button type="button" className="ai-btn" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
