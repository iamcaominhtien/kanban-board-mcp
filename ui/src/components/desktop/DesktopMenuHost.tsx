import { useEffect, useRef, useState } from 'react';
import { useAssist } from '../assist/AssistContext';
import { useToast } from '../Toast';
import { emitAppCommand, useAppCommand, type AppCommand } from '../../utils/appCommands';
import { AboutWindow, KeyboardShortcutsWindow, ReportIssueWindow, WhatsNewWindow } from './DesktopWindows';

export type MenuView = 'board' | 'list' | 'timeline' | 'docs' | 'schedules' | 'ideas';

interface Props {
  /** The view on screen, reported to the menu for its check mark. */
  view: MenuView;
  onSettings: (target: { page?: string; setting?: string }) => void;
  onNewTicket: () => void;
  /** Shows a view and closes anything above it (Settings, the AI members page). */
  onView: (view: MenuView) => void;
}

type Window = 'shortcuts' | 'whats-new' | 'report-issue' | 'about';
const WINDOWS: Window[] = ['shortcuts', 'whats-new', 'report-issue', 'about'];
// Commands a single screen answers: the view to show first ('current' keeps the view on screen)
const SCREEN_FOR: Record<string, MenuView | 'current'> = {
  'new-doc': 'docs',
  'new-project': 'current',
  'find-board': 'current',
};

/**
 * Receives the commands of the desktop menu (Electron's `app-command` message) and runs them with the app's own
 * routes: Settings pages, New Ticket, view switches, the four small windows, toasts. Anything a single screen owns
 * (new project, new idea, new Docs page, Find in Board, Ask AI) is sent on as an app command that screen listens for.
 * Renders nothing in the browser version.
 */
export function DesktopMenuHost({ view, onSettings, onNewTicket, onView }: Props) {
  const api = window.electronAPI;
  const toast = useToast();
  const assist = useAssist();
  const [open, setOpen] = useState<Window | null>(null);
  const latest = useRef({ view, onSettings, onNewTicket, onView, toast });
  latest.current = { view, onSettings, onNewTicket, onView, toast };

  useEffect(() => api?.setAppState?.({ view }), [api, view]);

  useEffect(() => {
    if (!api?.onAppCommand) return undefined;
    return api.onAppCommand((msg: AppCommand) => {
      const l = latest.current;
      switch (msg.command) {
        case 'settings':
          return l.onSettings({ page: msg.page as string | undefined, setting: msg.setting as string | undefined });
        case 'new-ticket':
          return l.onNewTicket();
        case 'view':
          return l.onView(msg.view as MenuView);
        case 'toast': {
          const action = msg.action as { label: string; command: string } | undefined;
          return void l.toast.showToast({
            variant: (msg.variant as 'success' | 'error' | 'warning' | 'info') ?? 'info',
            title: String(msg.title ?? ''),
            message: msg.message ? String(msg.message) : undefined,
            action: action && {
              label: action.label,
              onClick: () => action.command === 'open-releases' && void api.openReleasesPage?.(),
            },
          });
        }
        default: {
          const key = String(msg.command);
          if (WINDOWS.includes(key as Window)) return setOpen(key as Window);
          // These live on one screen: show it (closing Settings or the AI members page on top) and send the command
          // on once it is on screen. Search tickets is not on Docs or Schedules, so Find in Board goes to the Board.
          const target = SCREEN_FOR[key];
          if (target) {
            l.onView(
              target === 'current'
                ? ['docs', 'schedules'].includes(l.view) && key === 'find-board'
                  ? 'board'
                  : l.view
                : target,
            );
            return void setTimeout(() => emitAppCommand(msg), 80);
          }
          return emitAppCommand(msg);
        }
      }
    });
  }, [api]);

  useAppCommand('ask-ai', () => {
    if (assist && !assist.open) assist.toggle();
  });

  if (!api || !open) return null;
  const close = () => setOpen(null);
  return (
    <>
      {open === 'shortcuts' && <KeyboardShortcutsWindow onClose={close} />}
      {open === 'whats-new' && <WhatsNewWindow onClose={close} />}
      {open === 'report-issue' && <ReportIssueWindow onClose={close} />}
      {open === 'about' && <AboutWindow onClose={close} />}
    </>
  );
}
