import { google } from 'googleapis';

// drive.file, not drive/drive.readonly: the app can only see and manage files it
// creates itself. This is deliberate — it keeps the OAuth consent screen honest
// ("this app can only touch its own notes, not your whole Drive") and it keeps the
// app out of Google's restricted-scope verification/CASA assessment process, which
// full Drive access would require once you have real users.
const SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive.file'];

export function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
}

/**
 * A second client, deliberately built with NO redirect_uri. Native mobile
 * sign-in (the Flutter app's `google_sign_in` package, configured with
 * `serverClientId`) hands back a one-time `serverAuthCode` instead of a web
 * redirect's `code` — but Google's token endpoint still checks the
 * redirect_uri used at exchange time against the one used to obtain the
 * code, and a native sign-in used none. Exchanging a serverAuthCode with
 * the redirect-configured client above fails with redirect_uri_mismatch;
 * this is the fix, not a duplicate for its own sake.
 */
export function getOAuthClientForServerAuthCode() {
  return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
}

export function getAuthUrl(state: string): string {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    // prompt: 'consent' forces Google to hand back a refresh_token even if the user
    // has authorized this app before — without it, a returning user's second login
    // silently omits the refresh_token and background sync breaks.
    prompt: 'consent',
    scope: SCOPES,
    state,
  });
}

export async function exchangeCode(code: string) {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  return tokens;
}

export async function refreshAccessToken(refreshToken: string) {
  const client = getOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await client.refreshAccessToken();
  return credentials;
}

/** True when Google says the stored refresh token no longer works (revoked, or expired after 7 days in Testing). */
export function isInvalidGrant(error: unknown): boolean {
  const e = error as { message?: string; response?: { data?: { error?: string } } } | null;
  return e?.response?.data?.error === 'invalid_grant' || /invalid_grant/.test(e?.message ?? '');
}

export type GoogleProfile = { sub?: string; email?: string; email_verified?: boolean; name?: string };

/** OpenID Connect userinfo for an access token this Server obtained itself. Null if Google refuses. */
export async function fetchGoogleProfile(accessToken: string): Promise<GoogleProfile | null> {
  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10000),
  });
  return response.ok ? await response.json() as GoogleProfile : null;
}
