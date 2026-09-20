import { saveNoteMetadata } from '../lib/noteMetadata.js';
import { finishSync, findSync, openSync, recordSyncResult, settleAbandonedSyncs, type SyncOperation } from '../lib/syncOperation.js';
import { currentPerf, runWithPerf, timedDrive } from '../lib/perf.js';
import { NOTE_LIMIT } from '../lib/energy.js';
import { noteContentHash } from '../lib/contentHash.js';
import { acquireOperationLock } from '../lib/operationLock.js';
import { remoteNoteRowSchema } from '../types/noteWire.js';
import { mapConcurrent } from '../lib/concurrency.js';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { getDb } from '../db/mongo.js';
import { collections, type NoteDoc } from '../db/collections.js';
import { requireAuth } from '../middleware/auth.js';
import { decryptToken, encryptToken } from '../lib/crypto.js';
import { createNoteFile, updateNoteFile, deleteNoteFile, getNoteFileContent, ensureAppFolders, isDriveNotFound } from '../lib/googleDrive.js';
import { isInvalidGrant, refreshAccessToken } from '../lib/googleOAuth.js';
import { migrateAtomicFile, CorruptAtomicFileError } from '../types/atomicFile.js';
import { httpError } from '../lib/httpError.js';
import { logEvent } from '../lib/logs.js';

export type DriveAdapter = {
  createNoteFile: typeof createNoteFile;
  updateNoteFile: typeof updateNoteFile;
  deleteNoteFile: typeof deleteNoteFile;
  getNoteFileContent: typeof getNoteFileContent;
  ensureAppFolders?: typeof ensureAppFolders;
};

/** Notes per push request. Matches the most notes an account can hold, so one upload of everything is one request. */
export const MAX_PUSH_ROWS = NOTE_LIMIT.ceiling;
/** Drive writes in flight at once within one push. Each write is ~1.7 s of waiting, so they overlap well. */
const DRIVE_CONCURRENCY = 4;

export function createNotesRoute(drive: DriveAdapter = { createNoteFile, updateNoteFile, deleteNoteFile, getNoteFileContent }) {
  // Every Drive call is timed so a slow request shows how much of it was Google (see Server-Timing).
  const createNoteFile = (...args: Parameters<DriveAdapter['createNoteFile']>) => timedDrive(() => drive.createNoteFile(...args));
  const updateNoteFile = (...args: Parameters<DriveAdapter['updateNoteFile']>) => timedDrive(() => drive.updateNoteFile(...args));
  const deleteNoteFile = (...args: Parameters<DriveAdapter['deleteNoteFile']>) => timedDrive(() => drive.deleteNoteFile(...args));
  const getNoteFileContent = (...args: Parameters<DriveAdapter['getNoteFileContent']>) => timedDrive(() => drive.getNoteFileContent(...args));
  const ensureFolders = (...args: Parameters<typeof ensureAppFolders>) => timedDrive(() => (drive.ensureAppFolders ?? ensureAppFolders)(...args));
  const notesRoute = new Hono();
  // Notes are written through /push only, where sync is charged and rate limited. The single-note REST writes
  // would be a way around both, so they are closed.
  const usePush = (c: Context) => c.json({ error: 'use_push', hint: 'Write notes through POST /notes/push.' }, 410);
  notesRoute.post('/', usePush);
  notesRoute.patch('/:id', usePush);
  notesRoute.use('*', requireAuth);
  notesRoute.use('*', (c, next) => runWithPerf(async () => {
    const started = performance.now();
    // Writes are serialized per user across Vercel instances. Reads take no lock: pull reads the sequence
    // counter first and only rows up to it, and each sequence is committed before the next is issued.
    const readOnly = ['GET', 'HEAD'].includes(c.req.method);
    const release = readOnly ? null : await acquireOperationLock(await getDb(), `notes:${c.get('userId')}`, 15000);
    try {
      if (!readOnly && !c.req.path.endsWith('/push')) {
        // The lock is ours, so an operation still pending belongs to a request that died.
        await settleAbandonedSyncs(await getDb(), c.get('userId'));
      }
      await next();
    } finally { if (release) await release(); }
    const perf = currentPerf();
    c.header('Server-Timing', `total;dur=${Math.round(performance.now() - started)}, drive;dur=${Math.round(perf?.driveMs ?? 0)};desc="${perf?.driveCalls ?? 0} calls"`);
  }));

  /** Loads this user's Google tokens, refreshing the access token first if it's about to expire. */
  async function getLiveGoogleTokens(db: Awaited<ReturnType<typeof getDb>>, userId: string) {
    const account = await collections.googleAccounts(db).findOne({ userId });
    if (!account) throw Object.assign(new Error('no_google_account_linked'), { status: 409 });

    let accessToken = decryptToken(account.encryptedAccessToken);
    const refreshToken = decryptToken(account.encryptedRefreshToken);

    if (account.tokenExpiry.getTime() < Date.now() + 60_000) {
      let refreshed;
      try {
        refreshed = await refreshAccessToken(refreshToken);
      } catch (error) {
        // Revoked, or expired after seven days while the OAuth app is in Testing: the App signs in again.
        if (isInvalidGrant(error)) throw httpError('google_reauth_required', 401);
        throw error;
      }
      accessToken = refreshed.access_token!;
      await collections.googleAccounts(db).updateOne(
        { userId },
        { $set: { encryptedAccessToken: encryptToken(accessToken), tokenExpiry: new Date(refreshed.expiry_date!) } },
      );
    }

    if (!account.driveRootFolderId) throw Object.assign(new Error('drive_not_initialized'), { status: 409 });
    return { accessToken, refreshToken, driveFolderId: account.driveRootFolderId };
  }

  async function enforceNoteLimit(db: Awaited<ReturnType<typeof getDb>>, userId: string, incomingNewCount: number) {
    if (incomingNewCount <= 0) return null;
    const wallet = await collections.atomicUsers(db).findOne({ _id: userId });
    const noteLimit = wallet?.noteLimit ?? NOTE_LIMIT.free;
    const activeCount = await collections.notes(db).countDocuments({ userId, deleted: false });
    if (activeCount + incomingNewCount > noteLimit) return { error: 'note_limit_reached' as const, limit: noteLimit };
    return null;
  }

  // ---------------------------------------------------------------------------
  // Per-note REST CRUD — a simpler surface than /push and /pull below, for
  // anything that isn't the bulk sync path.
  // ---------------------------------------------------------------------------

  notesRoute.get('/', async (c) => {
    const userId = c.get('userId') as string;
    const db = await getDb();
    const rows = await collections.notes(db).find({ userId, deleted: false }).toArray();
    return c.json(rows);
  });

  notesRoute.get('/count', async (c) => {
    const userId = c.get('userId') as string;
    const db = await getDb();
    const count = await collections.notes(db).countDocuments({ userId, deleted: false });
    return c.json({ count });
  });

  notesRoute.delete('/:id', async (c) => {
    const userId = c.get('userId') as string;
    const id = c.req.param('id');
    const db = await getDb();
    const existing = await collections.notes(db).findOne({ _id: id, userId });
    if (!existing) return c.json({ error: 'not_found' }, 404);

    const { accessToken, refreshToken } = await getLiveGoogleTokens(db, userId);
    await deleteNoteFile(accessToken, refreshToken, existing.driveFileId);
    await saveNoteMetadata(db, userId, id, { deleted: true, updatedAt: new Date() });
    await logEvent(db, 'note_deleted', { userId, meta: { noteId: id } });
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Batch sync — /push and /pull. These exist specifically to match the shape
  // notes_repository.dart's `_push`/`_pull` already send/expect from Supabase
  // (snake_case row keys: id, kind, title, body, items, pinned, deleted,
  // created_at, updated_at, enc_v, payload), so the client's sync ALGORITHM
  // (dirty tracking, tombstones, merge-by-updated_at) needs no rewrite — only
  // the transport (Supabase client -> HTTP) does. `user_id` is deliberately
  // omitted from the wire shape below; it's implied by the session, never
  // trusted from the client.
  // ---------------------------------------------------------------------------
  type RemoteNoteRow = Omit<z.infer<typeof remoteNoteRowSchema>, 'base_version'> & { updated_at: string; version: number };

  function toWireRow(m: NoteDoc, content: { title: string; body: string; items: unknown[]; payload: string | null }): RemoteNoteRow {
    return {
      id: m._id,
      version: m.localVersion,
      kind: m.kind,
      title: content.title,
      body: content.body,
      items: content.items as RemoteNoteRow['items'],
      pinned: m.pinned,
      deleted: m.deleted,
      created_at: m.createdAt.toISOString(),
      updated_at: m.updatedAt.toISOString(),
      enc_v: m.encV,
      payload: content.payload,
    };
  }

  /** The response for a closed operation, identical for the original request and every retry. */
  function pushResponse(c: Context, operation: SyncOperation) {
    const { results, charged, refunded } = operation;
    // The App reads per-row results from a 502 and keeps failed notes dirty.
    if (results.some((r) => !r.ok)) return c.json({ error: 'note_sync_failed', ok: false, results, charged, refunded }, 502);
    return c.json({ ok: true, results, charged, refunded });
  }

  notesRoute.post('/push', async (c) => {
    const pushStarted = performance.now();
    const userId = c.get('userId') as string;
    const db = await getDb();
    const { rows, requestId, mode } = z.object({ rows: z.array(remoteNoteRowSchema).max(MAX_PUSH_ROWS), requestId: z.string().uuid(), mode: z.enum(['standard', 'instant']).default('standard') }).parse(await c.req.json());
    if (rows.length === 0) return c.json({ ok: true, results: [] });
    if (new Set(rows.map((row) => row.id)).size !== rows.length) {
      return c.json({ error: 'duplicate_note_ids' }, 400);
    }
    // A finished request is answered from its record before any check that depends on
    // current state (quota, Google tokens): those must not block recovery of a delivered sync.
    const recorded = await findSync(db, userId, requestId, rows, mode);
    if (recorded?.status === 'complete') return pushResponse(c, recorded);

    // One lookup serves both: reject another account's IDs before touching Drive, and find this user's existing notes.
    const found = await collections.notes(db).find({ _id: { $in: rows.map((r) => r.id) } }).toArray();
    if (found.some((doc) => doc.userId !== userId)) return c.json({ error: 'note_id_conflict' }, 409);
    const existingById = new Map(found.map((d) => [d._id, d]));

    // A batch may delete a note and add one at the limit. Only deletions that will really happen make room:
    // a stale delete (a version conflict) frees nothing, or it could be used to add notes beyond the limit.
    const existingOf = (r: { id: string }) => existingById.get(r.id);
    const addsNote = (r: (typeof rows)[number]) => !r.deleted && (!existingOf(r) || existingOf(r)!.deleted);
    const freesRoom = (r: (typeof rows)[number]) => r.deleted && !!existingOf(r) && !existingOf(r)!.deleted && r.base_version === existingOf(r)!.localVersion;
    const limitError = await enforceNoteLimit(db, userId, rows.filter(addsNote).length - rows.filter(freesRoom).length);
    if (limitError) return c.json(limitError, 409);

    const { accessToken, refreshToken, driveFolderId } = await getLiveGoogleTokens(db, userId);
    const operation = recorded ?? await openSync(db, userId, requestId, rows, mode);
    const decided = new Set(operation.results.map((result) => result.id));

    // Files and folders the user deleted in Drive are recreated instead of failing every later push. Notes are
    // written in parallel, so the folder is recreated once and every write that hit the gap waits for it.
    let folderId = driveFolderId;
    let recreating: Promise<void> | null = null;
    const recreateFolder = () => (recreating ??= (async () => {
      folderId = (await ensureFolders(accessToken, refreshToken)).notesId;
      await collections.googleAccounts(db).updateOne({ userId }, { $set: { driveRootFolderId: folderId } });
      await logEvent(db, 'drive_folder_recreated', { userId, level: 'warn' });
    })());
    const createInFolder = async (name: string, content: object) => {
      try {
        return await createNoteFile(accessToken, refreshToken, folderId, name, content);
      } catch (error) {
        if (!isDriveNotFound(error)) throw error;
        await recreateFolder();
        return createNoteFile(accessToken, refreshToken, folderId, name, content);
      }
    };

    // Decide each note first. A conflict or a note that already holds exactly this content needs no Drive write.
    type Job = { row: (typeof rows)[number]; existing: NoteDoc | undefined; hash: string };
    const jobs: Job[] = [];
    let unchanged = 0;
    for (const row of rows) {
      if (decided.has(row.id)) continue;
      const existing = existingOf(row);
      if (existing && row.base_version !== existing.localVersion) {
        await recordSyncResult(db, operation, { id: row.id, ok: false, error: 'note_conflict', version: existing.localVersion });
        continue;
      }
      const hash = noteContentHash(row);
      if (existing && existing.contentHash === hash && existing.deleted === row.deleted) {
        unchanged++;
        await recordSyncResult(db, operation, { id: row.id, ok: true, version: existing.localVersion, updated_at: existing.updatedAt.toISOString(), unchanged: true });
        continue;
      }
      jobs.push({ row, existing, hash });
    }

    // Drive writes overlap; nothing is committed to MongoDB until they are all done.
    const writeToDrive = async ({ row, existing }: Job) => {
      const driveContent = {
        version: 1 as const,
        id: row.id,
        kind: row.kind,
        title: row.title,
        body: row.body,
        items: row.items,
        pinned: row.pinned,
        encV: row.enc_v,
        payload: row.payload,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date().toISOString(),
      };
      let driveFileId: string;
      let driveRevisionId: string | null;
      if (existing) {
        try {
          const f = await updateNoteFile(accessToken, refreshToken, existing.driveFileId, driveContent);
          driveFileId = existing.driveFileId;
          driveRevisionId = f.headRevisionId ?? existing.driveRevisionId;
        } catch (error) {
          if (!isDriveNotFound(error)) throw error;
          driveFileId = existing.driveFileId;
          driveRevisionId = existing.driveRevisionId;
          // Deleted outside the app. A deleted note needs no file; a live one is written again.
          if (!row.deleted) {
            const f = await createInFolder(`${row.id}.atomic`, driveContent);
            driveFileId = f.id!;
            driveRevisionId = f.headRevisionId ?? null;
            await logEvent(db, 'drive_file_recreated', { userId, level: 'warn', meta: { noteId: row.id } });
          }
        }
      } else {
        const f = await createInFolder(`${row.id}.atomic`, driveContent);
        driveFileId = f.id!;
        driveRevisionId = f.headRevisionId ?? null;
      }
      if (row.deleted) {
        try {
          await deleteNoteFile(accessToken, refreshToken, driveFileId);
        } catch (error) {
          if (!isDriveNotFound(error)) throw error; // already gone
        }
      }
      return { driveFileId, driveRevisionId };
    };
    const written = await mapConcurrent(jobs, DRIVE_CONCURRENCY, async (job) => {
      try { return { ok: true as const, ...(await writeToDrive(job)) }; }
      catch (error) { return { ok: false as const, error }; }
    });
    // A revoked grant fails every row alike. Stop here without recording failures: the operation stays open,
    // the App signs in again and retries the same request, which resumes it.
    if (written.some((w) => !w.ok && isInvalidGrant(w.error))) throw httpError('google_reauth_required', 401);

    // Commit in the order the rows were sent, so their sequence numbers stay consecutive.
    for (let i = 0; i < jobs.length; i++) {
      const { row, existing, hash } = jobs[i];
      const w = written[i];
      try {
        if (!w.ok) throw w.error;
        const setFields = {
          userId,
          kind: row.kind,
          pinned: row.pinned,
          deleted: row.deleted,
          encV: row.enc_v,
          driveFileId: w.driveFileId,
          driveRevisionId: w.driveRevisionId,
          contentHash: hash,
          updatedAt: new Date(),
          lastSyncedAt: new Date(),
          syncStatus: 'synced' as const,
        };
        // Stores the success result in the same transaction as the metadata.
        await saveNoteMetadata(db, userId, row.id, setFields, existing ? undefined : {
          _id: row.id, ...setFields, folderId: null, createdAt: new Date(row.created_at), localVersion: 1,
        }, operation._id);
      } catch (e) {
        // Message only: Google client errors can carry request headers with bearer tokens.
        console.error('note_write_failed', row.id, e instanceof Error ? e.message : 'unknown');
        // A no-op when the commit did succeed but its response was lost: stored success wins.
        await recordSyncResult(db, operation, { id: row.id, ok: false, error: 'note_write_failed' });
      }
    }
    const completed = await finishSync(db, operation);

    // ms is the whole handler; driveMs is the part spent waiting for Google.
    await logEvent(db, 'notes_pushed', { userId, meta: {
      count: rows.length, failed: completed.results.filter((r) => !r.ok).length, unchanged, mode,
      ms: Math.round(performance.now() - pushStarted), driveMs: Math.round(currentPerf()?.driveMs ?? 0), driveCalls: currentPerf()?.driveCalls ?? 0,
    } });
    return pushResponse(c, completed);
  });

  notesRoute.get('/pull', async (c) => {
    const userId = c.get('userId') as string;
    const db = await getDb();
    const since = c.req.query('since');
    const afterValue = c.req.query('after');
    const after = afterValue === undefined ? null : z.coerce.number().int().nonnegative().parse(afterValue);
    const encOnly = c.req.query('encOnly') === 'true';

    if (after === null && since && !Number.isFinite(new Date(since).getTime())) return c.json({ error: 'invalid_since' }, 400);

    // Read the sequence counter first and take only rows up to it. A sequence is committed before the next
    // one is issued (writes are serialized per user), so everything at or below the counter is visible and
    // a write that lands during this request is picked up by the next pull. No lock is needed.
    const cursor = new Date().toISOString();
    const latest = await db.collection<{ _id: string; value: number }>('sync_counters').findOne({ _id: userId });
    const upper = latest?.value ?? 0;
    if (upper === 0 || (after !== null && after >= upper)) return c.json({ rows: [], cursor, nextCursor: upper, hasMore: false });

    const filter: Record<string, unknown> = { userId, syncSequence: { ...(after !== null ? { $gt: after } : {}), $lte: upper } };
    // Retain compatibility with older App requests that omit a timezone.
    if (after === null && since) filter.updatedAt = { $gte: new Date(since) };
    if (encOnly) filter.encV = 0;

    const metaRows = await collections.notes(db).find(filter).sort({ syncSequence: 1, _id: 1 }).limit(11).toArray();
    const hasMore = metaRows.length > 10;
    if (hasMore) metaRows.pop();
    const nextCursor = hasMore ? metaRows[metaRows.length - 1].syncSequence ?? 0 : upper;
    if (metaRows.length === 0) return c.json({ rows: [], cursor, nextCursor, hasMore: false });

    const { accessToken, refreshToken } = await getLiveGoogleTokens(db, userId);

    // Bound Drive requests while retaining row order. This does not replace
    // pagination or a durable sync cursor for large accounts.
    const unreadable: string[] = [];
    const rows = (await mapConcurrent(metaRows, 4, async (m) => {
        try {
          // A deleted note's file is only in the Drive trash, where it stays readable. Sending its content
          // lets every device keep it in a Recycle Bin and restore the real note, not an empty one.
          const raw = await getNoteFileContent(accessToken, refreshToken, m.driveFileId);
          const content = migrateAtomicFile(raw);
          return toWireRow(m, { title: content.title, body: content.body, items: content.items, payload: content.payload });
        } catch (error) {
          // A file deleted or corrupted in Drive must not block every other note. Transient Google or
          // network errors still fail the request so the App retries.
          if (!isDriveNotFound(error) && !(error instanceof CorruptAtomicFileError)) throw error;
          // A deleted note whose file is gone still has to reach every device as a deletion, just without content.
          if (m.deleted) return toWireRow(m, { title: '', body: '', items: [], payload: null });
          // A live note: skip it. Devices that still hold it keep it; their next edit writes the file again.
          unreadable.push(m._id);
          return null;
        }
      })).filter((row): row is RemoteNoteRow => row !== null);
    if (unreadable.length) await logEvent(db, 'notes_unreadable', { userId, level: 'warn', meta: { noteIds: unreadable } });

    return c.json({ rows, cursor, nextCursor, hasMore, skipped: unreadable.length });
  });

  /**
   * Empties the CLOUD copy: trashes every Drive file and removes every metadata row. It leaves no tombstones,
   * because a tombstone tells every device, including the one that asked, to delete its own local copy on the
   * next pull. The owner asked to empty the cloud, not their notes. A device that still holds a note simply
   * writes it to the cloud again the next time it is edited.
   */
  notesRoute.delete('/', async (c) => {
    const userId = c.get('userId') as string;
    const db = await getDb();
    const all = await collections.notes(db).find({ userId }).toArray();

    if (all.length > 0) {
      const { accessToken, refreshToken } = await getLiveGoogleTokens(db, userId);
      await mapConcurrent(all, 4, async (n) => {
        try {
          await deleteNoteFile(accessToken, refreshToken, n.driveFileId);
        } catch (error) {
          if (!isDriveNotFound(error)) throw error; // already deleted in Drive
        }
      });
    }
    // Only after every Drive file is gone: a failure above leaves the metadata in place so the wipe can be retried.
    await collections.notes(db).deleteMany({ userId });
    await logEvent(db, 'notes_wiped', { userId, meta: { count: all.length } });
    return c.json({ ok: true, deleted: all.length });
  });

  return notesRoute;
}

export default createNotesRoute();
