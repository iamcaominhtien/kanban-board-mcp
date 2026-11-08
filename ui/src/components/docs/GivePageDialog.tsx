import { useState } from 'react';
import { useAssignPage } from '../../api/docsWork';
import { extractError } from '../../api/extractError';
import { useMembers } from '../../api/members';
import { ModalShell, Spacer } from './docsShared';

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
 * Give a page to an AI team to write or review (#268). It becomes a ticket "Write/Review the page “X”", linked to the
 * page and assigned to the member, whose run starts; the page shows what it is doing.
 * @param props.projectId - The page's project (its AI members are listed).
 * @param props.page - The page to give.
 * @param props.onClose - Dismiss the dialog.
 * @param props.onGiven - Called with the new ticket and the member's name.
 */
export function GivePageDialog({ projectId, page, onClose, onGiven }: Props) {
  const ais = (useMembers(projectId).data ?? []).filter((m) => m.kind === 'ai');
  const [memberId, setMemberId] = useState<string | null>(null);
  const [kind, setKind] = useState<'write' | 'review'>('review');
  const [instruction, setInstruction] = useState('');
  const [error, setError] = useState<string | null>(null);
  const assign = useAssignPage(page.id);
  const chosen = memberId ?? ais[0]?.id ?? null;

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

  const label = { fontSize: 12, fontWeight: 700, color: '#5B6B60', letterSpacing: 0.3 } as const;
  return (
    <ModalShell
      width={520}
      ariaLabel="Give the page to an AI team"
      icon="i11"
      title={<>Give “{page.title}” to an AI team</>}
      subtitle="A ticket linked to the page, assigned to the member, and its run started"
      onClose={onClose}
      testId="docs-give-page"
      bodyStyle={{ padding: '16px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}
      footer={
        <>
          <Spacer />
          <button type="button" className="st-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="st-btn st-btn-primary"
            disabled={!chosen || assign.isPending}
            onClick={() => void give()}
          >
            {assign.isPending ? 'Giving…' : 'Give the page'}
          </button>
        </>
      }
    >
      {ais.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13.5, color: '#5B6B60' }}>
          This project has no AI team yet. Add one in Members, then give it the page.
        </p>
      ) : (
        <>
          <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <legend style={{ ...label, marginBottom: 6 }}>WHO</legend>
            {ais.map((m) => (
              <label
                key={m.id}
                style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, color: '#1E2A22' }}
              >
                <input type="radio" name="give-member" checked={chosen === m.id} onChange={() => setMemberId(m.id)} />
                {m.name}
              </label>
            ))}
          </fieldset>
          <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <legend style={{ ...label, marginBottom: 6 }}>TO</legend>
            {KINDS.map((k) => (
              <label key={k.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13.5 }}>
                <input
                  type="radio"
                  name="give-kind"
                  checked={kind === k.id}
                  onChange={() => setKind(k.id)}
                  style={{ marginTop: 3 }}
                />
                <span>
                  <span style={{ fontWeight: 600, color: '#1E2A22' }}>{k.label}</span>
                  <span style={{ display: 'block', fontSize: 12.5, color: '#5B6B60' }}>{k.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={label}>WHAT YOU WANT (OPTIONAL)</span>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={3}
              placeholder="Check the error cases against the API"
              style={{
                resize: 'vertical',
                padding: '8px 10px',
                borderRadius: 8,
                border: '1px solid #CFDDD3',
                fontSize: 13.5,
                fontFamily: 'inherit',
                color: '#1E2A22',
              }}
            />
          </label>
        </>
      )}
      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: '#B42318' }}>
          {error}
        </p>
      )}
    </ModalShell>
  );
}
