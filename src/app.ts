import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import authRoute from './routes/auth.js';
import notesRoute from './routes/notes.js';
import foldersRoute from './routes/folders.js';
import vaultRoute from './routes/vault.js';
import energyRoute from './routes/energy.js';
import atomicuserRoute from './routes/atomicuser.js';
import adminRoute from './routes/admin.js';
import publicRoute from './routes/public.js';
import { registerErrorHandler } from './middleware/errorHandler.js';

const app = new Hono().basePath('/api');
app.use('*', bodyLimit({ maxSize: 4 * 1024 * 1024, onError: (c) => c.json({ error: 'request_too_large' }, 413) }));

app.use(
  '*',
  cors({
    origin: process.env.ALLOWED_ORIGIN?.split(',').map((origin) => origin.trim()).filter(Boolean) ?? [],
  }),
);

registerErrorHandler(app);

app.get('/health', (c) => c.json({ ok: true }));
app.route('/auth', authRoute);
app.route('/notes', notesRoute);
app.route('/folders', foldersRoute);
app.route('/vault', vaultRoute);
app.route('/energy', energyRoute);
app.route('/atomicuser', atomicuserRoute);
app.route('/admin', adminRoute);
app.route('/public', publicRoute);

export default app;
