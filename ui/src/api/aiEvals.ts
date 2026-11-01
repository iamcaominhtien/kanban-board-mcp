import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EvalSuite, Mark } from '../types/aiEvals';
import { client } from './client';

export const evalKeys = {
  suites: ['ai', 'evals', 'suites'] as const,
  marks: ['ai', 'evals', 'marks'] as const,
};

export const evalApi = {
  suites: async () => (await client.get<EvalSuite[]>('/ai/evals/suites')).data,
  marks: async () => (await client.get<Mark[]>('/ai/evals/marks')).data,
  run: async (suite: string, memberId: string) =>
    (await client.post<{ markId: string; suite: string; runs: number }>('/ai/evals/run', { suite, memberId })).data,
};

/** Part of the team marks (wave 3). */
export function useEvalSuites() {
  return useQuery({ queryKey: evalKeys.suites, queryFn: evalApi.suites, staleTime: Infinity });
}

/** The marks, newest first; refreshed every few seconds while one is running. */
export function useEvalMarks() {
  return useQuery({
    queryKey: evalKeys.marks,
    queryFn: evalApi.marks,
    refetchInterval: (q) => (q.state.data?.some((m) => m.state === 'running') ? 3000 : false),
  });
}

/** Part of the team marks (wave 3). */
export function useRunEval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { suite: string; memberId: string }) => evalApi.run(v.suite, v.memberId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: evalKeys.marks }),
  });
}
