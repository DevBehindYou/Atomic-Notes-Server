import { Readable } from 'node:stream';
import { google, drive_v3 } from 'googleapis';
import { getOAuthClient } from './googleOAuth';

const APP_FOLDER_NAME = 'My-Atomic-Notes';

function driveClient(accessToken: string, refreshToken: string): drive_v3.Drive {
  const auth = getOAuthClient();
  auth.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
  return google.drive({ version: 'v3', auth, timeout: 20000 });
}

export async function findOrCreateFolder(
  drive: drive_v3.Drive,
  name: string,
  parentId?: string,
): Promise<string> {
  const q = [
    `mimeType = 'application/vnd.google-apps.folder'`,
    `name = '${name.replace(/'/g, "\\'")}'`,
    `trashed = false`,
    parentId ? `'${parentId}' in parents` : `'root' in parents`,
  ].join(' and ');

  const existing = await drive.files.list({ q, fields: 'files(id, name)', spaces: 'drive' });
  if (existing.data.files?.length) return existing.data.files[0].id!;

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentId ? [parentId] : undefined,
    },
    fields: 'id',
  });
  return created.data.id!;
}

/** Ensures "My-Atomic-Notes" exists in the user's Drive. Called once, on first connect. */
export async function ensureAppFolders(accessToken: string, refreshToken: string) {
  const drive = driveClient(accessToken, refreshToken);
  const notesId = await findOrCreateFolder(drive, APP_FOLDER_NAME);
  return { notesId };
}

const quoteQueryValue = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/**
 * Drive and MongoDB cannot commit together, so a create can succeed and the
 * metadata commit after it fail. Filenames are the note ID, so a retry looks
 * for that file first and rewrites it instead of leaving a second copy.
 */
export async function createNoteFileWith(drive: drive_v3.Drive, parentId: string, filename: string, content: object) {
  const media = () => ({ mimeType: 'application/json', body: Readable.from(JSON.stringify(content)) });
  const fields = 'id, headRevisionId, modifiedTime';
  const found = await drive.files.list({
    q: `name = '${quoteQueryValue(filename)}' and '${quoteQueryValue(parentId)}' in parents and trashed = false`,
    fields: 'files(id)', spaces: 'drive', pageSize: 1,
  });
  const existingId = found.data.files?.[0]?.id;
  if (existingId) return (await drive.files.update({ fileId: existingId, media: media(), fields })).data;
  return (await drive.files.create({
    requestBody: { name: filename, parents: [parentId], mimeType: 'application/json' }, media: media(), fields,
  })).data;
}

export async function createNoteFile(
  accessToken: string,
  refreshToken: string,
  parentId: string,
  filename: string,
  content: object,
) {
  return createNoteFileWith(driveClient(accessToken, refreshToken), parentId, filename, content);
}

export async function updateNoteFile(
  accessToken: string,
  refreshToken: string,
  fileId: string,
  content: object,
) {
  const drive = driveClient(accessToken, refreshToken);
  const res = await drive.files.update({
    fileId,
    requestBody: { trashed: false },
    media: { mimeType: 'application/json', body: Readable.from(JSON.stringify(content)) },
    fields: 'id, headRevisionId, modifiedTime',
  });
  return res.data;
}

/** Trashes rather than permanently deletes — gives the user a recovery window via Drive's own trash. */
export async function deleteNoteFile(accessToken: string, refreshToken: string, fileId: string) {
  const drive = driveClient(accessToken, refreshToken);
  await drive.files.update({ fileId, requestBody: { trashed: true } });
}

export async function getFileRevision(accessToken: string, refreshToken: string, fileId: string) {
  const drive = driveClient(accessToken, refreshToken);
  const res = await drive.files.get({ fileId, fields: 'headRevisionId, modifiedTime' });
  return res.data;
}

/**
 * Downloads and parses a `.atomic` file's actual content. Added alongside
 * the pull/sync endpoints — the first pass of this backend only ever wrote
 * Drive content, never read it back, which is fine for per-note CRUD (the
 * client already has what it just wrote) but not for pull, which needs to
 * hand back content the client doesn't have yet.
 */
export async function getNoteFileContent(accessToken: string, refreshToken: string, fileId: string) {
  const drive = driveClient(accessToken, refreshToken);
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'json' });
  return res.data as Record<string, unknown>;
}
