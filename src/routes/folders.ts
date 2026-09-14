import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../db/mongo';
import { collections } from '../db/collections';
import { requireAuth } from '../middleware/auth';

const foldersRoute = new Hono();
foldersRoute.use('*', requireAuth);

foldersRoute.get('/', async (c) => {
  const userId = c.get('userId') as string;
  const db = await getDb();
  const rows = await collections.folders(db).find({ userId }).toArray();
  return c.json(rows);
});

const createFolderSchema = z.object({ name: z.string().min(1).max(200), parentId: z.string().uuid().optional() });

foldersRoute.post('/', async (c) => {
  createFolderSchema.parse(await c.req.json());
  // Still deliberately stubbed, as in the first pass: creating a folder means
  // calling findOrCreateFolder (exported from lib/googleDrive.ts) scoped under
  // the user's "Atomic Notes" root, then inserting the Mongo row here — same
  // shape as notes.ts's POST /notes handler.
  return c.json({ error: 'not_implemented', hint: 'Wire to findOrCreateFolder in lib/googleDrive.ts, same pattern as routes/notes.ts' }, 501);
});

export default foldersRoute;
