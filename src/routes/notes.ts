import { saveNoteMetadata } from '../lib/noteMetadata.js';
import { finishSync, findSync, openSync, recordSyncResult, settleAbandonedSyncs, type SyncOperation } from '../lib/syncOperation.js';
import { currentPerf, runWithPerf, timedDrive } from '../lib/perf.js';
import { ENERGY } from '../lib/energy.js';
import { acquireOperationLock } from '../lib/operationLock.js';
import { NOTE_LIMITS, refineNoteContent, remoteNoteRowSchema } from '../types/noteWire.js';
import { mapConcurrent } from '../lib/concurrency.js';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/mongo.js';
import { collections, type NoteDoc } from '../db/collections.js';
import { requireAuth } from '../middleware/auth.js';
import { decryptToken, encryptToken } from '../lib/crypto.js';
import { createNoteFile, updateNoteFile, deleteNoteFile, getNoteFileContent, ensureAppFolders, isDriveNotFound } from '../lib/googleDrive.js';
import { isInvalidGrant, refreshAccessToken } from '../lib/googleOAuth.js';
import { todoItemSchema, migrateAtomicFile, CorruptAtomicFileError } from '../types/atomicFile.js';
import { httpError } from '../lib/httpError.js';
import { logEvent } from '../lib/logs.js';

export type DriveAdapter = {
  createNoteFile: typeof createNoteFile;
  updateNoteFile: typeof updateNoteFile;
  deleteNoteFile: typeof deleteNoteFile;
  getNoteFileContent: typeof getNoteFileContent;
  ensureAppFolders?: typeof ensureAppFolders;
};

export function createNotesRoute(drive: DriveAdapter = { createNoteFile, updateNoteFile, deleteNoteFile, getNoteFileContent }) {
  // Every Drive call is timed so a slow request shows how much of it was Google (see Server-Timing).
  const createNoteFile = (...args: Parameters<DriveAdapter['createNoteFile']>) => timedDrive(() => drive.createNoteFile(...args));
  const updateNoteFile = (...args: Parameters<DriveAdapter['updateNoteFile']>) => timedDrive(() => drive.updateNoteFile(...args));
  const deleteNoteFile = (...args: Parameters<DriveAdapter['deleteNoteFile']>) => timedDrive(() => drive.deleteNoteFile(...args));
  const getNoteFileContent = (...args: Parameters<DriveAdapter['getNoteFileContent']>) => timedDrive(() => drive.getNoteFileContent(...args));
  const ensureFolders = (...args: Parameters<typeof ensureAppFolders>) => timedDrive(() => (drive.ensureAppFolders ?? ensureAppFolders)(...args));
  const notesRoute = new Hono();
  notesRoute.use('*', requireAuth);
  notesRoute.use('*', (c, next) => runWithPerf(async () => {
    const started = performance.now();
    // Writes are serialized per user across Vercel instances. Reads take no lock: pull reads the sequence
    // counter first and only rows up to it, and each sequence is committed before the next is issued.
    const readOnly = ['GET', 'HEAD'].includes(c.req.method);
    const release = readOnly ? null : await acquireOperationLock(await getDb(), `notes:${c.get('userId')}`, 15000);
    try {
      if (!readOnly && !c.req.path.endsWith('/push')) {
        const db = await getDb();
        // The lock is ours, so an operation still pending belongs to a request that died.
        await settleAbandonedSyncs(db, c.get('userId'));
        if (['POST', 'PATCH'].includes(c.req.method)) {
          const wallet = await collections.atomicUsers(db).findOne({ _id: c.get('userId') });
          if (!wallet?.lastStandardSyncAt || Date.now() - wallet.lastStandardSyncAt.getTime() >= ENERGY.standardSyncFreeWindowMs) {
            return c.json({ error: 'sync_payment_required', hint: 'Use /notes/push for automatic charging.' }, 409);
          }
        }
      }
      await next();
    } finally { if (release) await release(); }
    const perf = currentPerf();
    c.header('Server-Timing', `total;dur=${Math.round(performance.now() - started)}, drive;dur=${Math.round(perf?.driveMs ?? 0)};desc="${perf?.driveCalls ?? 0} calls"`);
  }));

  // Field names match the real `note` table (kind/title/body/items/pinned/
  // enc_v/payload) — content (title/body/items, or payload when encrypted)
  // goes to Drive; everything else is metadata and stays in Mongo. See
  // db/collections.ts's noteSchema comment for the full Supabase-column ->
  // Mongo-field mapping.
  const noteFields = z.object({
    kind: z.enum(['text', 'todo']).default('text'),
    title: z.string().max(NOTE_LIMITS.title).default(''),
    body: z.string().max(NOTE_LIMITS.body).default(''),
    items: z.array(todoItemSchema).default([]),
    pinned: z.boolean().default(false),
    encV: z.union([z.literal(0), z.literal(1)]).default(0),
    payload: z.string().max(NOTE_LIMITS.payload).nullable().default(null),
    folderId: z.string().uuid().optional(),
  });
  const writeNoteSchema = noteFields.superRefine(refineNoteContent);
  // A PATCH must name the version it edited, so it cannot silently overwrite a newer one.
  const patchNoteSchema = noteFields.partial().extend({ base_version: z.number().int().nonnegative() });
  const mergedContentGuard = z.custom<Parameters<typeof refineNoteContent>[0]>().superRefine(refineNoteContent);

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
    const noteLimit = wallet?.noteLimit ?? 20;
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

  notesRoute.post('/', async (c) => {
    const userId = c.get('userId') as string;
    const db = await getDb();
    const body = writeNoteSchema.parse(await c.req.json());

    const limitError = await enforceNoteLimit(db, userId, 1);
    if (limitError) return c.json(limitError, 409);

    const { accessToken, refreshToken, driveFolderId } = await getLiveGoogleTokens(db, userId);

    const noteId = randomUUID();
    const now = new Date();
    const driveFile = await createNoteFile(accessToken, refreshToken, driveFolderId, `${noteId}.atomic`, {
      version: 1,
      id: noteId,
      kind: body.kind,
      title: body.title,
      body: body.body,
      items: body.items,
      pinned: body.pinned,
      encV: body.encV,
      payload: body.payload,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });

    const note: NoteDoc = {
      _id: noteId,
      userId,
      folderId: body.folderId ?? null,
      kind: body.kind,
      pinned: body.pinned,
      deleted: false,
      encV: body.encV,
      driveFileId: driveFile.id!,
      driveRevisionId: driveFile.headRevisionId ?? null,
      localVersion: 1,
      syncStatus: 'synced',
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    };
    await saveNoteMetadata(db, userId, noteId, {}, note);
    return c.json(note, 201);
  });

  notesRoute.patch('/:id', async (c) => {
    const userId = c.get('userId') as string;
    const id = c.req.param('id');
    const db = await getDb();
    const body = patchNoteSchema.parse(await c.req.json());

    // A deleted note is gone for this endpoint; reviving one goes through /push.
    const existing = await collections.notes(db).findOne({ _id: id, userId, deleted: false });
    if (!existing) return c.json({ error: 'not_found' }, 404);
    if (body.base_version !== existing.localVersion) {
      return c.json({ error: 'note_conflict', version: existing.localVersion }, 409);
    }

    const { accessToken, refreshToken } = await getLiveGoogleTokens(db, userId);

    const previous = migrateAtomicFile(await getNoteFileContent(accessToken, refreshToken, existing.driveFileId));
    const next = {
      version: 1 as const,
      id: existing._id,
      kind: body.kind ?? existing.kind,
      title: body.title ?? previous.title,
      body: body.body ?? previous.body,
      items: body.items ?? previous.items,
      pinned: body.pinned ?? existing.pinned,
      encV: body.encV ?? existing.encV,
      payload: body.payload === undefined ? previous.payload : body.payload,
      createdAt: existing.createdAt.toISOString(),
      updatedAt: new Date().toISOString(),
    };
    mergedContentGuard.parse(next);
    const driveFile = await updateNoteFile(accessToken, refreshToken, existing.driveFileId, next);

    const now = new Date();
    const updated = await saveNoteMetadata(db, userId, id, {
      kind: body.kind ?? existing.kind, pinned: body.pinned ?? existing.pinned,
      encV: body.encV ?? existing.encV, driveRevisionId: driveFile.headRevisionId ?? existing.driveRevisionId,
      updatedAt: now, lastSyncedAt: now,
    });
    return c.json(updated);
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
    const { rows, requestId, mode } = z.object({ rows: z.array(remoteNoteRowSchema).max(20), requestId: z.string().uuid(), mode: z.enum(['standard', 'instant']).default('standard') }).parse(await c.req.json());
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

    const newActiveCount = rows.filter((r) => (!existingById.has(r.id) || existingById.get(r.id)!.deleted) && !r.deleted).length;
    const limitError = await enforceNoteLimit(db, userId, newActiveCount);
    if (limitError) return c.json(limitError, 409);

    const { accessToken, refreshToken, driveFolderId } = await getLiveGoogleTokens(db, userId);
    const operation = recorded ?? await openSync(db, userId, requestId, rows, mode);
    const decided = new Set(operation.results.map((result) => result.id));

    // Files and folders the user deleted in Drive are recreated instead of failing every later push.
    let folderId = driveFolderId;
    const createInFolder = async (name: string, content: object) => {
      try {
        return await createNoteFile(accessToken, refreshToken, folderId, name, content);
      } catch (error) {
        if (!isDriveNotFound(error)) throw error;
        folderId = (await ensureFolders(accessToken, refreshToken)).notesId;
        await collections.googleAccounts(db).updateOne({ userId }, { $set: { driveRootFolderId: folderId } });
        await logEvent(db, 'drive_folder_recreated', { userId, level: 'warn' });
        return createNoteFile(accessToken, refreshToken, folderId, name, content);
      }
    };

    for (const row of rows) {
      if (decided.has(row.id)) continue;
      try {
        const now = new Date();
        const existing = existingById.get(row.id);
        if (existing && row.base_version !== existing.localVersion) {
          await recordSyncResult(db, operation, { id: row.id, ok: false, error: 'note_conflict', version: existing.localVersion });
          continue;
        }
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
          updatedAt: now.toISOString(),
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

        const setFields = {
          userId,
          kind: row.kind,
          pinned: row.pinned,
          deleted: row.deleted,
          encV: row.enc_v,
          driveFileId,
          driveRevisionId,
          updatedAt: new Date(),
          lastSyncedAt: new Date(),
          syncStatus: 'synced' as const,
        };
        // Stores the success result in the same transaction as the metadata.
        await saveNoteMetadata(db, userId, row.id, setFields, existing ? undefined : {
          _id: row.id, ...setFields, folderId: null, createdAt: new Date(row.created_at), localVersion: 1,
        }, operation._id);
      } catch (e) {
        // A revoked grant fails every row alike. Stop here without recording failures: the operation
        // stays open, the App signs in again and retries the same request, which resumes it.
        if (isInvalidGrant(e)) throw httpError('google_reauth_required', 401);
        // Message only: Google client errors can carry request headers with bearer tokens.
        console.error('note_write_failed', row.id, e instanceof Error ? e.message : 'unknown');
        // A no-op when the commit did succeed but its response was lost: stored success wins.
        await recordSyncResult(db, operation, { id: row.id, ok: false, error: 'note_write_failed' });
      }
    }
    const completed = await finishSync(db, operation);

    // ms is the whole handler; driveMs is the part spent waiting for Google.
    await logEvent(db, 'notes_pushed', { userId, meta: {
      count: rows.length, failed: completed.results.filter((r) => !r.ok).length,
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

    // Tombstones carry no content — skip the Drive read for those, the row
    // already tells the client everything it needs (delete it locally).
    const needsContent = metaRows.filter((m) => !m.deleted);
    let accessToken = '';
    let refreshToken = '';
    if (needsContent.length > 0) {
      ({ accessToken, refreshToken } = await getLiveGoogleTokens(db, userId));
    }

    // Bound Drive requests while retaining row order. This does not replace
    // pagination or a durable sync cursor for large accounts.
    const unreadable: string[] = [];
    const rows = (await mapConcurrent(metaRows, 4, async (m) => {
        if (m.deleted) return toWireRow(m, { title: '', body: '', items: [], payload: null });
        try {
          const raw = await getNoteFileContent(accessToken, refreshToken, m.driveFileId);
          const content = migrateAtomicFile(raw);
          return toWireRow(m, { title: content.title, body: content.body, items: content.items, payload: content.payload });
        } catch (error) {
          // A file deleted or corrupted in Drive must not block every other note. Skip it (devices
          // that still hold the note keep it; their next edit writes the file again). Transient
          // Google or network errors still fail the request so the App retries.
          if (!isDriveNotFound(error) && !(error instanceof CorruptAtomicFileError)) throw error;
          unreadable.push(m._id);
          return null;
        }
      })).filter((row): row is RemoteNoteRow => row !== null);
    if (unreadable.length) await logEvent(db, 'notes_unreadable', { userId, level: 'warn', meta: { noteIds: unreadable } });

    return c.json({ rows, cursor, nextCursor, hasMore, skipped: unreadable.length });
  });

  /** Hard-deletes everything (not just tombstones) — mirrors the live app's wipeRemote(), used on account/vault reset. */
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
    for (const note of all) {
      await saveNoteMetadata(db, userId, note._id, { deleted: true, updatedAt: new Date() });
    }
    await logEvent(db, 'notes_wiped', { userId, meta: { count: all.length } });
    return c.json({ ok: true, deleted: all.length });
  });

  return notesRoute;
}

export default createNotesRoute();
