import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../db/mongo';
import { collections, type AtomicUserDoc } from '../db/collections';
import { requireAuth } from '../middleware/auth';
import { logEvent } from '../lib/logs';
import {
  EnergyError,
  energyEnsure,
  energyGrantDaily,
  energyConvert,
  energySpend,
  energySpendStandard,
  energyRefund,
  energyHistory,
} from '../lib/energy';

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
        last_daily_grant_at: w.lastDailyGrantAt ? w.lastDailyGrantAt.toISOString() : null,
      }
    : null;
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
  return c.json({ wallet: walletToWire(wallet), history: historyToWire(history) });
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

const spendSchema = z.object({ amount: z.number().int().positive(), reason: z.string().min(1).max(200) });
energy.post('/spend', async (c) => {
  const userId = c.get('userId') as string;
  const db = await getDb();
  const { amount, reason } = spendSchema.parse(await c.req.json());
  try {
    await energySpend(db, userId, amount, reason);
  } catch (e) {
    if (e instanceof EnergyError) await logEvent(db, 'energy_spend_failed', { userId, level: 'warn', meta: { code: e.code, amount, reason } });
    return handleEnergyError(c, e);
  }
  const wallet = await collections.atomicUsers(db).findOne({ _id: userId });
  return c.json({ wallet: walletToWire(wallet) });
});

/** POST /energy/spend-standard — used by the notes sync path, not called directly by the UI. */
energy.post('/spend-standard', async (c) => {
  const userId = c.get('userId') as string;
  const db = await getDb();
  try {
    const charged = await energySpendStandard(db, userId);
    const wallet = await collections.atomicUsers(db).findOne({ _id: userId });
    return c.json({ charged, wallet: walletToWire(wallet) });
  } catch (e) {
    return handleEnergyError(c, e);
  }
});

const refundSchema = z.object({ amount: z.number().int().positive(), reason: z.string().min(1).max(200) });
energy.post('/refund', async (c) => {
  const userId = c.get('userId') as string;
  const db = await getDb();
  const { amount, reason } = refundSchema.parse(await c.req.json());
  await energyRefund(db, userId, amount, reason);
  const wallet = await collections.atomicUsers(db).findOne({ _id: userId });
  return c.json({ wallet: walletToWire(wallet) });
});

export default energy;
