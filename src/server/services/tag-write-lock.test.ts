import { describe, it, expect } from 'vitest';
import { withTagWriteLock, hasPendingTagWrite } from './tag-write-lock.js';

/** A promise plus its resolvers, so a test can hold a critical section open deterministically. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('withTagWriteLock', () => {
  it('serializes two writes to the same path — the second starts only after the first finishes', async () => {
    const events: string[] = [];
    const first = deferred<void>();

    const a = withTagWriteLock('/books/book.m4b', async () => {
      events.push('a:start');
      await first.promise;
      events.push('a:end');
    });
    const b = withTagWriteLock('/books/book.m4b', async () => {
      events.push('b:start');
    });

    // Give the microtask queue every chance to run b early; the lock must still hold it back.
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['a:start']);

    first.resolve();
    await Promise.all([a, b]);
    expect(events).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('chains rather than coalescing — both writes execute and each gets its own result', async () => {
    const results = await Promise.all([
      withTagWriteLock('/books/book.m4b', () => Promise.resolve('overwrite')),
      withTagWriteLock('/books/book.m4b', () => Promise.resolve('populate_missing')),
    ]);

    expect(results).toEqual(['overwrite', 'populate_missing']);
  });

  it('does not block writes to different paths (the lock is keyed, not global)', async () => {
    const events: string[] = [];
    const held = deferred<void>();

    const slow = withTagWriteLock('/books/one.m4b', async () => {
      events.push('one:start');
      await held.promise;
    });
    const fast = withTagWriteLock('/books/two.m4b', async () => {
      events.push('two:done');
    });

    await fast;
    // A bulk retag of 747 books must not become a global mutex.
    expect(events).toEqual(['one:start', 'two:done']);

    held.resolve();
    await slow;
  });

  it('releases the key when the write rejects, so the next write still runs', async () => {
    await expect(
      withTagWriteLock('/books/book.m4b', () => Promise.reject(new Error('helper exited 1'))),
    ).rejects.toThrow('helper exited 1');

    await expect(
      withTagWriteLock('/books/book.m4b', () => Promise.resolve('recovered')),
    ).resolves.toBe('recovered');
  });

  it('propagates a rejection to its own caller only, never to the queued write', async () => {
    const failing = withTagWriteLock('/books/book.m4b', () => Promise.reject(new Error('boom')));
    const following = withTagWriteLock('/books/book.m4b', () => Promise.resolve('ok'));

    await expect(failing).rejects.toThrow('boom');
    await expect(following).resolves.toBe('ok');
  });

  it('evicts the key once the chain drains', async () => {
    await withTagWriteLock('/books/drained.m4b', () => Promise.resolve());
    // The eviction rides a `.then` on the settled slot, so let the queue flush.
    await Promise.resolve();
    await Promise.resolve();

    expect(hasPendingTagWrite('/books/drained.m4b')).toBe(false);
  });
});
