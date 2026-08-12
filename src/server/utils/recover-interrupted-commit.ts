// Shared marker-gated recovery for import, rename, and merge writers (#1337/#1338/#1418).
import type { FastifyBaseLogger } from 'fastify';
import { assertMarkerPathWritable } from './marker-path-conflict.js';
import { prepareImportSiblings } from './import-staging.js';

// Collision preflight must precede recovery. Call before destructive writes; failures
// abort the writer while the stranded state remains recoverable.
export async function recoverInterruptedCommit(
  targetPath: string,
  libraryRoot: string,
  log: FastifyBaseLogger,
): Promise<void> {
  await assertMarkerPathWritable(targetPath);
  await prepareImportSiblings({ targetPath, libraryRoot, log });
}
