import type { Db, AnyBulkWriteOperation } from 'mongodb';
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

/** One row's worth of the same commit [saveNoteMetadataBatch] performs for a whole push. */
export interface NoteMetadataEntry {
  id: string;
  fields: Partial<NoteDoc>;
  /** Set only for a note that does not exist yet. */
  fresh?: NoteDoc;
  /** The pre-image, for a note that already exists — lets the resulting doc be computed
   *  without reading it back, the same way [fields] already carries the caller's intent. */
  existing?: NoteDoc;
}

/**
 * The batch form of [saveNoteMetadata]: one sequence-number block, one bulk write and one
 * results push for the whole push instead of one transaction per row. A push of 50 notes
 * used to pay for 50 transaction commits (the dominant cost once Drive writes overlap); this
 * pays for one, at the cost of a single extra read to notice a row whose target vanished
 * under us (an update that a blind bulk write cannot report per-row, unlike the single-row
 * `findOneAndUpdate` above).
 *
 * Ordering matches [entries]' order, so sequence numbers stay consecutive and in request order,
 * same as calling [saveNoteMetadata] once per row in a loop.
 */
export async function saveNoteMetadataBatch(
  db: Db,
  userId: string,
  entries: NoteMetadataEntry[],
  operationId: string,
): Promise<{ saved: Map<string, NoteDoc>; notFound: string[] }> {
  if (entries.length === 0) return { saved: new Map(), notFound: [] };
  return withTransaction(async (session) => {
    const counter = await db.collection<{ _id: string; value: number }>('sync_counters').findOneAndUpdate(
      { _id: userId }, { $inc: { value: entries.length } }, { upsert: true, returnDocument: 'after', session },
    );
    const firstSeq = counter!.value - entries.length + 1;

    const saved = new Map<string, NoteDoc>();
    const ops: AnyBulkWriteOperation<NoteDoc>[] = [];
    const updateIds: string[] = [];

    entries.forEach((entry, i) => {
      const syncSequence = firstSeq + i;
      if (entry.fresh) {
        const doc: NoteDoc = { ...entry.fresh, ...entry.fields, syncSequence };
        saved.set(entry.id, doc);
        ops.push({ insertOne: { document: doc } });
      } else {
        const doc: NoteDoc = {
          ...entry.existing!,
          ...entry.fields,
          syncSequence,
          localVersion: entry.existing!.localVersion + 1,
        };
        saved.set(entry.id, doc);
        updateIds.push(entry.id);
        ops.push({
          updateOne: {
            filter: { _id: entry.id, userId },
            update: { $set: { ...entry.fields, syncSequence }, $inc: { localVersion: 1 } },
          },
        });
      }
    });

    await collections.notes(db).bulkWrite(ops, { session, ordered: false });

    // A blind update reports no per-row match count; a follow-up read (inside the same
    // transaction, so it sees the write just made) finds any target that had vanished.
    if (updateIds.length > 0) {
      const present = await collections.notes(db)
        .find({ _id: { $in: updateIds }, userId }, { projection: { _id: 1 }, session })
        .toArray();
      const presentIds = new Set(present.map((d) => d._id));
      for (const id of updateIds) if (!presentIds.has(id)) saved.delete(id);
    }
    const notFound = entries.map((e) => e.id).filter((id) => !saved.has(id));

    const results = [...saved.values()].map((doc) => ({
      id: doc._id, ok: true as const, version: doc.localVersion, updated_at: doc.updatedAt.toISOString(), seq: doc.syncSequence!,
    }));
    if (results.length > 0) {
      const recorded = await syncOperations(db).updateOne(
        { _id: operationId, status: 'pending' },
        { $push: { results: { $each: results } } },
        { session },
      );
      if (recorded.matchedCount !== 1) throw Object.assign(new Error('sync_operation_closed'), { status: 409 });
    }
    return { saved, notFound };
  });
}
