import { Hono } from 'hono';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/mongo';
import { collections } from '../db/collections';
import { requireAuth } from '../middleware/auth';
import { logEvent } from '../lib/logs';

// IMPORTANT: this file does not, and should not, ever see a recovery phrase
// or a derived key. In the live app (lib/security/vault.dart), the phrase
// never leaves the device: the key is derived client-side, and the server's
// only jobs are (1) store a verifier so a wrong phrase can be rejected
// without trusting the client, and (2) hand back the KDF parameters so a
// second device derives the identical key. Do not "helpfully" add a
// server-side unlock/verify endpoint — that would mean the phrase (or the
// key) crossing the network, which defeats the entire design.
const vault = new Hono();
vault.use('*', requireAuth);

const createVaultSchema = z.object({
  verifier: z.string().min(1),
  kdfMemory: z.number().int().positive(),
  kdfIterations: z.number().int().positive(),
  kdfParallelism: z.number().int().positive(),
});

/** Lets a device check whether this account has a vault before prompting for a phrase. */
vault.get('/', async (c) => {
  const userId = c.get('userId') as string;
  const db = await getDb();
  const row = await collections.vaults(db).findOne({ _id: userId });
  if (!row) return c.json({ enabled: false }, 404);
  return c.json({
    enabled: true,
    verifier: row.verifier,
    kdf: row.kdf,
    kdfMemory: row.kdfMemory,
    kdfIterations: row.kdfIterations,
    kdfParallelism: row.kdfParallelism,
    encV: row.encV,
  });
});

/**
 * Creates the vault row. Insert-only, like the live app: a vault that
 * already exists for this account is a 409, never silently overwritten —
 * overwriting it would orphan every note already encrypted under the old key
 * on other devices.
 */
vault.post('/', async (c) => {
  const userId = c.get('userId') as string;
  const body = createVaultSchema.parse(await c.req.json());
  const db = await getDb();

  const existing = await collections.vaults(db).findOne({ _id: userId });
  if (existing) return c.json({ error: 'vault_already_exists' }, 409);

  try {
    await collections.vaults(db).insertOne({
    _id: userId,
    verifier: body.verifier,
    kdf: 'argon2id',
    kdfMemory: body.kdfMemory,
    kdfIterations: body.kdfIterations,
    kdfParallelism: body.kdfParallelism,
    encV: 1,
    createdAt: new Date(),
  });

  } catch (error) {
    if ((error as { code?: number }).code === 11000) return c.json({ error: 'vault_already_exists' }, 409);
    throw error;
  }

  await logEvent(db, 'vault_created', { userId });
  return c.json({ ok: true }, 201);
});

export default vault;
