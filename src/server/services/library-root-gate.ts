import type { AppSettings } from '@shared/schemas/settings/registry.js';

/**
 * The process-global half of the locking model. `withBookAdmissionLock` serializes mutators of ONE
 * book; this gate excludes the `library` settings write — which repoints or re-templates the root
 * every book's target is derived from — against the three commits that derive a target from it
 * (import, merge, rename). Two different scopes, so deliberately two different modules: this one
 * lives outside both `book-admission.ts` and `SettingsService`.
 *
 * Three states, and only three: idle, commits-in-flight (`commitsInFlight > 0`), and
 * settings-write-in-flight (`activeSettingsWrite !== null`).
 *
 * **Conflict policy is asymmetric on purpose.** A settings write arriving with commits in flight
 * REFUSES; a commit starting while a settings write is in flight WAITS. Refusing the settings write
 * costs the operator a retry; making an import wait costs it the two DB statements a settings write
 * runs, while refusing the import would fail a completed download and blocking the write could
 * stall for the length of an ffmpeg merge.
 *
 * A second settings write waits rather than refusing — the flag is a mutex, not a rejection gate,
 * and two settings writes have no conflicting effect on a commit. Concurrent commits do not exclude
 * each other at all; per-book serialization is the admission lock's job, so this is a count.
 *
 * Process-local and deliberately not persisted, like every other lock here (SECURITY.md,
 * #769/#877/#885). A restart mid-commit leaves no refusal state behind.
 */

/** Refusal arm: registered flat-409 in `plugins/error-handler.ts`, modeled on `ScanInProgressError`. */
export class LibraryRootBusyError extends Error {
  constructor(public readonly commitsInFlight: number) {
    super(
      `Library settings cannot change while ${commitsInFlight} import, merge or rename ${commitsInFlight === 1 ? 'is' : 'are'} deriving paths from the current root — retry once they finish`,
    );
    this.name = 'LibraryRootBusyError';
  }
}

/** A count, not a mutex: two commits may hold registrations at once and each releases its own. */
let commitsInFlight = 0;
/**
 * How many settings writes are enqueued OR running. The flag a commit waits on is
 * `settingsWriteDepth > 0`, not "a write body is executing": a commit that woke during the handoff
 * from one queued write to the next would register in the gap and get the second write refused,
 * which is exactly the arbitration AC15 rules out.
 */
let settingsWriteDepth = 0;
/** Resolves when `settingsWriteDepth` returns to zero; recreated per busy period. */
let settingsIdle: { promise: Promise<void>; resolve: () => void } | null = null;
/** Tail of the settings-write queue; `null` means idle, which is what keeps the check same-turn. */
let settingsWriteTail: Promise<void> | null = null;

const NOOP = (): void => undefined;

function enterSettingsWriteQueue(): void {
  settingsWriteDepth++;
  if (settingsIdle === null) {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => { resolve = res; });
    settingsIdle = { promise, resolve };
  }
}

function leaveSettingsWriteQueue(): void {
  settingsWriteDepth--;
  if (settingsWriteDepth === 0 && settingsIdle) {
    const idle = settingsIdle;
    settingsIdle = null;
    idle.resolve();
  }
}

/** Reads the `library` category; structural so the gate does not depend on `SettingsService`. */
export interface LibrarySettingsReader {
  get(category: 'library'): Promise<AppSettings['library']>;
}

export interface RootCommitRegistration {
  /** The canonical root read — taken under the registration, so no writer can have interleaved. */
  library: AppSettings['library'];
  /** Idempotent; call from a `finally` or a throwing commit permanently refuses `library` writes. */
  release: () => void;
}

/**
 * Register a root-dependent commit and hand back the root it must use.
 *
 * The order is: wait out any in-flight settings write → register synchronously → THEN read
 * `library`. The read is an `await` and cannot share the registration's turn; it does not need to,
 * because the registration itself protects it — once the count is non-zero any arriving settings
 * write is refused. Centralizing the read here is what makes "the waiting commit observes the new
 * root" hold by construction: no root-dependent mutator reads `library` for itself, so none can
 * forget a stale-root comparison.
 *
 * A failed read releases the registration and rethrows, so the caller takes its existing
 * settings-failure arm holding nothing.
 */
export async function beginRootCommit(settings: LibrarySettingsReader): Promise<RootCommitRegistration> {
  while (settingsWriteDepth > 0) {
    await settingsIdle?.promise;
  }
  // Same turn as the check above: no `await` may be introduced between them.
  commitsInFlight++;

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    commitsInFlight--;
  };

  try {
    const library = await settings.get('library');
    return { library, release };
  } catch (error: unknown) {
    release();
    throw error;
  }
}

/**
 * Wrap the `library` settings write. Refuses with {@link LibraryRootBusyError} when any commit
 * holds a registration; queues behind another settings write rather than refusing it.
 *
 * Not `async`: the idle fast path must observe the counter and claim the flag in the CALLER's turn.
 * An `async` wrapper would defer the check by a microtask, and a commit registering in between
 * would be neither refused nor waited for.
 */
export function withLibraryRootWrite<T>(fn: () => Promise<T>): Promise<T> {
  // Claim the writer flag at ENQUEUE time so it spans the whole queue, not one body.
  enterSettingsWriteQueue();

  const attempt = (): Promise<T> => {
    // Same turn: observe the counter, then start the write, with no `await` between.
    if (commitsInFlight > 0) return Promise.reject(new LibraryRootBusyError(commitsInFlight));
    return fn();
  };

  const previous = settingsWriteTail;
  const run = previous === null ? attempt() : previous.then(attempt, attempt);
  const tail = run.then(NOOP, NOOP);
  settingsWriteTail = tail;
  void tail.then(() => {
    if (settingsWriteTail === tail) settingsWriteTail = null;
    leaveSettingsWriteQueue();
  });
  return run;
}

/** Test-only: the gate's three states are otherwise unobservable, so a leak looks like success. */
export function rootGateState(): { commitsInFlight: number; settingsWriteInFlight: boolean } {
  return { commitsInFlight, settingsWriteInFlight: settingsWriteDepth > 0 };
}

/** Test-only: module-level state survives between cases and would inflate a counterfactual. */
export function resetRootGate(): void {
  commitsInFlight = 0;
  settingsWriteDepth = 0;
  settingsIdle?.resolve();
  settingsIdle = null;
  settingsWriteTail = null;
}
