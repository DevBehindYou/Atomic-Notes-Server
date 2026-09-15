import { remoteNoteRowSchema } from '../types/noteWire';
import { mapConcurrent } from '../lib/concurrency';
import { Hono } from 'hono';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/mongo';
import { collections, type NoteDoc } from '../db/collections';
import { requireAuth } from '../middleware/auth';
import { decryptToken, encryptToken } from '../lib/crypto';
import { createNoteFile, updateNoteFile, deleteNoteFile, getNoteFileContent } from '../lib/googleDrive';
import { refreshAccessToken } from '../lib/googleOAuth';
import { todoItemSchema, migrateAtomicFile } from '../types/atomicFile';
import { logEvent } from '../lib/logs';

export function createNotesRoute(drive = { createNoteFile, updateNoteFile, deleteNoteFile, getNoteFileContent }) {
  const { createNoteFile, updateNoteFile, deleteNoteFile, getNoteFileContent } = drive;
  const notesRoute = new Hono();
  notesRoute.use('*', requireAuth);

  // Field names match the real `note` table (kind/title/body/items/pinned/
  // enc_v/payload) — content (title/body/items, or payload when encrypted)
  // goes to Drive; everything else is metadata and stays in Mongo. See
  // db/collections.ts's noteSchema comment for the full Supabase-column ->
  // Mongo-field mapping.
  const writeNoteSchema = z.object({
    kind: z.enum(['text', 'todo']).default('text'),
    title: z.string().max(300).default(''),
    body: z.string().default(''),
    items: z.array(todoItemSchema).default([]),
    pinned: z.boolean().default(false),
    encV: z.number().int().default(0),
    payload: z.string().nullable().default(null),
    folderId: z.string().uuid().optional(),
  });

  /** Loads this user's Google tokens, refreshing the access token first if it's about to expire. */
  async function getLiveGoogleTokens(db: Awaited<ReturnType<typeof getDb>>, userId: string) {
    const account = await collections.googleAccounts(db).findOne({ userId });
    if (!account) throw Object.assign(new Error('no_google_account_linked'), { status: 409 });

    let accessToken = decryptToken(account.encryptedAccessToken);
    const refreshToken = decryptToken(account.encryptedRefreshToken);

    if (account.tokenExpiry.getTime() < Date.now() + 60_000) {
      const refreshed = await refreshAccessToken(refreshToken);
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
    await collections.notes(db).insertOne(note);
    return c.json(note, 201);
  });

  notesRoute.patch('/:id', async (c) => {
    const userId = c.get('userId') as string;
    const id = c.req.param('id');
    const db = await getDb();
    const body = writeNoteSchema.partial().parse(await c.req.json());

    const existing = await collections.notes(db).findOne({ _id: id, userId });
    if (!existing) return c.json({ error: 'not_found' }, 404);

    const { accessToken, refreshToken } = await getLiveGoogleTokens(db, userId);

    // NOTE: writes straight through (last-write-wins) — see driveRevisionId/
    // localVersion in db/collections.ts for the fields a real conflict check
    // would compare; not wired in yet, same caveat as the rest of this backend.
    const previous = migrateAtomicFile(await getNoteFileContent(accessToken, refreshToken, existing.driveFileId));
    const driveFile = await updateNoteFile(accessToken, refreshToken, existing.driveFileId, {
      version: 1,
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
    });

    const now = new Date();
    await collections.notes(db).updateOne(
      { _id: id, userId },
      {
        $set: {
          kind: body.kind ?? existing.kind,
          pinned: body.pinned ?? existing.pinned,
          encV: body.encV ?? existing.encV,
          driveRevisionId: driveFile.headRevisionId ?? existing.driveRevisionId,
          updatedAt: now,
          lastSyncedAt: now,
        },
        $inc: { localVersion: 1 },
      },
    );
    const updated = await collections.notes(db).findOne({ _id: id, userId });
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
    await collections.notes(db).updateOne({ _id: id, userId }, { $set: { deleted: true, updatedAt: new Date() } });
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
  type RemoteNoteRow = z.infer<typeof remoteNoteRowSchema> & { updated_at: string };

  function toWireRow(m: NoteDoc, content: { title: string; body: string; items: unknown[]; payload: string | null }): RemoteNoteRow {
    return {
      id: m._id,
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

  notesRoute.post('/push', async (c) => {
    const userId = c.get('userId') as string;
    const db = await getDb();
    const { rows } = z.object({ rows: z.array(remoteNoteRowSchema) }).parse(await c.req.json());
    if (rows.length === 0) return c.json({ ok: true, results: [] });
    if (new Set(rows.map((row) => row.id)).size !== rows.length) {
      return c.json({ error: 'duplicate_note_ids' }, 400);
    }
    // Reject collisions before touching Drive; also scope every write below.
    const collision = await collections.notes(db).findOne({
      _id: { $in: rows.map((row) => row.id) }, userId: { $ne: userId },
    });
    if (collision) return c.json({ error: 'note_id_conflict' }, 409);

    const existingDocs = await collections
      .notes(db)
      .find({ userId, _id: { $in: rows.map((r) => r.id) } })
      .toArray();
    const existingById = new Map(existingDocs.map((d) => [d._id, d]));

    const newActiveCount = rows.filter((r) => (!existingById.has(r.id) || existingById.get(r.id)!.deleted) && !r.deleted).length;
    const limitError = await enforceNoteLimit(db, userId, newActiveCount);
    if (limitError) return c.json(limitError, 409);

    const { accessToken, refreshToken, driveFolderId } = await getLiveGoogleTokens(db, userId);
    const results: Array<{ id: string; ok: boolean; updated_at?: string; error?: string }> = [];

    for (const row of rows) {
      try {
        const now = new Date();
        const existing = existingById.get(row.id);
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
          const f = await updateNoteFile(accessToken, refreshToken, existing.driveFileId, driveContent);
          driveFileId = existing.driveFileId;
          driveRevisionId = f.headRevisionId ?? existing.driveRevisionId;
        } else {
          const f = await createNoteFile(accessToken, refreshToken, driveFolderId, `${row.id}.atomic`, driveContent);
          driveFileId = f.id!;
          driveRevisionId = f.headRevisionId ?? null;
        }
        if (row.deleted) await deleteNoteFile(accessToken, refreshToken, driveFileId);

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
        await collections.notes(db).updateOne(
          { _id: row.id, userId },
          existing
            ? { $set: setFields, $inc: { localVersion: 1 } }
            : {
                $set: setFields,
                $setOnInsert: { _id: row.id, folderId: null, createdAt: new Date(row.created_at), localVersion: 1 },
              },
          { upsert: true },
        );

        results.push({ id: row.id, ok: true, updated_at: setFields.updatedAt.toISOString() });
      } catch (e) {
        results.push({ id: row.id, ok: false, error: e instanceof Error ? e.message : 'unknown_error' });
      }
    }

    await logEvent(db, 'notes_pushed', { userId, meta: { count: rows.length, failed: results.filter((r) => !r.ok).length } });
    if (results.some((r) => !r.ok)) {
      // The current App only checks HTTP status before clearing dirty notes.
      return c.json({ error: 'note_sync_failed', ok: false, results }, 502);
    }
    return c.json({ ok: true, results });
  });

  notesRoute.get('/pull', async (c) => {
    const userId = c.get('userId') as string;
    const db = await getDb();
    const since = c.req.query('since');
    const encOnly = c.req.query('encOnly') === 'true';

    const filter: Record<string, unknown> = { userId };
    if (since) {
      // Retain compatibility with older App requests that omit a timezone.
      const parsed = new Date(since);
      if (!Number.isFinite(parsed.getTime())) return c.json({ error: 'invalid_since' }, 400);
      filter.updatedAt = { $gte: parsed };
    }
    if (encOnly) filter.encV = 0;

    const cursor = new Date().toISOString();
    const metaRows = await collections.notes(db).find(filter).toArray();
    if (metaRows.length === 0) return c.json({ rows: [], cursor });

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
    const rows = await mapConcurrent(metaRows, 4, async (m) => {
        if (m.deleted) return toWireRow(m, { title: '', body: '', items: [], payload: null });
        const raw = await getNoteFileContent(accessToken, refreshToken, m.driveFileId);
        const content = migrateAtomicFile(raw);
        return toWireRow(m, { title: content.title, body: content.body, items: content.items, payload: content.payload });
      });

    return c.json({ rows, cursor });
  });

  /** Hard-deletes everything (not just tombstones) — mirrors the live app's wipeRemote(), used on account/vault reset. */
  notesRoute.delete('/', async (c) => {
    const userId = c.get('userId') as string;
    const db = await getDb();
    const all = await collections.notes(db).find({ userId }).toArray();

    if (all.length > 0) {
      const { accessToken, refreshToken } = await getLiveGoogleTokens(db, userId);
      await mapConcurrent(all, 4, (n) => deleteNoteFile(accessToken, refreshToken, n.driveFileId));
    }
    await collections.notes(db).deleteMany({ userId });
    await logEvent(db, 'notes_wiped', { userId, meta: { count: all.length } });
    return c.json({ ok: true, deleted: all.length });
  });

  return notesRoute;
}

export default createNotesRoute();
