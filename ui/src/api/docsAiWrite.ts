import { useMutation, useQuery } from '@tanstack/react-query';
import { client } from './client';
import type { DocsAiJob } from './docsAi';
import type { NeedsInputMarker, SendPreview, TidyCounts, writeRequest } from '../utils/writeRules';

/** Docs AI: write a page, publishing and history helpers, tidy on import (design/screens/docs-ai*.md). */

export type WriteRequest = ReturnType<typeof writeRequest>;

/** "What will be sent": the list, approximate tokens and cost, and what was left out. */
export interface WritePreview extends SendPreview {
  items: { n: number; kind: string; label: string }[];
  injections: { source: string; quote: string }[];
  tokens: number;
  cost: number;
  metered: boolean;
  member: string;
  suggestedTitle: string;
  from: string;
}

export interface WriteResult {
  pageId: string;
  title: string;
  gaps: string[];
  sources: { n: number; kind: string; label: string; pageId: string | null; quote: string }[];
  markers: number;
  cost: number;
  skipped: { pageId: string; title: string; reason: string }[];
  notes: string[];
  injections: { source: string; quote: string }[];
}

export const writeKeys = {
  preview: (projectId: string, key: string) => ['docs-ai', 'write-preview', projectId, key] as const,
  markers: (pageId: string) => ['docs-ai', 'markers', pageId] as const,
};

/** "What will be sent" for the picked sources; nothing is asked of the AI. */
export function useWritePreview(projectId: string, body: WriteRequest | null) {
  const key = JSON.stringify(body);
  return useQuery({
    queryKey: writeKeys.preview(projectId, key),
    queryFn: async () => (await client.post<WritePreview>(`/projects/${projectId}/docs/ai/write/preview`, body)).data,
    enabled: !!projectId && !!body,
    retry: false,
    staleTime: 10000,
  });
}

/** Start writing the draft: a `write` job (poll it with `useDocsAiJob`). */
export function useStartWrite(projectId: string) {
  return useMutation({
    mutationFn: async (body: WriteRequest) =>
      (await client.post<DocsAiJob>(`/projects/${projectId}/docs/ai/write`, body)).data,
  });
}

export interface MarkersResult {
  count: number;
  markers: NeedsInputMarker[];
  withAi: boolean;
}

/** The Needs input markers in your draft of a page (publishing stays possible while there are some). */
export function usePageMarkers(pageId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: writeKeys.markers(pageId ?? ''),
    queryFn: async () => (await client.get<MarkersResult>(`/docs/pages/${pageId}/ai/markers`)).data,
    enabled: !!pageId && enabled,
    retry: false,
    staleTime: 0,
  });
}

/** The editor accepted AI text: History marks the version "with AI" once it is published. Failures are ignored. */
export async function markAiAccepted(pageId: string): Promise<void> {
  try {
    await client.post(`/docs/pages/${pageId}/ai/accepted`);
  } catch {
    /* the mark is a convenience; accepting the text must not fail because of it */
  }
}

/** "What changed since vN" for a range of versions: a `history_summary` job. */
export function useStartHistorySummary(pageId: string) {
  return useMutation({
    mutationFn: async (v: { fromVersion: number; toVersion: number }) =>
      (await client.post<DocsAiJob>(`/docs/pages/${pageId}/ai/history-summary`, v)).data,
  });
}

/** A suggested change note from your draft: a `publish_note` job. */
export function useStartPublishNote(pageId: string) {
  return useMutation({
    mutationFn: async (v: { markdown?: string }) =>
      (await client.post<DocsAiJob>(`/docs/pages/${pageId}/ai/publish-note`, v)).data,
  });
}

/** "Changes since you last viewed", summarised: a `since_viewed` job. */
export function useStartSinceViewed(projectId: string) {
  return useMutation({
    mutationFn: async () => (await client.post<DocsAiJob>(`/projects/${projectId}/docs/ai/since-viewed`)).data,
  });
}

export interface SinceViewedPage {
  pageId: string;
  title: string;
  kind: 'changed' | 'new';
  fromVersion: number;
  toVersion: number;
  line: string | null;
  hidden: boolean;
}

export interface TidyOptionsBody {
  splitByHeading: boolean;
  ticketChips: boolean;
  seeLinks: boolean;
  headingLevels: boolean;
}

export interface TidyPage {
  index: number;
  title: string;
  markdown: string;
  changes: string[];
  file: { path: string; content: string };
}

export interface TidyResult {
  options: TidyOptionsBody;
  source: { filename: string; bytes: number; sections: number; splitLevel: number };
  counts: TidyCounts;
  seeLinks: {
    id: string;
    pageIndex: number;
    pageTitle: string;
    line: number;
    phrase: string;
    title: string;
    accepted: boolean;
  }[];
  pages: TidyPage[];
  cost: number;
}

/** Preview a tidy import (nothing is imported by this call). */
export function useTidyPreview(projectId: string) {
  return useMutation({
    mutationFn: async (v: {
      markdown: string;
      filename: string;
      options: TidyOptionsBody;
      acceptSeeLinks?: string[];
    }) => (await client.post<TidyResult>(`/projects/${projectId}/docs/ai/tidy`, v)).data,
  });
}
