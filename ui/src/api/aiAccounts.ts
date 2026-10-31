import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import camelcaseKeys from 'camelcase-keys';
import { client } from './client';
import { resolveOrigin } from './resolveOrigin';
import { aiKeys } from './ai';
import type {
  AccountCli,
  AccountsOverview,
  AiAccount,
  ComputerLogin,
  RemoveMembersPolicy,
  SignInStart,
  SignInState,
  TerminalMessage,
} from '../types/aiAccounts';
import type { AiMember } from '../types/ai';

export const accountKeys = {
  all: ['ai', 'accounts'] as const,
  list: (projectId?: string) => ['ai', 'accounts', 'list', projectId ?? ''] as const,
  logins: ['ai', 'accounts', 'computer-logins'] as const,
};

/**
 * Every AI account on this computer with the CLIs an account can be made for. `projectId` splits the members using
 * an account into "here" and "elsewhere". Accounts are re-asked for their status every few seconds while a sign-in
 * window is open elsewhere in the app, and every 15 s otherwise.
 */
export function useAiAccounts(projectId?: string) {
  return useQuery({
    queryKey: accountKeys.list(projectId),
    queryFn: async () => (await client.get<AccountsOverview>('/ai/accounts', { params: { projectId } })).data,
    refetchInterval: (q) => (q.state.data?.accounts.some((a) => a.status === 'signing_in') ? 3000 : 15000),
  });
}

/** The logins CLIs already have on this computer (only Claude Code says who). */
export function useComputerLogins() {
  return useQuery({
    queryKey: accountKeys.logins,
    queryFn: async () => (await client.get<ComputerLogin[]>('/ai/accounts-on-this-computer')).data,
    staleTime: 60_000,
    retry: false,
  });
}

/** Refreshes the account lists and every place that shows a member's account. */
function useRefresh() {
  const qc = useQueryClient();
  return () =>
    Promise.all([qc.invalidateQueries({ queryKey: accountKeys.all }), qc.invalidateQueries({ queryKey: aiKeys.all })]);
}

export const accountsApi = {
  create: async (body: { name: string; cli: AccountCli }) => (await client.post<AiAccount>('/ai/accounts', body)).data,
  rename: async (id: string, name: string) => (await client.patch<AiAccount>(`/ai/accounts/${id}`, { name })).data,
  /** "Check now": ask the CLI whether the account is signed in. */
  check: async (id: string) => (await client.post<AiAccount>(`/ai/accounts/${id}/check`)).data,
  signOut: async (id: string) => (await client.post<AiAccount>(`/ai/accounts/${id}/sign-out`)).data,
  remove: async (id: string, members: RemoveMembersPolicy, otherId?: string) =>
    (
      await client.delete<{ removed: boolean; membersMoved: number }>(`/ai/accounts/${id}`, {
        params: { members, otherId },
      })
    ).data,
  nameCheck: async (name: string) =>
    (await client.get<{ ok: boolean; message: string | null }>('/ai/accounts/name-check', { params: { name } })).data,
  /** Open the sign-in terminal on this computer (or get the command to run in a terminal of the person's own). */
  startSignIn: async (id: string, cols = 80, rows = 24) =>
    (await client.post<SignInStart>(`/ai/accounts/${id}/signin`, null, { params: { cols, rows } })).data,
  /** Stop signing in: the CLI is stopped, nothing is marked signed in. */
  cancelSignIn: async (id: string) => (await client.delete<{ stopped: boolean }>(`/ai/accounts/${id}/signin`)).data,
  /** The person is finished; the CLI is stopped and asked once more who is signed in. */
  finishSignIn: async (id: string) => (await client.post<{ done: boolean }>(`/ai/accounts/${id}/signin/done`)).data,
  /** Choose the account an AI member runs as (null: the login already on this computer). */
  assign: async (memberId: string, accountId: string | null) =>
    (await client.put<AiMember>(`/ai/members/${memberId}/account`, { accountId })).data,
};

/** Create / rename / check / sign out / remove / assign; each refreshes the lists afterwards. */
export function useAccountActions() {
  const refresh = useRefresh();
  const wrap = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    useMutation({ mutationFn: (a: A) => fn(...a), onSettled: () => void refresh() });
  const create = wrap(accountsApi.create);
  const rename = wrap(accountsApi.rename);
  const check = wrap(accountsApi.check);
  const signOut = wrap(accountsApi.signOut);
  const remove = wrap(accountsApi.remove);
  const assign = wrap(accountsApi.assign);
  return { create, rename, check, signOut, remove, assign, refresh };
}

export type TerminalLink = 'connecting' | 'open' | 'closed';

/**
 * The sign-in terminal of an account: a WebSocket that sends the terminal's output and the state the status bar
 * shows, and takes the person's keys. Call `start()` first (accountsApi.startSignIn); then pass the account id.
 *
 * @param accountId The account being signed in, or null to stay disconnected.
 * @param onOutput Called with every chunk of terminal output (write it to xterm).
 */
export function useSignInTerminal(accountId: string | null, onOutput: (data: string) => void) {
  const [state, setState] = useState<SignInState | null>(null);
  const [link, setLink] = useState<TerminalLink>('connecting');
  const socket = useRef<WebSocket | null>(null);
  const output = useRef(onOutput);
  output.current = onOutput;

  useEffect(() => {
    if (!accountId) return;
    setLink('connecting');
    setState(null);
    const url = resolveOrigin().replace(/^http/, 'ws') + `/ai/accounts/${accountId}/terminal`;
    const ws = new WebSocket(url);
    socket.current = ws;
    ws.onopen = () => setLink('open');
    ws.onclose = () => setLink('closed');
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(String(e.data)) as Record<string, unknown>;
        if (msg.type === 'out') output.current(String(msg.data ?? ''));
        else if (msg.type === 'state') setState(camelcaseKeys(msg, { deep: true }) as unknown as SignInState);
      } catch {
        /* a frame we do not understand is ignored */
      }
    };
    return () => {
      ws.close();
      socket.current = null;
    };
  }, [accountId]);

  const send = (msg: object) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(msg));
  };
  return {
    state,
    link,
    /** Keys the person types in the terminal. */
    input: (data: string) => send({ type: 'input', data }),
    /** Text from the "Paste code" button. */
    paste: (data: string) => send({ type: 'paste', data }),
    resize: (cols: number, rows: number) => send({ type: 'resize', cols, rows }),
  };
}

export type { TerminalMessage };
