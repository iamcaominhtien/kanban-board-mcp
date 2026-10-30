import { useQuery } from '@tanstack/react-query';
import { client } from './client';
import { resolveOrigin } from './resolveOrigin';
import type { AssistDraft, Availability, ChatMessage, CostEstimate } from '../types/assist';
import type { SentPiece } from './editorAi';
import type { SketchOwnerKind } from './sketches';

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
  estimates: { answer: CostEstimate; draw: CostEstimate } | null;
  limits: {
    maxOps: number;
    maxPoints: number;
    maxText: number;
    maxPrompt: number;
    maxImageBytes: number;
    attachments: {
      maxImages: number;
      maxImageBytes: number;
      maxTextFiles: number;
      maxTextBytes: number;
      imageTypes: string[];
    };
  };
  neverSent: string[];
}

/** "What will be sent" for one message. */
export interface SketchAiPreview {
  pieces: SentPiece[];
  tokens: number;
  estimate: CostEstimate | null;
  drawEstimate: CostEstimate | null;
  neverSent: string[];
  injections: { source: string; quote: string }[];
}

/** An attachment of a message, as the thread keeps it. */
export interface SketchAttachment {
  id: string;
  name: string;
  kind: 'image' | 'text';
  mime: string;
  /** The stored file name, for `sketchFilePath`. */
  file: string;
  bytes: number;
  width: number;
  height: number;
  chars: number;
}

/** What a person's message carried: the canvas, whether the picture of the drawing went along, the attachments. */
export interface SketchTurn {
  id: string;
  canvas: { w: number; h: number; title: string };
  picture: { width: number; height: number; bytes: number; file: string } | null;
  attachments: SketchAttachment[];
}

/** One message of the panel. */
export interface SketchAiMessageInput {
  text: string;
  title: string;
  /** Canvas size: the shapes of a drawing are clamped to it. */
  width: number;
  height: number;
  /** The flattened picture of the canvas as it is now; null sends words only. */
  picture: Blob | null;
  files: File[];
  memberId?: string | null;
}

/** The proposal of an answer (`draft.payload.result` of its draft): shapes to draw and ideas to add as labels. */
export interface SketchProposal {
  kind: 'proposal';
  ops: unknown[];
  dropped: number;
  note: string;
  layer: string;
  width: number;
  height: number;
  ideas: string[];
  /** Indexes of the ideas that were added as labels. */
  added: number[];
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
  /** "What will be sent": the pieces of this message. Sends nothing; only the sizes are told. */
  preview: async (
    req: SketchAiOwner & {
      prompt: string;
      title: string;
      width: number;
      height: number;
      chatId?: string | null;
      attachments: {
        name: string;
        kind: 'image' | 'text';
        bytes: number;
        width?: number;
        height?: number;
        chars?: number;
      }[];
    },
    image: { width: number; height: number; bytes: number } | null,
  ) =>
    (
      await client.post<SketchAiPreview>('/ai/sketch/preview', {
        ownerKind: req.ownerKind,
        ownerId: req.ownerId,
        projectId: req.projectId,
        sketchId: req.sketchId,
        chatId: req.chatId,
        prompt: req.prompt,
        title: req.title,
        width: req.width,
        height: req.height,
        withImage: !!image,
        imageWidth: image?.width ?? 0,
        imageHeight: image?.height ?? 0,
        imageBytes: image?.bytes ?? 0,
        attachments: req.attachments,
      })
    ).data,
  /** Send a message with the picture of the canvas and the attached files; the answer streams into the returned message. */
  send: async (chatId: string, m: SketchAiMessageInput) => {
    const f = new FormData();
    f.append('text', m.text);
    f.append('title', m.title);
    f.append('width', String(m.width));
    f.append('height', String(m.height));
    f.append('with_image', m.picture ? 'true' : 'false');
    if (m.memberId) f.append('member_id', m.memberId);
    if (m.picture) f.append('image', m.picture, 'picture.png');
    for (const file of m.files) f.append('files', file, file.name);
    return (await client.post<{ user: ChatMessage; ai: ChatMessage }>(`/ai/sketch/chats/${chatId}/messages`, f)).data;
  },
  /** Accept: the shapes are on the AI layer; this records it in the audit log. */
  accept: async (id: string) => (await client.post<AssistDraft>(`/ai/sketch/drafts/${id}/accept`)).data,
  /** An idea was added as a text label; the thread remembers it. */
  ideaAdded: async (id: string, index: number) =>
    (await client.post<AssistDraft>(`/ai/sketch/drafts/${id}/idea`, { index })).data,
  discard: async (id: string) => (await client.post<AssistDraft>(`/ai/assist/drafts/${id}/discard`)).data,
};

/**
 * The address of a picture or file kept with the person's own chat (it needs their name, so it is fetched, not linked).
 * @param chatId - The chat.
 * @param turnId - The message's turn id (`SketchTurn.id`).
 * @param file - The stored file name (`picture.png`, or `SketchAttachment.file`).
 */
export function sketchFilePath(chatId: string, turnId: string, file: string): string {
  return `/ai/sketch/chats/${chatId}/files/${turnId}/${file}`;
}

/**
 * A kept picture as an object URL, fetched with the person's name (null while loading or when it is gone).
 * @param path - From `sketchFilePath`; undefined skips the request.
 */
export function useKeptPicture(path: string | undefined): string | null {
  const q = useQuery({
    queryKey: ['sketch-ai', 'file', path ?? ''],
    queryFn: async () => {
      // not through the JSON client: the answer is a picture. The person's name goes along like on every request.
      let actor: string | null = null;
      try {
        actor = localStorage.getItem('kanbanActor');
      } catch {
        /* storage unavailable */
      }
      const r = await fetch(`${resolveOrigin()}${path}`, { headers: actor ? { 'X-Actor': actor } : {} });
      if (!r.ok) throw new Error('The picture is no longer kept.');
      return URL.createObjectURL(await r.blob());
    },
    enabled: !!path,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  return q.data ?? null;
}

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
