import { getDb } from '../db/mongo';
import { ensureIndexes } from '../db/collections';

const db = await getDb();
await ensureIndexes(db);
// eslint-disable-next-line no-console
console.log('Indexes ensured.');
process.exit(0);
