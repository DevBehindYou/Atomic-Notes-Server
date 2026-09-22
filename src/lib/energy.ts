import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { collections, type AtomicUserDoc } from '../db/collections.js';
import { withTransaction } from '../db/mongo.js';

/**
 * Ported from the real Postgres SQL (supabase/migrations/006_energy.sql,
 * 007_hourly_standard_sync.sql, 009_energy_refund.sql — read directly, not
 * reconstructed from call sites this time) to Node + MongoDB transactions in
 * place of SECURITY DEFINER functions. Three real discrepancies from this
 * file's earlier call-site-only reconstruction were caught and fixed once
 * the actual SQL was available: `energy_ensure` wasn't logging the 5-coin
 * welcome gift to the ledger at all; `energy_spend_standard`'s free-window
 * branch was advancing `last_standard_sync_at` when the real function
 * touches nothing on a free call (a bug that would have let a user sync free
 * indefinitely by syncing at least once an hour); and `energy_refund` used
 * `kind: 'spend'` where the real schema uses `kind: 'admin_adjust'` for any
 * server/operator-driven balance change, refunds included.
 *
 * Error codes are kept as the exact strings the Flutter client already
 * checks for (see EnergyService._friendly in the live app), so that if the
 * client is ever pointed at this API instead of Supabase, only the
 * transport (exception message -> HTTP error body) needs to change, not the
 * set of strings it's matching against.
 */

export const ENERGY = {
  coinToEnergy: 40,
  dailyGrant: 20,
  syncStandardCost: 5,
  syncInstantCost: 10,
  defaultEnergyCap: 120,
  /** A standard sync may start at most once per interval, by the Server's clock. Instant sync has no interval. */
  standardSyncIntervalMs: 60 * 60 * 1000, // 1 hour
  dailyGrantWindowMs: 24 * 60 * 60 * 1000, // 24 hours
} as const;

export interface NoteLimitTier {
  /** The note limit this tier grants. */
  readonly limit: number;
  /** Shown to the user; matches no other identifier. */
  readonly name: string;
  /** Coins to reach this tier from the one before it. 0 for the free starting tier. */
  readonly costCoins: number;
}

/**
 * How many notes an account may hold. Every account starts at the first tier. Each later tier costs
 * its own [costCoins] to reach from the one before it — not a flat per-step price, since the last
 * tier is a much bigger jump than the others. No purchase goes past the last tier's [limit].
 */
export const NOTE_LIMIT_TIERS: readonly NoteLimitTier[] = [
  { limit: 20, name: 'Tachyon', costCoins: 0 },
  { limit: 30, name: 'God', costCoins: 10 },
  { limit: 40, name: 'Antimatter', costCoins: 10 },
  { limit: 50, name: 'Monopole', costCoins: 10 },
  { limit: 100, name: 'Strangelet', costCoins: 50 },
] as const;

export const NOTE_LIMIT = {
  free: NOTE_LIMIT_TIERS[0].limit,
  ceiling: NOTE_LIMIT_TIERS[NOTE_LIMIT_TIERS.length - 1].limit,
} as const;

export class EnergyError extends Error {
  readonly status = 409;
  code: 'insufficient_coins' | 'insufficient_energy' | 'energy_cap_exceeded' | 'invalid_amount' | 'note_limit_ceiling';
  constructor(code: EnergyError['code']) {
    super(code);
    this.code = code;
  }
}

async function getOrInitWallet(db: Db, userId: string): Promise<AtomicUserDoc> {
  const col = collections.atomicUsers(db);
  const existing = await col.findOne({ _id: userId });
  if (existing) return existing;

  const fresh: AtomicUserDoc = {
    _id: userId,
    username: '',
    noteLimit: NOTE_LIMIT.free,
    coins: 5, // welcome gift — new wallets only, confirmed against the real SQL (006_energy.sql's energy_ensure)
    energy: 0,
    energyCap: ENERGY.defaultEnergyCap,
    lastDailyGrantAt: null,
    lastStandardSyncAt: null,
    createdAt: new Date(),
  };

  // Transactional: the wallet row and its "Welcome gift" ledger entry appear
  // together or not at all, matching the real SQL (energy_ensure inserts
  // both inside one function). Upsert rather than insert: two concurrent
  // first-calls (e.g. energy_ensure racing a note sync on login) must not
  // throw a duplicate-key error — only whichever one actually inserts writes
  // the ledger entry.
  await withTransaction(async (session) => {
    const result = await col.updateOne({ _id: userId }, { $setOnInsert: fresh }, { upsert: true, session });
    if (result.upsertedCount > 0) {
      await writeLedger(db, session, {
        userId,
        kind: 'admin_adjust',
        coinsDelta: 5,
        energyDelta: 0,
        resultingCoins: 5,
        resultingEnergy: 0,
        note: 'Welcome gift: 5 Atomic Coins',
      });
    }
  });

  return (await col.findOne({ _id: userId }))!;
}

/** The wallet, created with its welcome gift if missing. One read when it already exists. */
export const energyWallet = getOrInitWallet;

/** True when the rolling 24 hours since the last daily grant have passed. */
export const dailyGrantDue = (wallet: AtomicUserDoc, now = new Date()) =>
  wallet.lastDailyGrantAt === null || wallet.lastDailyGrantAt.getTime() <= now.getTime() - ENERGY.dailyGrantWindowMs;

/** energy_ensure — idempotent wallet init. Safe to call as often as needed. */
export async function energyEnsure(db: Db, userId: string): Promise<void> {
  await getOrInitWallet(db, userId);
}

async function writeLedger(
  db: Db,
  session: import('mongodb').ClientSession,
  entry: {
    userId: string;
    kind: 'daily_grant' | 'convert' | 'spend' | 'purchase' | 'admin_adjust';
    coinsDelta: number;
    energyDelta: number;
    resultingCoins: number;
    resultingEnergy: number;
    note: string | null;
  },
) {
  await collections.energyLedger(db).insertOne(
    { _id: randomUUID(), createdAt: new Date(), ...entry },
    { session },
  );
}

/** energy_grant_daily — +20 energy once per rolling 24h, server-clock-enforced. */
export async function energyGrantDaily(db: Db, userId: string): Promise<void> {
  await getOrInitWallet(db, userId);
  await withTransaction(async (session) => {
    const col = collections.atomicUsers(db);
    const now = new Date();
    const cutoff = new Date(now.getTime() - ENERGY.dailyGrantWindowMs);

    const wallet = await col.findOne(
      { _id: userId, $or: [{ lastDailyGrantAt: null }, { lastDailyGrantAt: { $lte: cutoff } }] },
      { session },
    );
    // No matching document -> already granted within the last 24h -> silent
    // no-op, matching the live app's fire-and-forget call on every launch.
    if (!wallet) return;

    const actualDelta = Math.max(0, Math.min(ENERGY.dailyGrant, wallet.energyCap - wallet.energy));

    // Re-assert the eligibility window in the filter, not just the read above,
    // so a concurrent grant (two devices opening at once) can't double-apply —
    // MongoDB detects the write conflict between the two transactions either way,
    // but this keeps the guard explicit rather than relying only on that.
    const updated = await col.findOneAndUpdate(
      { _id: userId, $or: [{ lastDailyGrantAt: null }, { lastDailyGrantAt: { $lte: cutoff } }] },
      { $inc: { energy: actualDelta }, $set: { lastDailyGrantAt: now } },
      { returnDocument: 'after', session },
    );
    if (!updated || actualDelta === 0) return;

    await writeLedger(db, session, {
      userId,
      kind: 'daily_grant',
      coinsDelta: 0,
      energyDelta: actualDelta,
      resultingCoins: updated.coins,
      resultingEnergy: updated.energy,
      note: 'Daily energy grant',
    });
  });
}

/** energy_convert — coins -> energy at 40:1. Hard-rejects if it would exceed the cap. */
export async function energyConvert(db: Db, userId: string, coins: number): Promise<void> {
  if (!Number.isInteger(coins) || coins <= 0) throw new EnergyError('invalid_amount');
  await getOrInitWallet(db, userId);

  await withTransaction(async (session) => {
    const col = collections.atomicUsers(db);
    const wallet = await col.findOne({ _id: userId }, { session });
    if (!wallet) throw new EnergyError('invalid_amount');

    if (wallet.coins < coins) throw new EnergyError('insufficient_coins');
    const energyGain = coins * ENERGY.coinToEnergy;
    if (wallet.energy + energyGain > wallet.energyCap) throw new EnergyError('energy_cap_exceeded');

    const updated = await col.findOneAndUpdate(
      { _id: userId, coins: { $gte: coins } }, // re-check under the transaction
      { $inc: { coins: -coins, energy: energyGain } },
      { returnDocument: 'after', session },
    );
    if (!updated) throw new EnergyError('insufficient_coins');

    await writeLedger(db, session, {
      userId,
      kind: 'convert',
      coinsDelta: -coins,
      energyDelta: energyGain,
      resultingCoins: updated.coins,
      resultingEnergy: updated.energy,
      note: `Converted ${coins} coins`,
    });
  });
}

/**
 * Buys the next step of note capacity with coins. [fromLimit] is the limit the caller saw, so the call is
 * safe to repeat: when the limit has already moved past it, the purchase went through and the wallet is
 * returned unchanged instead of charging a second time.
 */
export async function energyUpgradeNoteLimit(db: Db, userId: string, fromLimit: number): Promise<AtomicUserDoc> {
  if (!Number.isInteger(fromLimit) || fromLimit < 0) throw new EnergyError('invalid_amount');
  await getOrInitWallet(db, userId);

  return withTransaction(async (session) => {
    const col = collections.atomicUsers(db);
    const wallet = (await col.findOne({ _id: userId }, { session }))!;
    if (wallet.noteLimit > fromLimit) return wallet;
    if (wallet.noteLimit < fromLimit) throw new EnergyError('invalid_amount');

    const tierIndex = NOTE_LIMIT_TIERS.findIndex((t) => t.limit === wallet.noteLimit);
    const nextTier = tierIndex >= 0 ? NOTE_LIMIT_TIERS[tierIndex + 1] : undefined;
    if (!nextTier) throw new EnergyError('note_limit_ceiling');
    if (wallet.coins < nextTier.costCoins) throw new EnergyError('insufficient_coins');

    const updated = await col.findOneAndUpdate(
      { _id: userId, noteLimit: fromLimit, coins: { $gte: nextTier.costCoins } }, // re-check under the transaction
      { $inc: { coins: -nextTier.costCoins }, $set: { noteLimit: nextTier.limit } },
      { returnDocument: 'after', session },
    );
    if (!updated) throw new EnergyError('insufficient_coins');

    await writeLedger(db, session, {
      userId,
      kind: 'purchase',
      coinsDelta: -nextTier.costCoins,
      energyDelta: 0,
      resultingCoins: updated.coins,
      resultingEnergy: updated.energy,
      note: `Note limit ${fromLimit} to ${nextTier.limit} (${nextTier.name})`,
    });
    return updated;
  });
}

/**
 * energy_refund — reverses a charge that couldn't be delivered (e.g. sync
 * upload failed after energy was already spent). No `refund` kind exists in
 * the live schema's check constraint (daily_grant/convert/spend/purchase/
 * admin_adjust only) — logged as `spend` with a positive delta, same
 * convention a refund would need under that constraint.
 */
export async function energyRefund(db: Db, userId: string, amount: number, reason: string): Promise<void> {
  if (!Number.isInteger(amount) || amount <= 0) return; // no-op, matches the live client's guard
  await getOrInitWallet(db, userId);

  await withTransaction(async (session) => {
    const col = collections.atomicUsers(db);
    const wallet = await col.findOne({ _id: userId }, { session });
    if (!wallet) return;

    const actualDelta = Math.max(0, Math.min(amount, wallet.energyCap - wallet.energy));
    if (actualDelta === 0) return; // already at cap — nothing to credit

    const updated = await col.findOneAndUpdate(
      { _id: userId },
      { $inc: { energy: actualDelta } },
      { returnDocument: 'after', session },
    );
    if (!updated) return;

    await writeLedger(db, session, {
      userId,
      kind: 'admin_adjust', // confirmed against the real SQL (009_energy_refund.sql) — not 'spend', this backend's first-pass guess
      coinsDelta: 0,
      energyDelta: actualDelta,
      resultingCoins: updated.coins,
      resultingEnergy: updated.energy,
      note: `Refund: ${reason}`,
    });
  });
}

export async function energyHistory(db: Db, userId: string, limit = 200) {
  return collections
    .energyLedger(db)
    .find({ userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}
