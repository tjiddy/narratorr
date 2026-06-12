/**
 * Marker-gated recovery sequence shared by every mid-uptime writer that mutates a
 * library folder which might carry a stranded `.import-commit-pending` marker: the
 * manual/auto import pipeline (`copyToLibrary`), the rename writer (`renameBook`),
 * and the merge writer (`executeMerge`) — #1337/#1338/#1418.
 *
 * Lives in its own module (not `import-staging.ts`) so the three writers share one
 * encapsulation without pushing `import-staging.ts` past its line cap; it composes the
 * two existing primitives that already live there.
 */
import type { FastifyBaseLogger } from 'fastify';
import { assertMarkerPathWritable } from './marker-path-conflict.js';
import { prepareImportSiblings } from './import-staging.js';

/**
 * `assertMarkerPathWritable` (the #1341 collision preflight) runs FIRST: a non-file at
 * the marker path throws `MarkerPathConflictError`; a genuine non-ENOENT stat error
 * propagates raw. Then `prepareImportSiblings` consults the marker — PRESENT → restore
 * `.import-bak` into `targetPath` and clear the marker (throwing `BackupRecoveryError`
 * only on a restore/clear failure after the preflight passes); ABSENT → both siblings
 * are disposable scratch and are strict-cleared (a no-op on a clean path).
 *
 * Recover-then-proceed: callers invoke this BEFORE any destructive mutation so the
 * stranded state converges first; on a thrown failure the caller leaves on-disk state
 * intact and aborts its operation. Deliberately reuses the single
 * `assertMarkerPathWritable` + `prepareImportSiblings` encapsulation rather than
 * re-checking the marker inline — the suffix constants in
 * `src/core/utils/import-sibling-suffixes.ts` remain the single source of truth.
 */
export async function recoverInterruptedCommit(
  targetPath: string,
  libraryRoot: string,
  log: FastifyBaseLogger,
): Promise<void> {
  await assertMarkerPathWritable(targetPath);
  await prepareImportSiblings({
    stagingPath: `${targetPath}.import-tmp`,
    backupPath: `${targetPath}.import-bak`,
    targetPath,
    libraryRoot,
    log,
  });
}
