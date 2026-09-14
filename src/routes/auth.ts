import { Hono } from 'hono';
import { z } from 'zod';
import crypto, { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import type { Credentials, OAuth2Client } from 'google-auth-library';
import { getDb } from '../db/mongo';
import { collections } from '../db/collections';
import { getAuthUrl, getOAuthClient, getOAuthClientForServerAuthCode } from '../lib/googleOAuth';
import { ensureAppFolders } from '../lib/googleDrive';
import { encryptToken } from '../lib/crypto';
import { createSession, revokeSession } from '../lib/session';
import { logEvent } from '../lib/logs';
import { requireAuth } from '../middleware/auth';

const auth = new Hono();

/**
 * Shared by both login paths (web redirect and native mobile) once each has
 * its own way of getting a `code`/`serverAuthCode` exchanged into tokens.
 * Everything downstream of "we have tokens + a verified id_token" is
 * identical, so it lives once here instead of twice, with the two routes
 * differing only in how they get to this point.
 */
async function completeGoogleLogin(
  db: Db,
  client: OAuth2Client,
  tokens: Credentials,
  userAgent: string | null | undefined,
) {
  if (!tokens.access_token || !tokens.refresh_token || !tokens.id_token) {
    return {
      error: 'incomplete_token_response' as const,
      hint:
        'Missing refresh_token almost always means the user already granted consent once before. ' +
        'The web flow sends prompt=consent to avoid this on first login; the mobile flow needs ' +
        '`google_sign_in` configured with forceCodeForRefreshToken: true. Either way, if it still ' +
        'happens, have the user revoke access at https://myaccount.google.com/permissions and retry.',
    };
  }

  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID! });
  const payload = ticket.getPayload();
  if (!payload?.email || !payload.sub) return { error: 'invalid_id_token' as const };

  const googleAccountId = payload.sub;
  const email = payload.email;
  const now = new Date();

  let user = await collections.users(db).findOne({ email });
  if (!user) {
    user = { _id: randomUUID(), email, displayName: payload.name ?? null, createdAt: now, updatedAt: now };
    await collections.users(db).insertOne(user);
  }

  const tokenExpiry = new Date(tokens.expiry_date ?? Date.now() + 3600_000);
  const existingAccount = await collections.googleAccounts(db).findOne({ googleAccountId });

  if (existingAccount) {
    await collections.googleAccounts(db).updateOne(
      { googleAccountId },
      {
        $set: {
          encryptedAccessToken: encryptToken(tokens.access_token),
          encryptedRefreshToken: encryptToken(tokens.refresh_token),
          tokenExpiry,
        },
      },
    );
  } else {
    await collections.googleAccounts(db).insertOne({
      _id: randomUUID(),
      userId: user._id,
      googleAccountId,
      encryptedAccessToken: encryptToken(tokens.access_token),
      encryptedRefreshToken: encryptToken(tokens.refresh_token),
      tokenExpiry,
      driveRootFolderId: null,
      createdAt: now,
    });

    // Only set up the Drive folder structure on first connect, not every login.
    const folderIds = await ensureAppFolders(tokens.access_token, tokens.refresh_token);
    await collections.googleAccounts(db).updateOne(
      { googleAccountId },
      { $set: { driveRootFolderId: folderIds.notesId } },
    );
  }

  const sessionToken = await createSession(db, user._id, userAgent);
  await logEvent(db, 'login', { userId: user._id, meta: { via: existingAccount ? 'google_return' : 'google_first' } });

  return { token: sessionToken, user: { id: user._id, email: user.email } };
}

// ---------------------------------------------------------------------------
// Web redirect flow — kept for completeness/testing from a browser. The
// Flutter app should use POST /google/mobile below instead; a redirect-based
// OAuth flow inside a mobile app means a webview or custom-tab plus deep
// link handling, real friction native sign-in avoids entirely.
// ---------------------------------------------------------------------------
auth.get('/google', (c) => {
  const state = crypto.randomBytes(16).toString('hex');
  // TODO before production: persist `state` and verify it on /callback —
  // CSRF protection on the OAuth flow, not optional at launch.
  return c.redirect(getAuthUrl(state));
});

auth.get('/callback', async (c) => {
  const code = c.req.query('code');
  if (!code) return c.json({ error: 'missing_code' }, 400);

  const db = await getDb();
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);

  const result = await completeGoogleLogin(db, client, tokens, c.req.header('user-agent'));
  if ('error' in result) return c.json(result, 400);

  // Swap for a redirect into the Flutter app's custom URL scheme if this
  // path is ever used from a mobile browser tab instead of the app.
  return c.json(result);
});

// ---------------------------------------------------------------------------
// Native mobile flow. Client-side: `google_sign_in` configured with
// `serverClientId: <this project's WEB OAuth client ID>` (a second OAuth
// client, type "Web application", registered alongside the app's own —
// `google_sign_in` needs one to request offline server access even though
// the app itself signs in with its native/Android/iOS client) and
// `scopes: ['email', 'https://www.googleapis.com/auth/drive.file']`. After
// `signIn()`, `googleSignInAccount.serverAuthCode` is what gets POSTed here.
// ---------------------------------------------------------------------------
const mobileLoginSchema = z.object({ serverAuthCode: z.string().min(1) });

auth.post('/google/mobile', async (c) => {
  const { serverAuthCode } = mobileLoginSchema.parse(await c.req.json());
  const db = await getDb();
  const client = getOAuthClientForServerAuthCode();

  let tokens: Credentials;
  try {
    ({ tokens } = await client.getToken(serverAuthCode));
  } catch (e) {
    return c.json(
      {
        error: 'code_exchange_failed',
        hint:
          'Usually means the serverAuthCode was already used (they are single-use) or the ' +
          "server's GOOGLE_CLIENT_ID/SECRET don't match the serverClientId the app requested.",
      },
      400,
    );
  }

  const result = await completeGoogleLogin(db, client, tokens, c.req.header('user-agent'));
  if ('error' in result) return c.json(result, 400);
  return c.json(result);
});

auth.post('/logout', requireAuth, async (c) => {
  const db = await getDb();
  const token = c.get('sessionToken') as string;
  const userId = c.get('userId') as string;
  await revokeSession(db, token);
  await logEvent(db, 'logout', { userId });
  return c.json({ ok: true });
});

export default auth;
