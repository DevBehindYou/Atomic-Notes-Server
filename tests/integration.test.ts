import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';

// This suite creates and drops only its own database on a disposable local runner.
const uri = process.env.MONGODB_URI;
// Default: a disposable localhost replica set only. A developer may opt in to a temporary database inside an
// Atlas cluster: the suite still creates a uniquely named database and drops only that one at the end.
const localReplicaSet = /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+(?:[/?]|$)/.test(uri ?? '');
const atlasTempDb = process.env.INTEGRATION_ALLOW_ATLAS_TEMP_DB === 'yes' && /^mongodb\+srv:\/\//.test(uri ?? '');
if (!uri || !(localReplicaSet || atlasTempDb)) {
  throw new Error('Integration tests require a disposable localhost MongoDB replica set');
}
// Atlas limits database names to 38 bytes.
const databaseName = `atomic_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
process.env.MONGODB_DB_NAME = databaseName;
process.env.ADMIN_API_KEY = 'test-admin-key';
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');

const { getDb, closeDb, withTransaction } = await import('../src/db/mongo');
const { collections, ensureIndexes } = await import('../src/db/collections');
const { createSession, verifySession } = await import('../src/lib/session');
const { energyEnsure, energyConvert, energyGrantDaily } = await import('../src/lib/energy');
const { encryptToken } = await import('../src/lib/crypto');
const { createNotesRoute } = await import('../src/routes/notes');
const { registerErrorHandler } = await import('../src/middleware/errorHandler');
const { default: admin } = await import('../src/routes/admin');
const { default: publicRoute } = await import('../src/routes/public');
const { default: vault } = await import('../src/routes/vault');
const { default: energyRoute } = await import('../src/routes/energy');
const { default: profileRoute } = await import('../src/routes/atomicuser');
const { default: auth, completeGoogleLogin } = await import('../src/routes/auth');
const { beginSync, recordSyncResult, syncOperations } = await import('../src/lib/syncOperation');
const { saveNoteMetadata } = await import('../src/lib/noteMetadata');
const { decryptToken } = await import('../src/lib/crypto');
const { remoteNoteRowSchema } = await import('../src/types/noteWire');
const { mongoCommands } = await import('../src/lib/perf');
// Upper bounds on MongoDB commands per one-note operation (set after measuring; lower them when optimizing).
const BUDGET: Record<string, number> = { firstPush: 29, instantPush: 29, cooldownPush: 10, pullOneRow: 4, pullNothing: 2, count: 2 };

test('Server contracts with a real MongoDB replica set and a fake Drive adapter', { timeout: Number(process.env.INTEGRATION_TIMEOUT_MS ?? 120000) }, async (t) => {
  const db = await getDb();
  t.after(async () => {
    try { assert.equal(db.databaseName, databaseName); await db.dropDatabase(); }
    finally { await closeDb(); }
  });
  assert.ok((await db.admin().command({ hello: 1 })).setName, 'Transactions require a replica set');
  await ensureIndexes(db);

  const files = new Map<string, any>();
  let writes = 0, failDelete = false, failTitle = '', activeReads = 0, peakReads = 0, activeWrites = 0, peakWrites = 0;
  // Simulates what a user can do in Drive outside the app.
  const missingFiles = new Set<string>(); let missingFolder = '', foldersEnsured = 0;
  const notFound = () => Object.assign(new Error('File not found'), { code: 404 });
  // The user revoked the app in their Google account: every Drive call fails as Google reports it.
  let revoked = false;
  const revokedError = () => Object.assign(new Error('invalid_grant'), { response: { data: { error: 'invalid_grant' } } });
  const drive = {
    async createNoteFile(_a: string, _r: string, parent: string, _n: string, content: object) {
      if (revoked) throw revokedError();
      if (missingFolder && parent === missingFolder) throw notFound();
      if ((content as any).title === failTitle && failTitle) throw new Error('simulated_drive_failure');
      peakWrites = Math.max(peakWrites, ++activeWrites); await delay(5); activeWrites--;
      writes++; const id = randomUUID(); files.set(id, structuredClone(content)); return { id, headRevisionId: '1' };
    },
    async updateNoteFile(_a: string, _r: string, id: string, content: object) {
      if (revoked) throw revokedError();
      if (missingFiles.has(id)) throw notFound();
      if ((content as any).title === failTitle && failTitle) throw new Error('simulated_drive_failure');
      peakWrites = Math.max(peakWrites, ++activeWrites); await delay(5); activeWrites--;
      writes++; files.set(id, structuredClone(content)); return { id, headRevisionId: '2' };
    },
    async deleteNoteFile(_a: string, _r: string, id: string) {
      if (missingFiles.has(id)) throw notFound();
      if (failDelete) throw new Error('simulated_delete_failure');
      writes++;
    },
    async getNoteFileContent(_a: string, _r: string, id: string) {
      if (revoked) throw revokedError();
      if (missingFiles.has(id)) throw notFound();
      peakReads = Math.max(peakReads, ++activeReads); await delay(5); activeReads--;
      return structuredClone(files.get(id));
    },
    async ensureAppFolders() { foldersEnsured++; missingFolder = ''; return { notesId: 'recreated-folder' }; },
  };
  const app = new Hono(); registerErrorHandler(app);
  app.route('/api/notes', createNotesRoute(drive));
  app.route('/api/admin', admin); app.route('/api/public', publicRoute);
  app.route('/api/energy', energyRoute); app.route('/api/atomicuser', profileRoute);
  app.route('/api/vault', vault); app.route('/api/auth', auth);
  const request = (path: string, method = 'GET', body?: object, token?: string, adminKey?: string) => app.request(`/api${path}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(adminKey ? { 'x-admin-api-key': adminKey } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  async function user(email = `${randomUUID()}@example.com`) {
    const id = randomUUID(), now = new Date();
    await collections.users(db).insertOne({ _id: id, email, displayName: null, createdAt: now, updatedAt: now });
    await collections.googleAccounts(db).insertOne({ _id: randomUUID(), userId: id, googleAccountId: randomUUID(),
      encryptedAccessToken: encryptToken('test-access'), encryptedRefreshToken: encryptToken('test-refresh'),
      tokenExpiry: new Date(Date.now() + 3600000), driveRootFolderId: 'test-folder', createdAt: now });
    await energyEnsure(db, id);
    return { id, token: await createSession(db, id) };
  }
  const owner = await user(), other = await user();
  // Matches Note.toRemote + _sealRemote: updated_at is omitted by the App.
  const row = (overrides = {}) => ({ id: randomUUID(), kind: 'text', title: 'Keep title', body: 'Keep body', items: [],
    pinned: false, deleted: false, created_at: new Date().toISOString(),
    enc_v: 0, payload: null, ...overrides });
  // Opens the hourly standard sync again and tops up energy, for tests about something other than billing.
  const refill = (id: string) => collections.atomicUsers(db).updateOne({ _id: id }, { $set: { lastStandardSyncAt: null, energy: 100 } });
  // The owner is used for many pushes in a row, so its cooldown is reset each time; billing tests use their own accounts.
  const push = async (rows: object[], token = owner.token, requestId = randomUUID(), mode = 'standard') => {
    if (token === owner.token && mode === 'standard') await refill(owner.id);
    return request('/notes/push', 'POST', { rows, requestId, mode }, token);
  };

  await t.test('owner isolation, partial updates and failed pushes', async () => {
    const original = row(); assert.equal((await push([original])).status, 200);
    const before = writes;
    assert.equal((await push([original], other.token)).status, 409);
    assert.equal(writes, before);
    assert.equal((await collections.notes(db).findOne({ _id: original.id }))!.userId, owner.id);
    assert.equal((await push([original, original])).status, 400);
    assert.equal((await push([{ ...original, pinned: true, base_version: 1 }])).status, 200);
    const metadata = (await collections.notes(db).findOne({ _id: original.id }))!;
    assert.equal(files.get(metadata.driveFileId).body, 'Keep body');
    assert.equal(files.get(metadata.driveFileId).title, 'Keep title');
    assert.equal(files.get(metadata.driveFileId).pinned, true);
    failTitle = 'FAIL';
    const response = await push([row({ title: 'Success' }), row({ title: 'FAIL' })]);
    assert.equal(response.status, 502);
    const result = await response.json() as { error: string; results: { ok: boolean }[] }; assert.equal(result.error, 'note_sync_failed');
    assert.deepEqual(result.results.map((r: any) => r.ok), [true, false]);
    failTitle = '';
  });

  await t.test('reviving a tombstone respects quota before Drive writes', async () => {
    const deleted = row({ deleted: true }); assert.equal((await push([deleted])).status, 200);
    const count = await collections.notes(db).countDocuments({ userId: owner.id, deleted: false });
    await collections.atomicUsers(db).updateOne({ _id: owner.id }, { $set: { noteLimit: count } });
    const before = writes;
    assert.equal((await push([{ ...deleted, deleted: false }])).status, 409); assert.equal(writes, before);
    await collections.atomicUsers(db).updateOne({ _id: owner.id }, { $set: { noteLimit: 20 } });
  });

  await t.test('pull bounds Drive requests and failed wipe retains metadata', async () => {
    assert.equal((await push(Array.from({ length: 7 }, () => row()))).status, 200);
    const response = await request('/notes/pull', 'GET', undefined, owner.token);
    assert.equal(response.status, 200); assert.ok(((await response.json()) as { cursor: string }).cursor);
    assert.ok(peakReads <= 4); assert.ok(peakReads > 1);
    const count = await collections.notes(db).countDocuments({ userId: owner.id });
    failDelete = true;
    assert.equal((await request('/notes', 'DELETE', undefined, owner.token)).status, 500);
    assert.equal(await collections.notes(db).countDocuments({ userId: owner.id }), count);
    failDelete = false;
  });

  await t.test('wallet transactions roll back and concurrent daily grants apply once', async () => {
    const walletUser = await user();
    await energyEnsure(db, walletUser.id);
    assert.equal(await collections.energyLedger(db).countDocuments({ userId: walletUser.id }), 1);
    await energyConvert(db, walletUser.id, 1);
    await Promise.all([energyGrantDaily(db, walletUser.id), energyGrantDaily(db, walletUser.id)]);
    assert.equal((await collections.atomicUsers(db).findOne({ _id: walletUser.id }))!.energy, 60);
    assert.equal(await collections.energyLedger(db).countDocuments({ userId: walletUser.id, kind: 'daily_grant' }), 1);
    await assert.rejects(withTransaction(async (session) => {
      await collections.atomicUsers(db).updateOne({ _id: walletUser.id }, { $inc: { energy: 9 } }, { session });
      throw new Error('rollback_fixture');
    }), /rollback_fixture/);
    assert.equal((await collections.atomicUsers(db).findOne({ _id: walletUser.id }))!.energy, 60);
  });

  await t.test('Community notification CRUD hides targeted and expired messages', async () => {
    assert.equal((await request('/admin/notifications')).status, 401);
    const adminRequest = (method: string, body?: object, query = '') => request(`/admin/notifications${query}`, method, body, undefined, 'test-admin-key');
    const publicId = randomUUID();
    for (const fields of [ { id: publicId }, { target_user_id: owner.id }, { target_audience: 'user' }, { expires_at: '2020-01-01T00:00:00Z' } ]) {
      assert.equal((await adminRequest('POST', { type: 'info', subject: 'test', description: 'message', ...fields })).status, 200);
    }
    const visible = await (await request('/public/notifications/active')).json() as { rows: { id: string }[] };
    assert.deepEqual(visible.rows.map((n: any) => n.id), [publicId]);
    assert.equal((await adminRequest('PATCH', { id: publicId, status: 'resolved' })).status, 200);
    assert.deepEqual(((await (await request('/public/notifications/active')).json()) as { rows: unknown[] }).rows, []);
    assert.equal((await adminRequest('DELETE', undefined, `?id=${publicId}`)).status, 200);
    assert.equal(await collections.notifications(db).findOne({ _id: publicId }), null);
  });

  await t.test('literal email lookup, vault insert-only contract and session revocation', async () => {
    const account = await user('a+b@example.com');
    const energyResponse = await request('/energy', 'GET', undefined, account.token);
    assert.equal(energyResponse.status, 200);
    const state = await energyResponse.json() as { wallet: { energy_cap: number }; history: { coins_delta: number }[] };
    assert.equal(state.wallet.energy_cap, 120);
    assert.ok(state.history.some((entry) => entry.coins_delta === 5));
    assert.equal((await request('/atomicuser', 'PATCH', { username: 'test-user' }, account.token)).status, 200);
    for (const path of ['/admin/health', '/admin/stats']) {
      assert.equal((await request(path, 'GET', undefined, undefined, 'test-admin-key')).status, 200);
    }
    const lookup = await request('/admin/user?email=A%2BB%40EXAMPLE.COM', 'GET', undefined, undefined, 'test-admin-key');
    assert.equal(lookup.status, 200); assert.equal(((await lookup.json()) as { user_id: string }).user_id, account.id);
    const vaultBody = { verifier: 'test-verifier', kdfMemory: 65536, kdfIterations: 3, kdfParallelism: 1 };
    assert.equal((await request('/vault', 'POST', vaultBody, account.token)).status, 201);
    assert.equal((await request('/vault', 'POST', vaultBody, account.token)).status, 409);
    const session = await collections.sessions(db).findOne({ _id: createHash('sha256').update(account.token).digest('hex') });
    assert.ok(session); assert.notEqual(session._id, account.token);
    assert.equal((await request('/auth/logout', 'POST', undefined, account.token)).status, 200);
    assert.equal(await verifySession(db, account.token), null);
    assert.equal((await request('/vault', 'GET', undefined, account.token)).status, 401);
  });

  const wallet = async (id: string) => (await collections.atomicUsers(db).findOne({ _id: id }))!;
  const json = async (response: Response) => await response.json() as any;
  const refundCount = (id: string) => collections.energyLedger(db).countDocuments({ userId: id, note: /^Refund/ });

  await t.test('a finished request is replayed from its record even when quota and Google state changed', async () => {
    const account = await user(), requestId = randomUUID(), rows = [row()];
    const first = await push(rows, account.token, requestId);
    assert.equal(first.status, 200);
    const firstBody = await json(first);
    assert.equal(firstBody.charged, 5);
    const energy = (await wallet(account.id)).energy, before = writes;
    await collections.atomicUsers(db).updateOne({ _id: account.id }, { $set: { noteLimit: 0 } });
    await collections.googleAccounts(db).deleteOne({ userId: account.id });
    const second = await push(rows, account.token, requestId);
    assert.equal(second.status, 200);
    assert.deepEqual(await json(second), firstBody);
    assert.equal(writes, before);
    assert.equal((await wallet(account.id)).energy, energy);
    assert.equal((await push([{ ...rows[0], title: 'changed' }], account.token, requestId)).status, 409);
  });

  await t.test('concurrent duplicates of one request charge and write once', async () => {
    const account = await user(), requestId = randomUUID(), rows = [row()], before = writes;
    const [a, b] = await Promise.all([push(rows, account.token, requestId), push(rows, account.token, requestId)]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.deepEqual(await json(a), await json(b));
    assert.equal(writes, before + 1);
    assert.equal((await wallet(account.id)).energy, 15);
    assert.equal(await collections.energyLedger(db).countDocuments({ userId: account.id, kind: 'spend' }), 1);
  });

  await t.test('a batch where every note fails is refunded once and restores the free window', async () => {
    const account = await user(), requestId = randomUUID(), rows = [row({ title: 'FAIL' }), row({ title: 'FAIL' })];
    failTitle = 'FAIL';
    try {
      const first = await push(rows, account.token, requestId);
      assert.equal(first.status, 502);
      const body = await json(first);
      assert.deepEqual(body.results.map((r: any) => r.ok), [false, false]);
      assert.deepEqual([body.charged, body.refunded], [5, 5]);
      const after = await wallet(account.id);
      assert.equal(after.energy, 20);
      assert.equal(after.lastStandardSyncAt, null);
      assert.equal(await refundCount(account.id), 1);
      const again = await push(rows, account.token, requestId);
      assert.equal(again.status, 502);
      assert.deepEqual(await json(again), body);
      assert.equal((await wallet(account.id)).energy, 20);
      assert.equal(await refundCount(account.id), 1);
    } finally { failTitle = ''; }
  });

  await t.test('a partly successful batch keeps its charge', async () => {
    const account = await user();
    failTitle = 'FAIL';
    try {
      const response = await push([row({ title: 'fine' }), row({ title: 'FAIL' })], account.token);
      assert.equal(response.status, 502);
      const body = await json(response);
      assert.deepEqual([body.charged, body.refunded], [5, 0]);
      assert.equal((await wallet(account.id)).energy, 15);
      assert.equal(await refundCount(account.id), 0);
    } finally { failTitle = ''; }
  });

  await t.test('version conflicts are reported per note, not overwritten, and resolve with the current version', async () => {
    const account = await user(), note = row();
    const created = await json(await push([note], account.token));
    assert.equal(created.results[0].version, 1);
    await refill(account.id);
    const stale = await push([{ ...note, title: 'stale', base_version: 0 }], account.token);
    assert.equal(stale.status, 502);
    const staleBody = await json(stale);
    assert.equal(staleBody.results[0].error, 'note_conflict');
    assert.equal(staleBody.results[0].version, 1);
    const stored = (await collections.notes(db).findOne({ _id: note.id }))!;
    assert.equal(files.get(stored.driveFileId).title, 'Keep title');
    await refill(account.id);
    const fresh = await json(await push([{ ...note, title: 'fresh', base_version: 1 }], account.token));
    assert.equal(fresh.results[0].version, 2);
    assert.equal(files.get(stored.driveFileId).title, 'fresh');
  });

  await t.test('single-note REST writes are closed: notes are written through push, where sync is charged', async () => {
    const account = await user(), note = row();
    assert.equal((await push([note], account.token)).status, 200);
    const before = writes;
    for (const [path, method, body] of [['/notes', 'POST', row()], [`/notes/${note.id}`, 'PATCH', { pinned: true, base_version: 1 }]] as const) {
      const closed = await request(path, method, body, account.token);
      assert.equal(closed.status, 410);
      assert.equal((await json(closed)).error, 'use_push');
    }
    assert.equal(writes, before);
    assert.equal((await collections.notes(db).findOne({ _id: note.id }))!.pinned, false);
  });

  await t.test('pull pages by sequence cursor and reports deletions after the cursor', async () => {
    const account = await user(), notes = Array.from({ length: 12 }, () => row());
    const pushed = await push(notes, account.token);
    assert.equal(pushed.status, 200);
    // Each written row reports its sequence, consecutive within one push: the App uses this to skip its own echo.
    assert.deepEqual((await json(pushed)).results.map((r: any) => r.seq), Array.from({ length: 12 }, (_, i) => i + 1));
    const pull = async (query = '') => json(await request(`/notes/pull${query}`, 'GET', undefined, account.token));
    const first = await pull();
    assert.equal(first.rows.length, 10); assert.equal(first.hasMore, true);
    const second = await pull(`?after=${first.nextCursor}`);
    assert.equal(second.rows.length, 2); assert.equal(second.hasMore, false);
    assert.deepEqual([...first.rows, ...second.rows].map((r: any) => r.id), notes.map((n) => n.id));
    const third = await pull(`?after=${second.nextCursor}`);
    assert.deepEqual([third.rows.length, third.hasMore, third.nextCursor], [0, false, second.nextCursor]);
    await refill(account.id);
    assert.equal((await push([{ ...notes[0], deleted: true, base_version: 1 }], account.token)).status, 200);
    const fourth = await pull(`?after=${third.nextCursor}`);
    assert.deepEqual(fourth.rows.map((r: any) => [r.id, r.deleted]), [[notes[0].id, true]]);
    // A deleted note keeps its content (its Drive file is only in the trash) so a Recycle Bin can restore it.
    assert.equal(fourth.rows[0].title, 'Keep title');
    assert.equal(fourth.rows[0].body, 'Keep body');
  });

  await t.test('concurrent creates cannot exceed the note quota', async () => {
    const account = await user();
    await collections.atomicUsers(db).updateOne({ _id: account.id }, { $set: { noteLimit: 1 } });
    const responses = await Promise.all([push([row()], account.token), push([row()], account.token)]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    assert.equal(await collections.notes(db).countDocuments({ userId: account.id, deleted: false }), 1);
  });

  await t.test('concurrent vault creation returns one 201 and one 409', async () => {
    const account = await user(), body = { verifier: 'v', kdfMemory: 65536, kdfIterations: 3, kdfParallelism: 1 };
    const statuses = (await Promise.all([request('/vault', 'POST', body, account.token), request('/vault', 'POST', body, account.token)])).map((r) => r.status);
    assert.deepEqual(statuses.sort(), [201, 409]);
  });

  await t.test('operations abandoned by a dead request are settled from stored results, never guessed', async () => {
    const account = await user();
    // 1) Nothing committed: the charge is refunded and the next request proceeds.
    const lost = [row(), row()], lostId = randomUUID();
    // The route fingerprints zod-parsed rows, so a later retry through HTTP must match these.
    const parse = (rows: object[]) => rows.map((r) => remoteNoteRowSchema.parse(r));
    const lostOp = await beginSync(db, account.id, lostId, parse(lost), 'standard');
    assert.equal(lostOp.charged, 5); assert.equal((await wallet(account.id)).energy, 15);
    const next = await push([row()], account.token);
    assert.equal(next.status, 200);
    const settled = (await syncOperations(db).findOne({ _id: lostOp._id }))!;
    assert.equal(settled.status, 'complete');
    assert.deepEqual(settled.results.map((r) => r.error), ['note_write_interrupted', 'note_write_interrupted']);
    assert.equal(settled.refunded, 5);
    assert.equal(await refundCount(account.id), 1);
    assert.equal((await wallet(account.id)).energy, 15); // refunded 5, charged 5 for the new request
    assert.equal((await push(lost, account.token, lostId)).status, 502); // a late retry sees the recorded outcome

    // 2) One note committed before the crash: no refund, and a recorded failure cannot override the stored success.
    const committed = row(), missing = row(), partialId = randomUUID();
    await collections.atomicUsers(db).updateOne({ _id: account.id }, { $set: { energy: 100 } });
    const partial = await beginSync(db, account.id, partialId, parse([committed, missing]), 'instant');
    const fields = { userId: account.id, kind: 'text' as const, pinned: false, deleted: false, encV: 0 as const, driveFileId: 'file-x', driveRevisionId: null,
      updatedAt: new Date(), lastSyncedAt: new Date(), syncStatus: 'synced' as const };
    await saveNoteMetadata(db, account.id, committed.id, fields, { _id: committed.id, ...fields, folderId: null, createdAt: new Date(), localVersion: 1 }, partial._id);
    await recordSyncResult(db, partial, { id: committed.id, ok: false, error: 'note_write_failed' });
    const energyBefore = (await wallet(account.id)).energy;
    assert.equal((await request('/notes/count', 'GET', undefined, account.token)).status, 200); // GET does not settle
    assert.equal((await syncOperations(db).findOne({ _id: partial._id }))!.status, 'pending');
    assert.equal((await push([row()], account.token, randomUUID(), 'instant')).status, 200); // a new push does
    const outcome = (await syncOperations(db).findOne({ _id: partial._id }))!;
    assert.deepEqual(outcome.results.map((r) => [r.id, r.ok]), [[committed.id, true], [missing.id, false]]);
    assert.equal(outcome.refunded, 0);
    assert.equal((await wallet(account.id)).energy, energyBefore - 10); // only the new instant push was charged

    // 3) A closed operation refuses further commits, so a late request cannot write unaccounted metadata.
    const late = row();
    await assert.rejects(saveNoteMetadata(db, account.id, late.id, fields, { _id: late.id, ...fields, folderId: null, createdAt: new Date(), localVersion: 1 }, partial._id), /sync_operation_closed/);
    assert.equal(await collections.notes(db).findOne({ _id: late.id }), null);
  });

  await t.test('files and folders deleted in Drive: pull skips them, push recreates them, wipe tolerates them', async () => {
    const account = await user(), a = row({ title: 'A' }), b = row({ title: 'B' });
    assert.equal((await push([a, b], account.token)).status, 200);
    const meta = async (id: string) => (await collections.notes(db).findOne({ _id: id }))!;
    const oldFileOfA = (await meta(a.id)).driveFileId;
    missingFiles.add(oldFileOfA);

    // One permanently deleted file must not stop the account from syncing.
    const pulled = await json(await request('/notes/pull', 'GET', undefined, account.token));
    assert.deepEqual(pulled.rows.map((r: any) => r.id), [b.id]);
    assert.equal(pulled.skipped, 1);
    assert.equal(await collections.logs(db).countDocuments({ userId: account.id, event: 'notes_unreadable' }), 1);

    // The next edit writes the note to a new file and records it.
    await refill(account.id);
    const edited = await push([{ ...a, title: 'A edited', base_version: 1 }], account.token);
    assert.equal(edited.status, 200);
    const repaired = await meta(a.id);
    assert.notEqual(repaired.driveFileId, oldFileOfA);
    assert.equal(files.get(repaired.driveFileId).title, 'A edited');
    const again = await json(await request('/notes/pull', 'GET', undefined, account.token));
    assert.deepEqual(again.rows.map((r: any) => r.id).sort(), [a.id, b.id].sort());
    assert.equal(again.skipped, 0);

    // Deleting a note whose file is already gone needs no new file.
    missingFiles.add(repaired.driveFileId);
    const before = writes;
    await refill(account.id);
    assert.equal((await push([{ ...a, deleted: true, base_version: 2 }], account.token)).status, 200);
    assert.equal(writes, before);
    assert.equal((await meta(a.id)).deleted, true);

    // The app folder itself is gone: it is recreated once and the note lands in the new folder.
    missingFolder = 'test-folder';
    const c = row({ title: 'C' });
    await refill(account.id);
    assert.equal((await push([c], account.token)).status, 200);
    assert.equal(foldersEnsured, 1);
    assert.equal((await collections.googleAccounts(db).findOne({ userId: account.id }))!.driveRootFolderId, 'recreated-folder');
    assert.equal(await collections.logs(db).countDocuments({ userId: account.id, event: 'drive_folder_recreated' }), 1);

    // Wiping an account must not fail because some files are already gone.
    missingFiles.add((await meta(b.id)).driveFileId);
    const wiped = await request('/notes', 'DELETE', undefined, account.token);
    assert.equal(wiped.status, 200);
    assert.ok((await json(wiped)).deleted >= 3);
    // A cloud wipe leaves no tombstones: a pull must not tell any device to delete its own local notes.
    assert.equal(await collections.notes(db).countDocuments({ userId: account.id }), 0);
    const afterWipe = await json(await request('/notes/pull?after=0', 'GET', undefined, account.token));
    assert.deepEqual(afterWipe.rows, []);
    // The account keeps working: a device that still holds a note writes it again with its old version.
    await refill(account.id);
    const restored = await push([{ ...c, base_version: 1 }], account.token);
    assert.equal(restored.status, 200);
    assert.equal((await collections.notes(db).findOne({ _id: c.id }))!.localVersion, 1);
  });

  await t.test('round trips: one-note sync operations stay within a small database command budget', async () => {
    // Each command is a network round trip in production; a function far from Atlas pays ~200 ms for each.
    const commands = async (work: () => Response | Promise<Response>) => {
      const before = mongoCommands.started;
      const response = await work();
      assert.ok(response.status < 300, `status ${response.status}`);
      return mongoCommands.started - before;
    };
    const account = await user();
    const counts = {
      firstPush: await commands(() => push([row()], account.token)),         // charges, grants the daily energy, creates a note
      instantPush: await commands(() => push([row()], account.token, randomUUID(), 'instant')), // charges 10
      pullOneRow: await commands(() => request('/notes/pull?after=1', 'GET', undefined, account.token)),  // one note to read from Drive
      pullNothing: await commands(() => request('/notes/pull?after=99', 'GET', undefined, account.token)),
      count: await commands(() => request('/notes/count', 'GET', undefined, account.token)),
    };
    const refusedFrom = mongoCommands.started;
    assert.equal((await push([row()], account.token)).status, 429); // inside the hour: refused before any charge
    (counts as Record<string, number>).cooldownPush = mongoCommands.started - refusedFrom;
    console.log('MONGO COMMANDS PER OPERATION', JSON.stringify(counts));
    for (const [name, limit] of Object.entries(BUDGET)) assert.ok((counts as Record<string, number>)[name] <= limit, `${name}: ${(counts as Record<string, number>)[name]} commands, budget ${limit}`);
  });

  await t.test('a revoked Google grant answers 401 google_reauth_required; the same request resumes after sign-in without a second charge', async () => {
    const account = await user(), first = row({ title: 'Before revoke' });
    assert.equal((await push([first], account.token)).status, 200);
    assert.equal((await wallet(account.id)).energy, 15);

    revoked = true;
    try {
      const pull = await request('/notes/pull', 'GET', undefined, account.token);
      assert.equal(pull.status, 401);
      assert.equal((await json(pull)).error, 'google_reauth_required');

      const requestId = randomUUID(), rows = [row({ title: 'During revoke' })];
      const denied = await push(rows, account.token, requestId, 'instant');
      assert.equal(denied.status, 401);
      assert.equal((await json(denied)).error, 'google_reauth_required');
      assert.equal(await collections.notes(db).countDocuments({ userId: account.id }), 1); // only the first note exists
      assert.equal((await wallet(account.id)).energy, 5); // the instant sync was accepted and charged, and is still open
      assert.equal((await syncOperations(db).findOne({ _id: `${account.id}:${requestId}` }))!.status, 'pending');

      revoked = false; // the user signed in again
      const resumed = await push(rows, account.token, requestId, 'instant');
      assert.equal(resumed.status, 200);
      const body = await json(resumed);
      assert.deepEqual([body.charged, body.refunded], [10, 0]);
      assert.equal((await wallet(account.id)).energy, 5); // no second charge
      assert.equal(await collections.energyLedger(db).countDocuments({ userId: account.id, kind: 'spend' }), 2);
      assert.equal((await syncOperations(db).findOne({ _id: `${account.id}:${requestId}` }))!.status, 'complete');
    } finally { revoked = false; }
  });

  await t.test('a standard sync starts once per hour; instant sync is always open; a refused sync costs nothing', async () => {
    const account = await user(), first = row(), second = row(), third = row(), requestId = randomUUID();
    const paid = await push([first], account.token, requestId);
    assert.equal(paid.status, 200); assert.equal((await json(paid)).charged, 5);
    const energy = (await wallet(account.id)).energy, before = writes;
    const operations = await syncOperations(db).countDocuments({ userId: account.id });

    const refused = await push([second], account.token);
    assert.equal(refused.status, 429);
    const body = await json(refused);
    assert.equal(body.error, 'sync_cooldown');
    assert.ok(body.retry_after_seconds > 3500 && body.retry_after_seconds <= 3600, `retry after ${body.retry_after_seconds}`);
    assert.equal(refused.headers.get('retry-after'), String(body.retry_after_seconds));
    assert.equal(writes, before);
    assert.equal((await wallet(account.id)).energy, energy);
    assert.equal(await syncOperations(db).countDocuments({ userId: account.id }), operations);
    assert.equal(await collections.notes(db).countDocuments({ _id: second.id }), 0);
    // A retry of the request that already finished is answered from its record, not refused.
    assert.equal((await push([first], account.token, requestId)).status, 200);

    // Instant sync is open at any time, costs 10, and leaves the standard clock alone.
    const standardAt = (await wallet(account.id)).lastStandardSyncAt;
    const instant = await push([second], account.token, randomUUID(), 'instant');
    assert.equal(instant.status, 200); assert.equal((await json(instant)).charged, 10);
    assert.equal((await wallet(account.id)).energy, energy - 10);
    assert.deepEqual((await wallet(account.id)).lastStandardSyncAt, standardAt);

    // The hour is counted by the Server's clock: after it, a standard sync is charged again.
    await collections.atomicUsers(db).updateOne({ _id: account.id }, { $set: { lastStandardSyncAt: new Date(Date.now() - 61 * 60 * 1000), energy: 50 } });
    const later = await push([third], account.token);
    assert.equal(later.status, 200); assert.equal((await json(later)).charged, 5);
  });

  await t.test('a note that already holds exactly what a push sends is not written to Drive again', async () => {
    const account = await user(), note = row();
    const created = await json(await push([note], account.token));
    assert.equal(created.results[0].unchanged, undefined);
    assert.ok((await collections.notes(db).findOne({ _id: note.id }))!.contentHash);

    await refill(account.id);
    const before = writes;
    const same = await push([{ ...note, base_version: 1 }], account.token);
    assert.equal(same.status, 200);
    const [result] = (await json(same)).results;
    assert.deepEqual([result.ok, result.unchanged, result.version], [true, true, 1]);
    assert.equal(writes, before);
    assert.equal((await collections.notes(db).findOne({ _id: note.id }))!.localVersion, 1);

    // A real edit, and a batch that mixes an unchanged note, an edit and a new note.
    await refill(account.id);
    const edited = await json(await push([{ ...note, title: 'changed', base_version: 1 }], account.token));
    assert.equal(edited.results[0].version, 2); assert.equal(writes, before + 1);
    const fresh = row();
    await refill(account.id);
    const mixed = await json(await push([{ ...note, title: 'changed', base_version: 2 }, fresh], account.token));
    assert.deepEqual(mixed.results.map((r: any) => [r.ok, r.unchanged ?? false]), [[true, true], [true, false]]);
    assert.equal(writes, before + 2);
    // Pinning is content too, and deleting an already deleted note changes nothing.
    await refill(account.id);
    assert.equal((await json(await push([{ ...note, title: 'changed', pinned: true, base_version: 2 }], account.token))).results[0].version, 3);
    await refill(account.id);
    assert.equal((await push([{ ...note, title: 'changed', pinned: true, deleted: true, base_version: 3 }], account.token)).status, 200);
    await refill(account.id);
    const gone = (await json(await push([{ ...note, title: 'changed', pinned: true, deleted: true, base_version: 4 }], account.token))).results[0];
    assert.deepEqual([gone.ok, gone.unchanged], [true, true]);
  });

  await t.test('a batch is written to Drive in parallel and committed in the order it was sent', async () => {
    const account = await user(), notes = Array.from({ length: 12 }, (_, i) => row({ title: `n${i}` }));
    peakWrites = 0;
    const response = await push(notes, account.token);
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.deepEqual(body.results.map((r: any) => r.id), notes.map((n) => n.id));
    assert.deepEqual(body.results.map((r: any) => r.seq), Array.from({ length: 12 }, (_, i) => i + 1));
    assert.ok(peakWrites > 1 && peakWrites <= 4, `peak writes in flight: ${peakWrites}`);
  });

  await t.test('one push carries up to 100 notes', async () => {
    const account = await user();
    await collections.atomicUsers(db).updateOne({ _id: account.id }, { $set: { noteLimit: 100, energy: 100 } });
    assert.equal((await push(Array.from({ length: 101 }, () => row()), account.token)).status, 400);
    const response = await push(Array.from({ length: 100 }, () => row()), account.token);
    assert.equal(response.status, 200);
    assert.equal(await collections.notes(db).countDocuments({ userId: account.id, deleted: false }), 100);
  });

  await t.test('a batch may delete a note and add one at the limit, but a stale delete frees no room', async () => {
    const account = await user(), a = row(), b = row(), c = row(), d = row();
    await collections.atomicUsers(db).updateOne({ _id: account.id }, { $set: { noteLimit: 2 } });
    assert.equal((await push([a, b], account.token)).status, 200);
    await refill(account.id);
    const full = await push([c], account.token);
    assert.equal(full.status, 409); assert.equal((await json(full)).error, 'note_limit_reached');
    await refill(account.id);
    assert.equal((await push([{ ...a, deleted: true, base_version: 1 }, c], account.token)).status, 200);
    assert.equal(await collections.notes(db).countDocuments({ userId: account.id, deleted: false }), 2);
    // The delete of b names an old version, so it conflicts and removes nothing: adding d must not fit.
    await refill(account.id);
    assert.equal((await push([{ ...b, deleted: true, base_version: 0 }, d], account.token)).status, 409);
    assert.equal(await collections.notes(db).countDocuments({ userId: account.id, deleted: false }), 2);
  });

  await t.test('note capacity is bought one tier at a time, the last tier costs more, and a repeated call charges once', async () => {
    const account = await user();
    const upgrade = (from: number) => request('/energy/note-limit', 'POST', { from_limit: from }, account.token);
    const poor = await upgrade(30);
    assert.equal(poor.status, 409); assert.equal((await json(poor)).error, 'insufficient_coins');
    assert.equal((await wallet(account.id)).noteLimit, 30);

    // 10 + 20 + 30: exactly enough for every tier up to the ceiling, nothing left over.
    await collections.atomicUsers(db).updateOne({ _id: account.id }, { $set: { coins: 60 } });
    const first = await json(await upgrade(30));
    assert.deepEqual([first.wallet.note_limit, first.wallet.coins], [40, 50]);
    // The same call again, as after a lost response: the purchase went through, so nothing more is charged.
    const repeat = await upgrade(30);
    assert.equal(repeat.status, 200);
    assert.deepEqual([(await json(repeat)).wallet.coins, (await wallet(account.id)).noteLimit], [50, 40]);
    // A caller that is ahead of the Server is refused.
    assert.equal((await json(await upgrade(50))).error, 'invalid_amount');

    assert.equal((await json(await upgrade(40))).wallet.note_limit, 50);
    // Strangelet: 50 -> 100 costs 30 coins, not the earlier tiers' cheaper prices.
    const strangelet = await json(await upgrade(50));
    assert.deepEqual([strangelet.wallet.note_limit, strangelet.wallet.coins], [100, 0]);
    const capped = await upgrade(100);
    assert.equal(capped.status, 409); assert.equal((await json(capped)).error, 'note_limit_ceiling');
    assert.deepEqual([(await wallet(account.id)).coins, (await wallet(account.id)).noteLimit], [0, 100]);
    const purchases = await collections.energyLedger(db)
      .find({ userId: account.id, kind: 'purchase' })
      .sort({ createdAt: 1 })
      .toArray();
    assert.deepEqual(purchases.map((p) => p.coinsDelta), [-10, -20, -30]);

    // The Server publishes the tiers it enforces, and a pushed batch obeys the new limit.
    const state = await json(await request('/energy', 'GET', undefined, account.token));
    assert.equal(state.wallet.note_limit, 100);
    assert.equal(state.limits.note_limit_ceiling, 100);
    assert.deepEqual(
      state.limits.note_limit_tiers.map((t: any) => [t.limit, t.name, t.cost_coins]),
      [[30, 'Tachyon', 0], [40, 'Antimatter', 10], [50, 'Monopole', 20], [100, 'Strangelet', 30]],
    );
    await refill(account.id);
    assert.equal((await push(Array.from({ length: 60 }, () => row()), account.token)).status, 200);
  });

  await t.test('a client can neither spend nor refund energy itself', async () => {
    const account = await user();
    for (const path of ['/energy/spend', '/energy/spend-standard', '/energy/refund']) {
      const response = await request(path, 'POST', { amount: 1, reason: 'x' }, account.token);
      assert.equal(response.status, 410, path);
    }
  });

  await t.test('deleted notes expire after 30 days, and only the newest 5 sessions stay valid', async () => {
    const ttl = (await collections.notes(db).indexes()).find((index) => index.name === 'tombstone_ttl');
    assert.equal(ttl?.expireAfterSeconds, 30 * 24 * 60 * 60);
    assert.deepEqual(ttl?.partialFilterExpression, { deleted: true });

    const account = await user(), tokens = [account.token];
    for (let i = 0; i < 7; i++) { await delay(3); tokens.push(await createSession(db, account.id)); }
    assert.equal(await collections.sessions(db).countDocuments({ userId: account.id, revoked: false }), 5);
    assert.ok(await verifySession(db, tokens[tokens.length - 1]));
    assert.equal(await verifySession(db, tokens[0]), null);
  });

  await t.test('Google login falls back to the profile endpoint when the token response has no ID token', async () => {
    const verifier = { async verifyIdToken() { throw new Error('must not be called without an ID token'); } } as any;
    const sub = randomUUID(), setup = async () => ({ notesId: 'folder-p' });
    const tokens = { access_token: 'access', refresh_token: 'refresh', expiry_date: Date.now() + 3600000 };
    const viaProfile = await completeGoogleLogin(db, verifier, tokens, 'agent', setup as any,
      async () => ({ sub, email: 'Profile@Example.com', email_verified: true, name: 'P' })) as { user: { id: string; email: string } };
    assert.equal(viaProfile.user.email, 'profile@example.com');
    assert.equal((await collections.googleAccounts(db).findOne({ googleAccountId: sub }))!.userId, viaProfile.user.id);
    assert.deepEqual(await completeGoogleLogin(db, verifier, tokens, 'agent', setup as any, async () => null), { error: 'incomplete_token_response' });
    assert.deepEqual(await completeGoogleLogin(db, verifier, { ...tokens, access_token: undefined }, 'agent', setup as any, async () => ({})), { error: 'incomplete_token_response' });
    assert.deepEqual(await completeGoogleLogin(db, verifier, tokens, 'agent', setup as any,
      async () => ({ sub: randomUUID(), email: 'unverified@example.com', email_verified: false })), { error: 'invalid_id_token' });
  });

  await t.test('sync operation records expire after 30 days', async () => {
    const indexes = await db.collection('sync_operations').indexes();
    const ttl = indexes.find((index) => index.key.createdAt === 1);
    assert.equal(ttl?.expireAfterSeconds, 30 * 24 * 60 * 60);
  });

  await t.test('log rows expire after 30 days and the energy ledger is kept', async () => {
    const logTtl = (await collections.logs(db).indexes()).find((index) => index.name === 'logs_ttl');
    assert.deepEqual(logTtl?.key, { createdAt: 1 });
    assert.equal(logTtl?.expireAfterSeconds, 30 * 24 * 60 * 60);
    const ledger = await collections.energyLedger(db).indexes();
    assert.equal(ledger.some((index) => index.expireAfterSeconds !== undefined), false);
  });

  await t.test('returning Google login links by subject, reuses the refresh token and repairs missing Drive setup', async () => {
    const sub = randomUUID();
    const verifier = { async verifyIdToken({ idToken }: { idToken: string }) { return { getPayload: () => JSON.parse(idToken) }; } } as any;
    const login = (claims: object, tokens: object = {}, setup: any = async () => ({ notesId: 'folder-1' })) => completeGoogleLogin(db, verifier, {
      access_token: 'access', refresh_token: 'refresh-1', expiry_date: Date.now() + 3600000,
      id_token: JSON.stringify({ sub, email: 'Person@Example.com', email_verified: true, name: 'Person', ...claims }), ...tokens }, 'test-agent', setup);

    await assert.rejects(login({}, {}, async () => { throw new Error('drive_setup_failed'); }), /drive_setup_failed/);
    let account = (await collections.googleAccounts(db).findOne({ googleAccountId: sub }))!;
    assert.equal(account.driveRootFolderId, null);

    const returning = await login({ email: 'Moved@Example.com' }, { refresh_token: undefined, access_token: 'access-2' }, async () => ({ notesId: 'folder-2' })) as { user: { id: string; email: string } };
    assert.equal(returning.user.id, account.userId);
    assert.equal(returning.user.email, 'moved@example.com');
    account = (await collections.googleAccounts(db).findOne({ googleAccountId: sub }))!;
    assert.equal(account.driveRootFolderId, 'folder-2');
    assert.equal(decryptToken(account.encryptedRefreshToken), 'refresh-1');
    assert.equal(decryptToken(account.encryptedAccessToken), 'access-2');
    assert.equal(await collections.users(db).countDocuments({ _id: account.userId }), 1);

    assert.deepEqual(await login({ sub: randomUUID(), email: 'unverified@example.com', email_verified: false }), { error: 'invalid_id_token' });
    const noRefresh = await login({ sub: randomUUID(), email: 'norefresh@example.com' }, { refresh_token: undefined });
    assert.equal((noRefresh as { error: string }).error, 'refresh_token_required');
    assert.equal(await collections.users(db).findOne({ email: 'norefresh@example.com' }), null);
  });

  await t.test('OAuth state is stored hashed, bound to a cookie, and rejected when the binding or lifetime is wrong', async () => {
    const start = await app.request('/api/auth/google');
    assert.equal(start.status, 302);
    const cookie = start.headers.get('set-cookie')!;
    assert.match(cookie, /atomic_oauth_state=/); assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=Lax/i);
    const binding = /atomic_oauth_state=([^;]+)/.exec(cookie)![1];
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const states = db.collection<{ _id: string; binding: string; expiresAt: Date }>('oauth_states');
    const stored = (await states.findOne({ _id: hash(state) }))!;
    assert.equal(stored.binding, hash(binding));
    assert.equal(await states.findOne({ _id: state }), null);

    const callback = (query: string, cookieHeader?: string) => app.request(`/api/auth/callback?${query}`, { headers: cookieHeader ? { cookie: cookieHeader } : {} });
    assert.equal((await callback(`code=x&state=${state}`)).status, 400);
    assert.equal((await callback(`code=x&state=${state}`, 'atomic_oauth_state=wrong')).status, 400);
    assert.equal((await callback('code=x&state=unknown', `atomic_oauth_state=${binding}`)).status, 400);
    assert.ok(await states.findOne({ _id: hash(state) }), 'a rejected callback must not consume the state');
    await states.updateOne({ _id: hash(state) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await callback(`code=x&state=${state}`, `atomic_oauth_state=${binding}`)).status, 400);
  });
});
