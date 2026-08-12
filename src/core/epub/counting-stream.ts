import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';

/** Streamed inflated-byte accounting; attacker-authored declared sizes are advisory only. */

/** Deliberately not errno/zlib-shaped; identify cap breaches by class, not this string. */
export const EPUB_CAP_EXCEEDED_CODE = 'EPUB_CAP_EXCEEDED';

export class EpubCapExceededError extends Error {
  readonly code = EPUB_CAP_EXCEEDED_CODE;

  constructor(
    readonly cap: number,
    /** Every byte observed, including the chunk that crossed. */
    readonly bytesCounted: number,
  ) {
    super(`EPUB read exceeded its ${cap}-byte cap at ${bytesCounted} bytes`);
    this.name = 'EpubCapExceededError';
  }
}

/** Matches only module-created cap errors, not errors carrying the same code string. */
export function isCapExceededError(value: unknown): value is EpubCapExceededError {
  return value instanceof EpubCapExceededError;
}

export interface CountingStream extends Transform {
  readonly cap: number;
  /** Includes the crossing chunk and remains readable after abort for shared-budget charging. */
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
    // Exact-cap bytes pass; abort immediately in the transform that crosses the cap.
    if (this.#bytesCounted > this.cap) {
      callback(new EpubCapExceededError(this.cap, this.#bytesCounted));
      return;
    }
    callback(null, chunk);
  }
}

export function createCountingStream(cap: number): CountingStream {
  return new ByteCountingStream(cap);
}
