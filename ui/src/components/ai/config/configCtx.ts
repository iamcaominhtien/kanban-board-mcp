import { createContext, useContext } from 'react';
import type { AiConfig, AiMember } from '../../../types/ai';
import type { ConfigIssue, ConfigStatus, LibraryType } from './configApi';
import type { MemberDraft, SetCfg, SetDraft } from './parts';

/** What every card of the Configuration tab reads and changes: the unsaved draft and the server-side state. */
export interface CfgCtx {
  member: AiMember;
  /** The draft (unsaved) member fields and configuration. */
  draft: MemberDraft;
  cfg: AiConfig;
  /** The saved configuration. */
  saved: AiConfig;
  setCfg: SetCfg;
  setDraft: SetDraft;
  replaceConfig: (cfg: AiConfig) => void;
  issues: ConfigIssue[];
  status: ConfigStatus | undefined;
  refreshStatus: () => void;
  /** True while the draft differs from what is saved. */
  dirty: boolean;
  /** Open the library picker for these item types; the chosen items are attached to the draft. */
  pickLibrary: (types: LibraryType[], multiple?: boolean) => void;
  /** Tick or untick a Documented item. */
  tick: (key: string, done: boolean) => Promise<void>;
  newKey: string;
  setNewKey: (v: string) => void;
}

/** Carries the draft and server state to every card of the Configuration tab. */
export const CfgContext = createContext<CfgCtx | null>(null);

/** The context of the Configuration tab. */
export function useCfg(): CfgCtx {
  const v = useContext(CfgContext);
  if (!v) throw new Error('useCfg outside the Configuration tab');
  return v;
}

/** The adapter family of a member: which card set the tab shows. */
export function adapterOf(m: AiMember): 'claude-code' | 'antigravity' | 'api' | 'inbox' {
  if (m.provider === 'claude-code') return 'claude-code';
  if (m.provider === 'antigravity') return 'antigravity';
  return m.connection === 'api_key' ? 'api' : 'inbox';
}
