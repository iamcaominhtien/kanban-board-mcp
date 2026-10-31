import { useState } from 'react';
import {
  ideaRuleError,
  useAddAssumption,
  useAddEvidence,
  useCreateTestTicket,
  useDeleteAssumption,
  useDeleteEvidence,
  useEditAssumption,
} from '../../api/ideas';
import type { AssumptionImpact, AssumptionState, Idea, IdeaAssumption } from '../../types/idea';
import { useToast } from '../Toast';
import { AiChip } from './ideaShared';
import { EvidenceForm } from './IdeaEvidenceTab';

const IMPACTS: AssumptionImpact[] = ['low', 'medium', 'high'];
const STATES: AssumptionState[] = ['untested', 'testing', 'validated', 'disproved'];
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

interface Props {
  idea: Idea;
  readOnly: boolean;
  onOpenTicket: (id: string) => void;
  /** Open the Evidence tab on this assumption. */
  focusId?: string | null;
}

/** "What must be true": each assumption says how bad it is if wrong, what proof exists and how it is being tested. */
export function IdeaAssumptions({ idea, readOnly, onOpenTicket, focusId }: Props) {
  const toast = useToast();
  const add = useAddAssumption();
  const edit = useEditAssumption();
  const del = useDeleteAssumption();
  const test = useCreateTestTicket();
  const evidence = useAddEvidence();
  const removeEvidence = useDeleteEvidence();
  const [text, setText] = useState('');
  const [impact, setImpact] = useState<AssumptionImpact>('medium');
  const [openId, setOpenId] = useState<string | null>(focusId ?? null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  const fail = (title: string) => (e: unknown) => toast.error(title, ideaRuleError(e).message);

  async function addOne() {
    const t = text.trim();
    if (!t) return;
    try {
      await add.mutateAsync({ id: idea.id, text: t, impact });
      setText('');
    } catch (e) {
      fail('Could not add the assumption')(e);
    }
  }

  async function createTest(a: IdeaAssumption) {
    try {
      const res = await test.mutateAsync({ id: idea.id, assumptionId: a.id });
      toast.success(
        `Created ${res.ticket.id}`,
        'It tests this assumption. When it is Done you are asked what it showed.',
        6000,
        {
          label: 'Open ticket',
          onClick: () => onOpenTicket(res.ticket.id),
        },
      );
    } catch (e) {
      fail('Could not create the test')(e);
    }
  }

  return (
    <div data-testid="assumptions-tab">
      {idea.assumptions.length === 0 ? (
        <div className="is-empty" data-testid="no-assumptions">
          <h3>No assumptions yet</h3>
          <div>Write what must be true for this to work. Readiness stays Not started until you do.</div>
        </div>
      ) : (
        <table className="is-table">
          <thead>
            <tr>
              <th>Assumption</th>
              <th>Impact if wrong</th>
              <th>Status</th>
              <th>Evidence and test</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {idea.assumptions.map((a) => {
              const open = openId === a.id;
              return (
                <AssumptionRows key={a.id} open={open}>
                  <tr
                    className="is-row"
                    onClick={() => setOpenId(open ? null : a.id)}
                    data-testid={`assumption-${a.id}`}
                  >
                    <td style={{ maxWidth: 420 }} onClick={(e) => editing?.id === a.id && e.stopPropagation()}>
                      {editing?.id === a.id ? (
                        <input
                          className="is-input"
                          autoFocus
                          value={editing.text}
                          aria-label="Assumption text"
                          onChange={(e) => setEditing({ id: a.id, text: e.target.value })}
                          onKeyDown={async (e) => {
                            if (e.key === 'Escape') setEditing(null);
                            if (e.key === 'Enter' && editing.text.trim()) {
                              await edit
                                .mutateAsync({ id: idea.id, assumptionId: a.id, text: editing.text.trim() })
                                .catch(fail('Could not save'));
                              setEditing(null);
                            }
                          }}
                        />
                      ) : (
                        <span>
                          {a.text} {a.ai && <AiChip title="Added from the AI chat. It is yours once you edit it." />}
                        </span>
                      )}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <select
                        className="is-select"
                        value={a.impact}
                        disabled={readOnly}
                        aria-label="Impact if wrong"
                        onChange={(e) =>
                          edit.mutate(
                            { id: idea.id, assumptionId: a.id, impact: e.target.value as AssumptionImpact },
                            { onError: fail('Could not change the impact') },
                          )
                        }
                      >
                        {IMPACTS.map((i) => (
                          <option key={i} value={i}>
                            {cap(i)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <select
                        className={`is-select is-state is-state-${a.state}`}
                        value={a.state}
                        disabled={readOnly}
                        aria-label="Status"
                        onChange={(e) =>
                          edit.mutate(
                            { id: idea.id, assumptionId: a.id, status: e.target.value as AssumptionState },
                            { onError: fail('Could not change the status') },
                          )
                        }
                      >
                        {STATES.map((s) => (
                          <option key={s} value={s}>
                            {cap(s)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <span className="is-muted">
                        {a.evidence.length ? `${a.evidence.length} evidence` : 'No evidence'}
                      </span>{' '}
                      {a.testTicketId ? (
                        <button type="button" className="is-link is-mono" onClick={() => onOpenTicket(a.testTicketId!)}>
                          {a.testTicketId}
                        </button>
                      ) : (
                        !readOnly && (
                          <button
                            type="button"
                            className="is-btn is-btn-sm"
                            onClick={() => createTest(a)}
                            disabled={test.isPending}
                          >
                            Create test
                          </button>
                        )
                      )}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                      {!readOnly && (
                        <>
                          <button
                            type="button"
                            className="is-btn is-btn-ghost is-btn-sm"
                            onClick={() => setEditing({ id: a.id, text: a.text })}
                            aria-label="Edit assumption"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="is-btn is-btn-ghost is-btn-sm"
                            aria-label="Delete assumption"
                            onClick={() =>
                              window.confirm('Delete this assumption and its evidence?') &&
                              del.mutate({ id: idea.id, assumptionId: a.id }, { onError: fail('Could not delete') })
                            }
                          >
                            ×
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                  {open && (
                    <tr>
                      <td colSpan={5} className="is-detail">
                        <div className="is-label">Evidence</div>
                        {a.evidence.length === 0 && (
                          <div className="is-muted">Nothing yet. Add a comment, link, ticket, file or note.</div>
                        )}
                        {a.evidence.map((e) => (
                          <div key={e.id} className="is-evidence-line">
                            <span className="is-tag">{e.kind}</span>
                            <span>{e.title || e.ref}</span>
                            {e.title && e.kind === 'link' && (
                              <a href={e.ref} target="_blank" rel="noreferrer noopener" className="is-muted">
                                {e.ref}
                              </a>
                            )}
                            <span className="is-grow" />
                            {!readOnly && (
                              <button
                                type="button"
                                className="is-btn is-btn-ghost is-btn-sm"
                                onClick={() => removeEvidence.mutate({ id: idea.id, evidenceId: e.id })}
                              >
                                Remove
                              </button>
                            )}
                          </div>
                        ))}
                        {!readOnly && (
                          <EvidenceForm
                            ideaId={idea.id}
                            projectId={idea.projectId ?? undefined}
                            ideaTitle={idea.title}
                            assumptions={[{ id: a.id, text: a.text }]}
                            onAdd={async (v) => {
                              await evidence.mutateAsync({ id: idea.id, ...v });
                            }}
                          />
                        )}
                        {a.testTicketId && (
                          <div className="is-muted" style={{ marginTop: 8 }}>
                            When {a.testTicketId} is Done, you are asked: validated or disproved?
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </AssumptionRows>
              );
            })}
          </tbody>
        </table>
      )}
      {!readOnly && (
        <div className="is-add-assumption">
          <input
            className="is-input"
            placeholder="We believe …"
            value={text}
            aria-label="New assumption"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addOne()}
            maxLength={500}
          />
          <select
            className="is-select"
            value={impact}
            onChange={(e) => setImpact(e.target.value as AssumptionImpact)}
            aria-label="Impact if wrong"
          >
            {IMPACTS.map((i) => (
              <option key={i} value={i}>
                {cap(i)} impact
              </option>
            ))}
          </select>
          <button
            type="button"
            className="is-btn is-btn-primary"
            onClick={addOne}
            disabled={!text.trim() || add.isPending}
          >
            Add an assumption
          </button>
        </div>
      )}
    </div>
  );
}

/** Groups a row with its detail row (tbody needs a fragment-like wrapper without extra DOM). */
function AssumptionRows({ children }: { open: boolean; children: React.ReactNode }) {
  return <>{children}</>;
}
