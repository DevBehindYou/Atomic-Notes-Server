import { escapeRegex } from '../lib/validation.js';
import { Hono } from 'hono';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { getDb, withTransaction } from '../db/mongo.js';
import { collections, type NotificationDoc } from '../db/collections.js';
import { requireAdmin } from '../middleware/adminAuth.js';
import { computeControllerStats } from '../lib/adminStats.js';
import { logEvent } from '../lib/logs.js';
import { getEnvIssues } from '../lib/env.js';
import { NOTE_LIMIT } from '../lib/energy.js';

const admin = new Hono();
admin.use('*', requireAdmin);

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------
admin.get('/health', async (c) => {
  // Variable names and problems only, never values.
  const configuration = getEnvIssues();
  try {
    const db = await getDb();
    await collections.notifications(db).countDocuments({});
    return c.json({ db: true, dbError: null, configuration, time: new Date().toISOString() });
  } catch (e) {
    return c.json({ db: false, dbError: e instanceof Error ? e.message : 'DB error', configuration, time: new Date().toISOString() });
  }
});

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------
admin.get('/stats', async (c) => {
  try {
    const db = await getDb();
    const stats = await computeControllerStats(db);
    return c.json({ stats });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Failed to load stats' }, 500);
  }
});

// ---------------------------------------------------------------------------
// user lookup by email
// ---------------------------------------------------------------------------
admin.get('/user', async (c) => {
  const email = c.req.query('email')?.trim();
  if (!email) return c.json({ error: 'email is required' }, 400);

  const db = await getDb();
  const user = await collections.users(db).findOne({ email: { $regex: `^${escapeRegex(email)}$`, $options: 'i' } });
  if (!user) return c.json({ error: 'No user with that email' }, 404);

  const wallet = await collections.atomicUsers(db).findOne({ _id: user._id });
  // No last_sign_in_at concept from Supabase auth.users anymore — the most
  // recent session's createdAt is the closest honest equivalent.
  const lastSession = await collections
    .sessions(db)
    .find({ userId: user._id })
    .sort({ createdAt: -1 })
    .limit(1)
    .toArray();

  return c.json({
    user_id: user._id,
    email: user.email,
    username: wallet?.username ?? null,
    email_confirmed: true, // Google-verified at sign-in; there is no separate confirmation step
    last_sign_in_at: lastSession[0]?.createdAt.toISOString() ?? null,
    auth_created_at: user.createdAt.toISOString(),
    has_wallet: Boolean(wallet),
    coins: wallet?.coins ?? 0,
    energy: wallet?.energy ?? 0,
    energy_cap: wallet?.energyCap ?? 120,
    last_daily_grant_at: wallet?.lastDailyGrantAt?.toISOString() ?? null,
  });
});

// ---------------------------------------------------------------------------
// energy adjustment — direct port of Community's energy/route.ts logic,
// now living where the rest of the wallet-mutation logic already lives
// (lib/energy.ts's transactional pattern) instead of a second copy of it.
// ---------------------------------------------------------------------------
const adjustSchema = z
  .object({
    email: z.string().email().optional(),
    user_id: z.string().uuid().optional(),
    coins_delta: z.number().finite().default(0),
    energy_delta: z.number().finite().default(0),
    note: z.string().optional(),
  })
  .refine((b) => b.email || b.user_id, { message: 'email or user_id is required' })
  .refine((b) => b.coins_delta !== 0 || b.energy_delta !== 0, { message: 'nothing to adjust' });

admin.post('/energy', async (c) => {
  const body = adjustSchema.parse(await c.req.json());
  const db = await getDb();

  let resolvedUserId = body.user_id;
  if (!resolvedUserId && body.email) {
    const user = await collections.users(db).findOne({ email: { $regex: `^${escapeRegex(body.email)}$`, $options: 'i' } });
    if (!user) return c.json({ error: 'user not found' }, 404);
    resolvedUserId = user._id;
  }
  // Copied to a const: TypeScript doesn't carry the narrowing above into the
  // closure below (a `let` captured by a nested function is re-widened to
  // its declared type), so `resolvedUserId` inside withTransaction would
  // still type-check as `string | undefined` without this.
  const userId: string = resolvedUserId!;

  const result = await withTransaction(async (session) => {
    const col = collections.atomicUsers(db);
    const wallet = await col.findOne({ _id: userId }, { session });
    const curCoins = wallet?.coins ?? 0;
    const curEnergy = wallet?.energy ?? 0;
    const cap = wallet?.energyCap ?? 120;
    const newCoins = Math.max(0, curCoins + body.coins_delta);
    const newEnergy = Math.min(cap, Math.max(0, curEnergy + body.energy_delta));

    await col.updateOne(
      { _id: userId },
      {
        $set: { coins: newCoins, energy: newEnergy },
        $setOnInsert: {
          username: '',
          noteLimit: NOTE_LIMIT.free,
          energyCap: 120,
          lastDailyGrantAt: null,
          lastStandardSyncAt: null,
          createdAt: new Date(),
        },
      },
      { upsert: true, session },
    );

    await collections.energyLedger(db).insertOne(
      {
        _id: randomUUID(),
        userId,
        kind: 'admin_adjust',
        coinsDelta: newCoins - curCoins,
        energyDelta: newEnergy - curEnergy,
        resultingCoins: newCoins,
        resultingEnergy: newEnergy,
        note: body.note || 'Admin adjustment (Atomic-Controller)',
        createdAt: new Date(),
      },
      { session },
    );

    return { newCoins, newEnergy };
  });

  await logEvent(db, 'admin_energy_adjust', {
    userId,
    meta: { coinsDelta: body.coins_delta, energyDelta: body.energy_delta, note: body.note },
  });

  return c.json({ ok: true, user_id: userId, coins: result.newCoins, energy: result.newEnergy });
});

// ---------------------------------------------------------------------------
// notifications CRUD — wire shape is snake_case throughout, matching the
// live app's `notifications` table columns exactly (Controller's UI and the
// Flutter client, if notifications are ever wired up there, both expect
// these names). Internal storage is camelCase, per db/collections.ts.
// ---------------------------------------------------------------------------
function toWire(n: NotificationDoc) {
  return {
    id: n._id,
    type: n.type,
    subject: n.subject,
    description: n.description,
    priority: n.priority,
    status: n.status,
    action: n.action,
    action_url: n.actionUrl,
    icon: n.icon,
    target_audience: n.targetAudience,
    target_user_id: n.targetUserId,
    min_app_version: n.minAppVersion,
    max_app_version: n.maxAppVersion,
    dismissible: n.dismissible,
    created_at: n.createdAt.toISOString(),
    expires_at: n.expiresAt ? n.expiresAt.toISOString() : null,
  };
}

admin.get('/notifications', async (c) => {
  const db = await getDb();
  const rows = await collections.notifications(db).find({}).sort({ createdAt: -1 }).toArray();
  return c.json({ rows: rows.map(toWire) });
});

const createNotificationSchema = z.object({
  id: z.string().uuid().optional(),
  type: z.string().min(1),
  subject: z.string().min(1),
  description: z.string().min(1),
  priority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  status: z.enum(['active', 'resolved', 'expired']).optional(),
  action: z.string().nullable().optional(),
  action_url: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  target_audience: z.string().optional(),
  target_user_id: z.string().uuid().nullable().optional(),
  target_email: z.string().email().optional(),
  min_app_version: z.string().nullable().optional(),
  max_app_version: z.string().nullable().optional(),
  expires_at: z.string().nullable().optional(),
  dismissible: z.boolean().optional(),
});

admin.post('/notifications', async (c) => {
  const body = createNotificationSchema.parse(await c.req.json());
  const db = await getDb();

  let targetUserId = body.target_user_id ?? null;
  if (!targetUserId && body.target_email) {
    const user = await collections.users(db).findOne({ email: { $regex: `^${escapeRegex(body.target_email)}$`, $options: 'i' } });
    if (!user) return c.json({ error: 'target user not found' }, 404);
    targetUserId = user._id;
  }

  const doc: NotificationDoc = {
    _id: body.id ?? randomUUID(),
    type: body.type,
    subject: body.subject,
    description: body.description,
    priority: body.priority ?? 'normal',
    status: body.status ?? 'active',
    action: body.action ?? null,
    actionUrl: body.action_url ?? null,
    icon: body.icon ?? null,
    targetAudience: body.target_audience ?? 'all',
    targetUserId,
    minAppVersion: body.min_app_version ?? null,
    maxAppVersion: body.max_app_version ?? null,
    dismissible: body.dismissible !== false,
    createdAt: new Date(),
    expiresAt: body.expires_at ? new Date(body.expires_at) : null,
  };
  await collections.notifications(db).insertOne(doc);
  return c.json({ row: toWire(doc) });
});

const patchNotificationBodySchema = z.object({
  id: z.string().uuid(),
  type: z.string().min(1).optional(),
  subject: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  priority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  status: z.enum(['active', 'resolved', 'expired']).optional(),
  action: z.string().nullable().optional(),
  action_url: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  target_audience: z.string().nullable().optional(),
  target_user_id: z.string().uuid().nullable().optional(),
  min_app_version: z.string().nullable().optional(),
  max_app_version: z.string().nullable().optional(),
  expires_at: z.string().nullable().optional(),
  dismissible: z.boolean().optional(),
});

/** snake_case request body -> the camelCase partial Mongo's $set expects. Plain
 * and explicit on purpose — a clever conditional-spread version of this risks
 * inferring a type TypeScript can't cleanly match against the driver's
 * update-filter type; this can't get that wrong. */
function notificationPatchFields(b: z.infer<typeof patchNotificationBodySchema>): Partial<NotificationDoc> {
  const fields: Partial<NotificationDoc> = {};
  if (b.type !== undefined) fields.type = b.type;
  if (b.subject !== undefined) fields.subject = b.subject;
  if (b.description !== undefined) fields.description = b.description;
  if (b.priority !== undefined) fields.priority = b.priority;
  if (b.status !== undefined) fields.status = b.status;
  if (b.action !== undefined) fields.action = b.action;
  if (b.action_url !== undefined) fields.actionUrl = b.action_url;
  if (b.icon !== undefined) fields.icon = b.icon;
  if (b.target_audience !== undefined) fields.targetAudience = b.target_audience;
  if (b.target_user_id !== undefined) fields.targetUserId = b.target_user_id;
  if (b.min_app_version !== undefined) fields.minAppVersion = b.min_app_version;
  if (b.max_app_version !== undefined) fields.maxAppVersion = b.max_app_version;
  if (b.expires_at !== undefined) fields.expiresAt = b.expires_at ? new Date(b.expires_at) : null;
  if (b.dismissible !== undefined) fields.dismissible = b.dismissible;
  return fields;
}

admin.patch('/notifications', async (c) => {
  const body = patchNotificationBodySchema.parse(await c.req.json());
  const fields = notificationPatchFields(body);
  const db = await getDb();
  if (Object.keys(fields).length === 0) return c.json({ error: 'no fields to update' }, 400);

  const result = await collections.notifications(db).findOneAndUpdate(
    { _id: body.id },
    { $set: fields },
    { returnDocument: 'after' },
  );
  if (!result) return c.json({ error: 'not_found' }, 404);
  return c.json({ row: toWire(result) });
});

admin.delete('/notifications', async (c) => {
  const id = c.req.query('id');
  if (!id) return c.json({ error: 'id is required' }, 400);
  const db = await getDb();
  await collections.notifications(db).deleteOne({ _id: id });
  return c.json({ ok: true });
});

export default admin;
