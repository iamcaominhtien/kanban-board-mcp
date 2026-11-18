/**
 * The read-only role in the page bar (RichDocsStates frame 57): a blue chip that names the role, and one tap away the
 * reason Edit is off, with a way to ask the project admin for edit access.
 */

import { useEffect, useRef, useState } from 'react';
import { useRequestDocsAccess } from '../../../api/docsAccess';
import { StIcon } from './stIcons';
import './states.css';

interface Props {
  projectId: string;
  projectName: string;
  /** The reader's role in the project. */
  role: 'viewer' | 'member' | 'admin';
  /** Why Edit is off, when it is not the role itself (an edit policy). */
  reason: string;
  admins: string[];
}

const ROLE: Record<Props['role'], string> = { viewer: 'Viewer', member: 'Member', admin: 'Admin' };

/**
 * The role chip and its note.
 * @param props.projectId - The project (the request goes to its admins).
 * @param props.projectName - Named in the note.
 * @param props.role - The reader's role.
 * @param props.reason - Why this reader cannot edit (the space's edit policy).
 * @param props.admins - The project admins; the first is named.
 */
export function ViewerNote({ projectId, projectName, role, reason, admins }: Props) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState<null | 'sent' | 'asked' | 'error'>(null);
  const ask = useRequestDocsAccess(projectId);
  const ref = useRef<HTMLDivElement>(null);
  const admin = admins[0];
  useEffect(() => {
    if (!open) return undefined;
    const down = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  const request = async () => {
    try {
      const r = await ask.mutateAsync(`Edit access to Docs in ${projectName}`);
      setSent(r.sent ? 'sent' : 'asked');
    } catch {
      setSent('error');
    }
  };
  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        className="dst-role-chip"
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="role-chip"
        onClick={() => setOpen((v) => !v)}
      >
        <StIcon name="eye" size={12} sw={2} />
        {ROLE[role]}
      </button>
      {open && (
        <div
          className="dst-menu"
          role="dialog"
          aria-label="You can read and comment"
          data-testid="role-note"
          style={{ width: 340, right: 0, top: 'calc(100% + 10px)' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6, color: '#244E78' }}>
            <StIcon name="lock" size={16} sw={1.9} />
            <div style={{ fontSize: 14, fontWeight: 700, color: '#1E2A22' }}>You can read and comment</div>
          </div>
          <div style={{ fontSize: 12.5, color: '#3A4A3E', lineHeight: 1.5 }}>
            Your role in {projectName} is <b>{ROLE[role]}</b>.{' '}
            {role === 'viewer' ? 'Editors can change this page.' : `${reason}.`}{' '}
            {admin
              ? `Ask ${admin}, the project admin, if you need to edit.`
              : 'Ask a project admin if you need to edit.'}
          </div>
          {sent === 'sent' || sent === 'asked' ? (
            <div role="status" style={{ marginTop: 10, fontSize: 12.5, fontWeight: 600, color: '#2E6F40' }}>
              {sent === 'sent'
                ? `Request sent. ${admin ? `${admin} gets` : 'The project admins get'} a notification.`
                : `You already asked. ${admin ?? 'The project admins'} will get back to you.`}
            </div>
          ) : (
            <>
              {sent === 'error' && (
                <div role="alert" style={{ marginTop: 8, fontSize: 12.5, color: '#C4432A' }}>
                  Couldn't send the request. Try again.
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button
                  type="button"
                  className="st-btn st-btn-primary"
                  style={{ minHeight: 32 }}
                  disabled={ask.isPending}
                  onClick={() => void request()}
                  data-testid="ask-edit-access"
                >
                  <StIcon name="send" size={13} sw={2} />
                  {ask.isPending ? 'Sending…' : 'Ask for edit access'}
                </button>
                <button type="button" className="st-btn" style={{ minHeight: 32 }} onClick={() => setOpen(false)}>
                  Close
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
