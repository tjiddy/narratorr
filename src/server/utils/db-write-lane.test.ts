import { describe, expect, it } from 'vitest';
import type { Db, Transaction } from '@db/client.js';
import { serializeDbWrite } from './db-write-lane.js';

// Each invocation represents an independent caller; the Db object is their only shared state.
function fakeDb(name: string): Db {
  return { name } as unknown as Db;
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
  it('never overlaps two compound operations queued on the same connection by different callers', async () => {
    const db = fakeDb('shared');
    const gate = deferred();
    const events: string[] = [];

    const a = serializeDbWrite(db, async () => {
      events.push('a:start');
      await gate.promise;
      events.push('a:end');
    });

    const b = serializeDbWrite(db, async () => {
      events.push('b:start');
      events.push('b:end');
    });

    await flush();
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
    expect(secondRan).toBe(true);
    expect(track(blocked).settled).toBe(false);

    gate.resolve();
    await blocked;
  });

  it('propagates a rejection to its own caller without wedging the lane', async () => {
    const db = fakeDb('rejecting');
    const boom = new Error('write failed');

    await expect(serializeDbWrite(db, () => Promise.reject(boom))).rejects.toBe(boom);

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

  it('refuses a transaction handle at the type boundary', () => {
    const tx = {} as Transaction;
    // @ts-expect-error — `serializeDbWrite` takes a `Db`; a transaction handle is not one.
    const rejected = () => serializeDbWrite(tx, async () => undefined);

    expect(typeof rejected).toBe('function');
  });
});
