import { useEffect, useRef, useState } from 'react';
import { aiApi, useAiApprovals, useAiMutation, useAiOverview, useRunnerInfo } from '../../api/ai';
import { useAiAccounts } from '../../api/aiAccounts';
import { useAssist } from '../assist/AssistContext';
import { extractError } from '../../api/extractError';
import { useToast } from '../Toast';
import type { AiMember, AiProvider } from '../../types/ai';
import type { Member } from '../../types';
import { MemberAvatar } from '../MemberAvatar';
import { AddAiMemberModal } from './AddAiMemberModal';
import { AiProfile } from './AiProfile';
import { ApprovalsView, AuditView, SafetyView, UsageView } from './AiSafetyViews';
import { BoardAiPicker, PauseAllButton, RemoveAiDialog } from './AiDialogs';
import { AccountsTab } from './accounts/AccountsTab';
import { SignedOutBanners } from './accounts/SignedOutBanners';
import { accountCell, displayStatus } from '../../utils/memberAccount';
import './accounts/accountsMember.css';
import {
  AiAvatar,
  CeilingChip,
  ConnectionChip,
  PROVIDERS,
  ProviderChip,
  StatusLabel,
  ago,
  money,
  statusSub,
  useNow,
} from './aiUi';

type Tab = 'humans' | 'ai' | 'accounts' | 'approvals' | 'audit' | 'usage' | 'safety';

interface Props {
  projectId: string;
  projectName: string;
  humans: Member[];
  initialMemberId?: string | null;
  initialTab?: Tab;
  /** Open the audit log filtered to one AI member. */
  initialAuditMemberId?: string | null;
  /** Open “Add AI member” right away. */
  initialAdd?: boolean;
  onBack: () => void;
  onOpenTicket: (ticketId: string) => void;
  onOpenMembersModal: () => void;
  /** Open Settings (its AI section holds the Board AI's assistant settings). */
  onOpenSettings?: () => void;
  /** Show the board filtered to what this AI member is assigned. */
  onViewOnBoard?: (memberId: string) => void;
}

/** Members page with the AI tab: list, Board AI, add, profile, approvals, audit and usage. */
export function AiMembersPage({
  projectId,
  projectName,
  humans,
  initialMemberId,
  initialTab,
  initialAuditMemberId,
  initialAdd,
  onBack,
  onOpenTicket,
  onOpenMembersModal,
  onOpenSettings,
  onViewOnBoard,
}: Props) {
  const assist = useAssist();
  const [tab, setTab] = useState<Tab>(initialTab ?? 'ai');
  const [profileId, setProfileId] = useState<string | null>(initialMemberId ?? null);
  // “Edit” in a row's menu opens its profile straight on Configuration
  const [profileTab, setProfileTab] = useState<'overview' | 'configuration'>('overview');
  const [adding, setAdding] = useState<{ provider?: AiProvider } | null>(initialAdd ? {} : null);
  const [picker, setPicker] = useState(false);
  const [removing, setRemoving] = useState<AiMember | null>(null);
  const accounts = useAiAccounts(projectId);
  const overview = useAiOverview(projectId);
  const runner = useRunnerInfo();
  const webBuild = runner.data?.local === false;
  const approvals = useAiApprovals(projectId, 'pending');
  const members = overview.data?.members ?? [];
  const settings = overview.data?.settings;
  const boardAi = members.find((m) => m.id === settings?.boardAiId);

  useEffect(() => {
    if (initialMemberId) setProfileId(initialMemberId);
  }, [initialMemberId]);

  const profile = profileId ? members.find((m) => m.id === profileId) : null;

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
      </div>
      <div className="ai-page-inner">
        {profile ? (
          <AiProfile
            key={`${profile.id}-${profileTab}`}
            initialTab={profileTab}
            onViewOnBoard={onViewOnBoard}
            onOpenAudit={() => {
              setProfileId(null);
              setTab('audit');
            }}
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
                  People and AI who can be assigned tickets and @mentioned in {projectName}.
                </div>
              </div>
              {assist && members.length > 0 && (
                <button
                  type="button"
                  className="ai-btn"
                  style={{ padding: '10px 16px', fontSize: 13 }}
                  title="Describe the team you want; the Board AI asks what it needs and proposes the members for you to approve"
                  onClick={() =>
                    assist.ask({
                      scope: 'project',
                      fresh: true,
                      text: 'I want to set up AI members for this project. Ask me what you need to know, then propose them for me to approve.',
                    })
                  }
                  data-testid="ai-draft-members"
                >
                  ✦ Draft with AI
                </button>
              )}
              <button
                type="button"
                className="ai-btn ai-btn-primary"
                style={{ padding: '10px 16px', fontSize: 13 }}
                onClick={() => setAdding({})}
                data-testid="ai-add-member"
              >
                <span style={{ fontSize: 16, lineHeight: 1 }}>+</span> Add AI member
              </button>
            </div>
            {webBuild && members.some((m) => m.connection === 'local') && tab === 'ai' && <WebBuildNotice />}
            <div className="ai-tabs" role="tablist">
              <TabBtn id="humans" tab={tab} setTab={setTab} label="Humans" count={humans.length} />
              <TabBtn id="ai" tab={tab} setTab={setTab} label="AI" count={members.length} />
              <TabBtn
                id="accounts"
                tab={tab}
                setTab={setTab}
                label="AI accounts"
                count={accounts.data?.accounts.length ?? 0}
              />
              <TabBtn id="approvals" tab={tab} setTab={setTab} label="Inbox" count={approvals.data?.length ?? 0} />
              <TabBtn id="audit" tab={tab} setTab={setTab} label="Audit log" />
              <TabBtn id="usage" tab={tab} setTab={setTab} label="Usage" />
              <TabBtn id="safety" tab={tab} setTab={setTab} label="Safety" />
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
                (overview.isLoading ? (
                  <ListSkeleton />
                ) : overview.isError ? (
                  <ListError onRetry={() => void overview.refetch()} />
                ) : members.length === 0 ? (
                  <EmptyState onSetUp={(p) => setAdding({ provider: p })} />
                ) : (
                  <>
                    <BoardAiCard member={boardAi} onChange={() => setPicker(true)} onSettings={onOpenSettings} />
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 22,
                        fontSize: 12,
                        color: '#5B6B60',
                        margin: '16px 0 12px',
                      }}
                    >
                      <span>
                        <b style={{ color: '#1E2A22' }}>{overview.data?.summary.runningNow ?? 0}</b> running now
                      </span>
                      <span>
                        <b style={{ color: '#1E2A22' }}>{overview.data?.summary.runsToday ?? 0}</b> runs today
                      </span>
                      <span>
                        <b style={{ color: '#1E2A22' }}>{money(overview.data?.summary.spendToday)}</b> API spend today
                      </span>
                      {!!overview.data?.summary.needAttention && (
                        <span style={{ color: '#B4571F', fontWeight: 600 }}>
                          ⚠ {overview.data.summary.needAttention} need attention
                        </span>
                      )}
                      {!!overview.data?.pendingApprovals && (
                        <button type="button" className="ai-link" onClick={() => setTab('approvals')}>
                          {overview.data.pendingApprovals} approval{overview.data.pendingApprovals === 1 ? '' : 's'}{' '}
                          waiting
                        </button>
                      )}
                    </div>
                    <SignedOutBanners projectId={projectId} members={members} />
                    <MemberTable
                      members={members}
                      webBuild={webBuild}
                      onOpen={(id, t) => {
                        setProfileTab(t ?? 'overview');
                        setProfileId(id);
                      }}
                      onRemove={setRemoving}
                      onOpenTicket={onOpenTicket}
                    />
                  </>
                ))}
              {tab === 'accounts' && <AccountsTab projectId={projectId} />}
              {tab === 'approvals' && (
                <ApprovalsView projectId={projectId} humans={humans} members={members} onOpenTicket={onOpenTicket} />
              )}
              {tab === 'audit' && (
                <AuditView
                  projectId={projectId}
                  members={members}
                  onOpenTicket={onOpenTicket}
                  initial={{ memberId: initialAuditMemberId ?? undefined }}
                />
              )}
              {tab === 'usage' && <UsageView projectId={projectId} members={members} />}
              {tab === 'safety' && (
                <SafetyView projectId={projectId} members={members} onOpenAudit={() => setTab('audit')} />
              )}
            </div>
          </>
        )}
      </div>
      {adding && (
        <AddAiMemberModal
          projectId={projectId}
          projectName={projectName}
          initialProvider={adding.provider}
          webBuild={webBuild}
          onClose={() => setAdding(null)}
          onOpenProfile={(id) => {
            setAdding(null);
            setProfileTab('overview');
            setProfileId(id);
          }}
        />
      )}
      {picker && settings && (
        <BoardAiPicker
          projectId={projectId}
          members={members}
          currentId={settings.boardAiId}
          onClose={() => setPicker(false)}
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

function BoardAiCard({
  member,
  onChange,
  onSettings,
}: {
  member?: AiMember;
  onChange: () => void;
  onSettings?: () => void;
}) {
  return (
    <div
      data-testid="board-ai-card"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '16px 18px',
        borderRadius: 12,
        border: '1px solid #BFDCC7',
        background: '#F1F8F3',
      }}
    >
      {member ? (
        <AiAvatar provider={member.provider} color={member.color} glyph={member.glyph} size={44} />
      ) : (
        <span style={{ width: 44 }} />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="ai-label" style={{ color: '#2E6F40' }}>
            Board AI
          </span>
          {member && <StatusLabel status={member.status} sub={null} />}
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, marginTop: 2 }}>{member?.name ?? 'Not chosen yet'}</div>
        <div className="ai-hint" style={{ marginTop: 2 }}>
          Answers the board chatbot, drafts tickets, makes suggestions and manages the board.
          {member?.connection === 'api_key' ? ' Runs on the board with its API key.' : ''}
          {member?.connection === 'local' ? ' Runs through the CLI on this computer.' : ''}
        </div>
      </div>
      <button type="button" className="ai-btn" onClick={onChange}>
        ⟳ Change
      </button>
      {onSettings && (
        <button type="button" className="ai-btn" onClick={onSettings} data-testid="assistant-settings">
          Assistant settings
        </button>
      )}
    </div>
  );
}

function MemberTable({
  members,
  webBuild,
  onOpen,
  onRemove,
  onOpenTicket,
}: {
  members: AiMember[];
  /** The web build cannot start a local runner: those rows say it runs on the desktop. */
  webBuild: boolean;
  onOpen: (id: string, tab?: 'overview' | 'configuration') => void;
  onRemove: (m: AiMember) => void;
  onOpenTicket: (id: string) => void;
}) {
  const [menu, setMenu] = useState<string | null>(null);
  // Elapsed times of running members tick every second
  useNow(
    1000,
    members.some((m) => m.status.code === 'running'),
  );
  const toast = useToast();
  const pause = useAiMutation((m: AiMember) => (m.paused ? aiApi.resume(m.id) : aiApi.pause(m.id)));
  const test = useAiMutation((id: string) => aiApi.test(id));
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
        <div className="ai-label">AI member</div>
        <div className="ai-label">Provider</div>
        <div className="ai-label">Connection</div>
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
              <AiAvatar provider={m.provider} color={m.color} glyph={m.glyph} size={36} dim={m.paused} />
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap' }}>{m.name}</span>
                  {m.isBoardAi && (
                    <span className="ai-chip" style={{ background: '#1E2A22', color: '#fff', height: 20 }}>
                      ✦ Board AI
                    </span>
                  )}
                </div>
                <div
                  className="ai-hint"
                  style={{ marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                >
                  {m.description || (m.workingDir ? `Works in ${m.workingDir}` : PROVIDERS[m.provider].sub)}
                </div>
              </div>
            </div>
            <div>
              <ProviderChip provider={m.provider} />
            </div>
            <div>
              <ConnectionChip connection={m.connection} />
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
              {webBuild && m.connection === 'local' ? (
                <StatusLabel
                  status={{ code: 'idle', label: 'Runner on desktop', detail: null }}
                  sub={m.checkedAt ? `Last seen ${ago(m.checkedAt)}` : 'Queues until the desktop app is online'}
                />
              ) : (
                <StatusLabel
                  status={displayStatus(m)}
                  sub={displayStatus(m) !== m.status ? displayStatus(m).detail : (statusSub(m) ?? null)}
                />
              )}
            </div>
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                {m.usage.runsToday} run{m.usage.runsToday === 1 ? '' : 's'}
              </div>
              <div
                className="ai-muted"
                style={{
                  color:
                    m.connection === 'api_key' && m.dailyBudget != null && m.usage.costToday >= m.dailyBudget
                      ? '#B4571F'
                      : undefined,
                }}
              >
                {m.connection === 'api_key'
                  ? `${money(m.usage.costToday)} of ${money(m.dailyBudget)}`
                  : m.connection === 'local'
                    ? 'Not metered'
                    : '—'}
              </div>
            </div>
            <div>
              <CeilingChip ceiling={m.ceiling} />
            </div>
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
                    onClick={() => onOpen(m.id, 'configuration')}
                    data-testid={`ai-edit-${m.name}`}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="ai-mi"
                    onClick={() => {
                      setMenu(null);
                      pause.mutate(m);
                    }}
                  >
                    {m.paused ? 'Resume' : 'Pause'}
                  </button>
                  <button
                    type="button"
                    className="ai-mi"
                    onClick={async () => {
                      setMenu(null);
                      try {
                        const r = await test.mutateAsync(m.id);
                        if (r.ok) toast.success(`${m.name}: connection OK`, r.message);
                        else toast.error(`${m.name}: connection failed`, r.message);
                      } catch (err) {
                        toast.error('Test failed', extractError(err));
                      }
                    }}
                  >
                    Test connection
                  </button>
                  <div className="ai-divider" style={{ margin: '4px 0' }} />
                  <button
                    type="button"
                    className="ai-mi ai-mi-danger"
                    onClick={() => {
                      setMenu(null);
                      onRemove(m);
                    }}
                  >
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

/** The Account column: the account the member runs as, or the login on this computer as before. */
function AccountCell({ member }: { member: AiMember }) {
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

function EmptyState({ onSetUp }: { onSetUp: (p: AiProvider) => void }) {
  const cards: { p: AiProvider; title: string; sub: string }[] = [
    { p: 'claude-code', title: 'Claude Code', sub: 'Use the CLI already signed in on this computer.' },
    { p: 'antigravity', title: 'Antigravity', sub: 'Use the Antigravity CLI already signed in here.' },
    { p: 'anthropic', title: 'API key', sub: 'Anthropic, OpenAI, Gemini or custom. The board runs the agent.' },
  ];
  return (
    <div className="ai-card" style={{ padding: '36px 24px', textAlign: 'center' }} data-testid="ai-empty">
      <div style={{ fontSize: 16, fontWeight: 800 }}>No AI members yet</div>
      <div className="ai-hint" style={{ maxWidth: 520, margin: '6px auto 18px' }}>
        Add an AI member to assign tickets to it, @mention it in comments or ask it questions. Pick the quickest way to
        start.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, maxWidth: 760, margin: '0 auto' }}>
        {cards.map((c) => (
          <div
            key={c.p}
            className="ai-card"
            style={{ padding: 16, textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            <AiAvatar provider={c.p} size={32} />
            <div style={{ fontWeight: 700, fontSize: 13.5 }}>{c.title}</div>
            <div className="ai-hint" style={{ flex: 1 }}>
              {c.sub}
            </div>
            <button type="button" className="ai-btn ai-btn-sm" onClick={() => onSetUp(c.p)}>
              Set up
            </button>
          </div>
        ))}
      </div>
      <div className="ai-muted" style={{ marginTop: 16 }}>
        Tools already connected over MCP keep working; add them as “Other MCP client” to see them here.
      </div>
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
      {[0, 1, 2, 3].map((i) => (
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
      <div style={{ fontSize: 15, fontWeight: 800 }}>Could not load AI members</div>
      <div className="ai-hint" style={{ margin: '6px auto 14px', maxWidth: 420 }}>
        The board could not be reached. Nothing was changed; AI members that are running keep running.
      </div>
      <button type="button" className="ai-btn" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

/** F6: the web build cannot start a CLI on the person's own computer. */
function WebBuildNotice() {
  return (
    <div className="ai-notice ai-notice-warn" style={{ marginBottom: 14 }} data-testid="web-build-notice">
      <div>
        <b>Local runners only work in the desktop app</b>
        <div>
          This is the web build; it cannot start the Claude Code or Antigravity CLI. Their tickets queue and start when
          the desktop app is online. API-key AI members still work here.
        </div>
      </div>
    </div>
  );
}
