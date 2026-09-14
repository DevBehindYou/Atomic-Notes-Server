import type { Context, Next } from 'hono';
import { getDb } from '../db/mongo';
import { verifySession } from '../lib/session';

// Session-based, not JWT-based: the token is opaque and looked up in
// MongoDB on every request. This is the point of "store the client session
// in MongoDB" — it's what makes /auth/logout and future "sign out other
// devices" actually work, which a self-contained JWT can't do without a
// matching revocation list anyway (at which point you have this, plus a JWT).
export async function requireAuth(c: Context, next: Next) {
  const authHeader = c.req.header('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'missing_token' }, 401);
  }
  const rawToken = authHeader.slice('Bearer '.length);

  const db = await getDb();
  const userId = await verifySession(db, rawToken);
  if (!userId) return c.json({ error: 'invalid_token' }, 401);

  c.set('userId', userId);
  c.set('sessionToken', rawToken);
  await next();
}
