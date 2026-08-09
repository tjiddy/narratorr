import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Transform } from 'node:stream';
import {
  createCountingStream,
  isCapExceededError,
  EPUB_CAP_EXCEEDED_CODE,
} from './counting-stream.js';

async function* oneByteAtATime(count: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < count; i += 1) yield Buffer.from([0x61]);
}

async function run(
  source: AsyncIterable<Buffer> | Readable,
  stream: Transform,
): Promise<{ output?: Buffer; error?: unknown }> {
  // Preserve chunks forwarded before an abort makes sink iteration throw.
  const forwarded: Buffer[] = [];
  try {
    await pipeline(source, stream, async (out) => {
      for await (const chunk of out as AsyncIterable<Buffer>) forwarded.push(chunk);
    });
    return { output: Buffer.concat(forwarded) };
  } catch (error) {
    return { output: Buffer.concat(forwarded), error };
  }
}

describe('createCountingStream — the cap boundary', () => {
  it('passes a stream of exactly the cap intact and reports the exact total', async () => {
    const stream = createCountingStream(8);
    const input = Buffer.alloc(8, 0x61);
    const { output, error } = await run(Readable.from([input]), stream);

    expect(error).toBeUndefined();
    expect(output?.equals(input)).toBe(true);
    expect(stream.bytesCounted).toBe(8);
  });

  it('aborts inside the transform call that crosses the cap, consuming no further chunk', async () => {
    // One-byte chunks make the crossing byte observable independent of chunk size.
    const stream = createCountingStream(4);
    const { output, error } = await run(oneByteAtATime(20), stream);

    expect(isCapExceededError(error)).toBe(true);
    expect(stream.bytesCounted).toBe(5);
    expect(isCapExceededError(error) && error.bytesCounted).toBe(5);
    expect(output?.length).toBeLessThanOrEqual(4);
  });

  it('keeps the running total readable after an abort', async () => {
    const stream = createCountingStream(3);
    const { error } = await run(Readable.from([Buffer.alloc(10, 0x61)]), stream);

    expect(isCapExceededError(error)).toBe(true);
    expect(stream.bytesCounted).toBe(10);
  });

  it('exposes the cap it was built with', () => {
    expect(createCountingStream(1234).cap).toBe(1234);
  });
});

describe('createCountingStream — the cap-breach identity', () => {
  it('raises an error matched by the exported predicate and carrying a non-errno, non-zlib code', async () => {
    const { error } = await run(Readable.from([Buffer.alloc(4)]), createCountingStream(1));

    expect(isCapExceededError(error)).toBe(true);
    expect(isCapExceededError(error) && error.code).toBe(EPUB_CAP_EXCEEDED_CODE);
    expect(EPUB_CAP_EXCEEDED_CODE).not.toMatch(/^E[A-Z0-9]+$/);
    expect(EPUB_CAP_EXCEEDED_CODE).not.toMatch(/^(?:Z_|ERR_ZLIB_)/);
  });

  it('carries the cap and the observed total on the error itself', async () => {
    const { error } = await run(Readable.from([Buffer.alloc(7)]), createCountingStream(2));

    expect(isCapExceededError(error) && { cap: error.cap, bytes: error.bytesCounted }).toEqual({
      cap: 2,
      bytes: 7,
    });
  });

  it('does not match an ordinary Error wearing the same code string', () => {
    const impostor = Object.assign(new Error('cap exceeded'), { code: EPUB_CAP_EXCEEDED_CODE });
    expect(isCapExceededError(impostor)).toBe(false);
  });

  it('does not match non-Error values', () => {
    expect([null, undefined, 'boom', 0, {}].map(isCapExceededError)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe('createCountingStream — upstream failures', () => {
  it('surfaces a mid-flight source error unchanged and does not claim it as a cap breach', async () => {
    const boom = new Error('source exploded');
    async function* failing(): AsyncGenerator<Buffer> {
      yield Buffer.alloc(1);
      throw boom;
    }

    const { error } = await run(failing(), createCountingStream(1024));

    expect(error).toBe(boom);
    expect(isCapExceededError(error)).toBe(false);
  });
});
