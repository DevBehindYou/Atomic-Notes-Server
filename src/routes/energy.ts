import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../db/mongo.js';
import { collections, type AtomicUserDoc } from '../db/collections.js';
import { requireAuth } from '../middleware/auth.js';
import {
  ENERGY,
  EnergyError,
  NOTE_LIMIT,
  NOTE_LIMIT_TIERS,
  energyEnsure,
  energyGrantDaily,
  energyConvert,
  energyUpgradeNoteLimit,
  energyHistory,
} from '../lib/energy.js';

const energy = new Hono();
energy.use('*', requireAuth);

function handleEnergyError(c: import('hono').Context, e: unknown) {
  if (e instanceof EnergyError) return c.json({ error: e.code }, 409);
  throw e;
}

/**
 * The live Flutter client's Wallet.fromMap/EnergyTx.fromMap (energy_models.dart)
 * read snake_case keys — a direct carry-over from when they read Supabase rows
 * directly. Internal storage here is camelCase (see db/collections.ts); these
 * two functions are the wire-format translation, same pattern as notes'
 * push/pull toWireRow. Getting this wrong doesn't throw — it silently shows
 * wrong numbers (energyCap always falling back to 120, every ledger delta
 * reading as 0), which is worse than an error, so keep this in sync with
 * energy_models.dart if either side's shape changes.
 */
function walletToWire(w: AtomicUserDoc | null) {
  return w
    ? {
        coins: w.coins,
        energy: w.energy,
        energy_cap: w.energyCap,
        note_limit: w.noteLimit,
        last_daily_grant_at: w.lastDailyGrantAt ? w.lastDailyGrantAt.toISOString() : null,
      }
    : null;
}

/** The prices and ceilings, so the App shows what the Server enforces instead of a copy that can drift. */
function limitsToWire() {
  return {
    note_limit_free: NOTE_LIMIT.free,
    note_limit_ceiling: NOTE_LIMIT.ceiling,
    note_limit_tiers: NOTE_LIMIT_TIERS.map((t) => ({
      limit: t.limit,
      name: t.name,
      cost_coins: t.costCoins,
    })),
    sync_standard_cost: ENERGY.syncStandardCost,
    sync_instant_cost: ENERGY.syncInstantCost,
    sync_standard_interval_seconds: ENERGY.standardSyncIntervalMs / 1000,
  };
}

function historyToWire(rows: Awaited<ReturnType<typeof energyHistory>>) {
  return rows.map((r) => ({
    id: r._id,
    kind: r.kind,
    coins_delta: r.coinsDelta,
    energy_delta: r.energyDelta,
    resulting_coins: r.resultingCoins,
    resulting_energy: r.resultingEnergy,
    note: r.note,
    created_at: r.createdAt.toISOString(),
  }));
}

/** GET /energy — wallet + recent ledger, mirroring EnergyService.refresh() in the live app. */
energy.get('/', async (c) => {
  const userId = c.get('userId') as string;
  const db = await getDb();
  await energyEnsure(db, userId);
  await energyGrantDaily(db, userId);

  const wallet = await collections.atomicUsers(db).findOne({ _id: userId });
  const history = await energyHistory(db, userId);
  return c.json({ wallet: walletToWire(wallet), history: historyToWire(history), limits: limitsToWire() });
});

const convertSchema = z.object({ coins: z.number().int().positive() });
energy.post('/convert', async (c) => {
  const userId = c.get('userId') as string;
  const db = await getDb();
  const { coins } = convertSchema.parse(await c.req.json());
  try {
    await energyConvert(db, userId, coins);
  } catch (e) {
    return handleEnergyError(c, e);
  }
  const wallet = await collections.atomicUsers(db).findOne({ _id: userId });
  return c.json({ wallet: walletToWire(wallet) });
});

/**
 * POST /energy/note-limit — buys the next tier of note capacity with coins, up to the ceiling.
 * [from_limit] is the limit the App showed, which makes a repeated call harmless.
 */
const noteLimitSchema = z.object({ from_limit: z.number().int().nonnegative() });
energy.post('/note-limit', async (c) => {
  const userId = c.get('userId') as string;
  const db = await getDb();
  const { from_limit } = noteLimitSchema.parse(await c.req.json());
  try {
    const wallet = await energyUpgradeNoteLimit(db, userId, from_limit);
    return c.json({ wallet: walletToWire(wallet), limits: limitsToWire() });
  } catch (e) {
    return handleEnergyError(c, e);
  }
});

// Charging is done by the Server when a sync runs. A client can neither spend nor refund energy itself.
energy.post('/spend', (c) => c.json({ error: 'client_spending_disabled' }, 410));
energy.post('/spend-standard', (c) => c.json({ error: 'client_spending_disabled' }, 410));
// Refunds are performed only by the Server when a recorded sync fails.
energy.post('/refund', (c) => c.json({ error: 'client_refunds_disabled' }, 410));

export default energy;
