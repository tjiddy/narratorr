import { describe, it, expect } from 'vitest';
import { withPathWriteLock, hasPendingPathWrite } from './path-write-lock.js';

/** A promise plus its resolvers, so a test can hold a critical section open deterministically. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('withPathWriteLock', () => {
  it('serializes two writes to the same path — the second starts only after the first finishes', async () => {
    const events: string[] = [];
    const first = deferred<void>();

    const a = withPathWriteLock('/books/book.m4b', async () => {
      events.push('a:start');
      await first.promise;
      events.push('a:end');
    });
    const b = withPathWriteLock('/books/book.m4b', async () => {
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
      withPathWriteLock('/books/book.m4b', () => Promise.resolve('overwrite')),
      withPathWriteLock('/books/book.m4b', () => Promise.resolve('populate_missing')),
    ]);

    expect(results).toEqual(['overwrite', 'populate_missing']);
  });

  it('does not block writes to different paths (the lock is keyed, not global)', async () => {
    const events: string[] = [];
    const held = deferred<void>();

    const slow = withPathWriteLock('/books/one.m4b', async () => {
      events.push('one:start');
      await held.promise;
    });
    const fast = withPathWriteLock('/books/two.m4b', async () => {
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
      withPathWriteLock('/books/book.m4b', () => Promise.reject(new Error('helper exited 1'))),
    ).rejects.toThrow('helper exited 1');

    await expect(
      withPathWriteLock('/books/book.m4b', () => Promise.resolve('recovered')),
    ).resolves.toBe('recovered');
  });

  it('propagates a rejection to its own caller only, never to the queued write', async () => {
    const failing = withPathWriteLock('/books/book.m4b', () => Promise.reject(new Error('boom')));
    const following = withPathWriteLock('/books/book.m4b', () => Promise.resolve('ok'));

    await expect(failing).rejects.toThrow('boom');
    await expect(following).resolves.toBe('ok');
  });

  // #2301's defect, and the reason #2358 exists: the primitive keyed on the exact string handed to
  // it while three spellings of one file reached it, so one file got two chains and mutual
  // exclusion was silently off. Every other suite stayed green under that mutation on Linux — all
  // 24995 of them — because `resolve` alone already collapses `/a/../b`. The backslash-parent form
  // below is the ONLY shape that discriminates: `resolve` treats `\` as an ordinary character on
  // POSIX, so it cannot collapse it, and folding separators BEFORE resolving is what makes the two
  // spellings one key. The primitive touches no filesystem, so this reads identically on Windows —
  // deliberately the platform-neutral control for the Windows job.
  it('holds one chain for two spellings of one path, so a raw-keyed writer cannot enter beside a canonical holder', async () => {
    const events: string[] = [];
    const held = deferred<void>();
    const canonical = '/books/Mort/Mort.m4b';
    const legacy = '/books/Mort\\Sourcery\\..\\Mort.m4b';

    const holder = withPathWriteLock(canonical, async () => {
      events.push('canonical:start');
      await held.promise;
      events.push('canonical:end');
    });
    const contender = withPathWriteLock(legacy, async () => {
      events.push('legacy:start');
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['canonical:start']);

    held.resolve();
    await Promise.all([holder, contender]);
    expect(events).toEqual(['canonical:start', 'canonical:end', 'legacy:start']);
  });

  it('evicts the key once the chain drains', async () => {
    await withPathWriteLock('/books/drained.m4b', () => Promise.resolve());
    // The eviction rides a `.then` on the settled slot, so let the queue flush.
    await Promise.resolve();
    await Promise.resolve();

    expect(hasPendingPathWrite('/books/drained.m4b')).toBe(false);
  });

  // The OPF writer joined this lock in #2297; one map now serves two kinds of path.
  it('does not serialize an audio write against the sidecar write in the same folder', async () => {
    const events: string[] = [];
    const held = deferred<void>();

    const audio = withPathWriteLock('/books/Mort/Mort.m4b', async () => {
      events.push('audio:start');
      await held.promise;
    });
    const sidecar = withPathWriteLock('/books/Mort/metadata.opf', async () => {
      events.push('sidecar:done');
    });

    await sidecar;
    expect(events).toEqual(['audio:start', 'sidecar:done']);

    held.resolve();
    await audio;
  });

  it('serializes two sidecar writes to the same metadata.opf path', async () => {
    const events: string[] = [];
    const first = deferred<void>();

    const a = withPathWriteLock('/books/Mort/metadata.opf', async () => {
      events.push('a:start');
      await first.promise;
      events.push('a:end');
    });
    const b = withPathWriteLock('/books/Mort/metadata.opf', async () => {
      events.push('b:start');
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['a:start']);

    first.resolve();
    await Promise.all([a, b]);
    expect(events).toEqual(['a:start', 'a:end', 'b:start']);
  });
});
