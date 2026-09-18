import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';
import { z } from 'zod';
import { mapConcurrent } from '../src/lib/concurrency';
import { escapeRegex } from '../src/lib/validation';
import { registerErrorHandler } from '../src/middleware/errorHandler';
import { requireAdmin } from '../src/middleware/adminAuth';
import { encryptToken, decryptToken } from '../src/lib/crypto';
import { remoteNoteRowSchema } from '../src/types/noteWire';
import { createNoteFileWith } from '../src/lib/googleDrive';
import { assertProductionEnvironment, getEnvIssues } from '../src/lib/env';

test('current Flutter push payload omits updated_at and cannot choose its owner', () => {
  const row = remoteNoteRowSchema.parse({
    id: 'cfded5cb-1027-43a6-9f16-563a8132995e', user_id: 'untrusted-user-id',
    kind: 'text', title: 'App note', body: 'content', items: [], pinned: false,
    deleted: false, created_at: '2026-09-14T18:00:00.123456Z', enc_v: 0, payload: null,
  });
  assert.equal(row.updated_at, undefined);
  assert.equal('user_id' in row, false);
  assert.equal(row.body, 'content');
});

test('Drive scheduling is bounded and results keep their input order', async () => {
  let active = 0, peak = 0;
  const result = await mapConcurrent([4, 3, 2, 1, 0], 2, async (n) => {
    peak = Math.max(peak, ++active);
    await delay(n * 2);
    active--;
    return n;
  });
  assert.deepEqual(result, [4, 3, 2, 1, 0]);
  assert.equal(peak, 2);
});

test('failed Drive work settles in-flight operations before returning', async () => {
  let settled = false;
  await assert.rejects(mapConcurrent([0, 1, 2], 2, async (n) => {
    if (n === 0) { await delay(1); throw new Error('drive_failure'); }
    await delay(20); settled = true;
  }), /drive_failure/);
  assert.ok(settled);
});

test('email lookup treats regex characters literally', () => {
  const pattern = new RegExp(`^${escapeRegex('a+b@example.com')}$`, 'i');
  assert.ok(pattern.test('A+B@EXAMPLE.COM'));
  assert.equal(pattern.test('ab@exampleXcom'), false);
  assert.equal(new RegExp(`^${escapeRegex('.*')}$`).test('someone@example.com'), false);
});

test('invalid payloads and malformed JSON produce 400', async () => {
  const app = new Hono();
  registerErrorHandler(app);
  app.post('/validate', async (c) => c.json(z.object({ value: z.number() }).parse(await c.req.json())));
  assert.equal((await app.request('/validate', { method: 'POST', body: '{}' })).status, 400);
  assert.equal((await app.request('/validate', { method: 'POST', body: '{' })).status, 400);
});

test('admin key checks reject wrong byte lengths without throwing', async () => {
  process.env.ADMIN_API_KEY = 'aa';
  const app = new Hono();
  app.use('*', requireAdmin);
  app.get('/', (c) => c.json({ ok: true }));
  for (const key of ['', 'bb', 'éé']) {
    assert.equal((await app.request('/', { headers: { 'x-admin-api-key': key } })).status, 401);
  }
  assert.equal((await app.request('/', { headers: { 'x-admin-api-key': 'aa' } })).status, 200);
});

test('Google tokens round-trip encrypted and reject tampered ciphertext', () => {
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  const encrypted = encryptToken('test-refresh-token');
  assert.notEqual(encrypted, 'test-refresh-token');
  assert.equal(decryptToken(encrypted), 'test-refresh-token');
  const parts = encrypted.split('.');
  const cipher = Buffer.from(parts[2], 'base64'); cipher[0] ^= 1;
  parts[2] = cipher.toString('base64');
  assert.throws(() => decryptToken(parts.join('.')));
});

test('real Server entrypoint exposes health and rejects anonymous protected calls without MongoDB', async () => {
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017';
  const { default: app } = await import('../src/app');
  assert.equal((await app.request('/api/health')).status, 200);
  for (const [path, method] of [
    ['/notes/push', 'POST'], ['/notes/pull', 'GET'], ['/vault', 'GET'],
    ['/energy', 'GET'], ['/atomicuser', 'PATCH'], ['/auth/logout', 'POST'],
    ['/admin/notifications', 'GET'],
  ]) assert.equal((await app.request(`/api${path}`, { method })).status, 401, path);
  assert.equal((await app.request('/api/auth/google/mobile', { method: 'POST', body: '{}' })).status, 400);
});

test('Drive create reuses an existing file with the same name instead of leaving a second copy', async () => {
  const calls: string[] = [];
  const fakeDrive = (existingId: string | null) => ({ files: {
    async list(args: { q: string }) { calls.push(`list:${args.q}`); return { data: { files: existingId ? [{ id: existingId }] : [] } }; },
    async update(args: { fileId: string }) { calls.push(`update:${args.fileId}`); return { data: { id: args.fileId, headRevisionId: '2' } }; },
    async create(args: { requestBody: { name: string; parents: string[] } }) { calls.push(`create:${args.requestBody.name}:${args.requestBody.parents[0]}`); return { data: { id: 'new-file', headRevisionId: '1' } }; },
  } }) as unknown as Parameters<typeof createNoteFileWith>[0];

  const reused = await createNoteFileWith(fakeDrive('file-9'), 'folder-1', 'note.atomic', { a: 1 });
  assert.equal(reused.id, 'file-9');
  assert.deepEqual(calls.map((call) => call.split(':')[0]), ['list', 'update']);
  assert.match(calls[0], /name = 'note\.atomic' and 'folder-1' in parents and trashed = false/);

  calls.length = 0;
  const created = await createNoteFileWith(fakeDrive(null), "fold'er", 'note.atomic', { a: 1 });
  assert.equal(created.id, 'new-file');
  assert.deepEqual(calls.map((call) => call.split(':')[0]), ['list', 'create']);
  assert.ok(calls[0].includes("'fold\\'er' in parents"));
});

test('encrypted and plaintext note content cannot be mixed', () => {
  const base = { id: 'cfded5cb-1027-43a6-9f16-563a8132995e', kind: 'text', title: '', body: '', items: [], pinned: false,
    deleted: false, created_at: '2026-09-14T18:00:00Z' };
  assert.equal(remoteNoteRowSchema.safeParse({ ...base, enc_v: 1, payload: 'ciphertext' }).success, true);
  assert.equal(remoteNoteRowSchema.safeParse({ ...base, enc_v: 1, payload: null }).success, false);
  assert.equal(remoteNoteRowSchema.safeParse({ ...base, enc_v: 1, payload: 'ciphertext', body: 'leak' }).success, false);
  assert.equal(remoteNoteRowSchema.safeParse({ ...base, enc_v: 0, payload: 'ciphertext' }).success, false);
  assert.equal(remoteNoteRowSchema.safeParse({ ...base, enc_v: 0, payload: null, body: 'x'.repeat(131073) }).success, false);
});

test('configuration issues name variables without exposing values', () => {
  const secret = 'super-secret-value-that-must-not-leak-into-output';
  const good = {
    MONGODB_URI: 'mongodb+srv://user:pass@cluster.example.net', TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', ADMIN_API_KEY: 'k'.repeat(32),
    GOOGLE_REDIRECT_URI: 'https://atomic-notes-server-gde2e.vercel.app/api/auth/callback',
  } as NodeJS.ProcessEnv;
  assert.deepEqual(getEnvIssues(good), []);
  const bad = { ...good, TOKEN_ENCRYPTION_KEY: secret, ADMIN_API_KEY: 'short', GOOGLE_CLIENT_ID: '', GOOGLE_REDIRECT_URI: 'http://localhost/cb' } as NodeJS.ProcessEnv;
  const issues = getEnvIssues(bad);
  assert.deepEqual(issues.map((issue) => issue.name).sort(), ['ADMIN_API_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_REDIRECT_URI', 'TOKEN_ENCRYPTION_KEY']);
  assert.equal(JSON.stringify(issues).includes(secret), false);
  assert.doesNotThrow(() => assertProductionEnvironment({ ...bad, VERCEL_ENV: 'preview' } as NodeJS.ProcessEnv));
  assert.throws(() => assertProductionEnvironment({ ...bad, VERCEL_ENV: 'production' } as NodeJS.ProcessEnv), /TOKEN_ENCRYPTION_KEY/);
  assert.throws(() => assertProductionEnvironment({ ...bad, NODE_ENV: 'production' } as NodeJS.ProcessEnv), (error: Error) => !error.message.includes(secret));
});
