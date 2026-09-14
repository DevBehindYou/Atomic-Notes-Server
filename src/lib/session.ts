import { randomBytes, createHash } from 'node:crypto';
import type { Db } from 'mongodb';
import { collections } from '../db/collections';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Creates a session and returns the RAW token to hand to the client. Only the
 * SHA-256 hash is stored in MongoDB — the raw token exists nowhere else,
 * same reasoning as never storing plaintext passwords. The sessions
 * collection has a TTL index on `expiresAt` (see db/collections.ts), so
 * expired sessions clean themselves up without a cron job.
 */
export async function createSession(db: Db, userId: string, userAgent?: string | null): Promise<string> {
  const rawToken = randomBytes(32).toString('base64url');
  const now = new Date();
  await collections.sessions(db).insertOne({
    _id: hashToken(rawToken),
    userId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    revoked: false,
    userAgent: userAgent ?? null,
  });
  return rawToken;
}

/** Returns the session's userId if the raw token is valid, not revoked, and unexpired — else null. */
export async function verifySession(db: Db, rawToken: string): Promise<string | null> {
  const doc = await collections.sessions(db).findOne({ _id: hashToken(rawToken) });
  if (!doc) return null;
  if (doc.revoked) return null;
  if (doc.expiresAt.getTime() < Date.now()) return null;
  return doc.userId;
}

/** Used by /auth/logout. Idempotent — revoking an already-revoked or unknown token is a no-op. */
export async function revokeSession(db: Db, rawToken: string): Promise<void> {
  await collections.sessions(db).updateOne({ _id: hashToken(rawToken) }, { $set: { revoked: true } });
}
