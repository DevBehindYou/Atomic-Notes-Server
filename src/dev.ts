import { serve } from '@hono/node-server';
import app from './app.js';

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
// eslint-disable-next-line no-console
console.log(`Atomic Notes API running locally on http://localhost:${port}`);
