import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db, DbOrTx } from '../../db/client.js';
import { books } from '../../db/schema.js';
import type { BookStatus } from '../../shared/schemas/book.js';
import { Semaphore } from '../utils/semaphore.js';
import { serializeError } from '../utils/serialize-error.js';
import { withBookAdmissionLock } from './book-admission.js';
import { isCompanionEbookEligible } from './companion-ebook-eligibility.js';
import type { CompanionEbookObservation } from './companion-ebook-observation.js';
import { observeCompanionEbook } from './companion-ebook-observe.js';
import { findCompanionEbook, upsertCompanionEbook } from './companion-ebook.repository.js';
import type { SettingsService } from './settings.service.js';
import type { CompanionEbookRow } from './types.js';

/**
 * The companion-ebook reconciler (#1959, plan §6): the per-book locked pass, the conditional
 * write, the bounded-concurrency sweep, the coalescing runner, and the shutdown drain.
 *
 * **No trigger call sites live here.** Scan, cron, import completion, per-book Refresh & Scan,
 * the rename callers, and rejection are all #1960's.
 *
 * **Three units, used consistently below.** A *run* is one execution of `reconcileAll()`, from
 * the instant the call is accepted until it finishes; its setup phase (both settings reads and
 * the eligible-ids prefilter) is inside it. A *sweep* is the per-book phase of a run, beginning
 * at the instant the run ACCEPTS the prefilter's row set — after the shutdown re-check, not
 * merely when the query returns. A *book run* is one per-book pass, sweep-owned or direct.
 * Coalescing and the drain key on the run; the summary keys on the sweep. That split leaves no
 * interval in which a call has been accepted but belongs to nothing.
 *
 * **Neither public method ever rejects.** #1960's seams call them fire-and-forget behind an
 * already-returned response, so a throw would be unobservable by the caller and would surface
 * only as an unhandled rejection (fire-and-forget-preflight).
 */

/**
 * A fixed bound, deliberately not a setting: no registry entry, no env var. Four concurrent
 * per-book passes is a filesystem-shaped constant, not an operator-tunable one.
 */
export const RECONCILE_CONCURRENCY = 4;

/**
 * Bounds SWEEP runs only. A direct `reconcileBook()` takes no slot — it is user-triggered by
 * #1960's route and rename seams, must not queue behind a background sweep, and is already
 * serialized per book by the admission lock.
 */
const sweepSemaphore = new Semaphore(RECONCILE_CONCURRENCY);

/** The seven terminal dispositions of a book run. Every book in a sweep gets exactly one. */
type BookDisposition = 'observed' | 'unchanged' | 'retained' | 'conflicted' | 'skipped' | 'failed' | 'stopped';

/**
 * The `books` columns the AC19 precondition compares — read inside the lock, re-read in the tx.
 *
 * `status` carries the canonical `BookStatus`, not a widened `string`: it is handed straight to
 * `isCompanionEbookEligible`, whose input names the same type, so a drift between the column's
 * enum and the shared union has to fail at compile time here rather than be cast away.
 */
interface BookSnapshot {
  id: number;
  status: BookStatus;
  path: string | null;
}

/**
 * The EIGHT `companion_ebooks` columns the precondition compares. `validation_code` is not
 * optional: it is a material verdict field the repository writes for every `invalid`
 * observation, and it is the one column that can differ while the other seven agree — so a
 * seven-column guard would let a concurrent writer's verdict be silently overwritten.
 *
 * The comparison runs in TypeScript, where `null === null` holds, rather than in SQL, where
 * `= NULL` yields `NULL` and a nullable-column guard silently passes.
 */
function sameObservationRow(a: CompanionEbookRow | null, b: CompanionEbookRow | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.status === b.status &&
    a.filename === b.filename &&
    a.sizeBytes === b.sizeBytes &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.validationCode === b.validationCode &&
    a.candidateCount === b.candidateCount &&
    a.selectedFilename === b.selectedFilename
  );
}

/** `books` projection, built in a function body — a module-level column deref breaks any suite
 * that partial-mocks `db/schema` (drizzle-schema-toplevel-deref-breaks-partial-mocks). */
function bookSnapshotProjection() {
  return { id: books.id, status: books.status, path: books.path };
}

/**
 * No cast on the way out: the projection's inferred row type has to be assignable to
 * `BookSnapshot`, so a `books.status` enum change that no longer matches `BookStatus` fails
 * here at compile time instead of being laundered through the call site.
 */
async function readBookSnapshot(x: DbOrTx, bookId: number): Promise<BookSnapshot | null> {
  const rows: BookSnapshot[] = await x
    .select(bookSnapshotProjection())
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);
  return rows[0] ?? null;
}

export class CompanionEbookReconciler {
  /** Latched by `stop()`; checked immediately before each of the three points work begins. */
  private stopping = false;
  private stopPromise?: Promise<void>;
  /** The in-flight RUN — not the chain. A discarded follow-up is never registered here. */
  private activeRun: Promise<void> | null = null;
  /** The promise joined callers receive: settles when the whole chain settles. */
  private chain: Promise<void> | null = null;
  private followUpQueued = false;
  private readonly activeBookRuns = new Set<Promise<unknown>>();

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly log: FastifyBaseLogger,
  ) {}

  /**
   * Reconcile one book. Never rejects.
   *
   * The book run is registered SYNCHRONOUSLY, before the first settings read, so a `stop()`
   * landing in the same turn cannot miss a run parked on its first `await`.
   */
  reconcileBook(bookId: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    const run: Promise<void> = this.runDirectBook(bookId).finally(() => { this.activeBookRuns.delete(run); });
    this.activeBookRuns.add(run);
    return run;
  }

  /**
   * Reconcile every eligible book. Never rejects.
   *
   * At most one run is in flight and at most one follow-up is queued, so N calls arriving
   * during an in-flight run — in its setup phase or its sweep phase — produce exactly ONE
   * additional run. A call arriving during setup queues a follow-up rather than merely joining:
   * the in-flight run's prefilter may already have been issued before the change that prompted
   * the new call. There is no debounce — the method takes no arguments and has nothing to batch.
   */
  reconcileAll(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.chain !== null) {
      this.followUpQueued = true;
      return this.chain;
    }
    const chain: Promise<void> = this.runChain().finally(() => {
      if (this.chain === chain) this.chain = null;
    });
    this.chain = chain;
    return chain;
  }

  /**
   * Drain every accepted run and every accepted book run, then resolve.
   *
   * **Memoized AND non-`async`, deliberately.** `const a = stop(); const b = stop();` must yield
   * the literal same Promise object. An `async` method allocates a fresh outer promise on every
   * call and `await`s the memoized inner one, so identity does not survive even though the
   * drain is correctly memoized — which is why this copies the STRUCTURE of
   * `ConnectorRefreshQueue.stop()` and not its `async` keyword.
   */
  stop(): Promise<void> {
    return (this.stopPromise ??= this.runStop());
  }

  private async runStop(): Promise<void> {
    this.stopping = true;
    // Await the whole in-flight run, still in setup or already sweeping. A queued follow-up is
    // NOT awaited: it never starts, so there is nothing to drain.
    const run = this.activeRun;
    if (run !== null) await run;
    // After the run settles no sweep can add a book run and the flag already refuses direct
    // ones, so this snapshot is final and the drain terminates. Direct calls with no sweep
    // active are in here too, which is what keeps `app.close()` off an outstanding write.
    await Promise.allSettled([...this.activeBookRuns]);
  }

  // -------------------------------------------------------------------------
  // The run chain
  // -------------------------------------------------------------------------

  private async runChain(): Promise<void> {
    await this.startRun();
    while (this.followUpQueued && !this.stopping) {
      this.followUpQueued = false;
      await this.startRun();
    }
    if (this.followUpQueued) {
      this.followUpQueued = false;
      // Routine shutdown behaviour requiring no operator action, unlike a setup failure. A
      // follow-up exists only to re-observe books that may have changed while the sweep before
      // it ran; at shutdown every one of them would return `stopped` at the post-lock re-check.
      this.log.debug({}, 'Companion ebook reconcile follow-up discarded on shutdown');
    }
  }

  /** Check 1 for a run: accept, then register synchronously before the first `await`. */
  private startRun(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    const run: Promise<void> = this.executeRun().finally(() => {
      if (this.activeRun === run) this.activeRun = null;
    });
    this.activeRun = run;
    return run;
  }

  /**
   * One run: setup, then — if the drain has not intervened — the sweep phase.
   *
   * A rejection from either settings read or from the prefilter happens BEFORE the sweep-start
   * instant, so no sweep begins and no summary is emitted: there is no accepted row set to be
   * the `books` denominator, and fabricating one would falsely satisfy the total invariant.
   * `warn` rather than `debug` because a settings or DB read failing is a real fault, and with
   * no summary emitted it is the only signal that a scheduled sweep did not happen.
   */
  private async executeRun(): Promise<void> {
    let libraryRoot: string;
    let bookIds: number[];
    try {
      const { enabled } = await this.settings.get('companionEpub');
      if (!enabled) return;
      libraryRoot = (await this.settings.get('library')).path;
      bookIds = await this.selectEligibleBookIds();
    } catch (error: unknown) {
      this.log.warn({ error: serializeError(error) }, 'Companion ebook reconcile sweep setup failed');
      return;
    }

    // Check 2 — crossing into the sweep phase. The prefilter RETURNING is a precondition for
    // the sweep-start instant, not the instant itself: the two are one `await` apart and this
    // check sits in the gap. Anchoring on the return would start a sweep `stop()` had already
    // forbidden.
    if (this.stopping) {
      this.log.debug({}, 'Companion ebook reconcile sweep abandoned on shutdown');
      return;
    }

    await this.runSweep(bookIds, libraryRoot);
  }

  /**
   * The AC21 prefilter — book IDS ONLY, never a snapshot. The authoritative `path`/`status`
   * are re-read per book inside the lock by the same code path a direct `reconcileBook()` uses;
   * passing this query's already-stale row down would reopen, for every book in the sweep,
   * exactly the race the locked re-read closes.
   */
  private async selectEligibleBookIds(): Promise<number[]> {
    const rows = await this.db
      .select({ id: books.id })
      .from(books)
      .where(and(eq(books.status, 'imported'), isNotNull(books.path), sql`trim(${books.path}) <> ''`));
    return rows.map((row) => row.id);
  }

  /**
   * The sweep phase. Begins at the instant the run accepted `bookIds`; ends when every one of
   * them has reached a terminal disposition, at which point exactly one `info` summary is
   * emitted. Per-book detail stays at `debug`, so a sweep is replayable under `LOG_LEVEL=debug`
   * without being noisy at the default level.
   */
  private async runSweep(bookIds: number[], libraryRoot: string): Promise<void> {
    const startedAt = Date.now();
    const counts: Record<BookDisposition, number> = {
      observed: 0, unchanged: 0, retained: 0, conflicted: 0, skipped: 0, failed: 0, stopped: 0,
    };

    await Promise.all(bookIds.map(async (bookId) => {
      counts[await this.sweepBook(bookId, libraryRoot)] += 1;
    }));

    this.log.info(
      { books: bookIds.length, ...counts, durationMs: Date.now() - startedAt },
      'Companion ebook reconcile sweep complete',
    );
  }

  /**
   * Acquisition order is semaphore → admission lock, never the reverse: taking the per-book
   * lock first and then queueing for a slot would let four slot-holders wait behind a book
   * whose lock is held by a slow grab while the rest of the library sits idle.
   */
  private async sweepBook(bookId: number, libraryRoot: string): Promise<BookDisposition> {
    if (this.stopping) return 'stopped';
    await sweepSemaphore.acquire();
    try {
      return await this.acceptBookRun(bookId, true, libraryRoot);
    } finally {
      sweepSemaphore.release();
    }
  }

  /** Check 1 for a book run: accept, then register synchronously before the first `await`. */
  private acceptBookRun(bookId: number, enabled: boolean, libraryRoot: string): Promise<BookDisposition> {
    if (this.stopping) return Promise.resolve('stopped');
    const run: Promise<BookDisposition> = this.runBook(bookId, enabled, libraryRoot)
      .finally(() => { this.activeBookRuns.delete(run); });
    this.activeBookRuns.add(run);
    return run;
  }

  /** The direct path. Only it reads settings per call; the sweep hoists both reads to its run. */
  private async runDirectBook(bookId: number): Promise<void> {
    let libraryRoot: string;
    try {
      const { enabled } = await this.settings.get('companionEpub');
      if (!enabled) return;
      libraryRoot = (await this.settings.get('library')).path;
    } catch (error: unknown) {
      this.log.warn({ bookId, error: serializeError(error) }, 'Companion ebook reconcile setup failed');
      return;
    }
    // The disposition is discarded here; only the sweep sums it.
    await this.runBook(bookId, true, libraryRoot);
  }

  /**
   * One book run. Resolves to exactly one disposition from a single exit point, which is what
   * makes the summary's total invariant a property of the code rather than of counters
   * incremented at seven scattered exits.
   *
   * The lock is acquired EXACTLY ONCE and nothing on this path re-acquires it —
   * `withBookAdmissionLock` is non-reentrant and a second acquisition self-deadlocks.
   */
  private async runBook(bookId: number, enabled: boolean, libraryRoot: string): Promise<BookDisposition> {
    try {
      return await withBookAdmissionLock(bookId, () => this.reconcileLocked(bookId, enabled, libraryRoot));
    } catch (error: unknown) {
      // `debug`, not `warn`: a per-book failure is already `info`-visible through the summary's
      // `failed` counter, so the operator has the signal without the per-book noise.
      this.log.debug({ bookId, error: serializeError(error) }, 'Companion ebook reconcile failed for book');
      return 'failed';
    }
  }

  /**
   * Everything below runs while the admission lock is held: the `books` snapshot read, the
   * prior-observation read, the eligibility check, the filesystem pass, and the guarded write.
   *
   * **None of those reads may be hoisted out.** Two concurrent calls would both read
   * `prior = P0`; the first commits `P1`; the second — having observed NEWER bytes — aborts on
   * a precondition that no longer matches, and the newest observation is silently dropped.
   * `withBookAdmissionLock` serializes only its callback, so a read placed before it is not
   * serialized at all.
   *
   * Holding the lock across validation is deliberate: locking only the write would let two
   * passes duplicate the filesystem work and would reopen that same race, while per-book
   * isolation already bounds the blast radius of a slow parse.
   */
  private async reconcileLocked(bookId: number, enabled: boolean, libraryRoot: string): Promise<BookDisposition> {
    // Check 3 — starting a book run's work, immediately after acquiring the lock. Zero
    // filesystem and zero DB work happens after this point when the drain has begun.
    if (this.stopping) return 'stopped';

    const snapshot = await readBookSnapshot(this.db, bookId);
    if (snapshot === null) return 'skipped';

    const prior = await findCompanionEbook(this.db, bookId);

    const eligible = await isCompanionEbookEligible(
      { enabled, book: { id: bookId, status: snapshot.status, path: snapshot.path }, libraryRoot },
      this.log,
    );
    // No write at all — never a zeroing one. The exposure predicate's
    // `books.status === 'imported'` term already neutralises a stale row.
    if (!eligible) return 'skipped';

    const result = await observeCompanionEbook(
      { bookId, bookPath: snapshot.path!, libraryRoot, prior },
      this.log,
    );
    // A no-op pass is a TRUE no-op: no transaction, and not even an `updated_at` touch. Nothing
    // reads `updated_at` for exposure.
    if (result.outcome === 'unchanged') return 'unchanged';
    if (result.outcome === 'retain') return 'retained';

    return this.commitObservation(bookId, snapshot, prior, result.observation);
  }

  /**
   * The conditional write: one transaction, two precondition re-reads, then the upsert.
   *
   * The expected fingerprint is the PRE-SCAN one — the row read inside the lock before the
   * filesystem pass began, not the newly computed one. Term 1 is load-bearing on its own:
   * rename, import, and rejection all write `books.path`/`books.status` WITHOUT holding the
   * admission lock, so the lock alone cannot cover it. Term 2 is defence in depth against a
   * second writer.
   *
   * Nothing here serializes the transaction, deliberately. A libSQL connection permits one
   * transaction at a time and `createServices` hands the same `Db` to every service, but that
   * exclusion is enforced by the connection itself (`db/serial-transactions.ts`), not by callers
   * opting in — so the four concurrent per-book passes queue here automatically, and so does any
   * other service's transaction. Discovery, validation, and both pre-scan reads stay outside the
   * transaction, which is where a sweep actually spends its time.
   */
  private async commitObservation(
    bookId: number,
    snapshot: BookSnapshot,
    prior: CompanionEbookRow | null,
    observation: CompanionEbookObservation,
  ): Promise<BookDisposition> {
    return this.db.transaction(async (tx) => {
      const current = await readBookSnapshot(tx, bookId);
      if (current === null || current.path !== snapshot.path || current.status !== snapshot.status) {
        this.log.debug({ bookId, reason: 'book-changed' }, 'Companion ebook observation write aborted');
        return 'conflicted';
      }

      const currentRow = await findCompanionEbook(tx, bookId);
      if (!sameObservationRow(prior, currentRow)) {
        this.log.debug({ bookId, reason: 'observation-changed' }, 'Companion ebook observation write aborted');
        return 'conflicted';
      }

      await upsertCompanionEbook(tx, bookId, observation);
      return 'observed';
    });
  }
}
