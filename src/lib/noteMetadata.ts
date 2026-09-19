import type { Db } from 'mongodb';
import { collections, type NoteDoc } from '../db/collections.js';
import { withTransaction } from '../db/mongo.js';
import { syncOperations } from './syncOperation.js';

/**
 * Commit a monotonic per-user sync sequence with each metadata mutation.
 * With an operation ID, the success result is stored in the same transaction.
 * A closed operation aborts the commit, so a request that outlived its lock
 * cannot write metadata that no operation accounts for.
 */
export async function saveNoteMetadata(db: Db, userId: string, id: string, fields: Partial<NoteDoc>, fresh?: NoteDoc, operationId?: string): Promise<NoteDoc> {
  return withTransaction(async (session) => {
    const counter = await db.collection<{ _id: string; value: number }>('sync_counters').findOneAndUpdate(
      { _id: userId }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after', session },
    );
    const syncSequence = counter!.value;
    let saved: NoteDoc;
    if (fresh) {
      saved = { ...fresh, ...fields, syncSequence };
      await collections.notes(db).insertOne(saved, { session });
    } else {
      // The write returns the stored document, so no second read is needed.
      const updated = await collections.notes(db).findOneAndUpdate({ _id: id, userId },
        { $set: { ...fields, syncSequence }, $inc: { localVersion: 1 } }, { returnDocument: 'after', session });
      if (!updated) throw new Error('note_not_found');
      saved = updated;
    }
    if (operationId) {
      const recorded = await syncOperations(db).updateOne({ _id: operationId, status: 'pending' }, {
        $push: { results: { id, ok: true, version: saved.localVersion, updated_at: saved.updatedAt.toISOString(), seq: syncSequence } },
      }, { session });
      if (recorded.matchedCount !== 1) throw Object.assign(new Error('sync_operation_closed'), { status: 409 });
    }
    return saved;
  });
}
