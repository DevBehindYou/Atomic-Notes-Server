import { createHash, randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { collections } from '../db/collections.js';
import { withTransaction } from '../db/mongo.js';
import { ENERGY, EnergyError, energyEnsure, energyGrantDaily } from './energy.js';

export type SyncResult = { id: string; ok: boolean; updated_at?: string; error?: string; version?: number };
export type SyncOperation = {
  _id: string; userId: string; fingerprint: string; mode: 'standard' | 'instant'; rowIds: string[];
  charged: number; createdAt: Date; previousStandardAt: Date | null;
  status: 'pending' | 'complete'; results: SyncResult[]; refunded: number;
};
export const syncOperations = (db: Db) => db.collection<SyncOperation>('sync_operations');

const operationId = (userId: string, requestId: string) => `${userId}:${requestId}`;
const mismatch = () => Object.assign(new Error('sync_request_mismatch'), { status: 409 });
const fingerprintOf = (rows: unknown[], mode: string) => createHash('sha256').update(JSON.stringify({ rows, mode })).digest('hex');

/**
 * Returns the recorded operation for a request ID, if any. A completed
 * operation is the authoritative answer to a retry, so callers use this
 * before any quota, token or ownership check that could block recovery.
 */
export async function findSync(db: Db, userId: string, requestId: string, rows: unknown[], mode: 'standard' | 'instant') {
  const previous = await syncOperations(db).findOne({ _id: operationId(userId, requestId) });
  if (!previous) return null;
  if (previous.fingerprint !== fingerprintOf(rows, mode)) throw mismatch();
  return previous;
}

/**
 * Charges and records a new operation, or returns the recorded one for a retry.
 *
 * Precondition: the caller holds this user's notes lock. While it is held no
 * other request of this user is running, so any *other* pending operation
 * belongs to a request that died. Those are settled here from their stored
 * results (see [finishSync]) instead of blocking the user forever.
 */
export async function beginSync(db: Db, userId: string, requestId: string, rows: { id: string }[], mode: 'standard' | 'instant') {
  const previous = await findSync(db, userId, requestId, rows, mode);
  if (previous) return previous;
  await settleAbandonedSyncs(db, userId);
  await energyEnsure(db, userId);
  await energyGrantDaily(db, userId);
  const fingerprint = fingerprintOf(rows, mode);
  return withTransaction(async (session) => {
    const wallet = (await collections.atomicUsers(db).findOne({ _id: userId }, { session }))!;
    const now = new Date();
    const free = mode === 'standard' && wallet.lastStandardSyncAt !== null &&
      now.getTime() - wallet.lastStandardSyncAt.getTime() < ENERGY.standardSyncFreeWindowMs;
    const charged = rows.length === 0 || free ? 0 : mode === 'instant' ? ENERGY.syncInstantCost : ENERGY.syncStandardCost;
    if (wallet.energy < charged) throw new EnergyError('insufficient_energy');
    const operation: SyncOperation = { _id: operationId(userId, requestId), userId, fingerprint, mode, rowIds: rows.map((row) => row.id),
      charged, createdAt: now, previousStandardAt: wallet.lastStandardSyncAt, status: 'pending', results: [], refunded: 0 };
    if (charged > 0) {
      await collections.atomicUsers(db).updateOne({ _id: userId }, {
        $inc: { energy: -charged }, ...(mode === 'standard' ? { $set: { lastStandardSyncAt: now } } : {}),
      }, { session });
      await collections.energyLedger(db).insertOne({ _id: randomUUID(), userId, kind: 'spend', coinsDelta: 0,
        energyDelta: -charged, resultingCoins: wallet.coins, resultingEnergy: wallet.energy - charged,
        note: `${mode === 'instant' ? 'Instant' : 'Standard'} sync`, createdAt: now }, { session });
    }
    await syncOperations(db).insertOne(operation, { session });
    return operation;
  });
}

/** Settle every pending operation of a user. Same precondition as [beginSync]. */
export async function settleAbandonedSyncs(db: Db, userId: string) {
  for (const operation of await syncOperations(db).find({ userId, status: 'pending' }).toArray()) {
    await finishSync(db, operation);
  }
}

/**
 * Records a failed row. A row that already has a stored result is left alone:
 * a commit whose response was lost may have stored its success already, and
 * the stored success wins.
 */
export async function recordSyncResult(db: Db, operation: SyncOperation, result: SyncResult) {
  await syncOperations(db).updateOne(
    { _id: operation._id, status: 'pending', 'results.id': { $ne: result.id } },
    { $push: { results: result } },
  );
}

/**
 * Closes an operation. The stored results are authoritative: a success is stored
 * in the same transaction as the note metadata it describes, so a stored
 * success means the commit happened, whatever the request observed. A row with
 * no stored result never committed. Only the Server decides refunds, once, and
 * only when no row was delivered. Closed operations return their recorded outcome.
 */
export async function finishSync(db: Db, operation: SyncOperation) {
  return withTransaction(async (session) => {
    const current = (await syncOperations(db).findOne({ _id: operation._id }, { session }))!;
    if (current.status === 'complete') return current;
    const stored = new Map<string, SyncResult>();
    for (const result of current.results) {
      const known = stored.get(result.id);
      if (!known || (result.ok && !known.ok)) stored.set(result.id, result);
    }
    const results = current.rowIds.map((id) => stored.get(id) ?? { id, ok: false, error: 'note_write_interrupted' });
    let refunded = 0;
    if (current.charged > 0 && results.every((r) => !r.ok)) {
      const wallet = (await collections.atomicUsers(db).findOne({ _id: current.userId }, { session }))!;
      refunded = Math.max(0, Math.min(current.charged, wallet.energyCap - wallet.energy));
      const restoreWindow = current.mode === 'standard' && wallet.lastStandardSyncAt?.getTime() === current.createdAt.getTime();
      if (refunded > 0 || restoreWindow) {
        await collections.atomicUsers(db).updateOne({ _id: current.userId }, {
          ...(refunded > 0 ? { $inc: { energy: refunded } } : {}),
          ...(restoreWindow ? { $set: { lastStandardSyncAt: current.previousStandardAt } } : {}),
        }, { session });
      }
      if (refunded > 0) {
        await collections.energyLedger(db).insertOne({ _id: randomUUID(), userId: current.userId, kind: 'admin_adjust',
          coinsDelta: 0, energyDelta: refunded, resultingCoins: wallet.coins, resultingEnergy: wallet.energy + refunded,
          note: 'Refund: sync failed before any note succeeded', createdAt: new Date() }, { session });
      }
    }
    await syncOperations(db).updateOne({ _id: current._id }, { $set: { results, refunded, status: 'complete' } }, { session });
    return { ...current, results, refunded, status: 'complete' as const };
  });
}
