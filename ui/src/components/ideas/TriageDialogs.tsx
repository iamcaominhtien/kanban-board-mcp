import { useMemo, useState } from 'react';
import { extractError } from '../../api/extractError';
import { useIdeaList, useMergeIdea, useMoveIdea, useSimilar, useTagSuggestions } from '../../api/ideas';
import { useProjects } from '../../api/projects';
import type { ArchiveReason, Idea } from '../../types/idea';
import { ARCHIVE_REASON_LABELS, STAGE_LABELS } from '../../types/idea';
import { FooterNote, ModalShell, Spacer } from '../docs/docsShared';
import { StagePill, dateIn } from './ideaShared';

type Subject = Pick<Idea, 'id' | 'title' | 'projectId' | 'tags' | 'body' | 'description' | 'stage'>;

interface DialogProps {
  idea: Subject;
  onClose: () => void;
  /** Called after the server accepted the decision, with the toast text for the Undo. */
  onDone: (message: string, undo?: 'move' | 'merge', targetId?: string) => void;
}

/** The select that picks a project, or "No project". */
export function ProjectSelect({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const { data: projects = [] } = useProjects();
  return (
    <select
      className="is-select"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      aria-label="Project"
      style={{ width: '100%' }}
    >
      <option value="">No project</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} ({p.prefix})
        </option>
      ))}
    </select>
  );
}

/** Tag editor: a row of chips with an input that adds on Enter or comma. */
export function TagInput({
  tags,
  onChange,
  suggestions = [],
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  suggestions?: string[];
}) {
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const t = raw.trim().toLowerCase();
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setDraft('');
  };
  return (
    <div>
      <div className="is-tagbox">
        {tags.map((t) => (
          <span key={t} className="is-tag">
            {t}{' '}
            <button
              type="button"
              aria-label={`Remove ${t}`}
              className="is-x"
              onClick={() => onChange(tags.filter((x) => x !== t))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          className="is-tagin"
          value={draft}
          placeholder={tags.length ? '' : '+ tag'}
          aria-label="Add a tag"
          onChange={(e) => {
            if (e.target.value.endsWith(',')) add(e.target.value.slice(0, -1));
            else setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) {
              e.preventDefault();
              e.stopPropagation();
              add(draft);
            }
            if (e.key === 'Backspace' && !draft && tags.length) onChange(tags.slice(0, -1));
          }}
          onBlur={() => draft.trim() && add(draft)}
        />
      </div>
      {suggestions.filter((s) => !tags.includes(s)).length > 0 && (
        <div className="is-suggest-tags">
          <span className="is-muted">Suggested tags</span>
          {suggestions
            .filter((s) => !tags.includes(s))
            .map((s) => (
              <button key={s} type="button" className="is-tag is-tag-btn" onClick={() => onChange([...tags, s])}>
                + {s}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

/** Keep: start exploring the idea. The project and tags can be set in the same step. */
export function KeepDialog({ idea, onClose, onDone }: DialogProps) {
  const move = useMoveIdea();
  const [projectId, setProjectId] = useState<string | null>(idea.projectId);
  const [tags, setTags] = useState<string[]>(idea.tags);
  const [error, setError] = useState<string | null>(null);
  const suggestions = useTagSuggestions(`${idea.title} ${idea.description}`, idea.id).data ?? [];

  async function submit() {
    setError(null);
    try {
      await move.mutateAsync({
        id: idea.id,
        to: 'exploring',
        via: 'Keep',
        projectId: projectId && projectId !== idea.projectId ? projectId : undefined,
        tags: tags.join() === idea.tags.join() ? undefined : tags,
      });
      onDone(`Kept “${idea.title}”: Exploring`, 'move');
    } catch (e) {
      setError(extractError(e));
    }
  }

  return (
    <ModalShell
      width={440}
      ariaLabel="Keep this idea"
      title="Keep this idea"
      subtitle="It moves to Exploring. You can open the page right away."
      onClose={onClose}
      footer={
        <>
          {error && <FooterNote>{error}</FooterNote>}
          <Spacer />
          <button type="button" className="is-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="is-btn is-btn-primary" onClick={submit} disabled={move.isPending}>
            Keep
          </button>
        </>
      }
    >
      <div className="is-root is-dlg-body" style={{ flex: 'none', background: 'transparent' }}>
        <div className="is-field">
          <span className="is-label">Project</span>
          <ProjectSelect value={projectId} onChange={setProjectId} />
          <span className="is-muted">
            Or “No project”. You can explore it either way, but promoting needs a project.
          </span>
        </div>
        <div className="is-field">
          <span className="is-label">Tags</span>
          <TagInput tags={tags} onChange={setTags} suggestions={suggestions} />
        </div>
      </div>
    </ModalShell>
  );
}

const PARK_CHOICES = [
  { label: 'Next week', days: 7 },
  { label: 'In a month', days: 30 },
  { label: 'In 3 months', days: 90 },
];

/** Park: "for good ideas at a bad time". It returns to the Inbox on the chosen date. */
export function ParkDialog({ idea, onClose, onDone }: DialogProps) {
  const move = useMoveIdea();
  const [date, setDate] = useState(dateIn(7));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      await move.mutateAsync({
        id: idea.id,
        to: 'parked',
        parkUntil: date,
        parkNote: note.trim() || undefined,
        via: 'Park',
      });
      onDone(`Parked “${idea.title}” until ${date}`, 'move');
    } catch (e) {
      setError(extractError(e));
    }
  }

  return (
    <ModalShell
      width={420}
      ariaLabel="Park this idea"
      title="Park this idea"
      subtitle="For good ideas at a bad time."
      onClose={onClose}
      footer={
        <>
          {error && <FooterNote>{error}</FooterNote>}
          <Spacer />
          <button type="button" className="is-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="is-btn is-btn-primary" onClick={submit} disabled={move.isPending || !date}>
            Park
          </button>
        </>
      }
    >
      <div className="is-root is-dlg-body" style={{ flex: 'none', background: 'transparent' }}>
        <div className="is-field">
          <span className="is-label">Bring it back</span>
          <div className="is-radio-row">
            {PARK_CHOICES.map((c) => (
              <button
                key={c.label}
                type="button"
                className="is-choice"
                aria-pressed={date === dateIn(c.days)}
                onClick={() => setDate(dateIn(c.days))}
              >
                {c.label}
              </button>
            ))}
          </div>
          <input
            className="is-input"
            type="date"
            value={date}
            min={dateIn(0)}
            onChange={(e) => setDate(e.target.value)}
            aria-label="Pick a date"
          />
        </div>
        <div className="is-field">
          <span className="is-label">Note (optional)</span>
          <input
            className="is-input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why now is a bad time"
          />
        </div>
        <span className="is-muted">
          It leaves the lists and returns to your Inbox on that day, marked “Back from parked”.
        </span>
      </div>
    </ModalShell>
  );
}

/** Archive: not doing it. The reason is kept so the same idea is not rebuilt by accident. */
export function ArchiveDialog({ idea, onClose, onDone }: DialogProps) {
  const move = useMoveIdea();
  const [reason, setReason] = useState<ArchiveReason | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!reason) return;
    setError(null);
    try {
      await move.mutateAsync({
        id: idea.id,
        to: 'archived',
        archiveReason: reason,
        archiveNote: note.trim() || undefined,
        via: 'Archive',
      });
      onDone(`Archived “${idea.title}”`, 'move');
    } catch (e) {
      setError(extractError(e));
    }
  }

  return (
    <ModalShell
      width={440}
      ariaLabel="Archive this idea"
      title="Archive this idea"
      subtitle="The reason is kept so the same idea is not rebuilt by accident."
      onClose={onClose}
      footer={
        <>
          {error && <FooterNote>{error}</FooterNote>}
          <Spacer />
          <button type="button" className="is-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="is-btn is-btn-danger" onClick={submit} disabled={!reason || move.isPending}>
            Archive
          </button>
        </>
      }
    >
      <div className="is-root is-dlg-body" style={{ flex: 'none', background: 'transparent' }}>
        <div className="is-field">
          <span className="is-label">Why?</span>
          <div className="is-radio-row" role="radiogroup" aria-label="Reason">
            {(Object.keys(ARCHIVE_REASON_LABELS) as ArchiveReason[]).map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={reason === r}
                className="is-choice"
                aria-pressed={reason === r}
                onClick={() => setReason(r)}
              >
                {ARCHIVE_REASON_LABELS[r]}
              </button>
            ))}
          </div>
        </div>
        <div className="is-field">
          <span className="is-label">Note (optional)</span>
          <textarea
            className="is-textarea"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Others will see it when they search."
          />
        </div>
      </div>
    </ModalShell>
  );
}

/** Merge into another idea: its text and source are added there and you count as a +1. */
export function MergeDialog({ idea, onClose, onDone }: DialogProps) {
  const merge = useMergeIdea();
  const [q, setQ] = useState('');
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const similarQuery = useSimilar(`${idea.title} ${idea.body || idea.description}`, {
    exclude: idea.id,
    kinds: ['idea'],
  });
  const similar = useMemo(() => similarQuery.data ?? [], [similarQuery.data]);
  const search = useIdeaList({ scope: 'all', q, sort: 'updated' }, q.trim().length > 1);
  const scores = useMemo(() => new Map(similar.map((s) => [s.id, s.score])), [similar]);

  const candidates = useMemo(() => {
    const fromSearch = (search.data ?? []).filter(
      (i) => i.id !== idea.id && !['archived', 'building', 'shipped'].includes(i.stage),
    );
    if (q.trim().length > 1) return fromSearch.map((i) => ({ id: i.id, title: i.title, stage: i.stage }));
    return similar
      .filter((s) => s.stage && !['archived', 'building', 'shipped'].includes(s.stage))
      .map((s) => ({ id: s.id, title: s.title, stage: s.stage! }));
  }, [search.data, similar, q, idea.id]);

  async function submit() {
    if (!target) return;
    setError(null);
    try {
      await merge.mutateAsync({ id: idea.id, intoId: target });
      onDone(`Merged “${idea.title}” into ${target}`, 'merge', target);
    } catch (e) {
      setError(extractError(e));
    }
  }

  return (
    <ModalShell
      width={480}
      ariaLabel="Merge into another idea"
      title="Merge into another idea"
      subtitle="Also works across Inbox and active ideas."
      onClose={onClose}
      footer={
        <>
          {error ? (
            <FooterNote>{error}</FooterNote>
          ) : (
            <FooterNote>You can undo a merge for 10 minutes after.</FooterNote>
          )}
          <Spacer />
          <button type="button" className="is-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="is-btn is-btn-primary"
            onClick={submit}
            disabled={!target || merge.isPending}
          >
            Merge
          </button>
        </>
      }
    >
      <div className="is-root is-dlg-body" style={{ flex: 'none', background: 'transparent' }}>
        <input
          className="is-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search ideas to merge into"
          aria-label="Search ideas"
          autoFocus
        />
        <div className="is-pick-list" role="radiogroup" aria-label="Idea to merge into" style={{ marginTop: 10 }}>
          {candidates.length === 0 && (
            <span className="is-muted">
              {q.trim().length > 1 ? 'No idea found.' : 'No similar idea found. Search by title.'}
            </span>
          )}
          {candidates.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={target === c.id}
              className="is-pick"
              onClick={() => setTarget(c.id)}
            >
              <span className="is-grow">{c.title}</span>
              <StagePill stage={c.stage} />
              {scores.has(c.id) && (
                <span className="is-muted">{Math.round((scores.get(c.id) ?? 0) * 100)}% similar</span>
              )}
            </button>
          ))}
        </div>
        <p className="is-muted" style={{ marginTop: 10 }}>
          Merging adds this text and its source to that idea and counts you as a +1. Nothing is lost: this idea is
          archived as merged ({STAGE_LABELS[idea.stage]} now).
        </p>
      </div>
    </ModalShell>
  );
}
