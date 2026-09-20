import { z } from 'zod';
import type { Db } from 'mongodb';

// Every schema below is annotated with the real Supabase/Postgres column names
// it replaces (read directly from the live app's lib/database and lib/security
// source — not guessed). Field names here are camelCase/Mongo-idiomatic; the
// comments are the mapping table for whoever eventually touches the Flutter
// client's data layer.

// ---------------------------------------------------------------------------
// users — new in this backend; Supabase auth.users had no equivalent app table
// ---------------------------------------------------------------------------
export const userSchema = z.object({
  _id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type UserDoc = z.infer<typeof userSchema>;

// ---------------------------------------------------------------------------
// google_accounts — new in this backend; holds what auth used to not need to
// think about, because Supabase's own auth.users handled sign-in
// ---------------------------------------------------------------------------
export const googleAccountSchema = z.object({
  _id: z.string().uuid(),
  userId: z.string().uuid(),
  googleAccountId: z.string(),
  encryptedAccessToken: z.string(),
  encryptedRefreshToken: z.string(),
  tokenExpiry: z.date(),
  driveRootFolderId: z.string().nullable(),
  createdAt: z.date(),
});
export type GoogleAccountDoc = z.infer<typeof googleAccountSchema>;

// ---------------------------------------------------------------------------
// sessions — explicitly requested: "store the client session" in MongoDB.
// Replaces the stateless-JWT approach from the first pass of this backend —
// a session that lives in the DB can actually be revoked (logout, "sign out
// other devices"), which a bare JWT can't do without a matching DB anyway.
// The stored token is a SHA-256 hash, not the raw token, so a DB read/leak
// doesn't hand over a live bearer token.
// ---------------------------------------------------------------------------
export const sessionSchema = z.object({
  _id: z.string(), // hex-encoded SHA-256 of the raw session token
  userId: z.string().uuid(),
  createdAt: z.date(),
  expiresAt: z.date(),
  revoked: z.boolean().default(false),
  userAgent: z.string().nullable().optional(),
});
export type SessionDoc = z.infer<typeof sessionSchema>;

// ---------------------------------------------------------------------------
// atomic_users — mirrors the real `atomicuser` table. Confirmed against
// TESTING.md's RLS review (its exact words: "note_limit, coins, energy,
// energy_cap, last_daily_grant_at, last_standard_sync_at have client
// insert/update revoked"), not just inferred from client reads — the
// live app's RLS audit lists the full protected-column set, including two
// this backend's first pass missed entirely:
//
//   Supabase column          -> Mongo field
//   user_id (PK)              -> userId (used as _id here)
//   username                  -> username
//   note_limit                -> noteLimit        (default 20 — see note_quota.dart's
//                                                   freeLimit; per-user override is the
//                                                   hook for a future paid-tier)
//   coins                     -> coins             (new wallet starts at 5, a one-time
//                                                   "welcome gift" per TESTING.md I-3 —
//                                                   NOT 0, which this backend's first
//                                                   pass assumed)
//   energy                    -> energy
//   energy_cap                -> energyCap        (default 120)
//   last_daily_grant_at       -> lastDailyGrantAt
//   last_standard_sync_at     -> lastStandardSyncAt  (this backend's first pass
//                                                      guessed `lastStandardSyncChargeAt`
//                                                      — corrected to the real name)
// ---------------------------------------------------------------------------
export const atomicUserSchema = z.object({
  _id: z.string().uuid(), // == userId
  username: z.string().default(''),
  noteLimit: z.number().int().default(20),
  coins: z.number().int().default(5), // welcome gift, new wallets only
  energy: z.number().int().default(0),
  energyCap: z.number().int().default(120),
  lastDailyGrantAt: z.date().nullable().default(null),
  lastStandardSyncAt: z.date().nullable().default(null),
  createdAt: z.date(), // needed for the Controller dashboard's "new in 7 days" stat — missing in this backend's first pass
});
export type AtomicUserDoc = z.infer<typeof atomicUserSchema>;

// ---------------------------------------------------------------------------
// energy_ledger — mirrors the real `energy_ledger` table exactly, including
// the `kind` check-constraint values (read from EnergyTxKind in
// energy_models.dart). There is no `refund` kind in the live schema — a
// refund is logged as `spend` with a positive energyDelta; see lib/energy.ts.
//
//   Supabase column   -> Mongo field
//   id                 -> _id
//   user_id            -> userId
//   kind               -> kind
//   coins_delta        -> coinsDelta
//   energy_delta       -> energyDelta
//   resulting_coins    -> resultingCoins
//   resulting_energy   -> resultingEnergy
//   note               -> note
//   created_at         -> createdAt
// ---------------------------------------------------------------------------
export const energyTxKind = z.enum(['daily_grant', 'convert', 'spend', 'purchase', 'admin_adjust']);
export const energyLedgerSchema = z.object({
  _id: z.string().uuid(),
  userId: z.string().uuid(),
  kind: energyTxKind,
  coinsDelta: z.number().int(),
  energyDelta: z.number().int(),
  resultingCoins: z.number().int(),
  resultingEnergy: z.number().int(),
  note: z.string().nullable(),
  createdAt: z.date(),
});
export type EnergyLedgerDoc = z.infer<typeof energyLedgerSchema>;

// ---------------------------------------------------------------------------
// vaults — mirrors the real `vault` table exactly (from vault.dart's
// createVault/unlock). No salt column: the salt is
// SHA-256("atomic-notes-vault-v1|<user id>"), computed, never stored — that's
// deliberate in the original design and preserved here. The server NEVER sees
// the recovery phrase or the derived key, only this verifier blob — unlock is
// entirely client-side; see routes/vault.ts.
//
//   Supabase column     -> Mongo field
//   user_id (PK)         -> userId (used as _id here)
//   verifier             -> verifier
//   kdf                  -> kdf            ('argon2id')
//   kdf_memory           -> kdfMemory
//   kdf_iterations       -> kdfIterations
//   kdf_parallelism      -> kdfParallelism
//   enc_v                -> encV
// ---------------------------------------------------------------------------
export const vaultSchema = z.object({
  _id: z.string().uuid(), // == userId
  verifier: z.string(),
  kdf: z.literal('argon2id'),
  kdfMemory: z.number().int(),
  kdfIterations: z.number().int(),
  kdfParallelism: z.number().int(),
  encV: z.number().int(),
  createdAt: z.date(),
});
export type VaultDoc = z.infer<typeof vaultSchema>;

// ---------------------------------------------------------------------------
// notes — mirrors the real `note` table's METADATA columns. title/body/items
// (and the encrypted `payload` when enc_v >= 1) are deliberately NOT stored
// here — per the brief's ownership principle, that content lives in the
// user's Drive as the `.atomic` file (see types/atomicFile.ts). driveFileId/
// driveRevisionId/localVersion/syncStatus are new, added to make that
// Drive linkage possible; everything else is a direct carry-over.
//
//   Supabase column   -> Mongo field
//   id                 -> _id
//   user_id            -> userId
//   kind               -> kind          ('text' | 'todo')
//   pinned             -> pinned
//   deleted            -> deleted        (tombstone)
//   created_at         -> createdAt
//   updated_at         -> updatedAt      (server-set, not client-set — see
//                                         routes/notes.ts)
//   enc_v              -> encV
//   (title/body/items/payload live in Drive, not here)
// ---------------------------------------------------------------------------
export const noteSchema = z.object({
  _id: z.string().uuid(),
  userId: z.string().uuid(),
  folderId: z.string().uuid().nullable(),
  kind: z.enum(['text', 'todo']),
  pinned: z.boolean().default(false),
  deleted: z.boolean().default(false),
  encV: z.union([z.literal(0), z.literal(1)]).default(0),
  driveFileId: z.string(),
  driveRevisionId: z.string().nullable(),
  localVersion: z.number().int().default(1),
  syncSequence: z.number().int().optional(),
  // Fingerprint of the content last written to Drive (see lib/contentHash.ts). Absent on notes written before it existed.
  contentHash: z.string().optional(),
  syncStatus: z.enum(['synced', 'pending', 'conflict', 'error']).default('synced'),
  createdAt: z.date(),
  updatedAt: z.date(),
  lastSyncedAt: z.date().nullable(),
});
export type NoteDoc = z.infer<typeof noteSchema>;

// ---------------------------------------------------------------------------
// folders — no direct Supabase equivalent was found in the live app (it
// appears to be flat/unfoldered today); kept from the original brief for the
// Drive folder-organization feature described there.
// ---------------------------------------------------------------------------
export const folderSchema = z.object({
  _id: z.string().uuid(),
  userId: z.string().uuid(),
  driveFolderId: z.string(),
  name: z.string(),
  parentId: z.string().uuid().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type FolderDoc = z.infer<typeof folderSchema>;

// ---------------------------------------------------------------------------
// logs — explicitly requested. A minimal audit trail, not a full logging
// platform: security/account-relevant events, queryable by user or event type.
// ---------------------------------------------------------------------------
export const logSchema = z.object({
  _id: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  event: z.string(),
  level: z.enum(['info', 'warn', 'error']).default('info'),
  meta: z.record(z.any()).default({}),
  createdAt: z.date(),
});
export type LogDoc = z.infer<typeof logSchema>;

// ---------------------------------------------------------------------------
// notifications — mirrors the real `notifications` table (migrations 008 +
// 012). Global rows the Controller admin panel manages; the app/public site
// only ever reads them, scoped by targetAudience/targetUserId/version range.
// A second `user_notifications` table exists in the real schema for per-user
// read/dismiss state — not built here, notifications-as-a-feature stayed out
// of scope for this migration pass (see the server README).
// ---------------------------------------------------------------------------
export const notificationSchema = z.object({
  _id: z.string().uuid(),
  type: z.string(),
  subject: z.string(),
  description: z.string(),
  priority: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
  status: z.enum(['active', 'resolved', 'expired']).default('active'),
  action: z.string().nullable().default(null),
  actionUrl: z.string().nullable().default(null),
  icon: z.string().nullable().default(null),
  targetAudience: z.string().nullable().default('all'),
  targetUserId: z.string().uuid().nullable().default(null),
  minAppVersion: z.string().nullable().default(null),
  maxAppVersion: z.string().nullable().default(null),
  dismissible: z.boolean().default(true),
  createdAt: z.date(),
  expiresAt: z.date().nullable().default(null),
});
export type NotificationDoc = z.infer<typeof notificationSchema>;

// ---------------------------------------------------------------------------
// Collection getters
// ---------------------------------------------------------------------------
export const collections = {
  users: (db: Db) => db.collection<UserDoc>('users'),
  googleAccounts: (db: Db) => db.collection<GoogleAccountDoc>('google_accounts'),
  sessions: (db: Db) => db.collection<SessionDoc>('sessions'),
  atomicUsers: (db: Db) => db.collection<AtomicUserDoc>('atomic_users'),
  energyLedger: (db: Db) => db.collection<EnergyLedgerDoc>('energy_ledger'),
  vaults: (db: Db) => db.collection<VaultDoc>('vaults'),
  notes: (db: Db) => db.collection<NoteDoc>('notes'),
  folders: (db: Db) => db.collection<FolderDoc>('folders'),
  logs: (db: Db) => db.collection<LogDoc>('logs'),
  notifications: (db: Db) => db.collection<NotificationDoc>('notifications'),
};

/** Call once at startup (or via a one-off script) — indexes are not auto-created. */
export async function ensureIndexes(db: Db) {
  await db.collection("sync_operations").createIndex({ userId: 1, status: 1 });
  // Records only need to outlive the retries of a request; keep them for 30 days.
  await db.collection("sync_operations").createIndex({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
  await db.collection("oauth_states").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection("operation_locks").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await collections.users(db).createIndex({ email: 1 }, { unique: true });
  await collections.googleAccounts(db).createIndex({ googleAccountId: 1 }, { unique: true });
  await collections.googleAccounts(db).createIndex({ userId: 1 });
  await collections.sessions(db).createIndex({ userId: 1 });
  await collections.sessions(db).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL cleanup
  await collections.energyLedger(db).createIndex({ userId: 1, createdAt: -1 });
  await collections.notes(db).createIndex({ userId: 1, deleted: 1 });
  await collections.notes(db).createIndex({ userId: 1, updatedAt: 1 });
  await collections.notes(db).createIndex({ userId: 1, syncSequence: 1 });
  // A deleted note's row (a tombstone) is only needed until every device has seen the deletion, and its
  // Drive file leaves the Drive trash after 30 days. The partial filter keeps live notes out of the index.
  await collections.notes(db).createIndex({ updatedAt: 1 }, { name: 'tombstone_ttl', expireAfterSeconds: 30 * 24 * 60 * 60, partialFilterExpression: { deleted: true } });
  await collections.sessions(db).createIndex({ userId: 1, createdAt: -1 });
  await collections.folders(db).createIndex({ userId: 1 });
  await collections.logs(db).createIndex({ userId: 1, createdAt: -1 });
  await collections.notifications(db).createIndex({ status: 1, createdAt: -1 });
  await collections.notifications(db).createIndex({ targetUserId: 1 });
}
