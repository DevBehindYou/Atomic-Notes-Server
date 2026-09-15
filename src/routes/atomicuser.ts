import { energyEnsure } from '../lib/energy';
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../db/mongo';
import { collections } from '../db/collections';
import { requireAuth } from '../middleware/auth';

const atomicuser = new Hono();
atomicuser.use('*', requireAuth);

atomicuser.get('/', async (c) => {
  const userId = c.get('userId') as string;
  const db = await getDb();
  const doc = await collections.atomicUsers(db).findOne({ _id: userId });
  // Bare value, no '@' prefix and no '@atomicuser' fallback baked in here —
  // the live client's own getUserInfo() already owns that formatting
  // (empty string -> "@atomicuser", otherwise "@$username"). Baking a
  // half-formatted default in here would make the client's job ambiguous:
  // it can't tell "this really is the literal fallback" from "someone
  // named their account '@atomicuser'".
  return c.json({ username: doc?.username ?? '' });
});

const updateSchema = z.object({ username: z.string().min(1).max(60) });

// The live app's auth_service.dart does an insert-then-catch-23505-then-update
// dance to work around not having an atomic upsert available at the call site.
// A single upsert does the same thing in one round trip and one code path.
atomicuser.patch('/', async (c) => {
  const userId = c.get('userId') as string;
  const { username } = updateSchema.parse(await c.req.json());
  const db = await getDb();
  await energyEnsure(db, userId);
  await collections.atomicUsers(db).updateOne({ _id: userId }, { $set: { username } });
  return c.json({ ok: true, username });
});

export default atomicuser;
