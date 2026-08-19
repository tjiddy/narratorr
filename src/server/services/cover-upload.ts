import { join } from 'node:path';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { mimeToExt } from '../utils/mime.js';
import { replaceFileAtomically } from '../utils/atomic-file-replace.js';
import { finalizeCoverWrite, type CoverWriteOutcome } from './cover-write.js';

export type CoverUploadErrorCode = 'INVALID_MIME' | 'NOT_FOUND' | 'NO_PATH';

export class CoverUploadError extends Error {
  code: CoverUploadErrorCode;
  constructor(message: string, code: CoverUploadErrorCode) {
    super(message);
    this.code = code;
  }
}

/** Atomically write a cover. Pre-commit failures throw; post-commit finalization is nonfatal. */
export async function uploadBookCover(
  bookId: number,
  bookPath: string,
  buffer: Buffer,
  mimeType: string,
  db: Db,
  log: FastifyBaseLogger,
): Promise<CoverWriteOutcome> {
  const ext = mimeToExt(mimeType);
  if (!ext) {
    throw new CoverUploadError('Only JPG, PNG, and WebP images are supported', 'INVALID_MIME');
  }

  const keepFilename = `cover.${ext}`;
  const finalPath = join(bookPath, keepFilename);

  await replaceFileAtomically(finalPath, buffer, '.cover-upload-');

  await finalizeCoverWrite(bookId, bookPath, keepFilename, db, log);

  log.info({ bookId, path: finalPath }, 'Custom cover uploaded');
  return 'written';
}
