import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  beginRootCommit,
  withLibraryRootWrite,
  LibraryRootBusyError,
  rootGateState,
  resetRootGate,
  type LibrarySettingsReader,
} from './library-root-gate.js';
import type { AppSettings } from '@shared/schemas/settings/registry.js';

/** Module-level gate state survives between cases; a leak would otherwise read as a pass. */
beforeEach(() => {
  resetRootGate();
});

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Flush the microtask queue so a parked participant reaches its await before the next is issued. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function libraryRoot(path: string): AppSettings['library'] {
  return { path, folderFormat: '{Author}/{Title}', fileFormat: '' } as AppSettings['library'];
}

/** A reader whose `get` can be parked, so the "read happens under the registration" claim is testable. */
function reader(rootAtRead: () => string): LibrarySettingsReader & { calls: number } {
  const r = {
    calls: 0,
    get: async (_category: 'library') => {
      r.calls++;
      return libraryRoot(rootAtRead());
    },
  };
  return r as LibrarySettingsReader & { calls: number };
}

describe('beginRootCommit', () => {
  it('registers, returns the current library root, and releases the registration', async () => {
    const settings = reader(() => '/library-a');

    const commit = await beginRootCommit(settings);

    expect(commit.library.path).toBe('/library-a');
    expect(rootGateState().commitsInFlight).toBe(1);

    commit.release();
    expect(rootGateState().commitsInFlight).toBe(0);
  });

  it('release is idempotent so a double-release cannot cancel a sibling registration', async () => {
    const settings = reader(() => '/library-a');
    const first = await beginRootCommit(settings);
    const second = await beginRootCommit(settings);

    first.release();
    first.release();

    expect(rootGateState().commitsInFlight).toBe(1);
    second.release();
    expect(rootGateState().commitsInFlight).toBe(0);
  });

  it('releases its registration and rethrows when the library read fails', async () => {
    const boom = new Error('settings read failed');
    const settings: LibrarySettingsReader = { get: () => Promise.reject(boom) };

    await expect(beginRootCommit(settings)).rejects.toBe(boom);
    expect(rootGateState().commitsInFlight).toBe(0);

    // A failed read must not leave library.path permanently refused (case 33).
    await expect(withLibraryRootWrite(async () => 'written')).resolves.toBe('written');
  });
});

describe('settings write vs commits in flight', () => {
  // Case 20 — commit-first: the settings write is refused and nothing is written.
  it('refuses a library write while a commit holds a registration', async () => {
    const settings = reader(() => '/library-a');
    const commit = await beginRootCommit(settings);

    const write = vi.fn(async () => 'written');
    await expect(withLibraryRootWrite(write)).rejects.toBeInstanceOf(LibraryRootBusyError);
    // Refused BEFORE the write body runs, so a multi-category request mutates no category.
    expect(write).not.toHaveBeenCalled();

    commit.release();
    await expect(withLibraryRootWrite(write)).resolves.toBe('written');
    expect(write).toHaveBeenCalledTimes(1);
  });

  // Case 23 — the uncontended arm.
  it('allows a library write when nothing is in flight', async () => {
    const write = vi.fn(async () => 'written');
    await expect(withLibraryRootWrite(write)).resolves.toBe('written');
    expect(write).toHaveBeenCalledTimes(1);
    expect(rootGateState().settingsWriteInFlight).toBe(false);
  });

  // F17 — the counter is a count, not a boolean, and not a release-on-first.
  it('keeps refusing until the LAST of two concurrent commits releases', async () => {
    const settings = reader(() => '/library-a');
    const first = await beginRootCommit(settings);
    const second = await beginRootCommit(settings);
    expect(rootGateState().commitsInFlight).toBe(2);

    await expect(withLibraryRootWrite(async () => 'written')).rejects.toBeInstanceOf(LibraryRootBusyError);

    first.release();
    // A boolean flag, or a counter cleared by the first release, would let this through.
    await expect(withLibraryRootWrite(async () => 'written')).rejects.toBeInstanceOf(LibraryRootBusyError);

    second.release();
    await expect(withLibraryRootWrite(async () => 'written')).resolves.toBe('written');
  });

  // F17, second arm — decrement-on-error must not clear a sibling's live registration.
  it('a failed library read decrements only its own registration', async () => {
    const held = await beginRootCommit(reader(() => '/library-a'));

    const failing: LibrarySettingsReader = { get: () => Promise.reject(new Error('read failed')) };
    await expect(beginRootCommit(failing)).rejects.toThrow('read failed');

    expect(rootGateState().commitsInFlight).toBe(1);
    await expect(withLibraryRootWrite(async () => 'written')).rejects.toBeInstanceOf(LibraryRootBusyError);

    held.release();
    await expect(withLibraryRootWrite(async () => 'written')).resolves.toBe('written');
  });

  it('allows a library write again after a commit throws, because release is finally-scoped', async () => {
    const settings = reader(() => '/library-a');
    const commit = await beginRootCommit(settings);
    try {
      throw new Error('commit blew up');
    } catch {
      commit.release();
    }
    await expect(withLibraryRootWrite(async () => 'written')).resolves.toBe('written');
  });
});

describe('commit vs settings write in flight', () => {
  // Case 21 — settings-check-first: the commit WAITS and observes the POST-write root.
  it('makes a commit wait for an in-flight settings write and hands it the post-write root', async () => {
    let root = '/library-a';
    const settings = reader(() => root);
    const gate = deferred();
    const order: string[] = [];

    const write = withLibraryRootWrite(async () => {
      order.push('settings-write:start');
      await gate.promise;
      root = '/library-b';
      order.push('settings-write:end');
    });

    await settle();
    expect(rootGateState().settingsWriteInFlight).toBe(true);

    let observed: string | undefined;
    const commit = beginRootCommit(settings).then((registration) => {
      order.push('commit:registered');
      observed = registration.library.path;
      registration.release();
    });

    await settle();
    // The commit is waiting, not refused, and has not read the root yet.
    expect(settings.calls).toBe(0);
    expect(order).toEqual(['settings-write:start']);

    gate.resolve();
    await write;
    await commit;

    expect(order).toEqual(['settings-write:start', 'settings-write:end', 'commit:registered']);
    expect(observed).toBe('/library-b');
  });

  // F16 — three-party arbitration: S1 parked, then S2 and a commit both queued.
  it('queues a second settings write rather than refusing it, and never overlaps it with a commit', async () => {
    let root = '/library-a';
    const settings = reader(() => root);
    const first = deferred();
    const second = deferred();
    const order: string[] = [];

    const s1 = withLibraryRootWrite(async () => {
      order.push('s1:start');
      await first.promise;
      root = '/library-b';
      order.push('s1:end');
    });
    await settle();

    const s2 = withLibraryRootWrite(async () => {
      order.push('s2:start');
      await second.promise;
      root = '/library-c';
      order.push('s2:end');
    });
    let observed: string | undefined;
    const commit = beginRootCommit(settings).then((registration) => {
      order.push('commit:registered');
      observed = registration.library.path;
      registration.release();
    });

    await settle();
    expect(order).toEqual(['s1:start']);

    first.resolve();
    await settle();
    second.resolve();

    await expect(s1).resolves.toBeUndefined();
    // S2 waits behind S1; it is never refused, even though a commit is also queued.
    await expect(s2).resolves.toBeUndefined();
    await commit;

    expect(order.indexOf('s2:start')).toBeGreaterThan(order.indexOf('s1:end'));
    // No commit registration overlaps either writer.
    expect(order.indexOf('commit:registered')).toBeGreaterThan(order.indexOf('s2:end'));
    // The root it received is the one the observed serialization order produced.
    expect(observed).toBe('/library-c');
  });

  it('arbitrates the same way when the commit is queued before the second settings write', async () => {
    let root = '/library-a';
    const settings = reader(() => root);
    const first = deferred();
    const order: string[] = [];

    const s1 = withLibraryRootWrite(async () => {
      order.push('s1:start');
      await first.promise;
      root = '/library-b';
      order.push('s1:end');
    });
    await settle();

    let observed: string | undefined;
    const commit = beginRootCommit(settings).then((registration) => {
      order.push('commit:registered');
      observed = registration.library.path;
      registration.release();
    });
    const s2 = withLibraryRootWrite(async () => {
      order.push('s2:start');
      root = '/library-c';
      order.push('s2:end');
    });

    first.resolve();
    await expect(s1).resolves.toBeUndefined();
    await expect(s2).resolves.toBeUndefined();
    await commit;

    // Whichever waiter wakes first, a commit registration never sits between s2:start and s2:end.
    const registered = order.indexOf('commit:registered');
    expect(registered).not.toBe(-1);
    const inside = registered > order.indexOf('s2:start') && registered < order.indexOf('s2:end');
    expect(inside).toBe(false);
    expect(observed).toBe(root);
  });
});

describe('same-turn atomicity', () => {
  // Case 22 — invoked in one turn with no interleaving await: exactly one wins.
  it('lets exactly one of a same-turn commit and library write proceed', async () => {
    const settings = reader(() => '/library-a');

    const commit = beginRootCommit(settings);
    const write = withLibraryRootWrite(async () => 'written');

    const [commitResult, writeResult] = await Promise.allSettled([commit, write]);

    const won = [commitResult.status === 'fulfilled', writeResult.status === 'fulfilled'];
    expect(won.filter(Boolean)).toHaveLength(1);
    expect(writeResult.status === 'rejected' && writeResult.reason).toBeInstanceOf(LibraryRootBusyError);

    if (commitResult.status === 'fulfilled') commitResult.value.release();
  });

  it('registers synchronously when idle so a write issued later in the same turn is refused', async () => {
    const settings = reader(() => '/library-a');

    void beginRootCommit(settings);
    // No await between: the counter must already read 1.
    expect(rootGateState().commitsInFlight).toBe(1);

    await expect(withLibraryRootWrite(async () => 'written')).rejects.toBeInstanceOf(LibraryRootBusyError);
  });
});

describe('transient state', () => {
  // Case 32 — nothing is persisted; a fresh module state accepts a library write immediately.
  it('holds no refusal state across a reset standing in for a process restart', async () => {
    const commit = await beginRootCommit(reader(() => '/library-a'));
    expect(rootGateState().commitsInFlight).toBe(1);
    void commit;

    resetRootGate();

    expect(rootGateState()).toEqual({ commitsInFlight: 0, settingsWriteInFlight: false });
    await expect(withLibraryRootWrite(async () => 'written')).resolves.toBe('written');
  });

  it('clears the settings-write flag when the write throws', async () => {
    await expect(withLibraryRootWrite(async () => { throw new Error('write failed'); })).rejects.toThrow('write failed');
    expect(rootGateState().settingsWriteInFlight).toBe(false);
    await expect(withLibraryRootWrite(async () => 'written')).resolves.toBe('written');
  });
});
