import { useState, type ReactNode } from 'react';
import { useAiTeams, useTeamsActivity } from '../../api/ai';
import { useDocsPage } from '../../api/docs';
import { useAssignPage } from '../../api/docsWork';
import { extractError } from '../../api/extractError';
import { useMembers } from '../../api/members';
import type { AiTeam, TeamActivity } from '../../types/ai';
import { DOCS_SCRIM, useEscape } from './docsShared';
import { useTeamApply } from './suggestions/api';
import { pageApply } from './suggestions/pageAi';
import { SgIcon } from './suggestions/sgIcons';
import './suggestions/suggestions.css';

interface Props {
  projectId: string;
  page: { id: string; title: string };
  onClose: () => void;
  onGiven: (ticketId: string, member: string) => void;
}

const KINDS = [
  { id: 'review', label: 'Review it', hint: 'Comments on the passages to fix; the page is not rewritten.' },
  { id: 'write', label: 'Write it', hint: 'Writes or completes the page, one part at a time.' },
] as const;

/**
 * The line under a team in WHO (E 23): its roles and what it is doing, "Lead and Docs role · idle", "Dev, Reviewer,
 * QA · working on KAN-171", "… · paused". Null while the team is not known.
 * @param team - The team (its roles and whether it is paused).
 * @param activity - What its lead and roles do now.
 */
export function teamSubline(team: AiTeam | undefined, activity: TeamActivity | undefined): string | null {
  if (!team) return null;
  const names = team.roles.map((r) => r.name || r.key).filter(Boolean);
  const roles = names.length === 0 ? 'Lead' : names.length === 1 ? `Lead and ${names[0]} role` : names.join(', ');
  const now = [activity?.lead, ...(activity?.roles ?? [])].find((a) => a?.working)?.working ?? null;
  const state = team.paused ? 'paused' : now ? (now.ticketId ? `working on ${now.ticketId}` : 'working') : 'idle';
  return `${roles} · ${state}`;
}

/**
 * Give a page to an AI team to write or review (#268). It becomes a ticket "Write/Review the page “X”", linked to the
 * page and assigned to the member, whose run starts; the page shows what it is doing. Drawn as on the board ("AI teams
 * on rich pages" E 23–24): a line says how the changes arrive, and an empty page is written as a private draft.
 * @param props.projectId - The page's project (its AI members are listed).
 * @param props.page - The page to give.
 * @param props.onClose - Dismiss the dialog.
 * @param props.onGiven - Called with the new ticket and the member's name.
 */
export function GivePageDialog({ projectId, page, onClose, onGiven }: Props) {
  const ais = (useMembers(projectId).data ?? []).filter((m) => m.kind === 'ai');
  const teams = useAiTeams(projectId).data;
  const activity = useTeamsActivity(projectId).data;
  const full = useDocsPage(page.id).data;
  const teamApply = useTeamApply(projectId).data?.aiApply;
  // an empty page is written from nothing: Write it is chosen and the team writes a private draft
  const empty = !!full && full.version === 0 && !(full.draft?.markdown ?? '').trim();
  const [memberId, setMemberId] = useState<string | null>(null);
  const [picked, setPicked] = useState<'write' | 'review' | null>(null);
  const kind = picked ?? (empty ? 'write' : 'review');
  const [instruction, setInstruction] = useState('');
  const [error, setError] = useState<string | null>(null);
  const assign = useAssignPage(page.id);
  const chosen = memberId ?? ais[0]?.id ?? null;
  const direct = (pageApply(full?.settings) ?? (chosen ? teamApply?.[chosen] : null)) === 'direct';
  useEscape(onClose);

  async function give() {
    if (!chosen) return;
    setError(null);
    try {
      const out = await assign.mutateAsync({ memberId: chosen, kind, instruction: instruction.trim() || undefined });
      if (out.error) {
        setError(`${out.ticket.id} was made and linked, but the run did not start: ${out.error}`);
        return;
      }
      onGiven(out.ticket.id, ais.find((m) => m.id === chosen)?.name ?? 'The AI');
    } catch (err) {
      setError(extractError(err));
    }
  }

  const radio = (on: boolean, label: string, hint: ReactNode, onPick: () => void, name: string) => (
    <label key={label} className="gp-opt">
      <input type="radio" name={name} checked={on} onChange={onPick} className="gp-radio-input" />
      <span className="sg-radio gp-radio" aria-hidden="true" data-on={on || undefined} />
      <span>
        <span className="gp-opt-label">{label}</span>
        {hint && <span className="gp-opt-hint">{hint}</span>}
      </span>
    </label>
  );
  return (
    <div className="gp-scrim docs-root" style={{ background: DOCS_SCRIM }} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Give the page to an AI team"
        data-testid="docs-give-page"
        className="gp-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="gp-head">
          <span className="gp-badge" aria-hidden="true">
            <SgIcon name="spark" size={17} />
          </span>
          <div className="gp-head-text">
            <div className="gp-title">Give “{page.title}” to an AI team</div>
            <div className="gp-sub">A ticket linked to the page, assigned to the team, and its run started</div>
          </div>
          <button type="button" className="gp-x" aria-label="Close" onClick={onClose}>
            <SgIcon name="close" size={16} />
          </button>
        </div>
        <div className="gp-body">
          {ais.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13.5, color: '#5B6B60' }}>
              This project has no AI team yet. Add one in Members, then give it the page.
            </p>
          ) : (
            <>
              <fieldset className="gp-field">
                <legend className="gp-label">WHO</legend>
                <div className="gp-opts">
                  {ais.map((m) =>
                    radio(
                      chosen === m.id,
                      m.name,
                      teamSubline(
                        teams?.find((t) => t.id === m.id),
                        activity?.[m.id],
                      ),
                      () => setMemberId(m.id),
                      'give-member',
                    ),
                  )}
                </div>
              </fieldset>
              <fieldset className="gp-field">
                <legend className="gp-label">TO</legend>
                <div className="gp-opts">
                  {KINDS.map((k) => radio(kind === k.id, k.label, k.hint, () => setPicked(k.id), 'give-kind'))}
                </div>
              </fieldset>
              <label className="gp-field">
                <span className="gp-label">WHAT YOU WANT (OPTIONAL)</span>
                <textarea
                  className="gp-text"
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  rows={3}
                  placeholder={
                    kind === 'write'
                      ? 'Write this as a blog post for customers. Centre the title, add a pull quote.'
                      : 'Check the error cases against the API'
                  }
                />
                {kind === 'write' && (
                  <span className="gp-hint">
                    You can ask for formatting in plain words: centred title, pull quote, picture on the right, green
                    for tips. The team uses the page’s named colours.
                  </span>
                )}
              </label>
              <div className="gp-line" data-testid="give-page-arrive">
                <SgIcon name="wand" size={14} color="#5B3AA6" />
                <span>
                  {empty ? (
                    'This page is empty, so the team writes a private draft.'
                  ) : direct ? (
                    <>
                      Its changes are <b>saved on this page</b> at once. Undo is in History.
                    </>
                  ) : (
                    <>
                      Its comments and changes arrive as <b>suggestions</b> on this page.
                    </>
                  )}
                </span>
              </div>
            </>
          )}
          {error && (
            <p role="alert" style={{ margin: 0, fontSize: 13, color: '#B42318' }}>
              {error}
            </p>
          )}
        </div>
        <div className="gp-foot">
          <span style={{ flex: 1 }} />
          <button type="button" className="sg-btn sg-btn-dlg" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="sg-btn sg-btn-dlg sg-btn-primary"
            disabled={!chosen || assign.isPending}
            onClick={() => void give()}
          >
            {assign.isPending ? 'Giving…' : 'Give the page'}
          </button>
        </div>
      </div>
    </div>
  );
}
