import { useSyncExternalStore } from 'react';
import type { DocsRefRequest, DocsRefResult } from '../../../types/docs';
import { useEditorEnv } from './context';

/** Resolution of one reference (undefined while loading, null when the request failed). */
export function useResolved(ref: DocsRefRequest): DocsRefResult | null | undefined {
  const env = useEditorEnv();
  useSyncExternalStore(env?.resolver.subscribe ?? (() => () => {}), env?.resolver.getVersion ?? (() => 0));
  return env?.resolver.get(ref);
}
