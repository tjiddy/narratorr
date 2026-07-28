import type { Db } from '@db/client.js';

/**
 * An APPLICATION-level serialization lane, one per database connection (#1893 F36, re-homed by
 * #1959 F8 and narrowed by #1959 F13).
 *
 * **This is not the transaction guarantee.** Driver-level exclusion — a libSQL connection
 * permits one transaction at a time — is enforced by the connection itself in
 * `src/db/serial-transactions.ts`, where no caller can bypass it. Every `db.transaction(...)`
 * in the codebase is already ordered without touching this module.
 *
 * What this lane adds is stronger and different: it orders whole COMPOUND operations, including
 * the reads and branching that sit outside any transaction. `ImportStagingService` is the
 * caller that needs it — its PUT, finalize, and discard paths are read-then-decide-then-write
 * sequences, and one is a bare `DELETE` with no transaction at all. Ordering their transactions
 * would not be enough: a PUT racing finalize has to observe committed state rather than an
 * interleaved half-step, which is what makes two concurrent finalizes both resolve to
 * `processing` instead of one of them observing a torn view.
 *
 * **Reach for this only when a compound sequence must be atomic against another compound
 * sequence.** A single guarded transaction does not need it — `CompanionEbookReconciler` used
 * this briefly and no longer does, because its conditional write is one transaction and the
 * connection already orders those. Wrapping more than necessary throws away concurrency the
 * driver never restricted.
 *
 * **Keyed on the `Db`, and the parameter type says so.** The invariant is one lane per
 * connection, so the key must be the connection. `DbOrTx` would compile while being wrong: a
 * transaction-scoped handle is a different object and would silently receive its own tail,
 * reintroducing the interleaving this exists to prevent. The narrow parameter makes that
 * unrepresentable rather than merely discouraged, and needs no cast to key the map.
 *
 * This does NOT serialize across processes or across separate connections, and it is not a
 * substitute for a transaction's own guards — conditional writes still need their preconditions.
 */
const lanes = new WeakMap<Db, Promise<unknown>>();

/**
 * Run `fn` on `db`'s application lane: it starts only after every previously queued operation on
 * the same connection has settled.
 *
 * The chain is advanced with `.then(fn, fn)` and a settle-swallowing tail, so a rejected
 * operation neither wedges the lane nor propagates into the next one — the rejection still
 * reaches this call's own caller.
 */
export function serializeDbWrite<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  const previous = lanes.get(db) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  lanes.set(db, run.then(() => undefined, () => undefined));
  return run;
}
