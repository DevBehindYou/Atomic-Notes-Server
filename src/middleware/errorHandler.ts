import type { Hono } from 'hono';

export function registerErrorHandler(app: Hono) {
  app.onError((err, c) => {
    // eslint-disable-next-line no-console
    console.error(err);
    const status = (err as { status?: number }).status ?? 500;
    return c.json({ error: 'internal_error', message: err.message }, status as 500);
  });
}
