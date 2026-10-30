import { useEffect, useState } from 'react';
import { ideaRuleError, usePromoteIdea, usePromotePreview } from '../../api/ideas';
import { useIdeaAiStatus, usePrepareTicket } from '../../api/ideaAi';
import { useTicketWorkspace } from '../../api/tickets';
import type { Project } from '../../types';
import type { Idea } from '../../types/idea';
import { FooterNote, ModalShell, Spacer, plural } from '../docs/docsShared';
import { useToast } from '../Toast';
import { ProjectSelect } from './TriageDialogs';

type Subject = Pick<Idea, 'id' | 'title' | 'projectId' | 'stage'>;

interface Props {
  idea: Subject;
  projects: Project[];
  onClose: () => void;
  onOpenTicket: (id: string) => void;
  onPromoted: (ticketId: string) => void;
  /** Called with the idea's AI-drafted fields once step "Prepare the ticket" is on (see Idea AI). */
  extra?: React.ReactNode;
}

const COLUMNS = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'todo', label: 'To do' },
  { id: 'in-progress', label: 'In progress' },
] as const;

/** Promote: a preview of the ticket before anything is created. Nothing is written until Create. */
export function PromoteDialog({ idea, projects, onClose, onOpenTicket, onPromoted, extra }: Props) {
  const toast = useToast();
  const promote = usePromoteIdea();
  const [projectId, setProjectId] = useState<string | null>(idea.projectId);
  const preview = usePromotePreview(idea.id, projectId);
  const p = preview.data;

  const [createAs, setCreateAs] = useState<'one' | 'split'>('one');
  const [title, setTitle] = useState(idea.title);
  const [type, setType] = useState<'bug' | 'feature' | 'task' | 'chore'>('feature');
  const [priority, setPriority] = useState<'low' | 'medium' | 'high' | 'critical'>('medium');
  const [status, setStatus] = useState<(typeof COLUMNS)[number]['id']>('backlog');
  const [description, setDescription] = useState<string | null>(null);
  const [subs, setSubs] = useState<string[]>(['']);
  const [ack, setAck] = useState(false);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<'move' | 'copy' | 'leave'>('move');
  const idea_ws = useTicketWorkspace(idea.id).data;
  const wsFiles = idea_ws?.exists ? idea_ws.fileCount : 0;
  const aiStatus = useIdeaAiStatus(idea.projectId).data;
  const prepare = usePrepareTicket();
  const [error, setError] = useState<string | null>(null);

  // the first preview fills in the description; the person may then edit it
  useEffect(() => {
    if (p && description === null) setDescription(p.draft.description);
  }, [p, description]);

  const target = projectId ?? p?.projectId ?? null;
  const project = projects.find((x) => x.id === target);
  const blockers = p?.blockers ?? [];
  const notReady = !!p?.notReady;
  const needsProject = blockers.includes('needs_project');
  const stageBlocked = blockers.find((b) => b.startsWith('stage_'));
  const cleanSubs = subs.map((s) => s.trim()).filter(Boolean);
  const canCreate =
    !!p &&
    !p.alreadyPromotedTicket &&
    !stageBlocked &&
    !!target &&
    (!notReady || ack) &&
    (createAs === 'one' || cleanSubs.length > 0);

  /** "Prepare the ticket": the AI drafts the text, acceptance criteria and a split; the person edits before Create. */
  async function draftWithAi() {
    setError(null);
    try {
      const r = await prepare.mutateAsync(idea.id);
      if (r.title) setTitle(r.title);
      const criteria = r.acceptanceCriteria.length
        ? `\n\n### Acceptance criteria\n\n${r.acceptanceCriteria.map((c) => `- [ ] ${c}`).join('\n')}`
        : '';
      if (r.description) setDescription(`${r.description}${criteria}`);
      if (r.subTickets.length) {
        setCreateAs('split');
        setSubs(r.subTickets);
      }
      setAiNote(`Drafted by ${r.member}. Edit what you want before Create.`);
    } catch (e) {
      setError(`${ideaRuleError(e).message} Nothing was changed.`);
    }
  }

  async function create() {
    setError(null);
    try {
      const res = await promote.mutateAsync({
        id: idea.id,
        projectId: target,
        title: title.trim() || idea.title,
        type,
        priority,
        status,
        description: description ?? undefined,
        subTickets: createAs === 'split' ? cleanSubs : [],
        acknowledgeNotReady: ack,
        workspace: wsFiles > 0 ? workspace : 'leave',
      });
      toast.success(`Created ${res.ticket.id}`, `The idea is Building and follows ${res.ticket.id}.`, 7000, {
        label: 'Open ticket',
        onClick: () => onOpenTicket(res.ticket.id),
      });
      onPromoted(res.ticket.id);
    } catch (e) {
      const rule = ideaRuleError(e);
      setError(
        rule.code === 'already_promoted'
          ? `This idea already became ${String(rule.extra.ticketId ?? '')}.`
          : rule.message,
      );
    }
  }

  const body = (() => {
    if (preview.isLoading) return <div className="is-empty">Building the preview…</div>;
    if (preview.isError || !p) {
      return (
        <div className="is-empty">
          <h3>Could not build the preview</h3>
          <button type="button" className="is-btn" onClick={() => preview.refetch()}>
            Try again
          </button>
        </div>
      );
    }
    if (p.alreadyPromotedTicket) {
      return (
        <div className="is-empty" data-testid="already-promoted">
          <h3>Already a ticket</h3>
          <div>This idea became {p.alreadyPromotedTicket.id}. Open it instead.</div>
          <button
            type="button"
            className="is-btn is-btn-primary"
            style={{ marginTop: 12 }}
            onClick={() => onOpenTicket(p.alreadyPromotedTicket!.id)}
          >
            Open {p.alreadyPromotedTicket.id}
          </button>
        </div>
      );
    }
    if (stageBlocked) {
      return (
        <div className="is-empty">
          <h3>Not now</h3>
          <div>
            An idea that is {stageBlocked.replace('stage_', '')} cannot be promoted. Bring it back to Exploring first.
          </div>
        </div>
      );
    }
    return (
      <div className="is-promote">
        <div className="is-promote-form">
          <div className="is-field">
            <span className="is-label">Create as</span>
            <div className="is-radio-row">
              <button
                type="button"
                className="is-choice"
                aria-pressed={createAs === 'one'}
                onClick={() => setCreateAs('one')}
              >
                One ticket
              </button>
              <button
                type="button"
                className="is-choice"
                aria-pressed={createAs === 'split'}
                onClick={() => setCreateAs('split')}
              >
                Ticket with sub-tickets
              </button>
            </div>
          </div>
          <div className="is-field">
            <span className="is-label">Project</span>
            <ProjectSelect value={target} onChange={setProjectId} />
            {needsProject && !target && (
              <span className="is-muted">
                This idea does not belong to a project yet. Choosing one here also assigns the idea to it.
              </span>
            )}
            {idea.projectId && target && target !== idea.projectId && (
              <span className="is-muted">
                The idea stays in its project. The ticket is created in {project?.name}; people outside it see only the
                key.
              </span>
            )}
          </div>
          <div className="is-field">
            <span className="is-label">Title</span>
            <input
              className="is-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              aria-label="Ticket title"
            />
          </div>
          {aiStatus?.state === 'on' && (
            <div className="is-field">
              <button
                type="button"
                className="is-btn is-btn-sm"
                style={{ alignSelf: 'flex-start' }}
                onClick={draftWithAi}
                disabled={prepare.isPending}
                data-testid="draft-with-ai"
              >
                <span aria-hidden="true">✦</span>{' '}
                {prepare.isPending ? 'Drafting…' : `Draft with AI · about $${aiStatus.hints.ticket.toFixed(2)}`}
              </button>
              {aiNote && <span className="is-muted">{aiNote}</span>}
            </div>
          )}
          <div className="is-promote-row">
            <label className="is-field">
              <span className="is-label">Type</span>
              <select className="is-select" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
                {['feature', 'task', 'bug', 'chore'].map((t) => (
                  <option key={t} value={t}>
                    {t[0].toUpperCase() + t.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <label className="is-field">
              <span className="is-label">Priority</span>
              <select
                className="is-select"
                value={priority}
                onChange={(e) => setPriority(e.target.value as typeof priority)}
              >
                {['low', 'medium', 'high', 'critical'].map((t) => (
                  <option key={t} value={t}>
                    {t[0].toUpperCase() + t.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <label className="is-field">
              <span className="is-label">Column</span>
              <select className="is-select" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
                {COLUMNS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {createAs === 'split' && (
            <div className="is-field">
              <span className="is-label">Sub-tickets (you can rename or remove each)</span>
              {subs.map((s, i) => (
                <div key={i} style={{ display: 'flex', gap: 6 }}>
                  <input
                    className="is-input"
                    value={s}
                    placeholder="Sub-ticket title"
                    aria-label={`Sub-ticket ${i + 1}`}
                    onChange={(e) => setSubs(subs.map((x, k) => (k === i ? e.target.value : x)))}
                  />
                  <button
                    type="button"
                    className="is-btn is-btn-sm"
                    aria-label="Remove"
                    onClick={() => setSubs(subs.length > 1 ? subs.filter((_, k) => k !== i) : [''])}
                  >
                    ×
                  </button>
                </div>
              ))}
              {subs.length < 10 && (
                <button
                  type="button"
                  className="is-link"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={() => setSubs([...subs, ''])}
                >
                  + Add a sub-ticket
                </button>
              )}
              <span className="is-muted">The idea links to the parent. The sub-tickets are normal tickets.</span>
            </div>
          )}
          <div className="is-field">
            <span className="is-label">Description (built from the idea; you can edit it here)</span>
            <textarea
              className="is-textarea"
              rows={10}
              value={description ?? ''}
              onChange={(e) => setDescription(e.target.value)}
              aria-label="Ticket description"
            />
          </div>
          {wsFiles > 0 && (
            <div className="is-field" data-testid="workspace-choice">
              <span className="is-label">
                This idea has a workspace with {wsFiles} {wsFiles === 1 ? 'file' : 'files'}. What should happen to it?
              </span>
              {(
                [
                  [
                    'move',
                    'Move it to the ticket',
                    `The folder becomes the ticket’s workspace. Files are not copied twice.`,
                  ],
                  ['copy', 'Copy it to the ticket', 'The idea keeps its own folder too.'],
                  ['leave', 'Leave it with the idea', 'The ticket gets an empty workspace.'],
                ] as const
              ).map(([v, label, hint]) => (
                <label key={v} className="is-check">
                  <input type="radio" name="ws" checked={workspace === v} onChange={() => setWorkspace(v)} />
                  <span>
                    <b>{label}</b> <span className="is-muted">{hint}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
          {extra}
          {p.draft.checklist.length > 0 && (
            <div className="is-field">
              <span className="is-label">Still to check (becomes the ticket’s checklist)</span>
              {p.draft.checklist.map((c) => (
                <div key={c.assumptionId} className="is-muted">
                  ☐ {c.text}
                  {c.testTicketId ? ` (test ${c.testTicketId})` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
        <aside className="is-promote-side">
          <div className="is-label">What comes with it</div>
          <ul className="is-carry">
            <li>
              <b>Problem and idea text</b> → Description
            </li>
            <li>
              <b>Open assumptions</b> ({p.carried.openAssumptions}) → Checklist, each with its test ticket
            </li>
            <li>
              <b>Validated assumptions</b> ({p.carried.validatedAssumptions}) → An “Already confirmed” list
            </li>
            <li>
              <b>Evidence</b> ({p.carried.evidence}) → Stays on the idea; the ticket links to it
            </li>
            {p.draft.demand && (
              <li>
                <b>Demand</b> → A note: “{p.draft.demand}”
              </li>
            )}
            <li>
              <b>Research log and activity</b> ({plural(p.carried.logEntries, 'entry', 'entries')}) → Stay on the idea
            </li>
            {p.carried.disprovedAssumptions > 0 && (
              <li>
                <b>Disproved assumptions</b> ({p.carried.disprovedAssumptions}) → Not copied. Kept on the idea.
              </li>
            )}
          </ul>
          {notReady && (
            <div className="is-banner is-banner-warn" data-testid="not-ready">
              <div>
                <b>Not fully tested.</b> {p.notReady!.highOpen} high-impact{' '}
                {p.notReady!.highOpen === 1 ? 'assumption is' : 'assumptions are'} not validated yet
                {p.readiness.state === 'not_started' ? ' (no assumptions were written)' : ''}. You can promote anyway;
                open ones are carried over as checklist items.
                <label style={{ display: 'flex', gap: 7, alignItems: 'center', marginTop: 8, fontWeight: 600 }}>
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand,
                  promote anyway
                </label>
                {!ack && <div className="is-muted">Tick this to turn on Create ticket.</div>}
              </div>
            </div>
          )}
          <p className="is-muted" style={{ marginTop: 10 }}>
            The idea stays where it is. It links to the ticket and follows its status, even when the ticket is in
            another project.
          </p>
        </aside>
      </div>
    );
  })();

  return (
    <ModalShell
      width={820}
      ariaLabel="Promote to ticket"
      title="Promote to ticket"
      subtitle="Preview. Nothing is created until you press Create."
      onClose={onClose}
      zIndex={1250}
      testId="promote-dialog"
      footer={
        <>
          {error ? (
            <FooterNote>{error}</FooterNote>
          ) : (
            <FooterNote>
              {target
                ? `Creates a ticket in ${project?.name ?? 'the project'} · ${COLUMNS.find((c) => c.id === status)?.label}`
                : 'Choose a project to promote'}
            </FooterNote>
          )}
          <Spacer />
          <button type="button" className="is-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="is-btn is-btn-primary"
            disabled={!canCreate || promote.isPending}
            onClick={create}
            data-testid="create-ticket"
          >
            Create ticket
          </button>
        </>
      }
    >
      <div className="is-root" style={{ flex: 'none', background: 'transparent' }}>
        {body}
      </div>
    </ModalShell>
  );
}
