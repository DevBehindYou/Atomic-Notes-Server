import { getDb } from '../db/mongo.js';
import { ensureIndexes } from '../db/collections.js';

const db = await getDb();
await ensureIndexes(db);
// eslint-disable-next-line no-console
console.log('Indexes ensured.');
process.exit(0);
