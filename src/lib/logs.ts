import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { collections } from '../db/collections';

export async function logEvent(
  db: Db,
  event: string,
  opts: { userId?: string | null; level?: 'info' | 'warn' | 'error'; meta?: Record<string, unknown> } = {},
) {
  try {
    await collections.logs(db).insertOne({
      _id: randomUUID(),
      userId: opts.userId ?? null,
      event,
      level: opts.level ?? 'info',
      meta: opts.meta ?? {},
      createdAt: new Date(),
    });
  } catch (e) {
    // Logging must never break the request it's logging about.
    // eslint-disable-next-line no-console
    console.error('logEvent failed', event, e);
  }
}
