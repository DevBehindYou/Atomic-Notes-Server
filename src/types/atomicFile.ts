import { z } from 'zod';

// v1 of the Atomic Notes file format — the JSON body of each `<uuid>.atomic`
// file living in the user's own Drive. Mirrors the real `Note` model's full
// content-bearing columns (lib/database/note.dart): kind/title/body/items/
// pinned for a plaintext note, PLUS encV/payload for an encrypted one — when
// encV >= 1, title/body/items are empty placeholders and `payload` carries
// the actual ciphertext (see lib/security/vault.dart's seal/open). Missing
// payload/encV here was a real bug in this scaffold's first pass: an
// encrypted note would have round-tripped as empty content, silently.
export const todoItemSchema = z.union([
  z.object({ text: z.string(), done: z.boolean() }),
  z.object({ t: z.string(), d: z.boolean() }).transform(({ t, d }) => ({ text: t, done: d })),
]);

export const atomicFileV1Schema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  kind: z.enum(['text', 'todo']),
  title: z.string().max(300),
  body: z.string(),
  items: z.array(todoItemSchema).default([]),
  pinned: z.boolean().default(false),
  encV: z.number().int().default(0),
  payload: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type AtomicFileV1 = z.infer<typeof atomicFileV1Schema>;

/** A Drive file that exists but is not a readable note (edited or replaced outside the app). */
export class CorruptAtomicFileError extends Error {}

export function migrateAtomicFile(raw: unknown): AtomicFileV1 {
  const parsed = atomicFileV1Schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // Add `if (raw.version === <older>) return upgrade(raw)` branches here as the
  // format evolves, instead of failing every file written before a schema change.
  throw new CorruptAtomicFileError('Unrecognized or corrupt .atomic file — no migration path defined for this shape yet.');
}
