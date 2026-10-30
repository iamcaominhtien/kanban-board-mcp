import { useMutation, useQueryClient } from '@tanstack/react-query';
import { client } from './client';
import type { DocsAiJob } from './docsAi';

/** Where Ask the docs looks: this space, the open page (and the pages it links to) or every project I belong to. */
export type AskScope = 'space' | 'page' | 'all';
export type AskVerdict = 'answer' | 'not_covered' | 'disagree';

/** A source the answer used; the server verified the page, the heading and that the quote is in that section. */
export interface AskSource {
  n?: number;
  pageId: string;
  projectId: string;
  title: string;
  path: string[];
  heading: string;
  anchor: string | null;
  quote: string;
  editedAt: string;
}

export interface AskClosest {
  pageId: string;
  title: string;
  path: string[];
  heading: string;
  snippet: string;
}

/** The `result` of a finished `ask` job. */
export interface AskResult {
  question: string;
  scope: AskScope;
  pageId: string | null;
  answer: string;
  verdict: AskVerdict;
  citations: (AskSource & { n: number })[];
  closest: AskClosest[];
  conflicts: AskSource[];
  pagesRead: number;
  pagesCited: number;
  indexUpdatedAt: string | null;
  /** Page scope only: the page has more sections than one request holds. */
  tooLong: { readSections: number; totalSections: number } | null;
  askedModel: boolean;
  problems?: string[];
  injections?: { pageId: string; title: string; quote: string }[];
  feedback?: { rating: 'up' | 'down'; reason: string };
}

/** The typed result of a finished ask job (null while it runs or when it failed). */
export function askResult(job: DocsAiJob | undefined): AskResult | null {
  if (!job || job.state !== 'finished' || !job.result || !('verdict' in job.result)) return null;
  return job.result as unknown as AskResult;
}

export const askDocsApi = {
  ask: async (projectId: string, body: { question: string; scope: AskScope; pageId?: string | null }) =>
    (await client.post<DocsAiJob>(`/projects/${projectId}/docs/ai/ask`, body)).data,
  openAsChat: async (jobId: string) => (await client.post<{ chatId: string }>(`/docs/ai/ask/${jobId}/chat`)).data,
  feedback: async (jobId: string, rating: 'up' | 'down', reason?: string) =>
    (await client.post(`/docs/ai/ask/${jobId}/feedback`, { rating, reason })).data,
  reportStale: async (pageId: string, reason: string, jobId?: string) =>
    (await client.post(`/docs/pages/${pageId}/ai/report-stale`, { reason, jobId })).data,
};

/** Start an Ask (never automatic: only Enter or the button calls this). */
export function useAskDocs(projectId: string) {
  return useMutation({
    mutationFn: (body: { question: string; scope: AskScope; pageId?: string | null }) =>
      askDocsApi.ask(projectId, body),
  });
}

/** "Report as out of date": the page appears in Docs health; nothing is edited. */
export function useReportStale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { pageId: string; reason: string; jobId?: string }) =>
      askDocsApi.reportStale(v.pageId, v.reason, v.jobId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['docs-ai'] }),
  });
}
