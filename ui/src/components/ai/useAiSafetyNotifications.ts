import { useEffect, useRef } from 'react';
import { safetyApi } from '../../api/aiSafety';
import { useToast } from '../Toast';

/**
 * In-app toasts and desktop notifications for AI safety events (approval requested, auto-trip, blocked, offline;
 * design/screens/ai-safety-cost.md, B4 and H1). It polls the project's notification feed; the first load only
 * moves the cursor so opening the board never replays old news. An approval toast offers Review and Deny.
 */
export function useAiSafetyNotifications(projectId: string, onReview: () => void) {
  const toastNow = useToast();
  const toastRef = useRef(toastNow);
  toastRef.current = toastNow;
  const cursor = useRef<string | null>(null);
  const seen = useRef<Set<string>>(new Set());
  const review = useRef(onReview);
  review.current = onReview;
  useEffect(() => {
    cursor.current = null;
    seen.current = new Set();
    if (!projectId) return;
    let stopped = false;
    const tick = async () => {
      try {
        const toast = toastRef.current;
        const feed = await safetyApi.notifications(projectId, cursor.current ?? undefined);
        if (stopped) return;
        const first = cursor.current === null;
        cursor.current = feed.now;
        if (first) return;
        for (const n of [...feed.items].reverse()) {
          if (seen.current.has(n.id)) continue;
          seen.current.add(n.id);
          if (n.inapp) {
            if (n.event === 'approval_requested' && n.refKind === 'approval' && n.refId) {
              const id = n.refId;
              toast.showToast({
                variant: 'warning',
                title: n.title,
                message: n.body,
                duration: 12000,
                action: { label: 'Review', onClick: () => review.current() },
                secondaryAction: {
                  label: 'Deny',
                  onClick: () => {
                    void safetyApi.deny(id, 'Denied from the notification').then(
                      () => toast.success('Denied', 'The AI was told.'),
                      () => toast.error("Couldn't deny", 'Open the approval to see why.'),
                    );
                  },
                },
              });
            } else
              toast.showToast({
                variant: n.event === 'budget' ? 'warning' : 'info',
                title: n.title,
                message: n.body,
                duration: 9000,
              });
          }
          if (n.desktop && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            try {
              new Notification(n.title, { body: n.body });
            } catch {
              /* some platforms refuse the constructor */
            }
          }
        }
      } catch {
        /* offline or the server is restarting: try again next time */
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 8000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [projectId]);
}
