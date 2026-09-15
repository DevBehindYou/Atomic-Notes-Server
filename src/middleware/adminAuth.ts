import type { Context, Next } from 'hono';
import { timingSafeEqual } from 'node:crypto';

/**
 * Admin endpoints are for one trusted caller — Atomic Community's
 * server-side Controller routes — not end users, so they get a completely
 * separate auth model from requireAuth (Google OAuth + session tokens):
 * a single static key, sent as a header, checked against an env var.
 *
 * Community's own `/controller` login (two passwords + HMAC cookie) is
 * unrelated to this and stays exactly as it is — that gates a human opening
 * the admin panel in a browser; this gates Community's server calling this
 * API on that human's behalf. Two different trust boundaries, deliberately
 * not conflated: rotating one never requires touching the other.
 */
export async function requireAdmin(c: Context, next: Next) {
  const key = c.req.header('x-admin-api-key');
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) {
    return c.json({ error: 'admin_api_not_configured' }, 500);
  }
  if (!key || Buffer.byteLength(key) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(key), Buffer.from(expected))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return next();
}
