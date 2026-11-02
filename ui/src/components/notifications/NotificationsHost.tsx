import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import camelcaseKeys from 'camelcase-keys';
import { useNotificationCounts } from '../../api/notifications';
import type { NotificationRow } from '../../types/notifications';
import { useAssist } from '../assist/AssistContext';
import { AllNotificationsPage } from './AllNotificationsPage';
import { NotificationBell } from './NotificationBell';
import { NotificationPanel, type PanelTab } from './NotificationPanel';
import type { RowActionHandler } from './NotificationRow';
import { currentActor, inElectron, openActionOf } from './notificationUi';
import { unlockAudioOnFirstGesture } from '../../utils/notificationSound';
import type { NoticeOpen } from './browserNotifier';
import { useBrowserNotifier } from './useBrowserNotifier';
import { useFaviconDot } from './useFaviconDot';
import { useNotificationActions, type NavigateHandler } from './useNotificationActions';
import { useNotificationToasts } from './useNotificationToasts';
import { isTyping } from './useRowKeys';
import { useTabTitle } from './useTabTitle';

/** The event any part of the app (a toast's "+N more", a settings link) sends to open a notification surface. */
export const NOTIFICATIONS_EVENT = 'kanban:notifications';

export type NotificationsOpen = 'panel' | 'page' | 'settings';

/** Ask the app to open the panel, the All notifications page or Settings › Notifications. */
export function requestOpenNotifications(open: NotificationsOpen, tab?: PanelTab, rowId?: string): void {
  window.dispatchEvent(new CustomEvent(NOTIFICATIONS_EVENT, { detail: { open, tab, rowId } }));
}

interface Ctx {
  panelOpen: boolean;
  togglePanel: () => void;
  onAction: RowActionHandler;
  /** The row the All notifications page should open expanded (from the panel's "Open the list"). */
  focusRowId: string | null;
}

const NotificationsContext = createContext<Ctx | null>(null);

/** What the desktop app tells the window about a click on one of its notices. */
type DesktopOpen =
  (NotificationRow & { action?: string }) | { group: true; ids: string[]; needs: boolean; title?: string } | undefined;

interface DesktopBridge {
  setActor?: (name: string) => Promise<boolean> | boolean | void;
  onOpen?: (cb: (payload: DesktopOpen) => void) => () => void;
}

function bridge(): DesktopBridge | undefined {
  return (window.electronAPI as unknown as { notifications?: DesktopBridge } | undefined)?.notifications;
}

/** The bell for the top bar; it needs `NotificationsHost` above it. */
export function NotificationBellButton() {
  const ctx = useContext(NotificationsContext);
  if (!ctx) return null;
  return <NotificationBell open={ctx.panelOpen} onToggle={ctx.togglePanel} />;
}

/** The All notifications page as a view; it needs `NotificationsHost` above it. */
export function NotificationsPageView({
  onBack,
  onOpenSettings,
}: Readonly<{ onBack: () => void; onOpenSettings: () => void }>) {
  const ctx = useContext(NotificationsContext);
  if (!ctx) return null;
  return (
    <AllNotificationsPage
      onBack={onBack}
      onOpenSettings={onOpenSettings}
      onAction={ctx.onAction}
      bell={<NotificationBellButton />}
      panelOpen={ctx.panelOpen}
      focusRowId={ctx.focusRowId}
    />
  );
}

/**
 * Everything the notifications need from the app, in one place: the panel, the keys (N, Shift N), the toasts, the
 * tab title and the desktop bridge. The app says how to open a ticket, a page, the AI screens, the page and Settings.
 */
export function NotificationsHost({
  children,
  onOpenTicket,
  onOpenDoc,
  onOpenAiTab,
  onOpenAiMember,
  onOpenPage,
  onOpenSettings,
}: Readonly<{
  children: ReactNode;
  onOpenTicket: (ticketId: string) => void;
  /** `projectId` is the row's project: a row of another project opens there, never in the one on screen */
  onOpenDoc: (pageId: string, projectId?: string | null) => void;
  onOpenAiTab: (tab: 'accounts' | 'approvals', projectId?: string | null) => void;
  onOpenAiMember: (memberId?: string | null, projectId?: string | null) => void;
  onOpenPage: () => void;
  onOpenSettings: () => void;
}>) {
  const assist = useAssist();
  const counts = useNotificationCounts().data;
  const [panelOpen, setPanelOpen] = useState(false);
  const [tab, setTab] = useState<PanelTab>('needs');
  const [focusRowId, setFocusRowId] = useState<string | null>(null);
  const props = useRef({ onOpenTicket, onOpenDoc, onOpenAiTab, onOpenAiMember, onOpenPage, onOpenSettings });
  props.current = { onOpenTicket, onOpenDoc, onOpenAiTab, onOpenAiMember, onOpenPage, onOpenSettings };
  const assistRef = useRef(assist);
  assistRef.current = assist;

  const openPanel = useCallback((t?: PanelTab) => {
    if (t) setTab(t);
    setPanelOpen(true);
  }, []);
  const closePanel = useCallback(() => setPanelOpen(false), []);
  const togglePanel = useCallback(() => setPanelOpen((o) => !o), []);

  const navigate = useCallback<NavigateHandler>((row, actionId, extra) => {
    const p = props.current;
    const ticket = extra?.ticketId ?? row.ticketId;
    setPanelOpen(false);
    switch (actionId) {
      case 'open_ticket':
      case 'open_run_log':
      case 'open_item':
        if (ticket) p.onOpenTicket(ticket);
        else if (row.pageId) p.onOpenDoc(row.pageId, row.projectId);
        break;
      case 'open_run':
        // the run's detail is shown by AI Team › Run history; the panel only closes
        break;
      case 'sign_in':
        p.onOpenAiTab('accounts', row.projectId);
        break;
      case 'review':
        if (row.kind === 'page_proposal' && row.pageId) p.onOpenDoc(row.pageId, row.projectId);
        else p.onOpenAiTab('approvals', row.projectId);
        break;
      case 'open_ai':
      case 'change_permission':
        p.onOpenAiMember(row.memberId, row.projectId);
        break;
      case 'open_list':
        setFocusRowId(row.id);
        p.onOpenPage();
        break;
      case 'board_health':
        assistRef.current?.setHealthOpen(true);
        break;
      default:
        // open, reply
        if (row.kind === 'day_card') p.onOpenPage();
        else if (row.pageId) p.onOpenDoc(row.pageId, row.projectId);
        else if (ticket) p.onOpenTicket(ticket);
        else p.onOpenPage();
    }
  }, []);
  const onAction = useNotificationActions(navigate);
  const actionRef = useRef(onAction);
  actionRef.current = onAction;

  // A click on a system notice (the browser's, or the desktop app's): the thing itself, or the list for a group
  const openFromNotice = useCallback(
    (open: NoticeOpen) => {
      if ('group' in open && open.group) {
        openPanel(open.needs ? 'needs' : 'updates');
        return;
      }
      const row = open as NotificationRow & { action?: string };
      if (row.action) {
        void actionRef.current(row, row.action);
        return;
      }
      const id = openActionOf(row);
      if (id) void actionRef.current(row, id);
      else openPanel(row.needs ? 'needs' : 'updates');
    },
    [openPanel],
  );
  const browserFeed = useBrowserNotifier(openFromNotice);
  useNotificationToasts(onAction, counts?.head, browserFeed);
  useTabTitle(counts?.needs ?? 0);
  useFaviconDot(counts?.needs ?? 0);
  // the browser lets a page make sound only after the first click or key
  useEffect(() => unlockAudioOnFirstGesture(), []);

  // N opens and closes the panel, Shift N opens the page
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || isTyping(e.target)) return;
      // Another dialog or an editor (Canvas uses N for a note) keeps its own keys
      if (document.querySelector('[role="dialog"]:not([aria-label="Notifications"])')) return;
      if (e.key === 'n') {
        e.preventDefault();
        setPanelOpen((o) => !o);
      } else if (e.key === 'N') {
        e.preventDefault();
        setPanelOpen(false);
        setFocusRowId(null);
        props.current.onOpenPage();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The event other parts send (a toast's "+N more", the Settings link)
  useEffect(() => {
    const onEvent = (e: Event) => {
      const d = (e as CustomEvent<{ open?: NotificationsOpen; tab?: PanelTab; rowId?: string }>).detail;
      if (d?.open === 'panel') openPanel(d.tab);
      else if (d?.open === 'page') {
        setPanelOpen(false);
        setFocusRowId(d.rowId ?? null);
        props.current.onOpenPage();
      } else if (d?.open === 'settings') {
        setPanelOpen(false);
        props.current.onOpenSettings();
      }
    };
    window.addEventListener(NOTIFICATIONS_EVENT, onEvent);
    return () => window.removeEventListener(NOTIFICATIONS_EVENT, onEvent);
  }, [openPanel]);

  // Desktop app: tell it who this window acts as, and route a click on its notices
  useEffect(() => {
    if (!inElectron()) return;
    let pushed: string | null = null;
    const push = async () => {
      const b = bridge();
      const me = currentActor();
      if (!b?.setActor || pushed === me) return;
      try {
        const ok = await b.setActor(me);
        if (ok !== false) pushed = me; // false: the backend is not ready yet, try again
      } catch {
        /* try again on the next tick */
      }
    };
    void push();
    const timer = setInterval(() => void push(), 5000);
    const offReady = window.electronAPI?.onBackendReady?.(() => {
      pushed = null;
      void push();
    });
    const off = bridge()?.onOpen?.((raw) => {
      if (!raw) return; // only focus
      if ('group' in raw && raw.group) {
        openFromNotice(raw);
        return;
      }
      openFromNotice(
        camelcaseKeys(raw as unknown as Record<string, unknown>, { deep: true }) as unknown as NotificationRow & {
          action?: string;
        },
      );
    });
    return () => {
      clearInterval(timer);
      off?.();
      offReady?.();
    };
  }, [openFromNotice]);

  const ctx = useMemo<Ctx>(
    () => ({ panelOpen, togglePanel, onAction, focusRowId }),
    [panelOpen, togglePanel, onAction, focusRowId],
  );

  return (
    <NotificationsContext.Provider value={ctx}>
      {children}
      {panelOpen && (
        <NotificationPanel
          tab={tab}
          onTab={setTab}
          onClose={closePanel}
          onOpenPage={() => {
            setPanelOpen(false);
            setFocusRowId(null);
            onOpenPage();
          }}
          onOpenSettings={() => {
            setPanelOpen(false);
            onOpenSettings();
          }}
          onAction={onAction}
        />
      )}
    </NotificationsContext.Provider>
  );
}
