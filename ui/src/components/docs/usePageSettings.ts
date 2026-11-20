/**
 * Changing a page's settings from the Page settings panel: each change shows on the page at once (the cached page
 * is updated), and the changes made within a short pause are sent together. When the server refuses them the page
 * goes back to what it was and a toast says why.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { docsErrorDetail, docsKeys, patchPageSettings } from '../../api/docs';
import { extractError } from '../../api/extractError';
import type { DocsPage } from '../../types/docs';
import { useToast } from '../Toast';
import { mergeSettings, type SettingsPatch } from './pageSettings';

/** Pause after the last change before it is sent (ms). */
export const SETTINGS_SAVE_MS = 400;

/**
 * Returns `change(patch)`: applies the patch to the cached page now and sends it after a short pause.
 * @param pageId - The page whose settings change.
 */
export function usePageSettingsSaver(pageId: string): (patch: SettingsPatch) => void {
  const qc = useQueryClient();
  const toast = useToast();
  const pending = useRef<Record<string, unknown>>({});
  // the settings before the first change that has not been saved yet (what an error goes back to)
  const before = useRef<Record<string, unknown> | undefined | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef({ qc, toast, pageId });
  live.current = { qc, toast, pageId };

  const flush = useCallback(async () => {
    timer.current = null;
    const { qc: q, toast: t, pageId: id } = live.current;
    const patch = pending.current;
    if (!Object.keys(patch).length) return;
    pending.current = {};
    const restore = before.current;
    before.current = null;
    try {
      const page = await patchPageSettings(id, patch);
      // changes made while this one was on its way stay on screen
      const later = pending.current;
      q.setQueryData<DocsPage>(docsKeys.page(id), (old) =>
        old ? { ...old, ...page, settings: mergeSettings(page.settings, later) } : page,
      );
    } catch (e) {
      q.setQueryData<DocsPage>(docsKeys.page(id), (old) =>
        old ? { ...old, settings: mergeSettings(restore ?? undefined, pending.current) } : old,
      );
      t.error("Couldn't save the page settings", docsErrorDetail(e)?.message ?? extractError(e));
    }
  }, []);

  // a change still waiting is sent when the panel or the page goes away
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        void flush();
      }
    },
    [pageId, flush],
  );

  return useCallback(
    (patch: SettingsPatch) => {
      const { qc: q, pageId: id } = live.current;
      const cur = q.getQueryData<DocsPage>(docsKeys.page(id));
      if (before.current === null) before.current = cur?.settings;
      q.setQueryData<DocsPage>(docsKeys.page(id), (old) =>
        old ? { ...old, settings: mergeSettings(old.settings, patch) } : old,
      );
      Object.assign(pending.current, patch);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SETTINGS_SAVE_MS);
    },
    [flush],
  );
}
