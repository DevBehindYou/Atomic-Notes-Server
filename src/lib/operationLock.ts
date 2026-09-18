import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Db } from 'mongodb';

/**
 * Cross-instance serialization. The lease exceeds the configured 300s function
 * limit, so a live request always owns its lock. [waitMs] lets a request queue
 * behind a short-lived holder instead of failing at once with 409.
 */
export async function acquireOperationLock(db: Db, key: string, waitMs = 0): Promise<() => Promise<void>> {
  const owner = randomUUID();
  const locks = db.collection<{ _id: string; owner: string; expiresAt: Date }>('operation_locks');
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const result = await locks.updateOne(
        { _id: key, expiresAt: { $lte: new Date() } },
        { $set: { owner, expiresAt: new Date(Date.now() + 600000) } },
        { upsert: true },
      );
      if (!result.matchedCount && !result.upsertedCount) throw new Error('lock_not_acquired');
      return async () => { await locks.deleteOne({ _id: key, owner }); };
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      if (Date.now() >= deadline) throw Object.assign(new Error('operation_in_progress'), { status: 409 });
      await delay(100);
    }
  }
}
