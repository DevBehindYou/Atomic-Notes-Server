import { closeDb, getDb } from '../db/mongo.js';
import { collections } from '../db/collections.js';

/**
 * Read-only view of one account's server-side state, for checking a real-device test.
 * Usage: npm run db:inspect -- someone@example.com
 * Prints ids, counts, timestamps and event names. Never prints tokens, verifiers or note content.
 */
const email = process.argv[2]?.trim();
const db = await getDb();

if (!email) {
  const [users, sessions, notes, operations] = await Promise.all([
    collections.users(db).countDocuments({}),
    collections.sessions(db).countDocuments({ revoked: false, expiresAt: { $gt: new Date() } }),
    collections.notes(db).countDocuments({}),
    db.collection('sync_operations').countDocuments({}),
  ]);
  console.log({ database: db.databaseName, users, activeSessions: sessions, notes, syncOperations: operations });
  console.log('Pass an email to inspect one account: npm run db:inspect -- someone@example.com');
} else {
  const user = await collections.users(db).findOne({ email: email.toLowerCase() });
  if (!user) {
    console.log(`No user with email ${email}`);
  } else {
    const userId = user._id;
    const account = await collections.googleAccounts(db).findOne({ userId });
    const wallet = await collections.atomicUsers(db).findOne({ _id: userId });
    const noteCounts = await collections.notes(db).aggregate<{ _id: boolean; n: number }>([
      { $match: { userId } }, { $group: { _id: '$deleted', n: { $sum: 1 } } },
    ]).toArray();
    const operations = await db.collection<{ _id: string; mode: string; status: string; charged: number; refunded: number; results: { ok: boolean }[]; createdAt: Date }>('sync_operations')
      .find({ userId }).sort({ createdAt: -1 }).limit(5).toArray();
    const ledger = await collections.energyLedger(db).find({ userId }).sort({ createdAt: -1 }).limit(8).toArray();
    const logs = await collections.logs(db).find({ userId }).sort({ createdAt: -1 }).limit(10).toArray();
    const sessions = await collections.sessions(db).find({ userId }).sort({ createdAt: -1 }).limit(3).toArray();
    const vault = await collections.vaults(db).findOne({ _id: userId });

    console.log('user', { id: userId, email: user.email, createdAt: user.createdAt });
    console.log('google account', account ? {
      linked: true, driveFolderId: account.driveRootFolderId, tokenExpiry: account.tokenExpiry,
      tokensStoredEncrypted: !account.encryptedRefreshToken.includes('ya29') && account.encryptedRefreshToken.split('.').length === 3,
    } : 'none');
    console.log('wallet', wallet ? {
      coins: wallet.coins, energy: wallet.energy, energyCap: wallet.energyCap, noteLimit: wallet.noteLimit,
      lastDailyGrantAt: wallet.lastDailyGrantAt, lastStandardSyncAt: wallet.lastStandardSyncAt,
    } : 'none');
    console.log('notes', { active: noteCounts.find((c) => c._id === false)?.n ?? 0, deleted: noteCounts.find((c) => c._id === true)?.n ?? 0 });
    console.log('vault', vault ? { exists: true, createdAt: vault.createdAt } : { exists: false });
    console.log('sessions (newest first)', sessions.map((s) => ({ createdAt: s.createdAt, expiresAt: s.expiresAt, revoked: s.revoked })));
    console.log('sync operations (newest first)', operations.map((o) => ({
      status: o.status, mode: o.mode, charged: o.charged, refunded: o.refunded,
      rows: o.results.length, ok: o.results.filter((r) => r.ok).length, createdAt: o.createdAt,
    })));
    console.log('energy ledger (newest first)', ledger.map((l) => ({ kind: l.kind, coins: l.coinsDelta, energy: l.energyDelta, note: l.note, at: l.createdAt })));
    console.log('recent events', logs.map((l) => `${l.createdAt.toISOString()} ${l.level} ${l.event}`));
  }
}

await closeDb();
process.exit(0);
