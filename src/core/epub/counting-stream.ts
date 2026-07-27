import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';

/**
 * The bounded byte-counting transform every inflated archive read is piped
 * through (#1986, design §4).
 *
 * Same shape as the cover downloader's streamed cap
 * (`src/server/services/cover-download.ts`) — the declared size is advisory,
 * the streamed counter is authoritative — with an attacker-authored central
 * directory in place of a lying `Content-Length`. The shape is copied, not the
 * import: `src/core/**` may not reach into `src/server/**`.
 *
 * Stream transform only: it opens nothing and decides no verdict.
 */

/**
 * The `code` carried by a cap breach. Deliberately neither errno-shaped
 * (`/^E[A-Z0-9]+$/` does not match it — the underscores fall outside the class)
 * nor a zlib code, so it can never be mistaken for either by
 * `errors.ts`'s code-shape arm.
 *
 * It is **not** the identity, though: use `isCapExceededError`, never a code or
 * message comparison.
 */
export const EPUB_CAP_EXCEEDED_CODE = 'EPUB_CAP_EXCEEDED';

/** The error a `CountingStream` destroys itself with when the running total passes its cap. */
export class EpubCapExceededError extends Error {
  readonly code = EPUB_CAP_EXCEEDED_CODE;

  constructor(
    /** The cap the stream was built with. */
    readonly cap: number,
    /** Every byte observed, including the chunk that crossed. */
    readonly bytesCounted: number,
  ) {
    super(`EPUB read exceeded its ${cap}-byte cap at ${bytesCounted} bytes`);
    this.name = 'EpubCapExceededError';
  }
}

/**
 * The cap-breach identity. `errors.ts` calls this first and unconditionally, so
 * no caller ever needs a "check this before that" ordering rule.
 *
 * An ordinary `Error` carrying `EPUB_CAP_EXCEEDED_CODE` is **not** a match —
 * only a value this module constructed.
 */
export function isCapExceededError(value: unknown): value is EpubCapExceededError {
  return value instanceof EpubCapExceededError;
}

/** A `Transform` that exposes its cap and its running total. */
export interface CountingStream extends Transform {
  /** The byte cap this stream was built with. */
  readonly cap: number;
  /**
   * Every byte observed so far. Readable after a clean end **and** after an
   * abort, where it includes the chunk that crossed the cap — a caller sharing
   * one budget across several reads charges each read as it goes.
   */
  readonly bytesCounted: number;
}

class ByteCountingStream extends Transform implements CountingStream {
  #bytesCounted = 0;

  constructor(readonly cap: number) {
    super();
  }

  get bytesCounted(): number {
    return this.#bytesCounted;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#bytesCounted += chunk.length;
    // Strictly `>`: exactly `cap` bytes pass intact, `cap + 1` aborts. The abort
    // happens right here, in the call that crosses — it does not wait for the
    // source to drain or for flush, so no further chunk is ever counted.
    if (this.#bytesCounted > this.cap) {
      callback(new EpubCapExceededError(this.cap, this.#bytesCounted));
      return;
    }
    callback(null, chunk);
  }
}

/** Build a counting transform bounded at `cap` bytes. */
export function createCountingStream(cap: number): CountingStream {
  return new ByteCountingStream(cap);
}
