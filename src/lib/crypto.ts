import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';

function getKey(): Buffer {
  const key = process.env.TOKEN_ENCRYPTION_KEY;
  if (!key) throw new Error('TOKEN_ENCRYPTION_KEY is not set');
  const buf = Buffer.from(key, 'base64');
  if (buf.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (base64) — generate with: openssl rand -base64 32');
  }
  return buf;
}

/** Encrypts a Google access/refresh token before it touches Postgres. */
export function encryptToken(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((b) => b.toString('base64')).join('.');
}

export function decryptToken(payload: string): string {
  const [ivB64, tagB64, ctB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('Malformed encrypted token payload');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
