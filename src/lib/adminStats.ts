import type { Db } from 'mongodb';
import { collections } from '../db/collections.js';

/**
 * Direct port of supabase/migrations/011_controller_stats.sql's
 * `controller_stats()` — read from the actual SQL, not reconstructed. Same
 * field names (snake_case, matching the Controller UI's existing
 * expectations) and the same definitions, including the "active_24h is a
 * proxy via the daily energy grant, there is no telemetry" reasoning from
 * that migration's own comment.
 *
 * Postgres computed all of this in one round trip via subqueries; Mongo has
 * no equivalent single-query shape as clean, so this runs the equivalent
 * queries in parallel instead. Fine for an admin dashboard — not a hot path.
 */
export async function computeControllerStats(db: Db) {
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    totalUsers,
    active24h,
    new7d,
    totalNotes,
    vaults,
    walletTotals,
    activeNotifications,
    tx24h,
    coinsGranted24h,
    energySpent24h,
    ledgerByKindRows,
  ] = await Promise.all([
    collections.atomicUsers(db).countDocuments({}),
    collections.atomicUsers(db).countDocuments({ lastDailyGrantAt: { $gte: cutoff24h } }),
    collections.atomicUsers(db).countDocuments({ createdAt: { $gte: cutoff7d } }),
    collections.notes(db).countDocuments({ deleted: false }),
    collections.vaults(db).countDocuments({}),
    collections
      .atomicUsers(db)
      .aggregate<{ coins: number; energy: number }>([
        { $group: { _id: null, coins: { $sum: '$coins' }, energy: { $sum: '$energy' } } },
      ])
      .toArray(),
    collections.notifications(db).countDocuments({ status: 'active' }),
    collections.energyLedger(db).countDocuments({ createdAt: { $gte: cutoff24h } }),
    collections
      .energyLedger(db)
      .aggregate<{ total: number }>([
        { $match: { createdAt: { $gte: cutoff24h }, coinsDelta: { $gt: 0 } } },
        { $group: { _id: null, total: { $sum: '$coinsDelta' } } },
      ])
      .toArray(),
    collections
      .energyLedger(db)
      .aggregate<{ total: number }>([
        { $match: { createdAt: { $gte: cutoff24h }, energyDelta: { $lt: 0 } } },
        { $group: { _id: null, total: { $sum: '$energyDelta' } } },
      ])
      .toArray(),
    collections
      .energyLedger(db)
      .aggregate<{ _id: string; count: number }>([{ $group: { _id: '$kind', count: { $sum: 1 } } }])
      .toArray(),
  ]);

  const ledgerByKind: Record<string, number> = {};
  for (const row of ledgerByKindRows) ledgerByKind[row._id] = row.count;

  return {
    total_users: totalUsers,
    active_24h: active24h,
    new_7d: new7d,
    total_notes: totalNotes,
    vaults,
    coins_circulating: walletTotals[0]?.coins ?? 0,
    energy_outstanding: walletTotals[0]?.energy ?? 0,
    active_notifications: activeNotifications,
    tx_24h: tx24h,
    coins_granted_24h: coinsGranted24h[0]?.total ?? 0,
    energy_spent_24h: -(energySpent24h[0]?.total ?? 0), // stored negative; SQL negates the same way
    ledger_by_kind: ledgerByKind,
  };
}
