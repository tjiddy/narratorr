import type { DbOrTx } from '../../db/client.js';

/**
 * One serialization lane per database connection, shared by every service that opens a
 * transaction on it (#1959 F8; the pattern originates in #1893 F36).
 *
 * **Why this exists.** A `@libsql/client` connection permits exactly ONE transaction at a
 * time. `createDb` (`src/db/client.ts`) builds one client per process and `createServices`
 * hands that single `Db` to every service, so two overlapping `db.transaction(...)` calls —
 * from the same service or from two different ones — do not queue: the loser rejects with
 * `LibsqlError: SQLITE_BUSY: database is locked`. It is a connection-level constraint, not
 * lock contention, so no busy-timeout or retry setting avoids it.
 *
 * **Why a per-`Db` `WeakMap` rather than an injected instance.** The invariant that has to
 * hold is "one lane per connection", and only a lane keyed on the connection itself can
 * guarantee it. A lane passed through DI is a lane a future service can be wired without —
 * silently reintroducing exactly the overlap this module exists to prevent — and the failure
 * would surface as an intermittent `SQLITE_BUSY` inside whichever caller lost the race, which
 * reads as flaky application logic rather than a wiring mistake. Keying on the `Db` makes the
 * correct lane unmissable: any caller holding the same connection gets the same tail by
 * construction, with no wiring to forget. Entries are weakly held, so a per-test database is
 * collected with its lane.
 *
 * **Serialize the transaction, never the work around it.** Callers should wrap only
 * `db.transaction(...)`. Wrapping the reads, filesystem probes, or validation that surround it
 * would throw away concurrency the driver never restricted — `CompanionEbookReconciler` keeps
 * four per-book passes running while only their guarded writes queue here.
 *
 * This does NOT serialize across processes or across separate connections, and it is not a
 * substitute for a transaction's own guards: it prevents driver-level overlap, not logical
 * write conflicts. Conditional writes still need their own preconditions.
 */
const lanes = new WeakMap<object, Promise<unknown>>();

/**
 * Run `fn` on `db`'s serial write lane: it starts only after every previously queued operation
 * on the same connection has settled.
 *
 * The chain is advanced with `.then(fn, fn)` and a settle-swallowing tail, so a rejected
 * operation neither wedges the lane nor propagates into the next one — the rejection still
 * reaches this call's own caller.
 */
export function serializeDbWrite<T>(db: DbOrTx, fn: () => Promise<T>): Promise<T> {
  const key = db as unknown as object;
  const previous = lanes.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  lanes.set(key, run.then(() => undefined, () => undefined));
  return run;
}
