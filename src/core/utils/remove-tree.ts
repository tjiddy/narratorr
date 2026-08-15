// One tree-removal policy for the whole app: `{ recursive: true, force: true }` plus a bounded
// retry over the *whole* removal, for the transient failures Node itself names as retryable
// (an NFS silly-rename handle closing, a scanner still writing into the tree).
import { rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';

/**
 * Four attempts, so at most 100 + 200 + 300 = 600 ms of backoff and at most 4 walks of the tree —
 * **at any depth**, because the retry re-runs the whole removal rather than descending. A removal
 * that succeeds first try waits not at all; a recovered one pays backoff by construction, one
 * 100 ms wait in the realistic transient case.
 *
 * The depth-independence is why `fs.rm`'s own `maxRetries` is deliberately NOT passed below.
 * Node's ladder is per recursive invocation: `_rmchildren` re-enters `rimraf` for every child, so
 * an ancestor's retry hands each descendant a fresh ladder and the cumulative wait is
 * `200·(4^(h+1) − 1)` ms — ~55 min at height 6. Three callers (torrent output paths, import
 * staging siblings, book folders) take a depth nobody in this repo caps, and `fs.rm` ignores a
 * `signal` option, so that cost cannot be bounded from the outside either.
 */
export const REMOVE_TREE_MAX_RETRIES = 3;
/** Linear step: attempt N waits `REMOVE_TREE_RETRY_DELAY_MS * N`. See REMOVE_TREE_MAX_RETRIES. */
export const REMOVE_TREE_RETRY_DELAY_MS = 100;

/** Node's own `retryErrorCodes` (`internal/fs/rimraf`) — copied so we retry exactly what it would. */
const RETRYABLE = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM']);

/**
 * ENOENT never reaches here: `force: true` resolves it. Only a real `Error` can be ours — a bare
 * `{ code: 'EBUSY' }` is some other layer's value, and reading `.code` off it would buy an
 * arbitrary thrown object four attempts and 600 ms of backoff.
 */
function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code } = error as NodeJS.ErrnoException;
  return code !== undefined && RETRYABLE.has(code);
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Blocks the calling thread; verified on Node 24's main thread. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Removes a path recursively, retrying transient failures. Non-retryable errors reject untouched. */
export async function removeTree(path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error: unknown) {
      if (attempt >= REMOVE_TREE_MAX_RETRIES || !isRetryable(error)) throw error;
      await wait(REMOVE_TREE_RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

/** The blocking twin of `removeTree`, for teardown paths that cannot await. Same budget, same set. */
export function removeTreeSync(path: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error: unknown) {
      if (attempt >= REMOVE_TREE_MAX_RETRIES || !isRetryable(error)) throw error;
      sleep(REMOVE_TREE_RETRY_DELAY_MS * (attempt + 1));
    }
  }
}
