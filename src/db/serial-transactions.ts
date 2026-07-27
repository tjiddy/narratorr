import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-connection transaction serialization (#1959 F12).
 *
 * **The constraint.** A `@libsql/client` connection permits exactly ONE transaction at a time.
 * `createDb` builds one client per process and `createServices` hands that single `Db` to every
 * service, so two overlapping `db.transaction(...)` calls — from one service or from two — do
 * not queue: the loser rejects with `LibsqlError: SQLITE_BUSY: database is locked`. It is a
 * connection-level constraint, not lock contention, so no busy-timeout or retry avoids it.
 *
 * **Why this lives on the connection instead of at the call sites.** The first two attempts at
 * this made serialization something callers opt into — first a private promise tail per
 * service, then a shared helper. Both leave the same hole: the guarantee is only as good as the
 * adoption, and twenty-two `db.transaction(...)` call sites across eleven services never opted
 * in. Serializing inside the connection's own `transaction` method inverts that. There is
 * nothing to adopt, nothing to migrate, and no way for a future caller to bypass it — every
 * caller already goes through `db.transaction`, which is the boundary the constraint is
 * actually about.
 *
 * **What it does not do.** This orders transactions on one connection; it is not a substitute
 * for a transaction's own guards. A conditional write still needs its preconditions re-read
 * inside the transaction, and a compound read-modify-write that must not interleave with
 * another compound operation still needs an application-level lane
 * (`server/utils/db-write-lane.ts`) — that is a different, stronger guarantee about logical
 * operations rather than about the driver.
 */

/**
 * The connections whose transaction is open in the CURRENT async context.
 *
 * A plain flag cannot express this: while a transaction is in flight, an unrelated concurrent
 * task calling `db.transaction` must queue (that is the whole point), whereas a call made from
 * *inside* the transaction's own continuation must be refused — it would wait on a tail its own
 * caller is holding and hang forever. Only async-context propagation distinguishes the two.
 */
const openConnections = new AsyncLocalStorage<ReadonlySet<object>>();

/** One serialization tail per connection object. Weakly held, so a per-test database is collected with its tail. */
const tails = new WeakMap<object, Promise<unknown>>();

/**
 * Thrown instead of deadlocking when `db.transaction` is re-entered on a connection whose
 * transaction is already open in this async context.
 *
 * Without the guard this is a silent hang. SQLite cannot nest transactions on one connection
 * anyway, so such a call is already a defect today — it just fails with `SQLITE_BUSY` instead.
 * Turning it into a named error keeps the diagnosis immediate.
 */
export class NestedTransactionError extends Error {
  constructor() {
    super(
      'db.transaction() was called from inside an open transaction on the same connection. ' +
        'SQLite permits one transaction per connection — use the `tx` handle the callback ' +
        'receives, or `tx.transaction()` for a savepoint, instead of the outer `db`.',
    );
    this.name = 'NestedTransactionError';
  }
}

/**
 * Open a transaction on `connection` only once every transaction already queued on it has
 * settled.
 *
 * The tail is advanced with `.then(open, open)` and a settle-swallowing successor, so a
 * transaction that rolls back neither wedges the connection nor leaks its rejection into the
 * next one — the rejection still reaches its own caller unchanged.
 */
export function runSerializedTransaction<T>(connection: object, open: () => Promise<T>): Promise<T> {
  const alreadyOpen = openConnections.getStore();
  if (alreadyOpen?.has(connection)) return Promise.reject(new NestedTransactionError());

  // A set rather than a single value: a transaction on connection A may legitimately contain
  // one on connection B, and B's context must still remember that A is open.
  const nowOpen = new Set(alreadyOpen ?? []);
  nowOpen.add(connection);
  const enter = () => openConnections.run(nowOpen, open);

  const previous = tails.get(connection) ?? Promise.resolve();
  const run = previous.then(enter, enter);
  tails.set(connection, run.then(() => undefined, () => undefined));
  return run;
}
