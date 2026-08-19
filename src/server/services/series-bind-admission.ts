import { withBookAdmissionLocks } from './book-admission.js';

/**
 * The series-bind admission protocol (#2447). The bind writes `series_name` / `series_position` /
 * `user_cleared_fields` across a whole match set in one transaction, so unlike every other enrolled
 * mutator it cannot take a single lock at its entry point: the ids to lock are derived from a pool
 * the transaction used to load for itself.
 *
 * The shape is `withFreshClaimLock`'s read → lock → re-read → act-or-re-acquire loop
 * (`../utils/claim-lock.ts`), lifted from one path key to a set of book ids, and bounded the same
 * way. Three alternatives are rejected structurally, not stylistically:
 *
 * - **Acquiring inside the transaction deadlocks.** Every `db.transaction` on the single libSQL
 *   connection is queued behind the connection's tail (`@db/serial-transactions.ts`). A bind holding
 *   that lane while awaiting book X's admission lock would wait on a Fix Match that holds X and is
 *   itself waiting for the lane to open its own transaction. Neither can proceed. This is a strictly
 *   stronger reason than #2369's "never acquire inside a shared write primitive" — do not
 *   "simplify" the acquisition back inside the transaction.
 * - **Acquiring one lock at a time in argument order** deadlocks two overlapping batches; the one
 *   canonical sorted acquisition in `withBookAdmissionLocks` is the answer.
 * - **Validating one pool and letting the transaction load its own** leaves two reads separated by
 *   the transaction-lane enqueue, and nothing orders them. In that gap a mutator holding book Z can
 *   commit `series_name = <target>` and release; the transaction's reload then matches and writes Z
 *   while the bind never held Z's lock. Hence {@link withValidatedBindSet} hands the validated
 *   snapshot to `act`: it is the SOLE authority for what the transaction may write.
 *
 * What this guarantees is `writes ⊆ ids(S) ⊆ held`. What it deliberately does NOT do is freeze the
 * pool globally: a book that acquires the target series name after S is taken is simply not a member
 * of this bind. Not writing it is the correct outcome — writing it is the defect this protocol closes.
 */

/** Mirrors `MAX_CLAIM_KEY_REACQUIRES`: the same bound on the same read/lock/re-read loop. */
export const MAX_BIND_SET_REACQUIRES = 3;

/**
 * Sustained churn: the in-lock snapshot outgrew the held set on every attempt.
 *
 * `lastSetSize` is the size of the last set actually ACQUIRED, never the widened set the final
 * failed attempt computed — that one was never locked and naming it would send an operator hunting
 * contention on books nothing held.
 */
export class SeriesBindChurnError extends Error {
  constructor(public readonly lastSetSize: number) {
    super(
      `Series bind candidates grew on every attempt after ${MAX_BIND_SET_REACQUIRES} re-acquisitions ` +
        `(last attempted set size ${lastSetSize})`,
    );
    this.name = 'SeriesBindChurnError';
  }
}

export interface BindSetProtocol<S, T> {
  /** Pre-lock: decides only WHICH locks to take. None of its values may reach a write. */
  enumerate: () => Promise<readonly number[]>;
  /** In-lock: the authoritative snapshot S, re-read under the held set. */
  snapshot: () => Promise<S>;
  /** Every id S could cause a write to. */
  idsOf: (snapshot: S) => readonly number[];
  /** Runs under the locks, consuming S rather than re-deriving anything from the database. */
  act: (snapshot: S) => Promise<T>;
}

/**
 * Enumerate, acquire, snapshot-and-validate, then act on that same snapshot.
 *
 * Two independent causes can make S exceed the held set — a book newly acquiring the target series
 * name, and a prior series name that changed under the provider fetch and widened the targets — and
 * the single loop covers both. The held set may legitimately be a strict SUPERSET of `ids(S)`
 * (a narrowing prior-name change); holding extra locks is safe and is not an error arm.
 */
export async function withValidatedBindSet<S, T>(protocol: BindSetProtocol<S, T>): Promise<T> {
  const held = new Set(await protocol.enumerate());
  // The size ACQUIRED on the final attempt, not `held.size` at the throw: the last iteration widens
  // `held` and then exhausts the bound, so `held` ends up describing a set no acquisition ever took.
  // An operator reading the 409 is diagnosing contention over books that were actually locked.
  let lastAttemptedSize = held.size;

  for (let attempt = 0; attempt <= MAX_BIND_SET_REACQUIRES; attempt++) {
    const attempted = [...held];
    lastAttemptedSize = attempted.length;
    const outcome = await withBookAdmissionLocks(
      attempted,
      async (): Promise<{ widened: number[] } | { value: T }> => {
        const snapshot = await protocol.snapshot();
        const widened = protocol.idsOf(snapshot).filter((id) => !held.has(id));
        if (widened.length > 0) return { widened };
        return { value: await protocol.act(snapshot) };
      },
    );
    if ('value' in outcome) return outcome.value;
    // Release before re-acquiring: a nested acquisition of the widened set would await keys this
    // level already holds, and the lock is not re-entrant.
    for (const id of outcome.widened) held.add(id);
  }

  throw new SeriesBindChurnError(lastAttemptedSize);
}
