import { useQuery } from '@tanstack/react-query';
import { client } from './client';
import type { AssistDraft, Availability, CostEstimate } from '../types/assist';
import type { SentPiece } from './editorAi';
import type { SketchOwnerKind } from './sketches';

/** What the AI is asked to do with the drawing. */
export type SketchAiMode = 'ask' | 'ideas' | 'draw';

/** Where the sketch is: the AI is booked on the project of its owner. */
export interface SketchAiOwner {
  ownerKind: SketchOwnerKind;
  ownerId: string;
  projectId?: string;
  sketchId?: string;
}

/** What the sketch editor may offer, and whether this person may use it now. */
export interface SketchAiState {
  availability: Availability;
  memberId: string | null;
  estimates: Record<SketchAiMode, CostEstimate> | null;
  limits: { maxOps: number; maxPoints: number; maxText: number; maxImageBytes: number };
  neverSent: string[];
}

/** "What will be sent" for one request. */
export interface SketchAiPreview {
  pieces: SentPiece[];
  tokens: number;
  estimate: CostEstimate | null;
  neverSent: string[];
  injections: { source: string; quote: string }[];
}

/** An earlier question and answer of the panel; the last few are sent along, as data. */
export interface SketchAiTurn {
  q: string;
  a: string;
}

/** One request. */
export interface SketchAiRequest extends SketchAiOwner {
  mode: SketchAiMode;
  prompt: string;
  title: string;
  /** Canvas size: the shapes of `draw` are clamped to it. */
  width: number;
  height: number;
  history?: SketchAiTurn[];
}

/** The result of a sketch draft (`draft.payload.result`). */
export interface SketchAiResult {
  kind: 'answer' | 'ideas' | 'ops';
  text?: string;
  items?: string[];
  ops?: unknown[];
  dropped?: number;
  note?: string;
  layer?: string;
  width?: number;
  height?: number;
  cutShort: boolean;
  injections?: { source: string; quote: string }[];
}

export const sketchAiKeys = {
  state: (o: SketchAiOwner) =>
    ['sketch-ai', 'state', o.ownerKind, o.ownerId, o.projectId ?? '', o.sketchId ?? ''] as const,
};

/**
 * Whether AI help is available in the sketch editor for this person, who would answer and what it costs. Nothing is
 * sent. A refusal (viewer, AI off for the project, stranger...) comes back as `availability.code`, not as an error.
 * @param owner - The ticket, page or idea the sketch is in.
 * @param enabled - False skips the request.
 */
export function useSketchAiState(owner: SketchAiOwner, enabled = true) {
  return useQuery({
    queryKey: sketchAiKeys.state(owner),
    queryFn: async () =>
      (
        await client.get<SketchAiState>('/ai/sketch/state', {
          params: {
            owner_kind: owner.ownerKind,
            owner_id: owner.ownerId,
            project_id: owner.projectId,
            sketch_id: owner.sketchId,
          },
        })
      ).data,
    enabled: enabled && !!owner.ownerId,
    staleTime: 15000,
    retry: false,
  });
}

export const sketchAiApi = {
  /** "What will be sent": the pieces of this request. Sends nothing; only the size of the picture is told. */
  preview: async (req: SketchAiRequest, image: { width: number; height: number; bytes: number } | null) =>
    (
      await client.post<SketchAiPreview>('/ai/sketch/preview', {
        ownerKind: req.ownerKind,
        ownerId: req.ownerId,
        projectId: req.projectId,
        sketchId: req.sketchId,
        mode: req.mode,
        prompt: req.prompt,
        title: req.title,
        width: req.width,
        height: req.height,
        history: req.history ?? [],
        withImage: !!image,
        imageWidth: image?.width ?? 0,
        imageHeight: image?.height ?? 0,
        imageBytes: image?.bytes ?? 0,
      })
    ).data,
  /** Ask; poll the draft with `GET /ai/assist/drafts/{id}`. Nothing in the drawing changes. */
  ask: async (req: SketchAiRequest, image: Blob | null) => {
    const f = new FormData();
    f.append('owner_kind', req.ownerKind);
    f.append('owner_id', req.ownerId);
    if (req.projectId) f.append('project_id', req.projectId);
    if (req.sketchId) f.append('sketch_id', req.sketchId);
    f.append('mode', req.mode);
    f.append('prompt', req.prompt);
    f.append('title', req.title);
    f.append('width', String(req.width));
    f.append('height', String(req.height));
    f.append('history', JSON.stringify(req.history ?? []));
    if (image) f.append('image', image, 'picture.png');
    return (await client.post<AssistDraft>('/ai/sketch/drafts', f)).data;
  },
  getDraft: async (id: string) => (await client.get<AssistDraft>(`/ai/assist/drafts/${id}`)).data,
  /** Accept: the shapes are on the AI layer; this records it in the audit log. */
  accept: async (id: string) => (await client.post<AssistDraft>(`/ai/sketch/drafts/${id}/accept`)).data,
  discard: async (id: string) => (await client.post<AssistDraft>(`/ai/assist/drafts/${id}/discard`)).data,
  cancel: async (id: string) => (await client.post<AssistDraft>(`/ai/assist/drafts/${id}/cancel`)).data,
};

/**
 * The words of a failed sketch AI call, from the server's `{detail, code}` body or the network.
 * @param err - The thrown value.
 */
export function sketchAiError(err: unknown): { code: string; message: string } {
  const e = err as { response?: { data?: { detail?: unknown; code?: string } }; message?: string };
  const data = e?.response?.data;
  if (data && typeof data.detail === 'string') return { code: data.code ?? 'error', message: data.detail };
  return { code: 'offline', message: 'Could not reach the server. Nothing was sent.' };
}
