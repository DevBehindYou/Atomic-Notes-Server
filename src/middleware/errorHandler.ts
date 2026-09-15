import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';

export function registerErrorHandler(app: Hono) {
  app.onError((err, c) => {
    if (err instanceof ZodError) return c.json({ error: 'invalid_request', issues: err.issues.map(({ path, message }) => ({ path, message })) }, 400);
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof SyntaxError) return c.json({ error: 'invalid_json' }, 400);
    // eslint-disable-next-line no-console
    console.error(err);
    if ((err as { status?: number }).status === 409) return c.json({ error: err.message }, 409);
    return c.json({ error: 'internal_error' }, 500);
  });
}
