import { MongoClient, type Db } from 'mongodb';
import { mongoCommands } from '../lib/perf.js';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME ?? 'atomic_notes';
if (!uri) throw new Error('MONGODB_URI is not set');

// One client, reused across invocations. On Vercel this module-level client is
// cached per warm serverless instance — do NOT call `new MongoClient()` inside
// a request handler, that would open a fresh connection on every request.
const client = new MongoClient(uri, {
  maxPoolSize: 10,
  monitorCommands: true,
});
client.on('commandStarted', () => { mongoCommands.started++; });

let connected = false;
async function ensureConnected() {
  if (!connected) {
    await client.connect();
    connected = true;
  }
}

export async function getDb(): Promise<Db> {
  await ensureConnected();
  return client.db(dbName);
}

/** Release the process-owned pool for scripts and test teardown. */
export async function closeDb(): Promise<void> {
  await client.close();
  connected = false;
}

/**
 * Runs `fn` inside a MongoDB multi-document transaction. Requires the cluster
 * to be a replica set (Atlas gives you this by default; a bare standalone
 * `mongod` does not support transactions at all and this will throw).
 *
 * Used for the Energy mutations, which touch both `atomic_users` (the wallet)
 * and `energy_ledger` (the audit trail) and need to succeed or fail together —
 * this is the Node-side replacement for what a Postgres SECURITY DEFINER
 * function got for free from being one transaction on the server.
 */
export async function withTransaction<T>(fn: (session: import('mongodb').ClientSession) => Promise<T>): Promise<T> {
  await ensureConnected();
  const session = client.startSession();
  try {
    let result: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result!;
  } finally {
    await session.endSession();
  }
}
