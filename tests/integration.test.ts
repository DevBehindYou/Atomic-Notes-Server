import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';

// This suite creates and drops only its own database on a disposable local runner.
const uri = process.env.MONGODB_URI;
if (!uri || !/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+(?:[/?]|$)/.test(uri)) {
  throw new Error('Integration tests require a disposable localhost MongoDB replica set');
}
const databaseName = `atomic_test_${randomUUID().replaceAll('-', '')}`;
process.env.MONGODB_DB_NAME = databaseName;
process.env.ADMIN_API_KEY = 'test-admin-key';
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');

const { getDb, closeDb, withTransaction } = await import('../src/db/mongo');
const { collections, ensureIndexes } = await import('../src/db/collections');
const { createSession, verifySession } = await import('../src/lib/session');
const { energyEnsure, energyConvert, energyGrantDaily, energySpendStandard } = await import('../src/lib/energy');
const { encryptToken } = await import('../src/lib/crypto');
const { createNotesRoute } = await import('../src/routes/notes');
const { registerErrorHandler } = await import('../src/middleware/errorHandler');
const { default: admin } = await import('../src/routes/admin');
const { default: publicRoute } = await import('../src/routes/public');
const { default: vault } = await import('../src/routes/vault');
const { default: energyRoute } = await import('../src/routes/energy');
const { default: profileRoute } = await import('../src/routes/atomicuser');
const { default: auth } = await import('../src/routes/auth');

test('Server contracts with a real MongoDB replica set and a fake Drive adapter', { timeout: 120000 }, async (t) => {
  const db = await getDb();
  t.after(async () => {
    try { assert.equal(db.databaseName, databaseName); await db.dropDatabase(); }
    finally { await closeDb(); }
  });
  assert.ok((await db.admin().command({ hello: 1 })).setName, 'Transactions require a replica set');
  await ensureIndexes(db);

  const files = new Map<string, any>();
  let writes = 0, failDelete = false, failTitle = '', activeReads = 0, peakReads = 0;
  const drive = {
    async createNoteFile(_a: string, _r: string, _p: string, _n: string, content: object) {
      if ((content as any).title === failTitle && failTitle) throw new Error('simulated_drive_failure');
      writes++; const id = randomUUID(); files.set(id, structuredClone(content)); return { id, headRevisionId: '1' };
    },
    async updateNoteFile(_a: string, _r: string, id: string, content: object) {
      if ((content as any).title === failTitle && failTitle) throw new Error('simulated_drive_failure');
      writes++; files.set(id, structuredClone(content)); return { id, headRevisionId: '2' };
    },
    async deleteNoteFile(_a: string, _r: string, _id: string) {
      if (failDelete) throw new Error('simulated_delete_failure');
      writes++;
    },
    async getNoteFileContent(_a: string, _r: string, id: string) {
      peakReads = Math.max(peakReads, ++activeReads); await delay(5); activeReads--;
      return structuredClone(files.get(id));
    },
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
  const push = (rows: object[], token = owner.token) => request('/notes/push', 'POST', { rows }, token);

  await t.test('owner isolation, partial updates and failed pushes', async () => {
    const original = row(); assert.equal((await push([original])).status, 200);
    const before = writes;
    assert.equal((await push([original], other.token)).status, 409);
    assert.equal(writes, before);
    assert.equal((await collections.notes(db).findOne({ _id: original.id }))!.userId, owner.id);
    assert.equal((await push([original, original])).status, 400);
    assert.equal((await request(`/notes/${original.id}`, 'PATCH', { pinned: true }, owner.token)).status, 200);
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
    assert.equal(await energySpendStandard(db, walletUser.id), 5);
    const paid = (await collections.atomicUsers(db).findOne({ _id: walletUser.id }))!;
    assert.equal(await energySpendStandard(db, walletUser.id), 0);
    assert.deepEqual((await collections.atomicUsers(db).findOne({ _id: walletUser.id }))!.lastStandardSyncAt, paid.lastStandardSyncAt);
    await assert.rejects(withTransaction(async (session) => {
      await collections.atomicUsers(db).updateOne({ _id: walletUser.id }, { $inc: { energy: 9 } }, { session });
      throw new Error('rollback_fixture');
    }), /rollback_fixture/);
    assert.equal((await collections.atomicUsers(db).findOne({ _id: walletUser.id }))!.energy, 55);
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
});
