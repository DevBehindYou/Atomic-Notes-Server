import { z } from 'zod';
import { todoItemSchema } from './atomicFile';

// Matches the Flutter Note.toRemote + _sealRemote payload.
export const remoteNoteRowSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['text', 'todo']),
  title: z.string(),
  body: z.string(),
  items: z.array(todoItemSchema),
  pinned: z.boolean(),
  deleted: z.boolean(),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }).optional(),
  enc_v: z.number().int(),
  payload: z.string().nullable(),
});
