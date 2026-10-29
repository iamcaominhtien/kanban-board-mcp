import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AssistScope } from '../../types/assist';

export interface AskRequest {
  scope?: AssistScope;
  ticketId?: string | null;
  docId?: string | null;
  /** Sent right away when the dock opens. */
  text?: string;
  /** New chat instead of continuing the current one. */
  fresh?: boolean;
}

export interface BoardFilters {
  assignee?: string | null;
  type?: string | null;
  priority?: string | null;
  q?: string | null;
}

interface AssistValue {
  projectId: string | null;
  projectName: string;
  open: boolean;
  scope: AssistScope;
  ticketId: string | null;
  docId: string | null;
  chatId: string | null;
  pending: AskRequest | null;
  filters: BoardFilters;
  healthOpen: boolean;
  ask: (req?: AskRequest) => void;
  toggle: () => void;
  close: () => void;
  setScope: (scope: AssistScope) => void;
  setTicketId: (id: string | null) => void;
  setDocId: (id: string | null) => void;
  setChatId: (id: string | null) => void;
  consumePending: () => AskRequest | null;
  setHealthOpen: (open: boolean) => void;
  onOpenTicket: (id: string) => void;
  onOpenSettings: () => void;
  onOpenAiMembers: () => void;
  onOpenDoc: (pageId: string, anchor?: string | null) => void;
}

const AssistContext = createContext<AssistValue | null>(null);

/** Shared state of the Board AI dock: open, scope, chat, the ticket or page it is about (A, B). */
export function AssistProvider({
  projectId,
  projectName,
  filters,
  currentTicketId,
  onOpenTicket,
  onOpenSettings,
  onOpenAiMembers,
  onOpenDoc,
  children,
}: {
  projectId: string | null;
  projectName: string;
  filters: BoardFilters;
  currentTicketId: string | null;
  onOpenTicket: (id: string) => void;
  onOpenSettings: () => void;
  onOpenAiMembers: () => void;
  onOpenDoc: (pageId: string, anchor?: string | null) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<AssistScope>('project');
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [docId, setDocId] = useState<string | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [pending, setPending] = useState<AskRequest | null>(null);
  const [healthOpen, setHealthOpen] = useState(false);

  // A new project starts a new conversation
  useEffect(() => {
    setChatId(null);
    setTicketId(null);
    setDocId(null);
    setScope('project');
  }, [projectId]);

  // The open ticket is the "This ticket" scope (context attached: current ticket if one is open)
  useEffect(() => {
    if (currentTicketId) setTicketId(currentTicketId);
  }, [currentTicketId]);

  const ask = useCallback((req?: AskRequest) => {
    setOpen(true);
    if (!req) return;
    if (req.scope) setScope(req.scope);
    if (req.ticketId !== undefined) setTicketId(req.ticketId);
    if (req.docId !== undefined) setDocId(req.docId);
    if (req.fresh || req.scope) setChatId(null);
    setPending(req);
  }, []);

  const toggle = useCallback(() => setOpen((v) => !v), []);
  const close = useCallback(() => setOpen(false), []);
  const consumePending = useCallback(() => {
    const p = pending;
    setPending(null);
    return p;
  }, [pending]);

  const value = useMemo<AssistValue>(
    () => ({
      projectId,
      projectName,
      open,
      scope,
      ticketId,
      docId,
      chatId,
      pending,
      filters,
      healthOpen,
      ask,
      toggle,
      close,
      setScope,
      setTicketId,
      setDocId,
      setChatId,
      consumePending,
      setHealthOpen,
      onOpenTicket,
      onOpenSettings,
      onOpenAiMembers,
      onOpenDoc,
    }),
    [
      projectId,
      projectName,
      open,
      scope,
      ticketId,
      docId,
      chatId,
      pending,
      filters,
      healthOpen,
      ask,
      toggle,
      close,
      consumePending,
      onOpenTicket,
      onOpenSettings,
      onOpenAiMembers,
      onOpenDoc,
    ],
  );
  return <AssistContext.Provider value={value}>{children}</AssistContext.Provider>;
}

/** The dock's state (null outside the provider, e.g. in isolated tests). */
export function useAssist(): AssistValue | null {
  return useContext(AssistContext);
}

/** ⌘J / Ctrl+J toggles the dock (invented shortcut, A1). */
export function useAssistShortcut(enabled: boolean) {
  const ctx = useAssist();
  useEffect(() => {
    if (!enabled || !ctx) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        ctx.toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, ctx]);
}

/** "⌘J" on a Mac, "Ctrl J" elsewhere. */
export function shortcutLabel(): string {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘J' : 'Ctrl J';
}
