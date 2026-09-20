import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import { isInvalidGrant } from '../lib/googleOAuth.js';

export function registerErrorHandler(app: Hono) {
  app.onError((err, c) => {
    if (err instanceof ZodError) return c.json({ error: 'invalid_request', issues: err.issues.map(({ path, message }) => ({ path, message })) }, 400);
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof SyntaxError) return c.json({ error: 'invalid_json' }, 400);
    // Google refused the stored grant while a request was using it (revoked, or expired in Testing).
    if (isInvalidGrant(err)) return c.json({ error: 'google_reauth_required' }, 401);
    const known = err as { status?: number; expose?: boolean; details?: Record<string, unknown> };
    // Only our own errors (httpError) may show their code; Google client errors also carry a status.
    // These are expected refusals (a cooldown, a limit), not failures, so they leave no stack in the log.
    if (known.expose === true && (known.status === 401 || known.status === 409 || known.status === 429)) {
      const wait = known.details?.retry_after_seconds;
      if (known.status === 429 && typeof wait === 'number') c.header('Retry-After', String(wait));
      return c.json({ error: err.message, ...(known.details ?? {}) }, known.status);
    }
    // The stack only, never the error object: a Google client error carries the request, including
    // an Authorization header with a bearer token, and this output goes to the hosting log.
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? (err.stack ?? err.message) : 'non-Error thrown');
    if (known.status === 409) return c.json({ error: err.message }, 409);
    return c.json({ error: 'internal_error' }, 500);
  });
}
