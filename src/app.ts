import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import authRoute from './routes/auth';
import notesRoute from './routes/notes';
import foldersRoute from './routes/folders';
import vaultRoute from './routes/vault';
import energyRoute from './routes/energy';
import atomicuserRoute from './routes/atomicuser';
import adminRoute from './routes/admin';
import publicRoute from './routes/public';
import { registerErrorHandler } from './middleware/errorHandler';

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
