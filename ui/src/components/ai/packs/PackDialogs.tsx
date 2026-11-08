import { useEffect, useState, type ReactNode } from 'react';
import { aiPacksApi, usePackMutation } from '../../../api/aiPacks';
import { extractError } from '../../../api/extractError';
import type { RolePack } from '../../../types/aiPacks';
import { blankBodyOf, copyBodyOf, keyOf, KEY_RE } from './packLogic';

/** A small dialog of the AI screens: Escape and a click outside close it. */
export function PackModal({
  title,
  width = 480,
  onClose,
  children,
  foot,
  testId,
}: {
  title: string;
  width?: number;
  onClose: () => void;
  children: ReactNode;
  foot?: ReactNode;
  testId?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="ai-overlay" onClick={onClose}>
      <div
        className="ai-modal"
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ai-modal-head">
          <h2 className="ai-modal-title">{title}</h2>
        </div>
        <div className="ai-modal-body">{children}</div>
        {foot && (
          <div className="ai-modal-foot" style={{ justifyContent: 'flex-end' }}>
            {foot}
          </div>
        )}
      </div>
    </div>
  );
}

/** Put back the ready-made role, or remove the project's own one: both are DELETE of the project's pack. */
export function ConfirmPackDialog({
  projectId,
  pack,
  mode,
  onClose,
  onDone,
}: {
  projectId: string;
  pack: RolePack;
  mode: 'reset' | 'remove';
  onClose: () => void;
  onDone: (pack: RolePack) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const del = usePackMutation(projectId, (_: void) => aiPacksApi.remove(projectId, pack.key));
  const reset = mode === 'reset';
  const go = async () => {
    setError(null);
    try {
      await del.mutateAsync();
      onDone(pack);
    } catch (e) {
      setError(extractError(e));
    }
  };
  return (
    <PackModal
      title={reset ? `Put back the ready-made ${pack.name}?` : `Remove ${pack.name}?`}
      onClose={onClose}
      testId={reset ? 'pack-reset-dialog' : 'pack-remove-dialog'}
      foot={
        <>
          <button type="button" className="ai-btn" onClick={onClose}>
            {reset ? 'Keep my edits' : 'Keep it'}
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-danger"
            disabled={del.isPending}
            onClick={() => void go()}
            data-testid="pack-confirm"
          >
            {reset ? 'Reset' : 'Remove'}
          </button>
        </>
      }
    >
      <p className="ai-hint" style={{ margin: 0 }}>
        {reset
          ? 'This project’s edits to the role are removed and the ready-made version comes back.'
          : 'It is this project’s own role; there is no ready-made version to go back to.'}
      </p>
      {error && (
        <div className="ai-notice ai-notice-error" role="alert">
          {error}
        </div>
      )}
    </PackModal>
  );
}

/** Add a role: blank, or a copy of a pack; its name and key. */
export function AddRoleDialog({
  projectId,
  packs,
  onClose,
  onAdded,
}: {
  projectId: string;
  packs: RolePack[];
  onClose: () => void;
  onAdded: (pack: RolePack) => void;
}) {
  const [from, setFrom] = useState<'blank' | 'copy'>('blank');
  const [copyKey, setCopyKey] = useState(packs.find((p) => p.key === 'dev')?.key ?? packs[0]?.key ?? '');
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [tried, setTried] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const create = usePackMutation(projectId, (a: { key: string; body: ReturnType<typeof blankBodyOf> }) =>
    aiPacksApi.save(projectId, a.key, a.body),
  );
  const theKey = keyTouched ? key : keyOf(name);
  const source = packs.find((p) => p.key === copyKey);
  const nameError = !name.trim() ? 'A pack needs a name.' : null;
  const keyError = !theKey
    ? 'A pack needs a key.'
    : !KEY_RE.test(theKey)
      ? 'Letters, digits and underscores only.'
      : packs.some((p) => p.key === theKey)
        ? 'A role with this key exists already.'
        : null;
  const submit = async () => {
    setTried(true);
    setServerError(null);
    if (nameError || keyError) return;
    const body = from === 'copy' && source ? copyBodyOf(source, name.trim()) : blankBodyOf(name.trim());
    try {
      onAdded(await create.mutateAsync({ key: theKey, body }));
    } catch (e) {
      setServerError(extractError(e));
    }
  };
  return (
    <PackModal
      title="Add a role"
      onClose={onClose}
      testId="pack-add-dialog"
      foot={
        <>
          <button type="button" className="ai-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            disabled={create.isPending}
            onClick={() => void submit()}
            data-testid="pack-add-go"
          >
            Add the role
          </button>
        </>
      }
    >
      <div className="rp-field">
        <span className="ai-label">Start from</span>
        <div className="rp-start" role="radiogroup" aria-label="Start from">
          <button
            type="button"
            role="radio"
            aria-checked={from === 'copy'}
            className={`tw-chipbtn ${from === 'copy' ? 'tw-chipbtn-on' : ''}`}
            onClick={() => setFrom('copy')}
          >
            A copy of
          </button>
          {from === 'copy' && (
            <select
              className="ai-select"
              aria-label="Copy of"
              value={copyKey}
              onChange={(e) => setCopyKey(e.target.value)}
            >
              {packs.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            role="radio"
            aria-checked={from === 'blank'}
            className={`tw-chipbtn ${from === 'blank' ? 'tw-chipbtn-on' : ''}`}
            onClick={() => setFrom('blank')}
          >
            Blank
          </button>
        </div>
      </div>
      <label className="rp-field">
        <span className="ai-label">Name</span>
        <input
          className={`ai-input ${tried && nameError ? 'ai-input-error' : ''}`}
          aria-label="Name"
          autoFocus
          value={name}
          placeholder="Release manager"
          onChange={(e) => setName(e.target.value)}
          data-testid="pack-add-name"
        />
        {tried && nameError && <span className="rp-err">{nameError}</span>}
      </label>
      <label className="rp-field">
        <span className="ai-label">Key</span>
        <input
          className={`ai-input ai-mono ${tried && keyError ? 'ai-input-error' : ''}`}
          aria-label="Key"
          value={theKey}
          placeholder="release_manager"
          onChange={(e) => {
            setKeyTouched(true);
            setKey(e.target.value.toLowerCase());
          }}
          data-testid="pack-add-key"
        />
        {tried && keyError ? (
          <span className="rp-err">{keyError}</span>
        ) : (
          <span className="ai-hint">Letters, digits and underscores. It cannot be changed later.</span>
        )}
      </label>
      {serverError && (
        <div className="ai-notice ai-notice-error" role="alert">
          {serverError}
        </div>
      )}
    </PackModal>
  );
}
