import type { FastifyBaseLogger } from 'fastify';
import {
  ConnectorRequestError,
  requestWithRetry,
  type ConnectorImportItem,
  type ConnectorReason,
  type ConnectorRefreshResult,
} from '../../core/connectors/index.js';
import { serializeError } from '../utils/serialize-error.js';
import { CONNECTOR_TIMEOUT_MS, CONNECTOR_SHUTDOWN_DRAIN_MS } from '../../core/utils/constants.js';

export interface ConnectorRefreshQueueOptions {
  /** Debounce window before a coalesced burst flushes (ms). */
  debounceMs?: number;
  /** Backoff before the single retry of a failed flush (ms). */
  backoffMs?: number;
  /** Outer per-attempt guard around the flush run (ms). 0 disables the outer guard. */
  flushTimeoutMs?: number;
  /**
   * Hard cap on items in a pending batch. Reaching it flushes IMMEDIATELY
   * (without resetting the debounce timer) — bounds memory for path-scoped
   * providers (e.g. Plex) that consume every item.
   */
  maxBatchItems?: number;
  /**
   * Hard max-wait ceiling measured from the batch's FIRST enqueue. The per-item
   * debounce reset cannot push past it — a sustained burst still flushes here.
   */
  maxBatchWaitMs?: number;
  /**
   * Hard cap on how long `stop()` waits for in-flight flushes to drain on
   * shutdown (ms). Defaults to `CONNECTOR_SHUTDOWN_DRAIN_MS`. Injectable so tests
   * can use a tiny budget; production always uses the constant.
   */
  shutdownDrainMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 2_000;
const DEFAULT_BACKOFF_MS = 1_000;
// Outer service guard, longer than the adapter request timeout (F9 layering):
// fetchWithTimeout bounds each HTTP request; this only fires if an attempt hangs.
const DEFAULT_FLUSH_TIMEOUT_MS = CONNECTOR_TIMEOUT_MS + 5_000;
const DEFAULT_MAX_BATCH_ITEMS = 500;
const DEFAULT_MAX_BATCH_WAIT_MS = 30_000;

export interface PendingFlush {
  connectorId: number;
  // Every reason coalesced into this entry, deduplicated and first-seen order-stable.
  // The pending key is the connector id alone, so a mixed-reason burst (import +
  // restored during a bulk run) accumulates here as ONE entry → one provider refresh,
  // instead of splitting into a separate single-reason flush per reason.
  reasons: ConnectorReason[];
  items: ConnectorImportItem[];
  // Trailing quiet-period timer, reset on each enqueue.
  timer: ReturnType<typeof setTimeout>;
  // Non-resetting max-wait deadline timer, set once at first enqueue.
  deadlineTimer: ReturnType<typeof setTimeout>;
}

/** Connector-row-derived log fields, assembled by the resolver (the queue has no row access). */
export interface ConnectorLogContext {
  connectorId: number;
  connectorType: string;
  connectorName: string;
  /** `redactBaseUrl(connector.settings)` — host-only, credential-free. */
  url: string;
}

/**
 * The one channel through which the queue touches connector/adapter/DB state.
 * Returns the resolved flush (adapter request plan + log context + the provider
 * call), `null` to skip (disabled/not-found at flush time), or throws — carrying a
 * `ConnectorLogContext` via `FlushResolutionError` when the row was resolved
 * before the failure, so the queue can log the full connector-derived context.
 */
export interface ResolvedFlush {
  // adapter.estimateRequestCount(batch) — feeds the queue's withTimeout budget scaling.
  requestCount: number;
  // Connector-derived context; the queue merges { reasons, count } from the entry.
  logContext: ConnectorLogContext;
  // The provider call. The queue supplies the composed abort signal
  // (per-attempt timeout ∨ shutdown).
  run: (signal: AbortSignal) => Promise<ConnectorRefreshResult>;
}

export type ResolveFlush = (entry: PendingFlush) => Promise<ResolvedFlush | null>;

/**
 * A resolver failure that occurred AFTER the connector row was resolved (e.g.
 * `getAdapter` throwing on drifted settings / unknown type, `estimateRequestCount`
 * throwing). Carries the connector-derived `logContext` so the queue's failed-flush
 * warn reproduces the FULL fields (type/name/url), matching the pre-extraction
 * `connector?.…` catch that logged them whenever the row was already in hand.
 */
export class FlushResolutionError extends Error {
  constructor(readonly logContext: ConnectorLogContext, readonly cause: unknown) {
    super('Connector flush resolution failed');
    this.name = 'FlushResolutionError';
  }
}

/**
 * BEST-EFFORT, IN-MEMORY refresh queue: debounce, per-connector serialization,
 * single retry, scaled timeout, and bounded drain-on-shutdown. Pending work lives
 * only as setTimeout timers — there is no durable backing. `stop()` drains
 * in-flight flushes on graceful shutdown, but a hard crash (SIGKILL/OOM) or a
 * refresh still inside its debounce window is dropped by design. The downstream
 * media server (ABS/Plex) reconciles on its own next library change or periodic
 * scan, so a lost refresh is self-healing — a durable queue would be
 * over-engineering for a self-hosted single-process app (see #769/#877/#885).
 *
 * Owns NO DB, adapter cache, or connector-CRUD knowledge: connector/adapter state
 * reaches it ONLY through the injected `resolveFlush` callback.
 */
export class ConnectorRefreshQueue {
  // Pending debounce batches, keyed by connector id (as a string).
  private pending = new Map<string, PendingFlush>();
  // Set by stop() so any post-shutdown enqueue() is a no-op (mirrors
  // ImportQueueWorker's `stopping` flag).
  private stopping = false;
  // Per-connector-id tail of the in-flight flush chain. Serializes flushes for
  // the SAME connector (a cap-triggered flush chains behind any in-flight one)
  // while keeping DIFFERENT connector ids fully parallel. Keyed by connectorId —
  // the same dimension the pending queue debounces on, so a connector's coalesced
  // mixed-reason batch serializes against its own follow-up flushes.
  private draining = new Map<number, Promise<void>>();
  // Aborted by stop() when the shutdown drain budget expires. Composed into every
  // in-flight attempt's signal (see withTimeout) and threaded into requestWithRetry
  // so the awaiting request AND any pending retry/backoff unwind at the deadline —
  // a deadline abort is terminal (non-retryable), unlike a scaled-timeout abort.
  private readonly shutdownSignal = new AbortController();
  // Memoizes the stop() drain so a second call is a true no-op (returns the same
  // promise) and never re-runs the pending-drop / deadline-warn path.
  private stopPromise?: Promise<void>;
  private readonly debounceMs: number;
  private readonly backoffMs: number;
  private readonly flushTimeoutMs: number;
  private readonly maxBatchItems: number;
  private readonly maxBatchWaitMs: number;
  private readonly shutdownDrainMs: number;

  constructor(
    private readonly resolveFlush: ResolveFlush,
    private readonly log: FastifyBaseLogger,
    opts: ConnectorRefreshQueueOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.flushTimeoutMs = opts.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
    this.maxBatchItems = opts.maxBatchItems ?? DEFAULT_MAX_BATCH_ITEMS;
    this.maxBatchWaitMs = opts.maxBatchWaitMs ?? DEFAULT_MAX_BATCH_WAIT_MS;
    this.shutdownDrainMs = opts.shutdownDrainMs ?? CONNECTOR_SHUTDOWN_DRAIN_MS;
  }

  /**
   * Add one item to the debounced batch for `connectorId`. The debounce key is the
   * connector id ALONE — distinct reasons for the same connector coalesce into one
   * window and flush as a single batch carrying the union of items and the set of
   * reasons. ABS issues one full-library scan regardless of reason, so this collapses
   * what used to be one redundant scan per reason during mixed bursts (import +
   * rename/restored) into one.
   *
   * Upper bounds pre-empt the trailing debounce flush: reaching `maxBatchItems`
   * flushes immediately, and a `maxBatchWaitMs` deadline (set once at first
   * enqueue, never reset) caps how long a sustained burst can defer the flush.
   * Whichever condition fires first flushes the batch.
   */
  enqueue(connectorId: number, reason: ConnectorReason, item: ConnectorImportItem): void {
    // Post-stop enqueues are dropped: shutdown is in progress and there is no
    // future flush to schedule. Best-effort semantics — see the class comment.
    if (this.stopping) return;
    const key = String(connectorId);
    const existing = this.pending.get(key);
    if (existing) {
      existing.items.push(item);
      // Track the reason on the coalesced entry — deduplicated, first-seen order-stable.
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      if (existing.items.length >= this.maxBatchItems) {
        // Cap reached: flush now (flush() clears both timers), do NOT reset debounce.
        void this.flush(key);
        return;
      }
      clearTimeout(existing.timer);
      existing.timer = this.armTimer(() => { void this.flush(key); }, this.debounceMs);
      return;
    }
    const entry: PendingFlush = {
      connectorId,
      reasons: [reason],
      items: [item],
      timer: this.armTimer(() => { void this.flush(key); }, this.debounceMs),
      deadlineTimer: this.armTimer(() => { void this.flush(key); }, this.maxBatchWaitMs),
    };
    this.pending.set(key, entry);
    // Edge: maxBatchItems === 1 means the first item already hits the cap.
    if (entry.items.length >= this.maxBatchItems) void this.flush(key);
  }

  /**
   * Create a queue timer that does NOT keep the event loop alive. Every
   * refresh-queue `setTimeout` (debounce, deadline, and the request-timeout
   * watchdog in `withTimeout`) is armed through here so a pending timer can't
   * delay graceful shutdown past SIGTERM — `stop()` clears or awaits the work,
   * the timer itself must never be the thing holding the process open.
   */
  private armTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  }

  /**
   * BOUNDED graceful drain for shutdown (mirrors `ImportQueueWorker.stop()`):
   *  1. set the stopping flag so any further `enqueue()` is a no-op AND any
   *     chained (not-yet-started) draining tail short-circuits in `executeFlush`,
   *  2. clear all pending debounce + deadline timers and DROP their batches —
   *     warn-logging each so a lost refresh is visible (connector id + count),
   *  3. race the in-flight `draining` flushes against `shutdownDrainMs`: a flush
   *     mid-request OR mid-retry-backoff that settles inside the budget drains
   *     normally; at the deadline the shutdown signal is aborted (cancelling the
   *     awaiting request + any pending backoff) and the still-draining connectors
   *     are warn-logged as dropped.
   *
   * This bounds stop() — and therefore the whole graceful-shutdown sequence — to
   * `shutdownDrainMs` regardless of the scaled per-attempt `withTimeout` budget,
   * which can otherwise run to minutes for a large multi-path Plex batch (#1512).
   *
   * Never throws: `executeFlush` already absorbs its own errors, and the in-flight
   * await uses `Promise.allSettled` so a failing flush can't reject shutdown.
   * Idempotent — memoized, so a second call returns the same promise and never
   * re-drops pending or re-warns the deadline.
   */
  async stop(): Promise<void> {
    this.stopPromise ??= this.runStop();
    return this.stopPromise;
  }

  private async runStop(): Promise<void> {
    this.stopping = true;

    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      clearTimeout(entry.deadlineTimer);
      this.log.warn(
        { connectorId: entry.connectorId, reasons: entry.reasons, count: entry.items.length },
        'Connector refresh dropped on shutdown',
      );
    }
    this.pending.clear();

    const inFlight = [...this.draining.values()];
    if (inFlight.length === 0) return;

    this.log.info({ count: inFlight.length }, 'Awaiting in-flight connector refreshes before shutdown…');
    await this.drainInFlight(inFlight);
  }

  /**
   * Race the in-flight flushes against the shutdown drain budget. On a clean drain
   * (all settle first) returns quietly; on deadline expiry it aborts in-flight
   * attempts (so the awaiting requests + backoff sleeps unwind promptly) and warns
   * about whatever connector ids are still draining. `draining` self-prunes via
   * each flush's `.finally`, so its remaining keys at the deadline ARE the set
   * that failed to drain in time.
   */
  private async drainInFlight(inFlight: Promise<void>[]): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'deadline'>((resolve) => {
      timer = this.armTimer(() => resolve('deadline'), this.shutdownDrainMs);
    });
    const drained = Promise.allSettled(inFlight).then(() => 'drained' as const);
    const outcome = await Promise.race([drained, deadline]);
    if (timer) clearTimeout(timer);
    if (outcome === 'drained') return;

    this.shutdownSignal.abort();
    const dropped = [...this.draining.keys()];
    this.log.warn(
      { connectorIds: dropped, count: dropped.length },
      'Connector refreshes dropped at shutdown drain deadline',
    );
  }

  /**
   * Dequeue the pending batch for `key` and run it — but SERIALIZED per connector
   * id. `flush()` itself is synchronous: it detaches the batch (clears timers,
   * deletes the pending entry) and chains the actual adapter work behind any
   * in-flight flush for the SAME connector. This closes the cap-burst race: a
   * cap-triggered flush deletes its pending entry BEFORE awaiting adapter work, so
   * a synchronous >maxBatchItems burst can create a fresh pending entry for the
   * same connector while the first flush is still running — without this chain the
   * two flushes would run concurrent `run` calls (and concurrent sequential path
   * loops) against one provider. Chaining (not a global lock) leaves DIFFERENT
   * connector ids fully parallel.
   */
  private flush(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    // Clear BOTH timers so the surviving one (the bound that didn't fire) can't
    // re-flush an already-deleted entry.
    clearTimeout(entry.timer);
    clearTimeout(entry.deadlineTimer);
    this.pending.delete(key);

    // executeFlush() never rejects (full try/catch), so the chain stays resolved
    // and a failing flush can't break serialization for the next batch.
    const prior = this.draining.get(entry.connectorId) ?? Promise.resolve();
    const next = prior.then(() => this.executeFlush(entry));
    this.draining.set(entry.connectorId, next);
    // Drop the chain tail once it settles — but only if a later flush hasn't
    // already extended it (else we'd delete a still-pending tail and lose
    // serialization for the rest of the burst).
    void next.finally(() => {
      if (this.draining.get(entry.connectorId) === next) this.draining.delete(entry.connectorId);
    });
  }

  private async executeFlush(entry: PendingFlush): Promise<void> {
    // A chained tail (queued behind an active flush via flush()'s
    // `prior.then(() => executeFlush(entry))`) must NOT start fresh connector work
    // once shutdown has begun: when the active attempt unwinds, this continuation
    // would otherwise resolve + run a brand-new request after stop() has resolved.
    // Short-circuit BEFORE the resolver call and warn-log the drop. The chain's
    // `.finally` still cleans the draining entry.
    if (this.stopping) {
      this.log.warn(
        { connectorId: entry.connectorId, reasons: entry.reasons, count: entry.items.length },
        'Connector refresh dropped on shutdown',
      );
      return;
    }
    // Resolution runs inside a guarded scope so a drifted-settings row (ZodError),
    // an unknown connector type, or a getById DB error folds into the warn-log
    // path instead of escaping this detached flush as an unhandled rejection
    // (which the global handler turns into process.exit(1)).
    let resolved: ResolvedFlush | null;
    try {
      resolved = await this.resolveFlush(entry);
    } catch (error: unknown) {
      // A shutdown-deadline abort already warn-logs the dropped set in
      // drainInFlight(); don't double-log the resulting rejection.
      if (this.shutdownSignal.signal.aborted) return;
      // A FlushResolutionError carries the connector-derived context (row was
      // resolved before the failure) and the ORIGINAL error to serialize; a bare
      // error (getById rejected before a row existed) degrades type/name/url.
      const ctx = error instanceof FlushResolutionError ? error.logContext : undefined;
      const cause = error instanceof FlushResolutionError ? error.cause : error;
      this.logFailure(entry, ctx, cause);
      return;
    }
    // null → the resolver skipped (disabled/not-found at flush time): no run, no log.
    if (!resolved) return;
    const flush = resolved;
    try {
      // Capture the result: a resolved { success: false } is a completed-but-
      // rejected provider response (non-retryable) and must NOT read as a
      // successful dispatch; a success message (e.g. Plex skip counts) is logged.
      const result = await requestWithRetry(
        () => this.withTimeout(flush.run, flush.requestCount),
        {
          maxRetries: 1,
          delayMs: this.backoffMs,
          shouldRetry: (e) => e instanceof ConnectorRequestError && e.retryable,
          // The shutdown deadline aborts this signal; requestWithRetry then refuses
          // a second attempt and interrupts any pending backoff (a deadline abort
          // is terminal, NOT a retryable timeout).
          signal: this.shutdownSignal.signal,
        },
      );
      this.logFlushResult(this.successLogContext(flush.logContext, entry), result);
    } catch (error: unknown) {
      // A shutdown-deadline abort is an intentional cancellation, not a provider
      // error — already warned in drainInFlight(); don't double-log.
      if (this.shutdownSignal.signal.aborted) return;
      this.logFailure(entry, flush.logContext, error);
    }
  }

  /**
   * The success/dispatched/rejected/ineffective log context: connector-derived
   * fields (id/type/redacted url — NO name) merged with the coalesced reasons +
   * item count from the pending entry. The redacted host disambiguates same-type
   * connectors at 3am; `reasons` carries the full coalesced set so these logs never
   * imply a single reason that hides what was merged into this batch.
   */
  private successLogContext(ctx: ConnectorLogContext, entry: PendingFlush): Record<string, unknown> {
    return { connectorId: ctx.connectorId, connectorType: ctx.connectorType, reasons: entry.reasons, count: entry.items.length, url: ctx.url };
  }

  /**
   * The failed-flush warn. Populates type/name/url from the available `logContext`
   * and degrades them to `undefined` only when no row was ever resolved (getById
   * rejected). `serializeError()` wraps the caught error (no-raw-error-logging lint).
   */
  private logFailure(entry: PendingFlush, ctx: ConnectorLogContext | undefined, error: unknown): void {
    this.log.warn(
      {
        connectorId: ctx?.connectorId ?? entry.connectorId,
        connectorType: ctx?.connectorType,
        connectorName: ctx?.connectorName,
        reasons: entry.reasons,
        count: entry.items.length,
        url: ctx?.url,
        error: serializeError(error),
      },
      'Connector refresh failed',
    );
  }

  /**
   * Log a completed flush at the level dictated by its STRUCTURED result fields —
   * never by parsing `message`. `skipped`/`passthrough` are silently-ineffective
   * outcomes (no-derivable items left unrefreshed; paths sent unchanged against a
   * remapped server) the operator must see → warn. `fallbackRefreshed` does NOT
   * warn — those items were rescued by the section refresh. `?? 0` guards the
   * falsy-coercion trap: a present 0 must not read as "warn". The resolved server
   * paths are emitted at debug as the explicit replay handoff — no re-derivation.
   */
  private logFlushResult(logCtx: Record<string, unknown>, result: ConnectorRefreshResult): void {
    const ineffective = (result.skipped ?? 0) > 0 || (result.passthrough ?? 0) > 0;
    if (!result.success) {
      this.log.warn({ ...logCtx, message: result.message }, 'Connector refresh rejected');
    } else if (ineffective) {
      this.log.warn({ ...logCtx, message: result.message }, 'Connector refresh ineffective');
    } else if (result.message) {
      this.log.info({ ...logCtx, message: result.message }, 'Connector refresh dispatched');
    } else {
      this.log.debug(logCtx, 'Connector refresh dispatched');
    }
    if (result.resolvedServerPaths?.length) {
      this.log.debug({ ...logCtx, resolvedServerPaths: result.resolvedServerPaths }, 'Connector resolved server paths');
    }
  }

  /**
   * Run `fn` under an outer per-attempt guard. Threads a real AbortSignal into
   * `fn` and ABORTS it when the timeout fires — so an adapter that fans out
   * fetches (Plex) actually cancels in-flight work rather than leaving it racing
   * (the prior Promise.race could not stop already-started work). 0 disables the
   * timeout; the signal is still passed (never aborts).
   *
   * The budget is MULTI-REQUEST-AWARE: `flushTimeoutMs` budgets ONE request plus
   * margin (the historical default is `CONNECTOR_TIMEOUT_MS + 5s`), and each
   * ADDITIONAL sequential request the adapter reports via `requestCount` (Plex
   * issues one per distinct server path, sequentially) adds a full
   * `CONNECTOR_TIMEOUT_MS`. At requestCount === 1 the budget is identical to the
   * historical flat budget, so a single-request adapter (ABS) is unchanged.
   * `fetchWithTimeout` still bounds each individual HTTP request inside the
   * adapter; this watchdog only fires if a whole attempt hangs past its scaled
   * budget.
   */
  private async withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, requestCount: number): Promise<T> {
    const controller = new AbortController();
    // Compose the per-attempt timeout controller with the service shutdown signal:
    // EITHER the scaled-budget timeout OR a shutdown-drain-deadline abort cancels
    // the in-flight adapter request. Composed even when the outer timeout is
    // disabled so a shutdown abort still reaches the request.
    const signal = AbortSignal.any([controller.signal, this.shutdownSignal.signal]);
    if (this.flushTimeoutMs <= 0) return fn(signal);
    const budgetMs = this.flushTimeoutMs + Math.max(0, requestCount - 1) * CONNECTOR_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = this.armTimer(() => {
        controller.abort();
        reject(new ConnectorRequestError('Connector refresh timed out', { retryable: true }));
      }, budgetMs);
    });
    try {
      return await Promise.race([fn(signal), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
