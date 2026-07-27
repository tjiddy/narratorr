import { describe, expect, it } from 'vitest';
import type { DbOrTx } from '../../db/client.js';
import { serializeDbWrite } from './db-write-lane.js';

/**
 * The lane's whole purpose is an ordering guarantee across CALLERS, so every case below drives
 * it the way two different services would: separate `serializeDbWrite` calls that share nothing
 * but the connection object. A test that only queued from one call site would pass on a
 * service-local tail too, which is exactly the shape #1959 F8 rejected.
 */
function fakeDb(name: string): DbOrTx {
  return { name } as unknown as DbOrTx;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res as () => void; reject = rej; });
  return { promise, resolve, reject };
}

function track(promise: Promise<unknown>): { settled: boolean } {
  const state = { settled: false };
  void promise.then(() => { state.settled = true; }, () => { state.settled = true; });
  return state;
}

async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 1));
}

describe('serializeDbWrite (#1959 F8)', () => {
  it('never overlaps two operations queued on the same connection by different callers', async () => {
    const db = fakeDb('shared');
    const gate = deferred();
    const events: string[] = [];

    // Caller A — stands in for ImportStagingService's finalize transaction.
    const a = serializeDbWrite(db, async () => {
      events.push('a:start');
      await gate.promise;
      events.push('a:end');
    });

    // Caller B — stands in for the reconciler's guarded observation write. It holds no
    // reference to A; the connection is the only thing they share.
    const b = serializeDbWrite(db, async () => {
      events.push('b:start');
      events.push('b:end');
    });

    await flush();
    // B has not started: a service-local tail would have let it run straight through here.
    expect(events).toEqual(['a:start']);

    gate.resolve();
    await Promise.all([a, b]);
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('serializes a whole queue in FIFO order', async () => {
    const db = fakeDb('fifo');
    const order: number[] = [];

    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        serializeDbWrite(db, async () => {
          order.push(n);
          // Yield inside the critical section: any overlap would interleave the pushes.
          await new Promise((resolve) => setTimeout(resolve, 1));
          order.push(-n);
        }),
      ),
    );

    expect(order).toEqual([1, -1, 2, -2, 3, -3, 4, -4, 5, -5]);
  });

  it('keeps separate connections on separate lanes', async () => {
    const first = fakeDb('first');
    const second = fakeDb('second');
    const gate = deferred();
    let secondRan = false;

    const blocked = serializeDbWrite(first, () => gate.promise);
    const free = serializeDbWrite(second, async () => { secondRan = true; });

    await free;
    // The second connection's write completed while the first connection's lane is still held.
    expect(secondRan).toBe(true);
    expect(track(blocked).settled).toBe(false);

    gate.resolve();
    await blocked;
  });

  it('propagates a rejection to its own caller without wedging the lane', async () => {
    const db = fakeDb('rejecting');
    const boom = new Error('write failed');

    await expect(serializeDbWrite(db, () => Promise.reject(boom))).rejects.toBe(boom);

    // The next operation still runs — a lane advanced with a bare `.then(fn)` would have
    // inherited the rejection and refused everything queued after it, forever.
    await expect(serializeDbWrite(db, async () => 'ok')).resolves.toBe('ok');
    await expect(serializeDbWrite(db, async () => 'still ok')).resolves.toBe('still ok');
  });

  it('runs a follow-up queued behind a failing operation, and only after it settles', async () => {
    const db = fakeDb('rejecting-ordered');
    const gate = deferred();
    const events: string[] = [];

    const failing = serializeDbWrite(db, async () => {
      events.push('failing:start');
      await gate.promise;
      events.push('failing:end');
      throw new Error('boom');
    });
    const next = serializeDbWrite(db, async () => { events.push('next'); });

    await flush();
    expect(events).toEqual(['failing:start']);

    gate.resolve();
    await expect(failing).rejects.toThrow('boom');
    await next;
    expect(events).toEqual(['failing:start', 'failing:end', 'next']);
  });
});
