// Shared marker-gated recovery for import, rename, and merge writers (#1337/#1338/#1418).
import type { FastifyBaseLogger } from 'fastify';
import { assertMarkerPathWritable } from './marker-path-conflict.js';
import { prepareImportSiblings } from './import-staging.js';

// Collision preflight must precede recovery. Call before destructive writes; failures
// abort the writer while the stranded state remains recoverable.
//
// This is the single entry point to the shared import-scratch namespace, and its callers — rename,
// both import paths, and merge — race each other there today. Rename takes a claim key around its
// call (#2301); the others deliberately do NOT, because enrolling folder mutators one at a time
// provably does not converge. Cross-service serialization of book-folder mutations needs one
// coherent ownership model decided together, and is #2301's largest Out of Scope item. Do not
// enrol another caller here piecemeal.
export async function recoverInterruptedCommit(
  targetPath: string,
  libraryRoot: string,
  log: FastifyBaseLogger,
): Promise<void> {
  await assertMarkerPathWritable(targetPath);
  await prepareImportSiblings({ targetPath, libraryRoot, log });
}
