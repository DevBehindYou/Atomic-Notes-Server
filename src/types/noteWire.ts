import { z } from 'zod';
import { todoItemSchema } from './atomicFile.js';

/** Bounds shared by batch sync and the direct note endpoints. */
export const NOTE_LIMITS = { title: 300, body: 131072, payload: 196608, wireBytes: 250000 } as const;

type NoteContent = { title: string; body: string; items: unknown[]; encV: number; payload: string | null };

/** Encrypted notes carry only ciphertext; plaintext and ciphertext must not mix. */
export function refineNoteContent(content: NoteContent, ctx: z.RefinementCtx) {
  if (Buffer.byteLength(JSON.stringify(content)) > NOTE_LIMITS.wireBytes) ctx.addIssue({ code: 'custom', message: 'Note exceeds 250 KB sync limit' });
  if (content.encV === 1 && (!content.payload || content.title || content.body || content.items.length)) {
    ctx.addIssue({ code: 'custom', message: 'Encrypted notes must contain only encrypted payload content' });
  }
  if (content.encV === 0 && content.payload) {
    ctx.addIssue({ code: 'custom', message: 'Plaintext notes cannot carry an encrypted payload' });
  }
}

// Matches the Flutter Note.toRemote + _sealRemote payload.
export const remoteNoteRowSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['text', 'todo']),
  title: z.string().max(NOTE_LIMITS.title),
  body: z.string().max(NOTE_LIMITS.body),
  items: z.array(todoItemSchema),
  pinned: z.boolean(),
  deleted: z.boolean(),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }).optional(),
  enc_v: z.union([z.literal(0), z.literal(1)]),
  payload: z.string().max(NOTE_LIMITS.payload).nullable(),
  base_version: z.number().int().nonnegative().default(0),
}).superRefine((row, ctx) => refineNoteContent({ ...row, encV: row.enc_v }, ctx));
