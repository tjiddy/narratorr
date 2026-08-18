import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db, DbOrTx } from '@db/client.js';
import { books } from '@db/schema.js';
import type { BookStatus } from '@shared/schemas/book.js';
import { BoundedSemaphore } from '@core/utils/bounded-semaphore.js';
import { serializeError } from '../utils/serialize-error.js';
import { withBookAdmissionLock } from './book-admission.js';
import { findCompanionEbookCandidates } from './companion-ebook-discovery.js';
import { isCompanionEbookEligible } from './companion-ebook-eligibility.js';
import type { CompanionEbookObservation } from './companion-ebook-observation.js';
import {
  observeCompanionEbook,
  revalidateCompanionFile,
  statRegularFile,
} from './companion-ebook-observe.js';
import { resolveCompanionEbookPath } from './companion-ebook-open.js';
import { findCompanionEbook, upsertCompanionEbook } from './companion-ebook.repository.js';
import type { SettingsService } from './settings.service.js';
import type { CompanionEbookRow } from './types.js';

// Fixed filesystem concurrency, not an operator-tunable setting.
export const RECONCILE_CONCURRENCY = 4;

// Only sweeps use this; direct user actions rely on the per-book admission lock.
const sweepSemaphore = new BoundedSemaphore(RECONCILE_CONCURRENCY);

type BookDisposition = 'observed' | 'unchanged' | 'retained' | 'conflicted' | 'skipped' | 'failed' | 'stopped';

// Return the transaction's written row; a post-commit read can observe another writer.
type CommitResult = { outcome: 'observed'; row: CompanionEbookRow } | { outcome: 'conflicted' };

export type CompanionSelectionResult =
  | { outcome: 'selected'; row: CompanionEbookRow }
  | { outcome: 'disabled' }
  | { outcome: 'book_missing' }
  | { outcome: 'ineligible' }
  /** The candidate directory is definitively gone. */
  | { outcome: 'gone' }
  /** Listing failed without proving absence; the candidate set is unknown. */
  | { outcome: 'undetermined' }
  | { outcome: 'out_of_range' }
  /** The chosen basename is no longer a contained, readable regular file. */
  | { outcome: 'unresolvable' }
  /** Revalidation could not derive a verdict; the prior observation remains. */
  | { outcome: 'retained' }
  /** The conditional-write precondition no longer matched. */
  | { outcome: 'conflicted' }
  | { outcome: 'stopped' }
  /** An exception was absorbed; the method never rejects. */
  | { outcome: 'failed' };

interface BookSnapshot {
  id: number;
  status: BookStatus;
  path: string | null;
}

// Keep `force` request-scoped so concurrent direct and sweep runs cannot leak it across books.
interface BookRunInput {
  bookId: number;
  enabled: boolean;
  libraryRoot: string;
  force: boolean;
}

// Compare every mutable observation field in TypeScript so nullable columns use null-safe equality.
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

// Keep schema dereferences inside the function; module-level access breaks partial schema mocks.
function bookSnapshotProjection() {
  return { id: books.id, status: books.status, path: books.path };
}

async function readBookSnapshot(x: DbOrTx, bookId: number): Promise<BookSnapshot | null> {
  const rows: BookSnapshot[] = await x
    .select(bookSnapshotProjection())
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);
  return rows[0] ?? null;
}

export class CompanionEbookReconciler {
  private stopping = false;
  private stopPromise?: Promise<void>;
  /** The in-flight run only, not the chain; a queued follow-up is registered when it starts. */
  private activeRun: Promise<void> | null = null;
  /** The caller-facing promise covering the full coalesced chain. */
  private chain: Promise<void> | null = null;
  private followUpQueued = false;
  private readonly activeBookRuns = new Set<Promise<unknown>>();

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Never rejects. Registers synchronously so `stop()` cannot miss work paused at its first await.
   * `force` bypasses fingerprint reuse and is only for explicit single-book refreshes. */
  reconcileBook(bookId: number, force = false): Promise<void> {
    if (this.stopping) return Promise.resolve();
    const run: Promise<void> = this.runDirectBook(bookId, force)
      .finally(() => { this.activeBookRuns.delete(run); });
    this.activeBookRuns.add(run);
    return run;
  }

  /** Never rejects. Concurrent calls join one chain and queue at most one follow-up run. */
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

  /** Never rejects. `index` targets the live discovery list; synchronous registration makes the
   * selection drainable, and user-triggered selections bypass the sweep semaphore. */
  selectCompanionEbook(bookId: number, index: number): Promise<CompanionSelectionResult> {
    if (this.stopping) return Promise.resolve({ outcome: 'stopped' });
    const run: Promise<CompanionSelectionResult> = this.runSelection(bookId, index)
      .finally(() => { this.activeBookRuns.delete(run); });
    this.activeBookRuns.add(run);
    return run;
  }

  /** Intentionally non-async: repeated calls must return the same Promise object. */
  stop(): Promise<void> {
    return (this.stopPromise ??= this.runStop());
  }

  private async runStop(): Promise<void> {
    this.stopping = true;
    // A queued follow-up is not awaited because shutdown prevents it from starting.
    const run = this.activeRun;
    if (run !== null) await run;
    // After the active run settles, `stopping` makes this set a final snapshot.
    await Promise.allSettled([...this.activeBookRuns]);
  }

  private async runChain(): Promise<void> {
    await this.startRun();
    while (this.followUpQueued && !this.stopping) {
      this.followUpQueued = false;
      await this.startRun();
    }
    if (this.followUpQueued) {
      this.followUpQueued = false;
      this.log.debug({}, 'Companion ebook reconcile follow-up discarded on shutdown');
    }
  }

  /** Register synchronously so `stop()` cannot miss a run paused at its first await. */
  private startRun(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    const run: Promise<void> = this.executeRun().finally(() => {
      if (this.activeRun === run) this.activeRun = null;
    });
    this.activeRun = run;
    return run;
  }

  /** Setup failures emit no sweep summary because no row set was accepted. */
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

    // `stop()` may have latched while the prefilter query was awaiting.
    if (this.stopping) {
      this.log.debug({}, 'Companion ebook reconcile sweep abandoned on shutdown');
      return;
    }

    await this.runSweep(bookIds, libraryRoot);
  }

  /** Prefilter IDs only; path and status are re-read under each book's lock. */
  private async selectEligibleBookIds(): Promise<number[]> {
    const rows = await this.db
      .select({ id: books.id })
      .from(books)
      .where(and(eq(books.status, 'imported'), isNotNull(books.path), sql`trim(${books.path}) <> ''`));
    return rows.map((row) => row.id);
  }

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
   * Acquire a sweep slot before the admission lock so queued background work cannot block direct
   * work. Inverting the two would let a queued reconciliation sit on a book's admission lock while
   * waiting for a slot.
   *
   * The cost of that ordering, now that #2369 puts every mutator inside the admission lock: a
   * reconciliation blocked on a held book still consumes one of {@link RECONCILE_CONCURRENCY}
   * slots. One long hold — a merge, a mass copy — leaves three, and four concurrently-held books
   * saturate the semaphore and stall the rest of the sweep for as long as those holds last. That is
   * the accepted bound, not an unbounded stall: the sweep is idempotent background work and drains
   * when a hold releases. No timeout, abandonment or lock-stealing is introduced to shorten it.
   */
  private async sweepBook(bookId: number, libraryRoot: string): Promise<BookDisposition> {
    if (this.stopping) return 'stopped';
    const release = await sweepSemaphore.acquire();
    try {
      return await this.acceptBookRun({ bookId, enabled: true, libraryRoot, force: false });
    } finally {
      release();
    }
  }

  /** Register synchronously so shutdown cannot miss a book run paused at its first await. */
  private acceptBookRun(input: BookRunInput): Promise<BookDisposition> {
    if (this.stopping) return Promise.resolve('stopped');
    const run: Promise<BookDisposition> = this.runBook(input)
      .finally(() => { this.activeBookRuns.delete(run); });
    this.activeBookRuns.add(run);
    return run;
  }

  private async runDirectBook(bookId: number, force: boolean): Promise<void> {
    let libraryRoot: string;
    try {
      const { enabled } = await this.settings.get('companionEpub');
      if (!enabled) return;
      libraryRoot = (await this.settings.get('library')).path;
    } catch (error: unknown) {
      this.log.warn({ bookId, error: serializeError(error) }, 'Companion ebook reconcile setup failed');
      return;
    }
    await this.runBook({ bookId, enabled: true, libraryRoot, force });
  }

  /** Acquire the non-reentrant admission lock exactly once on this path. */
  private async runBook(input: BookRunInput): Promise<BookDisposition> {
    const { bookId } = input;
    try {
      return await withBookAdmissionLock(bookId, () => this.reconcileLocked(input));
    } catch (error: unknown) {
      // The sweep's info summary exposes failures; per-book detail stays at debug.
      this.log.debug({ bookId, error: serializeError(error) }, 'Companion ebook reconcile failed for book');
      return 'failed';
    }
  }

  /** Keep snapshot/prior reads, validation, and the guarded write inside the lock. Hoisting a read
   * lets concurrent passes compare stale state and discard the newer observation. */
  private async reconcileLocked(input: BookRunInput): Promise<BookDisposition> {
    const { bookId, enabled, libraryRoot, force } = input;

    // Shutdown may have latched while this run waited for the lock.
    if (this.stopping) return 'stopped';

    const snapshot = await readBookSnapshot(this.db, bookId);
    if (snapshot === null) return 'skipped';

    const prior = await findCompanionEbook(this.db, bookId);

    const eligible = await isCompanionEbookEligible(
      { enabled, book: { id: bookId, status: snapshot.status, path: snapshot.path }, libraryRoot },
      this.log,
    );
    // Do not clear stale rows; exposure independently requires imported status.
    if (!eligible) return 'skipped';

    const result = await observeCompanionEbook(
      { bookId, bookPath: snapshot.path!, libraryRoot, prior, force },
      this.log,
    );
    if (result.outcome === 'unchanged') return 'unchanged';
    if (result.outcome === 'retain') return 'retained';

    const committed = await this.commitObservation(bookId, snapshot, prior, result.observation);
    return committed.outcome === 'conflicted' ? 'conflicted' : 'observed';
  }

  /** Read process-wide settings before the lock; all per-book state in the write guard stays inside. */
  private async runSelection(bookId: number, index: number): Promise<CompanionSelectionResult> {
    let libraryRoot: string;
    try {
      const { enabled } = await this.settings.get('companionEpub');
      if (!enabled) return { outcome: 'disabled' };
      libraryRoot = (await this.settings.get('library')).path;
    } catch (error: unknown) {
      this.log.warn({ bookId, error: serializeError(error) }, 'Companion ebook selection setup failed');
      return { outcome: 'failed' };
    }

    try {
      return await withBookAdmissionLock(bookId, () => this.selectLocked(bookId, index, libraryRoot));
    } catch (error: unknown) {
      this.log.debug({ bookId, error: serializeError(error) }, 'Companion ebook selection failed for book');
      return { outcome: 'failed' };
    }
  }

  /** Discover once and carry the selected basename through resolution and revalidation; rediscovery
   * could silently repoint the owner's index. Resolver containment and fingerprint stats stay separate. */
  private async selectLocked(
    bookId: number,
    index: number,
    libraryRoot: string,
  ): Promise<CompanionSelectionResult> {
    // Drain re-check after the lock: no filesystem or DB work starts once stopping is latched.
    if (this.stopping) return { outcome: 'stopped' };

    const snapshot = await readBookSnapshot(this.db, bookId);
    if (snapshot === null) return { outcome: 'book_missing' };

    const prior = await findCompanionEbook(this.db, bookId);

    const eligible = await isCompanionEbookEligible(
      { enabled: true, book: { id: bookId, status: snapshot.status, path: snapshot.path }, libraryRoot },
      this.log,
    );
    if (!eligible) return { outcome: 'ineligible' };

    const bookPath = snapshot.path!;
    const discovery = await findCompanionEbookCandidates({ bookId, bookPath }, this.log);
    if (discovery.outcome !== 'ok') return { outcome: discovery.outcome };

    // Range-check the live list, never the stored candidate count.
    const { candidates } = discovery;
    if (index < 0 || index >= candidates.length) return { outcome: 'out_of_range' };
    const filename = candidates[index]!;

    const resolved = await resolveCompanionEbookPath({ bookId, bookPath, filename, libraryRoot }, this.log);
    if (resolved.outcome !== 'ok') return { outcome: 'unresolvable' };

    const before = await statRegularFile(bookId, resolved.path, this.log);
    if (before === null) return { outcome: 'unresolvable' };

    const revalidated = await revalidateCompanionFile(
      { bookId, path: resolved.path, filename, selected: true, candidateCount: candidates.length, before },
      this.log,
    );
    if (revalidated.outcome === 'retain') return { outcome: 'retained' };

    // Use the actual prior row so both conditional-write preconditions remain effective.
    const committed = await this.commitObservation(bookId, snapshot, prior, revalidated.observation);
    if (committed.outcome === 'conflicted') return { outcome: 'conflicted' };

    // Direct selections need an info audit; sweeps use one aggregate info record.
    // Never log the resolved path or library root.
    this.log.info(
      { bookId, filename, status: committed.row.status, candidateCount: candidates.length },
      'Companion ebook selection persisted',
    );
    return { outcome: 'selected', row: committed.row };
  }

  /** Re-read both guards transactionally; rename/import/rejection can change the book without this
   * admission lock. Filesystem work stays outside; the shared connection serializes transactions. */
  private async commitObservation(
    bookId: number,
    snapshot: BookSnapshot,
    prior: CompanionEbookRow | null,
    observation: CompanionEbookObservation,
  ): Promise<CommitResult> {
    return this.db.transaction(async (tx) => {
      const current = await readBookSnapshot(tx, bookId);
      if (current === null || current.path !== snapshot.path || current.status !== snapshot.status) {
        this.log.debug({ bookId, reason: 'book-changed' }, 'Companion ebook observation write aborted');
        return { outcome: 'conflicted' };
      }

      const currentRow = await findCompanionEbook(tx, bookId);
      if (!sameObservationRow(prior, currentRow)) {
        this.log.debug({ bookId, reason: 'observation-changed' }, 'Companion ebook observation write aborted');
        return { outcome: 'conflicted' };
      }

      // Return `.returning()` directly; a post-commit read can observe another writer.
      const row = await upsertCompanionEbook(tx, bookId, observation);
      return { outcome: 'observed', row };
    });
  }
}
