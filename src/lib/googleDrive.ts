import { Readable } from 'node:stream';
import { google, drive_v3 } from 'googleapis';
import { getOAuthClient } from './googleOAuth';

const APP_FOLDER_NAME = 'My-Atomic-Notes';

function driveClient(accessToken: string, refreshToken: string): drive_v3.Drive {
  const auth = getOAuthClient();
  auth.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
  return google.drive({ version: 'v3', auth });
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

export async function createNoteFile(
  accessToken: string,
  refreshToken: string,
  parentId: string,
  filename: string,
  content: object,
) {
  const drive = driveClient(accessToken, refreshToken);
  const res = await drive.files.create({
    requestBody: { name: filename, parents: [parentId], mimeType: 'application/json' },
    media: { mimeType: 'application/json', body: Readable.from(JSON.stringify(content)) },
    fields: 'id, headRevisionId, modifiedTime',
  });
  return res.data;
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
