import { useMutation, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { client } from './client';
import { docsAiError, useDocsAiJob, type DocsAiJob } from './docsAi';

/** What AI does with one page (docs-ai E and F). Every call starts a job; the answer is the job's `result`. */

export interface SummaryResult {
  text: string;
  title: string;
  cost: number;
  metered: boolean;
  flagged?: string;
}

export interface ExplainResult {
  text: string;
  /** "Architecture › API" */
  from: string;
  section: string;
  cost: number;
  metered: boolean;
  flagged?: string;
}

export interface TranslateResult {
  markdown: string;
  language: string;
  keptOriginalBlocks: number;
  cost: number;
  metered: boolean;
  /** Only the first sections fit in one request. */
  tooLong?: { readSections: number; totalSections: number };
  sections?: { slug: string; title: string }[];
}

export type FindingKind = 'unclear' | 'missing' | 'unknown_link' | 'style';

export interface CheckFinding {
  id: string;
  kind: FindingKind;
  quote: string;
  section: string;
  message: string;
  suggestion?: string;
}

export interface CheckResult {
  findings: CheckFinding[];
  stylePage: { id: string; title: string } | null;
  ignored: number;
  cost: number;
  metered: boolean;
}

export interface FixResult {
  findingId: string;
  old: string;
  new: string;
  cost: number;
  metered: boolean;
}

export interface DiagramResult {
  diagramId: string;
  label: string;
  version: number;
  /** `[name](diagram:dg_…)`: the line that shows the diagram in a page. */
  markdown: string;
  /** True when an existing diagram got a new version. */
  changed: boolean;
  cost: number;
  metered: boolean;
}

export const pageAiKeys = { page: (pageId: string) => ['docs-ai', 'page', pageId] as const };

const post = async (path: string, body?: unknown) => (await client.post<DocsAiJob>(path, body)).data;

/** The calls that start a page-level Docs AI job. Each returns the job; follow it with `useDocsAiJob`. */
export function usePageAiStart(pageId: string) {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: ['docs-ai', 'jobs'] });
  const summary = useMutation({
    mutationFn: (markdown?: string) => post(`/docs/pages/${pageId}/ai/summary`, markdown ? { markdown } : {}),
    onSuccess: done,
  });
  const explain = useMutation({
    mutationFn: (v: { selection: string; section?: string }) => post(`/docs/pages/${pageId}/ai/explain`, v),
    onSuccess: done,
  });
  const translate = useMutation({
    mutationFn: (v: { language: string; section?: string }) => post(`/docs/pages/${pageId}/ai/translate`, v),
    onSuccess: done,
  });
  const check = useMutation({
    mutationFn: (markdown?: string) => post(`/docs/pages/${pageId}/ai/check`, markdown ? { markdown } : {}),
    onSuccess: done,
  });
  const fix = useMutation({
    mutationFn: (v: { findingId: string; markdown?: string; jobId?: string }) =>
      post(`/docs/pages/${pageId}/ai/check/${v.findingId}/fix`, { markdown: v.markdown, jobId: v.jobId }),
    onSuccess: done,
  });
  const diagram = useMutation({
    mutationFn: (v: { selection?: string; instruction?: string; diagramId?: string; markdown?: string }) =>
      post(`/docs/pages/${pageId}/ai/diagram`, {
        selection: v.selection,
        instruction: v.instruction,
        diagram_id: v.diagramId,
        markdown: v.markdown,
      }),
    onSuccess: done,
  });
  const ignore = useMutation({
    mutationFn: async (key: string) =>
      (await client.post<{ ok: boolean; key: string }>(`/docs/pages/${pageId}/ai/check/ignore`, { key })).data,
  });
  return { summary, explain, translate, check, fix, diagram, ignore };
}

/** A running page job and its typed result (null until it finishes). */
export function usePageJob<T>(jobId: string | null | undefined) {
  const job = useDocsAiJob(jobId);
  const data = job.data;
  const failed = data?.state === 'failed' || data?.state === 'cancelled';
  return {
    job: data,
    running: !!jobId && (!data || data.state === 'queued' || data.state === 'running'),
    result: data?.state === 'finished' ? (data.result as unknown as T) : null,
    error: failed ? { code: data.error.code ?? 'error', detail: data.error.message ?? 'Could not finish.' } : null,
  };
}

/** "Check if up to date" (the freshness check lives in another feature; a 404/501 means it is not there yet). */
export function useCheckFreshness(pageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await client.post<unknown>(`/docs/pages/${pageId}/ai/freshness`, {})).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['docs-ai'] }),
  });
}

/** Whether a failed freshness call means "not available" (so the menu row is disabled instead of showing an error). */
export function freshnessUnavailable(e: unknown): boolean {
  return axios.isAxiosError(e) && (e.response?.status === 404 || e.response?.status === 501);
}

/** The message and code of a failed page AI call, from the request or from a failed job. */
export function pageAiProblem(e: unknown): { code: string; detail: string } {
  return docsAiError(e) ?? { code: 'error', detail: 'Something went wrong. Try again.' };
}
