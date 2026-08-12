import { AsyncLocalStorage } from 'node:async_hooks';

// libSQL permits one active transaction per connection; overlapping BEGINs fail rather
// than queue, and busy retries do not fix that connection-level constraint. Serialize at
// db.transaction so participation is mandatory. This does not replace transaction-local
// guards or the stronger application-level db-write lane.

interface TransactionMarker {
  open: boolean;
}

// Async context distinguishes a nested same-connection call, which would deadlock, from
// unrelated concurrency, which should queue. The marker is mutable because inherited ALS
// stores can outlive the transaction; post-settle descendants must queue rather than reject.
const openConnections = new AsyncLocalStorage<ReadonlyMap<object, TransactionMarker>>();

// One weakly held serialization tail per connection; test databases collect with their tails.
const tails = new WeakMap<object, Promise<unknown>>();

/** Throw instead of deadlocking when db.transaction re-enters the same open connection. */
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

/** Queue behind every earlier transaction without allowing a rejection to poison the tail. */
export function runSerializedTransaction<T>(connection: object, open: () => Promise<T>): Promise<T> {
  const inherited = openConnections.getStore();
  if (inherited?.get(connection)?.open) return Promise.reject(new NestedTransactionError());

  // A transaction on A may contain one on B; share markers so every inherited map sees settles.
  const marker: TransactionMarker = { open: true };
  const nowOpen = new Map(inherited ?? []);
  nowOpen.set(connection, marker);
  // Flip in the transaction's first continuation, before any awaiter resumes.
  const enter = () =>
    openConnections.run(nowOpen, open).then(
      (value) => {
        marker.open = false;
        return value;
      },
      (error: unknown) => {
        marker.open = false;
        throw error;
      },
    );

  const previous = tails.get(connection) ?? Promise.resolve();
  const run = previous.then(enter, enter);
  tails.set(connection, run.then(() => undefined, () => undefined));
  return run;
}
