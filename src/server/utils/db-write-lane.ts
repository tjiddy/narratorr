import type { Db } from '@db/client.js';

/**
 * Per-connection lane for compound read/decide/write operations whose work outside a
 * transaction must not interleave. Transactions are already serialized by the driver.
 * Keying on `Db`, not `DbOrTx`, preserves one lane per connection. This does not coordinate
 * processes or connections, and conditional writes still need their own guards.
 */
const lanes = new WeakMap<Db, Promise<unknown>>();

// Advance past rejection so one failed operation cannot wedge the lane.
export function serializeDbWrite<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  const previous = lanes.get(db) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  lanes.set(db, run.then(() => undefined, () => undefined));
  return run;
}
