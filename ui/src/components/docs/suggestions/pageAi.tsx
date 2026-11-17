/**
 * What a page and a project say about AI teams (design "AI teams on rich pages", B 9–10 and G 35): the page menu's
 * "AI changes" (Suggest first / Apply directly / Team default) and "Not for AI teams", Settings › Docs AI's switch
 * per team, and the block lock "Teams cannot change this" (`lockedBlocks`), with the small mark on locked blocks.
 */

import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { docsErrorDetail, docsKeys, patchPageSettings } from '../../../api/docs';
import { useDocsAiState } from '../../../api/docsAi';
import { extractError } from '../../../api/extractError';
import type { DocsPage } from '../../../types/docs';
import { useToast } from '../../Toast';
import { Icon } from '../Icon';
import { mergeSettings } from '../pageSettings';
import { useSetTeamApply, useTeamApply, type AiApply } from './api';
import './suggestions.css';

/** The page's own `aiApply`: null when the team's setting applies. */
export function pageApply(settings: Record<string, unknown> | undefined): AiApply | null {
  const v = settings?.aiApply;
  return v === 'suggest' || v === 'direct' ? v : null;
}

/** The block ids the page locks for teams. */
export function lockedBlocks(settings: Record<string, unknown> | undefined): string[] {
  const v = settings?.lockedBlocks;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Whether the page is kept away from AI teams. */
export const notForAi = (settings: Record<string, unknown> | undefined) => settings?.notForAi === true;

/**
 * Returns `save(patch)`: changes page settings now in the cached page and on the server; on a refusal the page goes
 * back and a toast says why. Resolves to whether it was saved.
 * @param pageId - The page.
 */
export function usePatchPageAi(pageId: string): (patch: Record<string, unknown>) => Promise<boolean> {
  const qc = useQueryClient();
  const toast = useToast();
  return useCallback(
    async (patch: Record<string, unknown>) => {
      const key = docsKeys.page(pageId);
      const before = qc.getQueryData<DocsPage>(key)?.settings;
      qc.setQueryData<DocsPage>(key, (old) => (old ? { ...old, settings: mergeSettings(old.settings, patch) } : old));
      try {
        const page = await patchPageSettings(pageId, patch);
        qc.setQueryData<DocsPage>(key, (old) => (old ? { ...old, ...page } : page));
        return true;
      } catch (e) {
        qc.setQueryData<DocsPage>(key, (old) => (old ? { ...old, settings: before } : old));
        toast.error("Couldn't save the page settings", docsErrorDetail(e)?.message ?? extractError(e));
        return false;
      }
    },
    [pageId, qc, toast],
  );
}

const APPLY_LABEL: Record<AiApply, string> = { suggest: 'Suggest first', direct: 'Apply directly' };

/**
 * The team setting that applies to a page when it has none: the setting of the team that answers in Docs AI.
 * @param projectId - The page's project.
 */
function useTeamDefault(projectId: string): AiApply {
  const team = useTeamApply(projectId).data?.aiApply;
  const member = useDocsAiState(projectId).data?.memberId;
  return (member && team?.[member]) || 'suggest';
}

/**
 * The page menu's AI rows: "AI changes" (how a team's changes arrive on this page) and "Not for AI teams".
 * @param props.page - The page.
 * @param props.projectId - Its project.
 * @param props.canEdit - Editors change them; others see them off.
 * @param props.onClose - Closes the menu after a choice.
 */
export function AiChangesItems({
  page,
  projectId,
  canEdit,
  onClose,
}: {
  page: DocsPage;
  projectId: string;
  canEdit: boolean;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const save = usePatchPageAi(page.id);
  const own = pageApply(page.settings);
  const dflt = useTeamDefault(projectId);
  const kept = notForAi(page.settings);
  const choose = (v: AiApply | null) => {
    void save({ aiApply: v });
    onClose?.();
  };
  return (
    <div data-testid="sg-ai-items">
      <button
        type="button"
        role="menuitem"
        className="dk-mi"
        aria-expanded={open}
        disabled={!canEdit}
        data-testid="menu-ai-changes"
        onClick={() => setOpen((v) => !v)}
        style={{ width: '100%', border: 'none', background: 'none', textAlign: 'left', fontFamily: 'inherit' }}
      >
        <span style={{ color: '#5B6B60', display: 'flex' }}>
          <Icon name="i28" size={15} strokeWidth={1.8} />
        </span>
        <span>AI changes</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#5B6B60' }}>
          {own ? APPLY_LABEL[own] : 'Team default'}
        </span>
      </button>
      {open && (
        <div className="sg-menu-sub" role="group" aria-label="When a team changes this page">
          <span className="sg-menu-head">WHEN A TEAM CHANGES THIS PAGE</span>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={own === 'suggest'}
            className="sg-menu-opt"
            data-testid="ai-apply-suggest"
            onClick={() => choose('suggest')}
          >
            Suggest first
            <small>Changes wait for you to accept them.</small>
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={own === 'direct'}
            className="sg-menu-opt"
            data-testid="ai-apply-direct"
            onClick={() => choose('direct')}
          >
            Apply directly
            <small>Saved at once. Undo is in History.</small>
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={own === null}
            className="sg-menu-opt"
            data-testid="ai-apply-default"
            onClick={() => choose(null)}
          >
            Team default: {APPLY_LABEL[dflt]}
            <small>Change it in Settings › Docs.</small>
          </button>
        </div>
      )}
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={kept}
        className="dk-mi"
        disabled={!canEdit}
        data-testid="menu-not-for-ai"
        onClick={() => {
          void save({ notForAi: kept ? null : true });
          onClose?.();
        }}
        style={{ width: '100%', border: 'none', background: 'none', textAlign: 'left', fontFamily: 'inherit' }}
      >
        <span style={{ color: '#5B6B60', display: 'flex' }}>
          <Icon name="lock" size={15} strokeWidth={1.8} />
        </span>
        <span>Not for AI teams</span>
        {kept && (
          <span style={{ marginLeft: 'auto', color: '#2E6F40', display: 'flex' }}>
            <Icon name="check" size={14} strokeWidth={2.2} />
          </span>
        )}
      </button>
    </div>
  );
}

/**
 * Settings › Docs AI: how each AI team changes pages (Suggest first / Apply directly). Admins change it.
 * @param props.projectId - The project.
 * @param props.teams - The project's AI teams.
 * @param props.admin - The person is an admin of the project's Docs.
 */
export function TeamApplySettings({
  projectId,
  teams,
  admin,
}: {
  projectId: string;
  teams: { id: string; name: string }[];
  admin: boolean;
}) {
  const q = useTeamApply(projectId);
  const set = useSetTeamApply(projectId);
  const toast = useToast();
  if (!teams.length) return null;
  const map = q.data?.aiApply ?? {};
  return (
    <div data-testid="sg-team-apply" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#1E2A22' }}>How teams change pages</div>
        <div style={{ fontSize: 12, color: '#5B6B60', lineHeight: 1.5 }}>
          Suggest first: a team’s edits wait for you to accept them. Apply directly: they are saved at once and Undo is
          in History. A page can override this in its menu. Pages a team wrote itself are always applied directly.
        </div>
      </div>
      {teams.map((t) => {
        const v: AiApply = map[t.id] ?? 'suggest';
        return (
          <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: '#1E2A22', fontWeight: 600 }}>{t.name}</span>
            <span className="sg-switch" role="radiogroup" aria-label={`How ${t.name} changes pages`}>
              {(['suggest', 'direct'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={v === k}
                  aria-pressed={v === k}
                  disabled={!admin || set.isPending}
                  data-testid={`team-apply-${t.id}-${k}`}
                  onClick={() =>
                    v !== k &&
                    set.mutate(
                      { memberId: t.id, apply: k },
                      {
                        onError: (e) =>
                          toast.error("Couldn't save the setting", docsErrorDetail(e)?.message ?? extractError(e)),
                      },
                    )
                  }
                >
                  {APPLY_LABEL[k]}
                </button>
              ))}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- block lock ---------- */

/** The page's locked blocks and a way to lock or unlock one (the editor's block menu). */
export interface BlockLock {
  locked: readonly string[];
  toggle: (blockId: string) => void;
}

const BlockLockContext = createContext<BlockLock | null>(null);

/** The open page's block lock, or null outside a Docs page editor. */
export function useBlockLock(): BlockLock | null {
  return useContext(BlockLockContext);
}

/**
 * Gives the editor's block menu "Teams cannot change this", and marks the locked blocks.
 * @param props.page - The page being edited.
 * @param props.enabled - False leaves it out (a viewer).
 */
export function BlockLockProvider({
  page,
  enabled = true,
  children,
}: {
  page: DocsPage;
  enabled?: boolean;
  children: ReactNode;
}) {
  const save = usePatchPageAi(page.id);
  const [mine, setMine] = useState<string[] | null>(null);
  const locked = mine ?? lockedBlocks(page.settings);
  const value = useMemo<BlockLock | null>(
    () =>
      enabled
        ? {
            locked,
            toggle: (id) => {
              const next = locked.includes(id) ? locked.filter((x) => x !== id) : [...locked, id];
              setMine(next);
              void save({ lockedBlocks: next.length ? next : null }).then((ok) => {
                if (!ok) setMine(null);
              });
            },
          }
        : null,
    [enabled, locked, save],
  );
  return (
    <BlockLockContext.Provider value={value}>
      <LockMarks ids={locked} />
      {children}
    </BlockLockContext.Provider>
  );
}

const SAFE_ID = /^[\w-]{1,64}$/;

/**
 * The small "Locked for teams" mark on locked blocks, in the reader and in the editor (a style keyed by block id).
 * @param props.ids - The locked block ids.
 */
export function LockMarks({ ids }: { ids: readonly string[] }) {
  const sel = ids.filter((id) => SAFE_ID.test(id)).map((id) => `[data-block-id="${id}"]`);
  if (!sel.length) return null;
  const on = sel.join(',');
  const mark = sel.map((s) => `${s}:not(.dk-changed)::after`).join(',');
  return (
    <style data-testid="sg-lock-marks">{`${on}{position:relative;box-shadow:-10px 0 0 -7px #C7D2CB}
${mark}{content:'Locked for teams';position:absolute;top:-8px;right:0;font:700 10px/16px var(--font-ui,'Plus Jakarta Sans',sans-serif);padding:0 6px;border-radius:5px;background:#F1F3F1;color:#5B6B60;pointer-events:none}`}</style>
  );
}
